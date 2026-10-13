// 「纽约破伦敦低/高 + 15m BOS + FVG 回踩收盘确认 + NY 盘高低点止损」回测。
//
// 规则来自用户实盘用法（BTC 15m）：
//   1. 偏空来源＝盘段结构：伦敦盘整段低点被纽约盘「收盘」跌破。
//   2. 15m 结构：破位处出现看跌 BOS（用 LuxAlgo 结构，摆动长度 5）。
//   3. 入场：价格反抽回看跌 FVG（该次下挫留下的失衡），且 15m 收盘重新跌回 FVG 下沿之下 → 进场。
//   4. 止损：纽约盘到进场为止的最高点。
//   5. 出场：用户未定。测试固定盈亏比 {1,1.5,2,3}R 与「下方最近流动性」两种。
// 多头为完全镜像（纽约收盘升破伦敦盘高点、看涨 FVG、止损放纽约盘低点）。
//
// 运行：./node_modules/.bin/esbuild backtest/session_sweep.ts --bundle --platform=node --format=esm \
//        --outfile=/tmp/sessbt.mjs && node /tmp/sessbt.mjs

import { contractOf, type Candle } from "../convex/exchanges";
import { tzMinutes, inWindow } from "../convex/gate";
import { runStructure, computeFvgs, type Fvg } from "../convex/luxSmc";
import { fetchHistory } from "./history";

const SYMBOLS = ["BTC", "XAU"];
const LON_START = 8 * 60, LON_END = 16 * 60 + 30; // Europe/London 本地分钟
const NY_START = 9 * 60 + 30, NY_END = 16 * 60; // America/New_York 本地分钟
const SWING = 5;
const COST = 0.0007;
const MAX_HOLD = 96; // 最长 24h（15m 根）
const RTARGETS = [1, 1.5, 2, 3];
const LIQ_LOOKBACK = 200; // 流动性目标取近 200 根内的摆动点

const pct = (x: number) => (x * 100).toFixed(2) + "%";
const pad = (s: unknown, w = 4) => String(s).padStart(w);

type Setup = {
  symbol: string;
  side: "long" | "short";
  ts: number;
  entryIdx: number;
  entry: number;
  stop: number;
  liqTarget: number;
};

// 生成 setups（每张 NY 盘最多一笔）
function findSetups(symbol: string, c15: Candle[], fvgs: Fvg[]): Setup[] {
  const lows = runStructure(c15, SWING).lows;
  const highs = runStructure(c15, SWING).highs;
  const out: Setup[] = [];
  let prevLon = false, prevNy = false;
  let lonLow = Infinity, lonHigh = -Infinity;
  let nyHigh = -Infinity, nyLow = Infinity;
  let bias = 0, breakIdx = -1, entered = false;

  for (let i = 0; i < c15.length; i++) {
    const t = c15[i].t;
    const bar = c15[i];
    const inLon = inWindow(tzMinutes(t, "Europe/London"), LON_START, LON_END);
    const inNy = inWindow(tzMinutes(t, "America/New_York"), NY_START, NY_END);

    if (inLon && !prevLon) { lonLow = Infinity; lonHigh = -Infinity; }
    if (inLon) { lonLow = Math.min(lonLow, bar.l); lonHigh = Math.max(lonHigh, bar.h); }
    if (inNy && !prevNy) { nyHigh = -Infinity; nyLow = Infinity; bias = 0; breakIdx = -1; entered = false; }
    if (inNy) { nyHigh = Math.max(nyHigh, bar.h); nyLow = Math.min(nyLow, bar.l); }

    if (inNy && bias === 0) {
      if (bar.c < lonLow) { bias = -1; breakIdx = i; }
      else if (bar.c > lonHigh) { bias = 1; breakIdx = i; }
    }

    if (inNy && bias !== 0 && !entered) {
      const wantBull = bias > 0;
      // 找破位处及之后形成、尚未缓解、方向一致的 FVG
      let hit: Fvg | null = null;
      for (let k = fvgs.length - 1; k >= 0; k--) {
        const f = fvgs[k];
        if (f.idx > i || f.idx < breakIdx - 2) continue;
        if (f.dir !== (wantBull ? "bull" : "bear")) continue;
        if (f.mitigatedIdx !== null && f.mitigatedIdx <= i) continue;
        if (wantBull) {
          if (bar.l <= f.top && bar.c > f.top) { hit = f; break; }
        } else {
          if (bar.h >= f.bottom && bar.c < f.bottom) { hit = f; break; }
        }
      }
      if (hit) {
        const entry = bar.c;
        const stop = wantBull ? nyLow : nyHigh;
        const entryIdx = i;
        const risk = Math.abs(entry - stop);
        // 流动性目标：方向上最近的摆动点，且距离至少 1R（否则不是有意义的目标）
        let liq = NaN;
        const since = t - LIQ_LOOKBACK * 900;
        if (wantBull) {
          for (const p of highs) if (p.t < t && p.t >= since && p.price - entry >= risk) liq = isNaN(liq) ? p.price : Math.min(liq, p.price);
        } else {
          for (const p of lows) if (p.t < t && p.t >= since && entry - p.price >= risk) liq = isNaN(liq) ? p.price : Math.max(liq, p.price);
        }
        const okStop = wantBull ? stop < entry : stop > entry;
        const okLiq = wantBull ? liq > entry : liq < entry;
        if (okStop) {
          out.push({ symbol, side: wantBull ? "long" : "short", ts: t, entryIdx, entry, stop, liqTarget: okLiq ? liq : NaN });
          entered = true;
        }
      }
    }

    prevLon = inLon;
    prevNy = inNy;
  }
  return out;
}

// 固定目标出场；返回净% 与 R
function exitFixed(c15: Candle[], s: Setup, rMul: number): { net: number; r: number } {
  const long = s.side === "long";
  const risk = Math.abs(s.entry - s.stop);
  const target = long ? s.entry + rMul * risk : s.entry - rMul * risk;
  const endIdx = Math.min(c15.length - 1, s.entryIdx + MAX_HOLD);
  let exit = c15[endIdx].c;
  for (let k = s.entryIdx + 1; k <= endIdx; k++) {
    const bar = c15[k];
    const hitStop = long ? bar.l <= s.stop : bar.h >= s.stop;
    const hitTgt = long ? bar.h >= target : bar.l <= target;
    if (hitStop) { exit = s.stop; break; }
    if (hitTgt) { exit = target; break; }
  }
  const gross = long ? (exit - s.entry) / s.entry : (s.entry - exit) / s.entry;
  const r = (long ? exit - s.entry : s.entry - exit) / risk;
  return { net: gross - COST, r };
}

// 流动性目标出场；无有效目标时退化为 2R
function exitLiq(c15: Candle[], s: Setup): { net: number; r: number } {
  if (isNaN(s.liqTarget)) return exitFixed(c15, s, 2);
  const long = s.side === "long";
  const risk = Math.abs(s.entry - s.stop);
  const target = s.liqTarget;
  const endIdx = Math.min(c15.length - 1, s.entryIdx + MAX_HOLD);
  let exit = c15[endIdx].c;
  for (let k = s.entryIdx + 1; k <= endIdx; k++) {
    const bar = c15[k];
    const hitStop = long ? bar.l <= s.stop : bar.h >= s.stop;
    const hitTgt = long ? bar.h >= target : bar.l <= target;
    if (hitStop) { exit = s.stop; break; }
    if (hitTgt) { exit = target; break; }
  }
  const gross = long ? (exit - s.entry) / s.entry : (s.entry - exit) / s.entry;
  const r = (long ? exit - s.entry : s.entry - exit) / risk;
  return { net: gross - COST, r };
}

function statsOf(xs: number[]) {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, win: n ? xs.filter((x) => x > 0).length / n : 0, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

function line(label: string, rows: { net: number; r: number }[]) {
  const net = statsOf(rows.map((x) => x.net));
  const r = statsOf(rows.map((x) => x.r));
  console.log(
    `    ${label.padEnd(16)} n=${pad(net.n, 4)}  净 ${pad(pct(net.mean), 8)}  胜率 ${pad(pct(net.win), 7)}  t=${net.t.toFixed(2)}  | 净R ${pad(r.mean.toFixed(2), 6)} (t=${r.t.toFixed(2)})`,
  );
}

async function main() {
  const allSetups: Record<string, Setup[]> = {};
  const c15map: Record<string, Candle[]> = {};
  let lo = Infinity, hi = 0;
  for (const sym of SYMBOLS) {
    const c15 = await fetchHistory(contractOf("gate", sym), "15m", 9600);
    c15map[sym] = c15;
    lo = Math.min(lo, c15[0].t);
    hi = Math.max(hi, c15[c15.length - 1].t);
    const fvgs = computeFvgs(c15);
    const setups = findSetups(sym, c15, fvgs);
    allSetups[sym] = setups;
    const longs = setups.filter((s) => s.side === "long").length;
    console.log(`${sym}: setups=${setups.length} (多 ${longs} / 空 ${setups.length - longs})`);
  }
  const flat: Setup[] = [];
  for (const sym of SYMBOLS) flat.push(...allSetups[sym]);
  flat.sort((a, b) => a.ts - b.ts);
  if (process.env.LIST) {
    for (const s of flat.slice(-15)) {
      console.log(`  ${s.symbol} ${s.side.padEnd(5)} ${new Date(s.ts * 1000).toISOString().slice(0, 16)}  进 ${s.entry}  损 ${s.stop}  目标 ${s.liqTarget}`);
    }
  }
  const mid = lo + (hi - lo) * 0.7;

  console.log(`\n窗口 ${new Date(lo * 1000).toISOString().slice(0, 10)} ~ ${new Date(hi * 1000).toISOString().slice(0, 10)}  (${((hi - lo) / 86400).toFixed(0)}d)  成本 ${pct(COST)}/笔`);

  console.log(`\n=== 固定盈亏比出场（全部） ===`);
  for (const R of RTARGETS) line(`${R}R`, flat.map((s) => exitFixed(c15map[s.symbol], s, R)));
  line("流动性目标", flat.map((s) => exitLiq(c15map[s.symbol], s)));

  console.log(`\n=== 分方向（流动性目标） ===`);
  line("多", flat.filter((s) => s.side === "long").map((s) => exitLiq(c15map[s.symbol], s)));
  line("空", flat.filter((s) => s.side === "short").map((s) => exitLiq(c15map[s.symbol], s)));

  console.log(`\n=== 分品种（流动性目标） ===`);
  for (const sym of SYMBOLS) line(sym, allSetups[sym].map((s) => exitLiq(c15map[s.symbol], s)));

  console.log(`\n=== 样本外（流动性目标，前70% 定/后30% 验） ===`);
  line("前70%(内)", flat.filter((s) => s.ts <= mid).map((s) => exitLiq(c15map[s.symbol], s)));
  line("后30%(外)", flat.filter((s) => s.ts > mid).map((s) => exitLiq(c15map[s.symbol], s)));
}

await main();
