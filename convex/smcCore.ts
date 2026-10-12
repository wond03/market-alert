// SMC 纯逻辑（无 Convex 依赖）——被 convex/smc.ts 与 backtest/smc.ts 共用，
// 保证回测与线上记录器的判定绝对一致。

import type { Candle } from "./gate";

export const TF = 900; // 15m
export const FRACTAL = 2; // 摆动点：左右各 2 根

export const SL = 0.005;
export const TP = 0.006;
export const HOLD_H = 8;

const MAKER_BPS = 2;
const TAKER_BPS = 5;
const SLIP_BPS = 2;
export const TARGET_COST = (MAKER_BPS + MAKER_BPS) / 10000;
export const STOP_COST = (MAKER_BPS + TAKER_BPS + SLIP_BPS) / 10000;
export const FUNDING_8H: Record<string, number> = { BTC: 0.000027, XAU: 0.000043 };

export type Swing = { idx: number; t: number; price: number };
export type Trend = "bull" | "bear" | "range";
export type Fvg = { top: number; bottom: number; dir: "bull" | "bear"; dist: number };

// 摆动点（fractal N）：仅返回右侧已有 N 根确认的点（无未来函数）。
export function findSwings(
  candles: Candle[],
  n: number,
): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = n; i < candles.length - n; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= n; k++) {
      if (!(candles[i].h > candles[i - k].h) || !(candles[i].h > candles[i + k].h)) isHigh = false;
      if (!(candles[i].l < candles[i - k].l) || !(candles[i].l < candles[i + k].l)) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, t: candles[i].t, price: candles[i].h });
    if (isLow) lows.push({ idx: i, t: candles[i].t, price: candles[i].l });
  }
  return { highs, lows };
}

export function structureOf(highs: Swing[], lows: Swing[]): Trend {
  if (highs.length < 2 || lows.length < 2) return "range";
  const h1 = highs[highs.length - 2].price;
  const h2 = highs[highs.length - 1].price;
  const l1 = lows[lows.length - 2].price;
  const l2 = lows[lows.length - 1].price;
  if (h2 > h1 && l2 > l1) return "bull";
  if (h2 < h1 && l2 < l1) return "bear";
  return "range";
}

// 当前价上方/下方最近的未填补 FVG（只用到 bar 索引 j 及之前的数据）。
export function nearestFvg(
  candles: Candle[],
  j: number,
  price: number,
): { above: Fvg | null; below: Fvg | null } {
  let above: Fvg | null = null;
  let below: Fvg | null = null;
  for (let i = 2; i <= j; i++) {
    let top: number | null = null;
    let bottom: number | null = null;
    let dir: "bull" | "bear" | null = null;
    if (candles[i].l > candles[i - 2].h) {
      dir = "bull";
      bottom = candles[i - 2].h;
      top = candles[i].l;
    } else if (candles[i].h < candles[i - 2].l) {
      dir = "bear";
      bottom = candles[i].h;
      top = candles[i - 2].l;
    }
    if (!dir || top === null || bottom === null) continue;
    let filled = false;
    for (let k = i + 1; k <= j; k++) {
      if (candles[k].l <= top && candles[k].h >= bottom) {
        filled = true;
        break;
      }
    }
    if (filled) continue;
    const mid = (top + bottom) / 2;
    const dist = price > 0 ? Math.abs(mid - price) / price : 0;
    if (mid > price) {
      if (!above || dist < above.dist) above = { top, bottom, dir, dist };
    } else {
      if (!below || dist < below.dist) below = { top, bottom, dir, dist };
    }
  }
  return { above, below };
}

export function alignOf(tradeDir: string, trend: Trend): boolean {
  return (tradeDir === "long" && trend === "bull") || (tradeDir === "short" && trend === "bear");
}

export type ManagedResult = {
  exitTs: number;
  exitPrice: number;
  reason: string;
  gross: number;
  net: number;
  mfe: number;
  mae: number;
} | null;

// 保守口径：信号 K 线只判止损；其后逐根先判止损再判止盈；到期市价平。附带 MFE/MAE。
export function manage(
  candles: Candle[],
  t: {
    tradeDir: string;
    entryPrice: number;
    sl: number;
    tp: number;
    sigTs: number;
    holdH: number;
    symbol: string;
  },
  now: number,
): ManagedResult {
  const short = t.tradeDir === "short";
  const entry = t.entryPrice;
  const stop = short ? entry * (1 + t.sl) : entry * (1 - t.sl);
  const tgt = short ? entry * (1 - t.tp) : entry * (1 + t.tp);
  const endT = t.sigTs + t.holdH * 3600;
  const dir = short ? -1 : 1;
  const cost = (reason: string) => (reason === "target" ? TARGET_COST : STOP_COST);
  const fin = (
    reason: string,
    exitTs: number,
    exitPrice: number,
    gross: number,
    mfe: number,
    mae: number,
  ) => {
    const funding = (FUNDING_8H[t.symbol] ?? 0) * dir * (t.holdH / 8);
    return { exitTs, exitPrice, reason, gross, net: gross - cost(reason) - funding, mfe, mae };
  };
  let mfe = 0;
  let mae = 0;
  let last: Candle | null = null;
  for (const c of candles) {
    if (c.t < t.sigTs) continue;
    if (c.t > endT) break;
    const hitStop = short ? c.h >= stop : c.l <= stop;
    if (c.t === t.sigTs) {
      if (hitStop) return fin("stop", c.t, stop, -t.sl, mfe, mae);
      continue;
    }
    last = c;
    mfe = Math.max(mfe, short ? (entry - c.l) / entry : (c.h - entry) / entry);
    mae = Math.max(mae, short ? (c.h - entry) / entry : (entry - c.l) / entry);
    const hitTgt = short ? c.l <= tgt : c.h >= tgt;
    if (hitStop) return fin("stop", c.t, stop, -t.sl, mfe, mae);
    if (hitTgt) return fin("target", c.t, tgt, t.tp, mfe, mae);
  }
  if (last && now >= endT) {
    const raw = short ? (entry - last.c) / entry : (last.c - entry) / entry;
    return fin("timeout", last.t, last.c, raw, mfe, mae);
  }
  return null;
}
