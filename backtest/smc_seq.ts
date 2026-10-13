// SMC 序列化决策函数回测（公正版）——不再把 BOS/CHoCH 当孤立触发器。
//
// 序列：HTF(1h) 用 BOS/CHoCH 定 bias → 只在折价(多)/溢价(空) → 价格回踩 HTF 订单块(POI)
//        → LTF(15m) 先扫最近流动性再出同向 CHoCH → 确认收盘进场
//        → 止损放在扫针极值（贴）→ 目标为反向最近的 LTF 流动性（保留 R 不对称）。
//
// 记录每笔的 R 结果与成本后净值；样本外按时间前半/后半分。
//
// 运行：./node_modules/.bin/esbuild backtest/smc_seq.ts --bundle --platform=node --format=esm \
//        --outfile=/tmp/seqbt.mjs && node /tmp/seqbt.mjs

import { contractOf, type Candle } from "../convex/exchanges";
import { fetchHistory } from "./history";
import { runStructure } from "../convex/luxSmc";

const SYMBOLS = ["BTC", "XAU"];
const SWING_H = 50; // 1h 摆动结构
const SWING_L = 5; // 15m 结构（进场用）
const LB = 20; // 扫针参考：前 20 根 15m 的最值
const SETUP_WIN = 40; // 进入 POI 后等待 CHoCH 的窗口（15m 根）
const TARGET_LOOKBACK = 200; // 目标取近 200 根 15m 内的摆动点
const HOLD = 192; // 最长持有 48h
const COST = 0.0007; // 单次往返成本（手续费+滑点，近似）
const FUNDING_8H: Record<string, number> = { BTC: 0.000027, XAU: 0.000043 };

const pct = (x: number) => (x * 100).toFixed(2) + "%";
const pad = (s: unknown, w = 4) => String(s).padStart(w);

type Trade = {
  symbol: string;
  side: "long" | "short";
  ts: number;
  entry: number;
  stop: number;
  target: number;
  riskPct: number;
  gross: number;
  net: number;
  rNet: number;
  reason: string;
};

function manageOne(
  symbol: string,
  side: "long" | "short",
  c15: Candle[],
  entryIdx: number,
  entry: number,
  stop: number,
  target: number,
): Trade | null {
  const long = side === "long";
  const riskPct = Math.abs(entry - stop) / entry;
  const dataEnd = c15[c15.length - 1].t;
  if (riskPct <= 0) return null;
  const endIdx = Math.min(c15.length - 1, entryIdx + HOLD);
  let reason = "timeout";
  let exit = c15[endIdx].c;
  for (let k = entryIdx + 1; k <= endIdx; k++) {
    const bar = c15[k];
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
  const holdH = ((endIdx - entryIdx) * 900) / 3600;
  const funding = (FUNDING_8H[symbol] ?? 0) * (long ? 1 : -1) * (holdH / 8);
  const net = gross - COST - funding;
  return { symbol, side, ts: c15[entryIdx].t, entry, stop, target, riskPct, gross, net, rNet: net / riskPct, reason };
}

// 单方向序列模拟。side=+1 多、-1 空。
function simulateDir(symbol: string, c1h: Candle[], c15: Candle[], side: "long" | "short"): Trade[] {
  const long = side === "long";
  const h = runStructure(c1h, SWING_H);
  const l = runStructure(c15, SWING_L);

  // 1h 突破（定 bias）：availTime = 突破 K 收盘后
  const hBreaks = h.breaks.map((b) => ({ avail: b.t + 3600, dir: b.dir }));
  // 1h 订单块（POI）：与 breaks 同序
  const hOBs = h.breaks.map((b, k) => ({
    avail: b.t + 3600,
    bull: b.dir === "bull",
    low: h.orderBlocks[k]?.low ?? NaN,
    high: h.orderBlocks[k]?.high ?? NaN,
    mit: false,
  }));
  // 1h 摆动点（算溢价/折价区间）
  const hPivH = h.highs.map((p) => ({ avail: p.t + SWING_H * 3600, price: p.price }));
  const hPivL = h.lows.map((p) => ({ avail: p.t + SWING_H * 3600, price: p.price }));

  // 15m CHoCH（进场触发）
  const chochLong = l.breaks.filter((b) => b.tag === "CHoCH" && b.dir === "bull").map((b) => b.idx);
  const chochShort = l.breaks.filter((b) => b.tag === "CHoCH" && b.dir === "bear").map((b) => b.idx);
  const chochSet = new Set(long ? chochLong : chochShort);
  // 15m 摆动点（目标流动性）
  const tgtHi = l.highs.map((p) => ({ t: p.t, price: p.price }));
  const tgtLo = l.lows.map((p) => ({ t: p.t, price: p.price }));

  let bPtr = 0;
  let obPtr = 0;
  let phPtr = 0;
  let plPtr = 0;
  let htfDir: "bull" | "bear" | null = null;
  let eq = NaN; // 区间中位

  const trades: Trade[] = [];
  let setup: { startIdx: number; ref: number; sweep: number } | null = null;

  for (let i = 1; i < c15.length; i++) {
    const t = c15[i].t;
    const bar = c15[i];

    // 推进 1h 状态
    while (bPtr < hBreaks.length && hBreaks[bPtr].avail <= t) {
      htfDir = hBreaks[bPtr].dir;
      bPtr++;
    }
    while (obPtr < hOBs.length && hOBs[obPtr].avail <= t) obPtr++;
    while (phPtr < hPivH.length && hPivH[phPtr].avail <= t) phPtr++;
    while (plPtr < hPivL.length && hPivL[plPtr].avail <= t) plPtr++;
    if (phPtr > 0 && plPtr > 0) eq = (hPivH[phPtr - 1].price + hPivL[plPtr - 1].price) / 2;
    else eq = NaN;

    // 维护活跃 OB（未缓解）
    for (let k = 0; k < obPtr; k++) {
      const ob = hOBs[k];
      if (ob.mit || isNaN(ob.low)) continue;
      if (ob.bull && bar.l < ob.low) ob.mit = true;
      if (!ob.bull && bar.h > ob.high) ob.mit = true;
    }

    // 建立 setup：回踩到与 bias 同向、且未缓解、处于折价/溢价的 HTF OB
    if (!setup && htfDir && !isNaN(eq)) {
      const wantBull = long;
      if ((long && htfDir === "bull" && bar.c < eq) || (!long && htfDir === "bear" && bar.c > eq)) {
        let best = -1;
        for (let k = obPtr - 1; k >= 0; k--) {
          const ob = hOBs[k];
          if (ob.mit || isNaN(ob.low) || ob.bull !== wantBull) continue;
          const overlaps = bar.l <= ob.high && bar.h >= ob.low;
          if (overlaps) {
            best = k;
            break;
          }
        }
        if (best >= 0) {
          let ref = long ? Infinity : -Infinity;
          for (let k = Math.max(0, i - LB); k < i; k++) ref = long ? Math.min(ref, c15[k].l) : Math.max(ref, c15[k].h);
          setup = { startIdx: i, ref, sweep: long ? Infinity : -Infinity };
        }
      }
    }

    // 跟踪扫针 & 寻找 CHoCH 确认
    if (setup) {
      setup.sweep = long ? Math.min(setup.sweep, bar.l) : Math.max(setup.sweep, bar.h);
      const swept = long ? setup.sweep < setup.ref : setup.sweep > setup.ref;
      const choch = chochSet.has(i) && i > setup.startIdx;
      if (choch && swept) {
        const entry = bar.c;
        const stop = setup.sweep;
        // 目标：反向最近流动性（近 TARGET_LOOKBACK 根内的摆动点）
        let target = NaN;
        const since = t - TARGET_LOOKBACK * 900;
        if (long) {
          for (const p of tgtHi) if (p.t < t && p.t >= since && p.price > entry) target = isNaN(target) ? p.price : Math.min(target, p.price);
        } else {
          for (const p of tgtLo) if (p.t < t && p.t >= since && p.price < entry) target = isNaN(target) ? p.price : Math.max(target, p.price);
        }
        const okStop = long ? stop < entry : stop > entry;
        const okTgt = long ? target > entry : target < entry;
        if (!isNaN(target) && okStop && okTgt) {
          const tr = manageOne(symbol, side, c15, i, entry, stop, target);
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
  const g = statsOf(rows.map((r) => r.gross));
  const avgRisk = rows.length ? rows.reduce((a, r) => a + r.riskPct, 0) / rows.length : 0;
  console.log(
    `  ${label.padEnd(10)} n=${pad(net.n, 4)}  毛 ${pad(pct(g.mean), 8)}  净 ${pad(pct(net.mean), 8)}  胜率 ${pad(pct(net.win), 7)}  t=${net.t.toFixed(2)}  | 净R ${pad(rn.mean.toFixed(2), 6)} (t=${rn.t.toFixed(2)})  平均止损 ${pct(avgRisk)}`,
  );
}

async function main() {
  const all: Trade[] = [];
  let lo = Infinity;
  let hi = 0;
  for (const sym of SYMBOLS) {
    const contract = contractOf("gate", sym);
    const c1h = await fetchHistory(contract, "1h", 2000);
    const c15 = await fetchHistory(contract, "15m", 9600);
    lo = Math.min(lo, c15[0].t);
    hi = Math.max(hi, c15[c15.length - 1].t);
    const longs = simulateDir(sym, c1h, c15, "long");
    const shorts = simulateDir(sym, c1h, c15, "short");
    console.log(`${sym}: 多头 setup ${longs.length}，空头 setup ${shorts.length}`);
    all.push(...longs, ...shorts);
  }
  all.sort((a, b) => a.ts - b.ts);
  const mid = lo + (hi - lo) * 0.7;
  console.log(`\n窗口 ${new Date(lo * 1000).toISOString().slice(0, 10)} ~ ${new Date(hi * 1000).toISOString().slice(0, 10)}  成本 ${pct(COST)}/笔`);
  console.log(`\n=== 序列化 SMC 决策函数（含成本） ===`);
  line("全部", all);
  line("多", all.filter((r) => r.side === "long"));
  line("空", all.filter((r) => r.side === "short"));
  line("BTC", all.filter((r) => r.symbol === "BTC"));
  line("XAU", all.filter((r) => r.symbol === "XAU"));
  line("前70%(内)", all.filter((r) => r.ts <= mid));
  line("后30%(外)", all.filter((r) => r.ts > mid));
  for (const r of ["target", "stop", "timeout"]) line(`出场=${r}`, all.filter((x) => x.reason === r));
}

await main();
