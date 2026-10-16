// 诊断：作战面板信号闸门漏斗，统计每根 5m 收盘在各级过滤上的存活数量，定位「信号过少」的瓶颈。
// 与 evaluateBattle 同序复算各闸门（使用同一批导出函数与常量）。
//
// 运行：
//   ./node_modules/.bin/esbuild backtest/funnel.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/opencode/bt-funnel.mjs && node /tmp/opencode/bt-funnel.mjs

import { fetchHistory, type Candle } from "./history";
import { contractOf } from "../convex/exchanges";
import { battleZones, hasDisplacement, MTF_DIR_SWING } from "../convex/battleCore";
import { runStructure, atr, ATR_LEN, INTERNAL_LEN } from "../convex/luxSmc";
import * as gate from "../convex/gate";

const SYMBOLS = ["BTC", "XAU"];
const FIVE_M = 9000;
const FIFT_M = 3000;
const ONE_H = 900;

const pad = (s: string, w: number) => String(s).padStart(w);
const padE = (s: string, w: number) => String(s).padEnd(w);

function closedEnd(arr: Candle[], tClose: number, sec: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t + sec <= tClose) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isEngulf(prev: Candle | undefined, last: Candle, bias: string): boolean {
  if (!prev) return false;
  if (bias === "bull") return last.c > last.o && prev.c < prev.o && last.c >= prev.o && last.o <= prev.c;
  return last.c < last.o && prev.c > prev.o && last.c <= prev.o && last.o >= prev.c;
}
function isPin(c: Candle, bias: string): boolean {
  const rng = c.h - c.l;
  if (rng <= 0) return false;
  if (Math.abs(c.c - c.o) > rng * 0.34) return false;
  if (bias === "bull") return Math.min(c.c, c.o) - c.l >= rng * 0.5;
  return c.h - Math.max(c.c, c.o) >= rng * 0.5;
}

type Funnel = {
  bars: number;
  hasDir: number;
  dirFresh: number;
  dirDisp: number;
  hasZones: number;
  inZone: number;
  internalConfirm: number;
  ltfConfirm: number;
  signal: number;
};

type Cfg = { bufMult: number; lb: number; cl: number; label: string };

async function run(sym: string, cfg: Cfg): Promise<Funnel> {
  const f: Funnel = { bars: 0, hasDir: 0, dirFresh: 0, dirDisp: 0, hasZones: 0, inZone: 0, internalConfirm: 0, ltfConfirm: 0, signal: 0 };
  const c5 = await fetchHistory(contractOf("gate", sym), "5m", FIVE_M);
  const c15 = await fetchHistory(contractOf("gate", sym), "15m", FIFT_M);
  const c1h = await fetchHistory(contractOf("gate", sym), "1h", ONE_H);
  for (let j = 0; j < c5.length; j++) {
    const tClose = c5[j].t + 300;
    const ltf = c5.slice(Math.max(0, j - 499), j + 1);
    const mEnd = closedEnd(c15, tClose, 900);
    const hEnd = closedEnd(c1h, tClose, 3600);
    const mtf = c15.slice(Math.max(0, mEnd - 299), mEnd);
    if (mtf.length < 220 || hEnd < 60) continue;
    f.bars++;

    const mtfSt = runStructure(mtf, MTF_DIR_SWING);
    const dir = mtfSt.trendAtEnd;
    const dirLast = mtfSt.breaks.length ? mtfSt.breaks[mtfSt.breaks.length - 1] : undefined;
    if (!(dir === "bull" || dir === "bear") || !dirLast) continue;
    f.hasDir++;

    if (!(dirLast.t >= gate.currentDayStart(tClose))) continue;
    f.dirFresh++;

    const disp = hasDisplacement(mtf, { kind: "OB", bias: dir, top: 0, bottom: 0, idx: dirLast.idx, t: dirLast.t }, atr(mtf, ATR_LEN));
    if (!disp) continue;
    f.dirDisp++;

    const zones = battleZones(mtf, dir);
    if (!zones.length) continue;
    f.hasZones++;

    const ltfAtrArr = atr(ltf, 14);
    const ltfAtr = ltfAtrArr[ltf.length - 1] || c5[j].c * 0.002;
    const price = ltf[ltf.length - 1].c;
    const buf = cfg.bufMult * ltfAtr;
    const inZone = zones.some((z) => price >= z.bottom - buf && price <= z.top + buf);
    if (!inZone) continue;
    f.inZone++;

    const mres = runStructure(mtf, INTERNAL_LEN);
    const mb = mres.breaks.length ? mres.breaks[mres.breaks.length - 1] : undefined;
    if (!(mb && mb.dir === dir && mtf.length - 1 - mb.idx <= cfg.lb)) continue;
    f.internalConfirm++;

    const lres = runStructure(ltf, INTERNAL_LEN);
    const lb = lres.breaks.length ? lres.breaks[lres.breaks.length - 1] : undefined;
    const recentBreak = !!lb && lb.dir === dir && ltf.length - 1 - lb.idx <= cfg.cl;
    const last = ltf[ltf.length - 1];
    const prev = ltf[ltf.length - 2];
    const confirm = recentBreak || isEngulf(prev, last, dir) || isPin(last, dir);
    if (!confirm) continue;
    f.ltfConfirm++;
    f.signal++; // 漏斗末端（未去重：同一区可能重复计）
  }
  return f;
}

async function main() {
  const base: Cfg = { bufMult: 0.15, lb: 4, cl: 3, label: "基线" };
  const rows: { sym: string; f: Funnel }[] = [];
  const agg: Funnel = { bars: 0, hasDir: 0, dirFresh: 0, dirDisp: 0, hasZones: 0, inZone: 0, internalConfirm: 0, ltfConfirm: 0, signal: 0 };
  for (const sym of SYMBOLS) {
    const f = await run(sym, base);
    rows.push({ sym, f });
    for (const k of Object.keys(agg) as (keyof Funnel)[]) agg[k] += f[k];
  }
  const stages: [string, keyof Funnel][] = [
    ["1 5m收盘(已预热)", "bars"],
    ["2 15m方向bull/bear", "hasDir"],
    ["3 方向当日新鲜", "dirFresh"],
    ["4 方向带位移", "dirDisp"],
    ["5 存在合格入区", "hasZones"],
    ["6 价格在区内", "inZone"],
    ["7 15m内部确认", "internalConfirm"],
    ["8 5m触发", "ltfConfirm"],
  ];
  console.log(`基线：确认1回看=${base.lb} 确认2回看=${base.cl} 入区缓冲=${base.bufMult}×ATR  窗口≈31天\n`);
  console.log(padE("stage", 22) + pad("BTC", 7) + pad("XAU", 7) + pad("合计", 8) + pad("占上一步", 10) + pad("占全部", 9));
  const all = agg.bars;
  for (let i = 0; i < stages.length; i++) {
    const [label, key] = stages[i];
    const prevKey = i > 0 ? stages[i - 1][1] : key;
    const prev = agg[prevKey];
    const v = agg[key];
    const btc = rows.find((r) => r.sym === "BTC")!.f[key];
    const xau = rows.find((r) => r.sym === "XAU")!.f[key];
    console.log(
      padE(label, 22) +
        pad(String(btc), 7) +
        pad(String(xau), 7) +
        pad(String(v), 8) +
        pad(prev ? ((v / prev) * 100).toFixed(1) + "%" : "-", 10) +
        pad(all ? ((v / all) * 100).toFixed(2) + "%" : "-", 9),
    );
  }

  const sweep: Cfg[] = [
    { bufMult: 0.15, lb: 4, cl: 3, label: "基线 buf=0.15 lb=4 cl=3" },
    { bufMult: 0.3, lb: 4, cl: 3, label: "buf=0.3" },
    { bufMult: 0.5, lb: 4, cl: 3, label: "buf=0.5" },
    { bufMult: 0.15, lb: 4, cl: 5, label: "cl=5" },
    { bufMult: 0.15, lb: 9, cl: 3, label: "去掉确认1" },
    { bufMult: 0.15, lb: 9, cl: 9, label: "去掉确认1+放宽触发" },
    { bufMult: 0.3, lb: 9, cl: 5, label: "buf=0.3+去确认1+cl5" },
  ];
  console.log(`\n=== 单/组合放宽后的末端信号数（未去重，31天两标的） ===`);
  console.log(padE("scenario", 26) + pad("BTC", 7) + pad("XAU", 7) + pad("合计", 8) + pad("倍数", 8));
  const baseCount = agg.signal;
  for (const sc of sweep) {
    let tot = 0;
    let btc = 0;
    let xau = 0;
    for (const sym of SYMBOLS) {
      const r = await run(sym, sc);
      if (sym === "BTC") btc = r.signal;
      else xau = r.signal;
      tot += r.signal;
    }
    console.log(padE(sc.label, 26) + pad(String(btc), 7) + pad(String(xau), 7) + pad(String(tot), 8) + pad((tot / baseCount).toFixed(2) + "x", 8));
  }
  console.log(`\n注：末端「8 5m触发」未去重，实际推送数 ≤ 该值（同一入区当天只发一次）。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
