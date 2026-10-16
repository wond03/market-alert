// 影子统计：量化作战面板每一层的通过率（对齐 ima 笔记《先量化每一层的通过率》）。
// 同时给出两种口径：
//   A 生产逐根口径：同一根 5m 上「方向→入区→确认1→确认2」的条件通过率（乘起来=漏斗末端概率）。
//   B 事件序列口径：入区事件后 N 根内出现确认1；确认1 后 3 根内出现确认2（且要求确认2 在确认1 之后）。
//
// 运行：
//   ./node_modules/.bin/esbuild backtest/shadow.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/opencode/bt-shadow.mjs && node /tmp/opencode/bt-shadow.mjs

import { fetchHistory, type Candle } from "./history";
import { contractOf } from "../convex/exchanges";
import { battleZones, hasDisplacement, MTF_DIR_SWING, CONFIRM_LOOKBACK, buildRisk, ZONE_BUF_ATR } from "../convex/battleCore";
import { runStructure, atr, ATR_LEN, INTERNAL_LEN } from "../convex/luxSmc";
import * as gate from "../convex/gate";

const SYMBOLS = ["BTC", "XAU"];
const FIVE_M = 9000;
const FIFT_M = 3000;
const ONE_H = 900;
const N_LIST = [3, 4]; // 确认1 回看根数（笔记口径 3；当前生产 4）

const pad = (s: string, w: number) => String(s).padStart(w);
const padE = (s: string, w: number) => String(s).padEnd(w);
const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) + "%" : "-");

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

type Entry = { t: number; dir: string; zone: { top: number; bottom: number; idx: number } };
type Brk = { t: number; dir: string };
type Trig = { t: number; dir: string };

type SymData = {
  bars: number;
  dirValid: number;
  inZoneBars: number;
  conf1Bars: Record<number, number>; // per N
  conf2Bars: Record<number, number>;
  rrGe2: number;
  sigBars: number;
  entries: Entry[];
  intBreaks: Brk[];
  ltfTrigs: Trig[];
  rrSamples: number[]; // 生产口径下的 rr
};

async function collect(sym: string): Promise<SymData> {
  const d: SymData = {
    bars: 0,
    dirValid: 0,
    inZoneBars: 0,
    conf1Bars: { 3: 0, 4: 0 },
    conf2Bars: { 3: 0, 4: 0 },
    rrGe2: 0,
    sigBars: 0,
    entries: [],
    intBreaks: [],
    ltfTrigs: [],
    rrSamples: [],
  };
  const c5 = await fetchHistory(contractOf("gate", sym), "5m", FIVE_M);
  const c15 = await fetchHistory(contractOf("gate", sym), "15m", FIFT_M);
  const c1h = await fetchHistory(contractOf("gate", sym), "1h", ONE_H);
  const lastIntT: Record<string, number> = { bull: 0, bear: 0 };
  const lastTrigT: Record<string, number> = { bull: 0, bear: 0 };
  let prevInZone = false;
  let prevDir = "";

  for (let j = 0; j < c5.length; j++) {
    const tClose = c5[j].t + 300;
    const ltf = c5.slice(Math.max(0, j - 499), j + 1);
    const mEnd = closedEnd(c15, tClose, 900);
    const hEnd = closedEnd(c1h, tClose, 3600);
    const mtf = c15.slice(Math.max(0, mEnd - 299), mEnd);
    if (mtf.length < 220 || hEnd < 60) continue;
    d.bars++;

    const mtfSt = runStructure(mtf, MTF_DIR_SWING);
    const dir = mtfSt.trendAtEnd;
    const dirLast = mtfSt.breaks.length ? mtfSt.breaks[mtfSt.breaks.length - 1] : undefined;
    const dirOk = (dir === "bull" || dir === "bear") && !!dirLast && dirLast.t >= gate.currentDayStart(tClose);
    if (!dirOk) continue;
    const disp = hasDisplacement(mtf, { kind: "OB", bias: dir as "bull" | "bear", top: 0, bottom: 0, idx: dirLast!.idx, t: dirLast!.t }, atr(mtf, ATR_LEN));
    if (!disp) continue;
    d.dirValid++;

    const zones = battleZones(mtf, dir as "bull" | "bear");
    const ltfAtrArr = atr(ltf, 14);
    const ltfAtr = ltfAtrArr[ltf.length - 1] || c5[j].c * 0.002;
    const price = ltf[ltf.length - 1].c;
    const buf = ZONE_BUF_ATR * ltfAtr;
    let inZone: { top: number; bottom: number; idx: number } | null = null;
    for (const z of zones) {
      if (price >= z.bottom - buf && price <= z.top + buf) {
        if (!inZone || Math.abs(price - (z.top + z.bottom) / 2) < Math.abs(price - (inZone.top + inZone.bottom) / 2)) inZone = z;
      }
    }
    if (!inZone) {
      prevInZone = false;
      continue;
    }
    d.inZoneBars++;
    if (!prevInZone || prevDir !== dir) d.entries.push({ t: tClose, dir, zone: { top: inZone.top, bottom: inZone.bottom, idx: inZone.idx } });
    prevInZone = true;
    prevDir = dir;

    // 15m 内部结构：新出现的同向突破（记录时间）
    const mres = runStructure(mtf, INTERNAL_LEN);
    const ib = mres.breaks.length ? mres.breaks[mres.breaks.length - 1] : undefined;
    if (ib && ib.dir === dir && ib.t > lastIntT[dir]) {
      lastIntT[dir] = ib.t;
      d.intBreaks.push({ t: ib.t, dir });
    }
    // 5m 触发（结构突破/吞没/Pin），记录时间
    const lres = runStructure(ltf, INTERNAL_LEN);
    const lb = lres.breaks.length ? lres.breaks[lres.breaks.length - 1] : undefined;
    const last = ltf[ltf.length - 1];
    const prev = ltf[ltf.length - 2];
    const recentBreak = !!lb && lb.dir === dir && ltf.length - 1 - lb.idx <= CONFIRM_LOOKBACK;
    const trig = recentBreak || isEngulf(prev, last, dir as "bull" | "bear") || isPin(last, dir as "bull" | "bear");
    if (trig && tClose > lastTrigT[dir]) {
      lastTrigT[dir] = tClose;
      d.ltfTrigs.push({ t: tClose, dir });
    }

    for (const N of N_LIST) {
      const c1 = !!ib && ib.dir === dir && mtf.length - 1 - ib.idx <= N;
      if (c1) d.conf1Bars[N]++;
      if (c1 && trig) {
        d.conf2Bars[N]++;
        d.sigBars++;
        const risk = buildRisk(dir as "bull" | "bear", inZone as never, mtfSt, price, ltfAtr, []);
        if (risk.rr != null) {
          d.rrSamples.push(risk.rr);
          if (risk.rr >= 2) d.rrGe2++;
        }
      }
    }
  }
  return d;
}

function seqRates(d: SymData, N: number, requireZoneAtTrigger: boolean) {
  // B 口径：入区事件 → N 根 15m 内确认1 → 3 根 5m 内确认2（同向、时间在后）
  let e = d.entries.length;
  let c1 = 0;
  let c2 = 0;
  for (const en of d.entries) {
    const t1End = en.t + N * 900;
    const ib = d.intBreaks.find((b) => b.dir === en.dir && b.t > en.t && b.t <= t1End);
    if (!ib) continue;
    c1++;
    const t2End = ib.t + CONFIRM_LOOKBACK * 300;
    const tg = d.ltfTrigs.find((x) => x.dir === en.dir && x.t > ib.t && x.t <= t2End);
    if (tg) c2++;
  }
  void requireZoneAtTrigger;
  return { e, c1, c2 };
}

async function main() {
  const data: Record<string, SymData> = {};
  for (const sym of SYMBOLS) data[sym] = await collect(sym);
  const syms = SYMBOLS;

  console.log("=== A 生产逐根口径（同一根 5m 上的条件通过率，逐层相乘）===\n");
  for (const sym of [...syms, "ALL"]) {
    const ds = sym === "ALL" ? syms.map((s) => data[s]) : [data[sym]];
    const bars = ds.reduce((a, x) => a + x.bars, 0);
    const dv = ds.reduce((a, x) => a + x.dirValid, 0);
    const iz = ds.reduce((a, x) => a + x.inZoneBars, 0);
    console.log(`[${sym}] 预热后 5m 根数=${bars}`);
    console.log(`  方向成立(方向+新鲜+位移): ${dv}  P=${pct(dv, bars)}`);
    console.log(`  入区: ${iz}  P(入区|方向)=${pct(iz, dv)}`);
    for (const N of N_LIST) {
      const c1 = ds.reduce((a, x) => a + x.conf1Bars[N], 0);
      const c2 = ds.reduce((a, x) => a + x.conf2Bars[N], 0);
      const rrN = ds.reduce((a, x) => a + x.rrSamples.length, 0);
      const rr2 = ds.reduce((a, x) => a + x.rrGe2, 0);
      const prod = (iz / dv) * (c1 / iz) * (c2 / c1);
      console.log(
        `  [确认1回看=${N}] P(确认1|入区)=${pct(c1, iz)} (${c1})  P(确认2|确认1)=${pct(c2, c1)} (${c2})  逐层积≈${(prod * 100).toFixed(2)}%`,
      );
      console.log(`             信号(未去重)=${c2}  P(RR≥2|信号)=${pct(rr2, rrN)}  中位RR=${rrMedian(ds)}`);
    }
    console.log("");
  }

  console.log("=== B 事件序列口径（入区事件 → N 根内确认1 → 3 根内确认2，要求先后顺序）===\n");
  console.log(padE("sym", 6) + padE("入区事件", 10) + pad("确认1", 7) + pad("确认2", 7) + pad("P(确认1|入区)", 14) + pad("P(确认2|确认1)", 14) + pad("P全链", 9));
  for (const sym of [...syms, "ALL"]) {
    for (const N of N_LIST) {
      const ds = sym === "ALL" ? syms.map((s) => data[s]) : [data[sym]];
      let e = 0;
      let c1 = 0;
      let c2 = 0;
      for (const x of ds) {
        const r = seqRates(x, N, false);
        e += r.e;
        c1 += r.c1;
        c2 += r.c2;
      }
      const label = `${sym} N=${N}`;
      console.log(
        padE(label, 6) +
          pad(String(e), 10) +
          pad(String(c1), 7) +
          pad(String(c2), 7) +
          pad(pct(c1, e), 14) +
          pad(pct(c2, c1), 14) +
          pad(pct(c2, e), 9),
      );
    }
  }
  console.log(`\n窗口≈31天 两标的；确认2 窗口=${CONFIRM_LOOKBACK} 根 5m。方向层含「当日新鲜+位移」。`);
}

function rrMedian(ds: SymData[]): string {
  const xs = ds.flatMap((x) => x.rrSamples).sort((a, b) => a - b);
  if (!xs.length) return "-";
  const m = xs[Math.floor(xs.length / 2)];
  return m.toFixed(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
