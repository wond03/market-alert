// 序列化 SMC 的「周期结构缩放」回测。
//
// 与 smc_seq.ts 完全相同的决策逻辑（HTF bias → 折溢价 → HTF OB POI → LTF 扫针+CHoCH
// → 止损扫针极值、目标反向流动性），唯一变量是 HTF/LTF 的尺度对。
// 所有时间窗口按墙钟秒等比换算（不随周期改变实际时长），保证跨尺度可比。
//
// 目的：更高周期能取到长得多的历史（4h≈666d、1d≈5.5y），直接扩大样本量。
//
// 运行：./node_modules/.bin/esbuild backtest/smc_tf.ts --bundle --platform=node --format=esm \
//        --outfile=/tmp/tfbt.mjs && node /tmp/tfbt.mjs

import { contractOf, type Candle } from "../convex/exchanges";
import { fetchHistory } from "./history";
import { runStructure } from "../convex/luxSmc";

const SYMBOLS = ["BTC", "XAU"];
const SWING_H = 50; // HTF 摆动结构
const SWING_L = 5; // LTF 结构（进场用）
const SWEEP_LB_SEC = 5 * 3600; // 扫针参考回看（墙钟）
const SETUP_SEC = 10 * 3600; // 进入 POI 后等待 CHoCH 的窗口
const TARGET_SEC = 50 * 3600; // 目标取近 50h 内的摆动点
const HOLD_SEC = 48 * 3600; // 最长持有
const COST = 0.0007; // 单次往返成本
const FUNDING_8H: Record<string, number> = { BTC: 0.000027, XAU: 0.000043 };

const TF_SEC: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

// 每个尺度对：LTF 目标根数决定可用历史长度
const CFGS = [
  { name: "1d→4h", h: "1d", l: "4h", lPts: 3990 },
  { name: "4h→1h", h: "4h", l: "1h", lPts: 5990 },
  { name: "1h→15m", h: "1h", l: "15m", lPts: 9600 },
  { name: "15m→5m", h: "15m", l: "5m", lPts: 9000 },
];

const pct = (x: number) => (x * 100).toFixed(2) + "%";
const pad = (s: unknown, w = 4) => String(s).padStart(w);

type Trade = {
  symbol: string;
  side: "long" | "short";
  ts: number;
  gross: number;
  net: number;
  rNet: number;
  riskPct: number;
  reason: string;
};

function manageOne(
  symbol: string,
  side: "long" | "short",
  cL: Candle[],
  entryIdx: number,
  entry: number,
  stop: number,
  target: number,
  HOLD: number,
  ltfSec: number,
): Trade | null {
  const long = side === "long";
  const riskPct = Math.abs(entry - stop) / entry;
  if (riskPct <= 0) return null;
  const endIdx = Math.min(cL.length - 1, entryIdx + HOLD);
  let reason = "timeout";
  let exit = cL[endIdx].c;
  for (let k = entryIdx + 1; k <= endIdx; k++) {
    const bar = cL[k];
    const hitStop = long ? bar.l <= stop : bar.h >= stop;
    const hitTgt = long ? bar.h >= target : bar.l <= target;
    if (hitStop) {
      reason = "stop";
      exit = stop;
      break;
    }
    if (hitTgt) {
      reason = "target";
      exit = target;
      break;
    }
  }
  const gross = long ? (exit - entry) / entry : (entry - exit) / entry;
  const holdH = ((endIdx - entryIdx) * ltfSec) / 3600;
  const funding = (FUNDING_8H[symbol] ?? 0) * (long ? 1 : -1) * (holdH / 8);
  const net = gross - COST - funding;
  return { symbol, side, ts: cL[entryIdx].t, gross, net, rNet: net / riskPct, riskPct, reason };
}

function simulateDir(symbol: string, side: "long" | "short", cH: Candle[], cL: Candle[], ltfSec: number): Trade[] {
  const long = side === "long";
  const h = runStructure(cH, SWING_H);
  const l = runStructure(cL, SWING_L);
  // WINMODE=bar：窗口按「结构根数」固定，不随周期缩放（更标准的尺度对比）
  // WINMODE=clock：窗口按墙钟秒等比换算（默认）
  const barMode = process.env.WINMODE === "bar";
  const LB = barMode ? 20 : Math.max(1, Math.round(SWEEP_LB_SEC / ltfSec));
  const SETUP_WIN = barMode ? 40 : Math.max(1, Math.round(SETUP_SEC / ltfSec));
  const TARGET_LOOKBACK = barMode ? 200 : Math.max(1, Math.round(TARGET_SEC / ltfSec));
  const HOLD = barMode ? 192 : Math.max(1, Math.round(HOLD_SEC / ltfSec));
  const htfSec = cH.length > 1 ? cH[1].t - cH[0].t : 3600;

  const hBreaks = h.breaks.map((b) => ({ avail: b.t + htfSec, dir: b.dir }));
  const hOBs = h.breaks.map((b, k) => ({
    avail: b.t + htfSec,
    bull: b.dir === "bull",
    low: h.orderBlocks[k]?.low ?? NaN,
    high: h.orderBlocks[k]?.high ?? NaN,
    mit: false,
  }));
  const hPivH = h.highs.map((p) => ({ avail: p.t + SWING_H * htfSec, price: p.price }));
  const hPivL = h.lows.map((p) => ({ avail: p.t + SWING_H * htfSec, price: p.price }));

  const chochLong = l.breaks.filter((b) => b.tag === "CHoCH" && b.dir === "bull").map((b) => b.idx);
  const chochShort = l.breaks.filter((b) => b.tag === "CHoCH" && b.dir === "bear").map((b) => b.idx);
  const chochSet = new Set(long ? chochLong : chochShort);
  const tgtHi = l.highs.map((p) => ({ t: p.t, price: p.price }));
  const tgtLo = l.lows.map((p) => ({ t: p.t, price: p.price }));

  let bPtr = 0, obPtr = 0, phPtr = 0, plPtr = 0;
  let htfDir: "bull" | "bear" | null = null;
  let eq = NaN;
  const trades: Trade[] = [];
  let setup: { startIdx: number; ref: number; sweep: number } | null = null;

  for (let i = 1; i < cL.length; i++) {
    const t = cL[i].t;
    const bar = cL[i];

    while (bPtr < hBreaks.length && hBreaks[bPtr].avail <= t) htfDir = hBreaks[bPtr++].dir;
    while (obPtr < hOBs.length && hOBs[obPtr].avail <= t) obPtr++;
    while (phPtr < hPivH.length && hPivH[phPtr].avail <= t) phPtr++;
    while (plPtr < hPivL.length && hPivL[plPtr].avail <= t) plPtr++;
    eq = phPtr > 0 && plPtr > 0 ? (hPivH[phPtr - 1].price + hPivL[plPtr - 1].price) / 2 : NaN;

    for (let k = 0; k < obPtr; k++) {
      const ob = hOBs[k];
      if (ob.mit || isNaN(ob.low)) continue;
      if (ob.bull && bar.l < ob.low) ob.mit = true;
      if (!ob.bull && bar.h > ob.high) ob.mit = true;
    }

    if (!setup && htfDir && !isNaN(eq)) {
      const wantBull = long;
      if ((long && htfDir === "bull" && bar.c < eq) || (!long && htfDir === "bear" && bar.c > eq)) {
        let best = -1;
        for (let k = obPtr - 1; k >= 0; k--) {
          const ob = hOBs[k];
          if (ob.mit || isNaN(ob.low) || ob.bull !== wantBull) continue;
          if (bar.l <= ob.high && bar.h >= ob.low) {
            best = k;
            break;
          }
        }
        if (best >= 0) {
          let ref = long ? Infinity : -Infinity;
          for (let k = Math.max(0, i - LB); k < i; k++) ref = long ? Math.min(ref, cL[k].l) : Math.max(ref, cL[k].h);
          setup = { startIdx: i, ref, sweep: long ? Infinity : -Infinity };
        }
      }
    }

    if (setup) {
      setup.sweep = long ? Math.min(setup.sweep, bar.l) : Math.max(setup.sweep, bar.h);
      const swept = long ? setup.sweep < setup.ref : setup.sweep > setup.ref;
      const choch = chochSet.has(i) && i > setup.startIdx;
      if (choch && swept) {
        const entry = bar.c;
        const stop = setup.sweep;
        let target = NaN;
        const since = t - TARGET_LOOKBACK * ltfSec;
        if (long) {
          for (const p of tgtHi) if (p.t < t && p.t >= since && p.price > entry) target = isNaN(target) ? p.price : Math.min(target, p.price);
        } else {
          for (const p of tgtLo) if (p.t < t && p.t >= since && p.price < entry) target = isNaN(target) ? p.price : Math.max(target, p.price);
        }
        const okStop = long ? stop < entry : stop > entry;
        const okTgt = long ? target > entry : target < entry;
        if (!isNaN(target) && okStop && okTgt) {
          const tr = manageOne(symbol, side, cL, i, entry, stop, target, HOLD, ltfSec);
          if (tr) trades.push(tr);
        }
        setup = null;
      } else if (i - setup.startIdx > SETUP_WIN) {
        setup = null;
      }
    }
  }
  return trades;
}

function statsOf(xs: number[]) {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, win: n ? xs.filter((x) => x > 0).length / n : 0, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

function line(label: string, rows: Trade[]) {
  const net = statsOf(rows.map((r) => r.net));
  const rn = statsOf(rows.map((r) => r.rNet));
  const avgRisk = rows.length ? rows.reduce((a, r) => a + r.riskPct, 0) / rows.length : 0;
  console.log(
    `    ${label.padEnd(12)} n=${pad(net.n, 4)}  毛 ${pad(pct(net.mean + COST), 8)}  净 ${pad(pct(net.mean), 8)}  胜率 ${pad(pct(net.win), 7)}  t=${net.t.toFixed(2)}  | 净R ${pad(rn.mean.toFixed(2), 6)} (t=${rn.t.toFixed(2)})  止损 ${pct(avgRisk)}`,
  );
}

async function main() {
  for (const cfg of CFGS) {
    const htfSec = TF_SEC[cfg.h];
    const ltfSec = TF_SEC[cfg.l];
    const hPts = Math.min(6000, Math.ceil((cfg.lPts * ltfSec + 200 * htfSec) / htfSec) + 400);
    const all: Trade[] = [];
    let lo = Infinity, hi = 0;
    console.log(`\n######## ${cfg.name} (HTF ${cfg.h} / LTF ${cfg.l}) ########`);
    for (const sym of SYMBOLS) {
      const contract = contractOf("gate", sym);
      const cH = await fetchHistory(contract, cfg.h, hPts);
      const cL = await fetchHistory(contract, cfg.l, cfg.lPts);
      lo = Math.min(lo, cL[0].t);
      hi = Math.max(hi, cL[cL.length - 1].t);
      const longs = simulateDir(sym, "long", cH, cL, ltfSec);
      const shorts = simulateDir(sym, "short", cH, cL, ltfSec);
      all.push(...longs, ...shorts);
    }
    all.sort((a, b) => a.ts - b.ts);
    const mid = lo + (hi - lo) * 0.7;
    console.log(`  窗口 ${new Date(lo * 1000).toISOString().slice(0, 10)} ~ ${new Date(hi * 1000).toISOString().slice(0, 10)}  (${((hi - lo) / 86400).toFixed(0)}d)  成本 ${pct(COST)}/笔`);
    line("全部", all);
    line("多", all.filter((r) => r.side === "long"));
    line("空", all.filter((r) => r.side === "short"));
    line("BTC", all.filter((r) => r.symbol === "BTC"));
    line("XAU", all.filter((r) => r.symbol === "XAU"));
    line("前70%(内)", all.filter((r) => r.ts <= mid));
    line("后30%(外)", all.filter((r) => r.ts > mid));
  }
}

await main();
