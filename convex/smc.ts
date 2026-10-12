// SMC（Smart Money Concepts）纸面记录器 —— 只记录、不推送、不交易。
//
// 冻结定义（2026-10-13 与用户确认，fractal N=2）：
//  - 摆动点：某根 K 的高(低)严格高于(低于)左右各 2 根 → 摆动高(低)点；右侧 2 根收盘后才确认，无未来函数。
//  - 结构：最近两个已确认摆动高、两个摆动低同时抬升 = bull；同时下移 = bear；否则 range。
//  - 区间/溢折价：最近确认摆动高-低为 dealing range；(price-low)/(high-low) ≥ 0.5 = premium，< 0.5 = discount。
//  - FVG：三根 K 失衡缺口；记录当前价上方/下方最近的「未填补」缺口及方向。
//  - 扫荡：某根 15m K 刺破参考位（前时段高/低 或 摆动高/低）后收盘回到位内（SFP / liquidity sweep）。
//  - 每个扫荡同时记录两个方向：reversal（SFP 反转）与 continuation（延续），事后对比。
//  - 出场与成本口径沿用旧回测（SL 0.5% / TP 0.6% / H 8h），并记录 MFE/MAE 供事后重算其它出场。
//
// 仅在设置 SMC_TRACKING=1 的部署上运行（prod），dev 不记录，避免重复。

import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import * as gate from "./gate";
import * as exchanges from "./exchanges";
import type { Exchange } from "./exchanges";

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  const value = proc?.env?.[name];
  return value ? String(value).trim() : "";
}

const EXCHANGE: Exchange = "gate";
const SYMBOLS = ["BTC", "XAU"];
const TF = 900; // 15m
const FRACTAL = 2; // 摆动点：左右各 2 根

// 出场与成本（与旧回测/paper 一致）
const SL = 0.005;
const TP = 0.006;
const HOLD_H = 8;
const MAKER_BPS = 2;
const TAKER_BPS = 5;
const SLIP_BPS = 2;
const TARGET_COST = (MAKER_BPS + MAKER_BPS) / 10000;
const STOP_COST = (MAKER_BPS + TAKER_BPS + SLIP_BPS) / 10000;
const FUNDING_8H: Record<string, number> = { BTC: 0.000027, XAU: 0.000043 };

type Swing = { idx: number; t: number; price: number };
type Trend = "bull" | "bear" | "range";
type Fvg = { top: number; bottom: number; dir: "bull" | "bear"; dist: number };

// 摆动点（fractal N）：仅返回右侧已有 N 根确认的点。
function findSwings(candles: gate.Candle[], n: number): { highs: Swing[]; lows: Swing[] } {
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

function structureOf(highs: Swing[], lows: Swing[]): Trend {
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
function nearestFvg(
  candles: gate.Candle[],
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

function alignOf(tradeDir: string, trend: Trend): boolean {
  return (tradeDir === "long" && trend === "bull") || (tradeDir === "short" && trend === "bear");
}

// 保守口径：信号 K 线只判止损；其后逐根先判止损再判止盈；到期市价平。附带 MFE/MAE。
function manage(
  candles: gate.Candle[],
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
): { exitTs: number; exitPrice: number; reason: string; gross: number; net: number; mfe: number; mae: number } | null {
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
  let last: gate.Candle | null = null;
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

type SignalInsert = {
  exchange: string;
  symbol: string;
  sigTs: number;
  session: string;
  level: number;
  levelKind: string;
  sweepSide: string;
  bias: string;
  tradeDir: string;
  entryPrice: number;
  pen: number;
  rangeHigh?: number;
  rangeLow?: number;
  posPct?: number;
  zone: string;
  trend1h: string;
  trend15: string;
  align1h: boolean;
  align15: boolean;
  fvgAbove?: number;
  fvgBelow?: number;
  fvgAboveDir?: string;
  fvgBelowDir?: string;
  sl: number;
  tp: number;
  holdH: number;
  status: string;
  openedAt: number;
};

export const scan = internalAction({
  args: {},
  handler: async (ctx) => {
    if (env("SMC_TRACKING") !== "1") return { skipped: true };

    const now = Math.floor(Date.now() / 1000);
    const c15cache = new Map<string, gate.Candle[]>();
    const get15 = async (symbol: string): Promise<gate.Candle[]> => {
      let c = c15cache.get(symbol);
      if (!c) {
        c = await exchanges.getCandles(EXCHANGE, exchanges.contractOf(EXCHANGE, symbol), gate.BREAK_INTERVAL, 300);
        c15cache.set(symbol, c);
      }
      return c;
    };

    let opened = 0;
    for (const symbol of SYMBOLS) {
      let c15: gate.Candle[];
      let c1h: gate.Candle[];
      try {
        c15 = await get15(symbol);
        c1h = (await exchanges.getCandles(EXCHANGE, exchanges.contractOf(EXCHANGE, symbol), "1h", 200)).filter(
          (c) => c.t + 3600 <= now,
        );
      } catch (e) {
        console.error(`smc fetch ${symbol} failed: ${e}`);
        continue;
      }
      const closed = c15.filter((c) => c.t + TF <= now);
      if (closed.length < 20) continue;

      // 前时段高/低（复用 gate 的时段轮转逻辑）
      const cache = new Map<string, gate.Candle[]>();
      const mkRule = (field: "high" | "low", dir: "up" | "down"): gate.RuleDoc => ({
        _id: `${EXCHANGE}:${symbol}:${field}`,
        exchange: EXCHANGE,
        symbol,
        label: `${symbol} ${field}`,
        type: "breakout",
        indicator: "prev_session",
        field,
        dir,
        enabled: true,
      });
      const levels: { kind: string; price: number }[] = [];
      try {
        levels.push({ kind: "session_high", price: (await gate.resolveLevel(mkRule("high", "up"), cache)).level });
        levels.push({ kind: "session_low", price: (await gate.resolveLevel(mkRule("low", "down"), cache)).level });
      } catch (e) {
        console.error(`smc session ${symbol} failed: ${e}`);
      }

      const swings15 = findSwings(c15, FRACTAL);
      const swings1h = findSwings(c1h, FRACTAL);
      const trend1h = structureOf(swings1h.highs, swings1h.lows);

      const key = `${EXCHANGE}:${symbol}`;
      const st = await ctx.runQuery(internal.smc.getState, { key });
      const prevChecked = st?.checked;
      const newBars = prevChecked === undefined ? [] : closed.filter((c) => c.t > prevChecked);

      const rows: SignalInsert[] = [];
      for (const bar of newBars) {
        const j = c15.findIndex((c) => c.t === bar.t);
        if (j < FRACTAL + 2) continue;
        // 日内：仅记录三大交易时段（亚洲盘/伦敦盘/纽约盘）内收盘的信号。
        const session = gate.currentSessionName(bar.t + TF);
        if (!session) continue;
        // 该 bar 时刻「已确认」的摆动点（右侧 N 根已出现）
        const hi = swings15.highs.filter((s) => s.idx <= j - FRACTAL);
        const lo = swings15.lows.filter((s) => s.idx <= j - FRACTAL);
        const trend15 = structureOf(hi, lo);
        const lastHi = hi.length ? hi[hi.length - 1] : null;
        const lastLo = lo.length ? lo[lo.length - 1] : null;

        let rangeHigh: number | undefined;
        let rangeLow: number | undefined;
        let posPct: number | undefined;
        let zone = "mid";
        if (lastHi && lastLo && lastHi.price > lastLo.price) {
          rangeHigh = lastHi.price;
          rangeLow = lastLo.price;
          posPct = (bar.c - rangeLow) / (rangeHigh - rangeLow);
          zone = posPct >= 0.5 ? "premium" : "discount";
        }
        const fvg = nearestFvg(c15, j, bar.c);
        const prev = c15[j - 1];

        const barLevels: { kind: string; price: number }[] = [];
        if (lastHi) barLevels.push({ kind: "swing_high", price: lastHi.price });
        if (lastLo) barLevels.push({ kind: "swing_low", price: lastLo.price });
        for (const L of levels) barLevels.push(L);

        for (const L of barLevels) {
          // 新鲜刺破：仅当上一根未触碰该位时才计一次，避免连续多根重复扫同一位。
          const up = bar.h > L.price && bar.c < L.price && prev.h <= L.price; // 上破后收回 → 上侧被扫
          const dn = bar.l < L.price && bar.c > L.price && prev.l >= L.price; // 下破后收回 → 下侧被扫
          if (!up && !dn) continue;
          const pen = up ? (bar.h - L.price) / L.price : (L.price - bar.l) / L.price;
          const revDir = up ? "short" : "long"; // SFP：扫上做空、扫下做多
          const contDir = up ? "long" : "short"; // 延续：顺势继续
          const biases: [string, string][] = [
            ["reversal", revDir],
            ["continuation", contDir],
          ];
          for (const [bias, td] of biases) {
            rows.push({
              exchange: EXCHANGE,
              symbol,
              sigTs: bar.t,
              session,
              level: L.price,
              levelKind: L.kind,
              sweepSide: up ? "up" : "down",
              bias,
              tradeDir: td,
              entryPrice: bar.c,
              pen,
              rangeHigh,
              rangeLow,
              posPct,
              zone,
              trend1h,
              trend15,
              align1h: alignOf(td, trend1h),
              align15: alignOf(td, trend15),
              fvgAbove: fvg.above ? fvg.above.dist : undefined,
              fvgBelow: fvg.below ? fvg.below.dist : undefined,
              fvgAboveDir: fvg.above ? fvg.above.dir : undefined,
              fvgBelowDir: fvg.below ? fvg.below.dir : undefined,
              sl: SL,
              tp: TP,
              holdH: HOLD_H,
              status: "open",
              openedAt: now,
            });
            opened++;
          }
        }
      }

      const newest = closed.length ? closed[closed.length - 1].t : prevChecked;
      if (newest !== undefined && (prevChecked === undefined || newest > prevChecked)) {
        await ctx.runMutation(internal.smc.upsertState, { key, checked: newest });
      }
      if (rows.length) await ctx.runMutation(internal.smc.insertSignals, { signals: rows });
    }

    // 跟踪已开信号
    const openList = await ctx.runQuery(internal.smc.openSignals, {});
    let closedN = 0;
    for (const s of openList) {
      let candles: gate.Candle[];
      try {
        candles = await get15(s.symbol);
      } catch (e) {
        console.error(`smc manage ${s.symbol} fetch failed: ${e}`);
        continue;
      }
      const out = manage(candles, s, now);
      if (out) {
        await ctx.runMutation(internal.smc.closeSignal, { id: s._id, ...out, closedAt: now });
        closedN++;
      }
    }

    console.log(`smc scan: opened=${opened} closed=${closedN} open=${openList.length - closedN}`);
    return { opened, closed: closedN };
  },
});

// ---- 内部读写 ----

export const getState = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) =>
    ctx.db.query("smcState").withIndex("by_key", (q) => q.eq("key", key)).unique(),
});

export const upsertState = internalMutation({
  args: { key: v.string(), checked: v.number() },
  handler: async (ctx, { key, checked }) => {
    const existing = await ctx.db.query("smcState").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (existing) await ctx.db.patch(existing._id, { checked });
    else await ctx.db.insert("smcState", { key, checked });
  },
});

const signalValidator = v.object({
  exchange: v.string(),
  symbol: v.string(),
  sigTs: v.number(),
  session: v.string(),
  level: v.number(),
  levelKind: v.string(),
  sweepSide: v.string(),
  bias: v.string(),
  tradeDir: v.string(),
  entryPrice: v.number(),
  pen: v.number(),
  rangeHigh: v.optional(v.number()),
  rangeLow: v.optional(v.number()),
  posPct: v.optional(v.number()),
  zone: v.string(),
  trend1h: v.string(),
  trend15: v.string(),
  align1h: v.boolean(),
  align15: v.boolean(),
  fvgAbove: v.optional(v.number()),
  fvgBelow: v.optional(v.number()),
  fvgAboveDir: v.optional(v.string()),
  fvgBelowDir: v.optional(v.string()),
  sl: v.number(),
  tp: v.number(),
  holdH: v.number(),
  status: v.string(),
  openedAt: v.number(),
});

export const insertSignals = internalMutation({
  args: { signals: v.array(signalValidator) },
  handler: async (ctx, { signals }) => {
    for (const s of signals) await ctx.db.insert("smcSignals", s);
  },
});

export const openSignals = internalQuery({
  args: {},
  handler: async (ctx) =>
    ctx.db.query("smcSignals").withIndex("by_status", (q) => q.eq("status", "open")).collect(),
});

export const closeSignal = internalMutation({
  args: {
    id: v.id("smcSignals"),
    exitTs: v.number(),
    exitPrice: v.number(),
    reason: v.string(),
    gross: v.number(),
    net: v.number(),
    mfe: v.number(),
    mae: v.number(),
    closedAt: v.number(),
  },
  handler: async (ctx, { id, ...rest }) => {
    await ctx.db.patch(id, { status: "closed", ...rest });
  },
});

// ---- 公开查询（只读） ----

export const recentSmcSignals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) =>
    ctx.db.query("smcSignals").withIndex("by_sigTs").order("desc").take(limit ?? 50),
});

function statsOf(nets: number[]) {
  const n = nets.length;
  const sum = nets.reduce((a, b) => a + b, 0);
  const mean = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(nets.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    netMean: mean,
    netSum: sum,
    win: n ? nets.filter((x) => x > 0).length / n : 0,
    t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
  };
}

export const smcSummary = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("smcSignals").collect();
    const closed = all.filter((s) => s.status === "closed" && s.net !== undefined);
    const group = (pred: (s: (typeof closed)[number]) => boolean) =>
      statsOf(closed.filter(pred).map((s) => s.net as number));
    return {
      total: all.length,
      open: all.filter((s) => s.status === "open").length,
      closed: closed.length,
      overall: statsOf(closed.map((s) => s.net as number)),
      byBias: {
        reversal: group((s) => s.bias === "reversal"),
        continuation: group((s) => s.bias === "continuation"),
      },
      byAlign1h: { aligned: group((s) => s.align1h), opposing: group((s) => !s.align1h) },
      byZone: { premium: group((s) => s.zone === "premium"), discount: group((s) => s.zone === "discount") },
      bySession: {
        亚洲盘: group((s) => s.session === "亚洲盘"),
        伦敦盘: group((s) => s.session === "伦敦盘"),
        纽约盘: group((s) => s.session === "纽约盘"),
      },
    };
  },
});
