// SMC（Smart Money Concepts）纸面记录器 —— 只记录、不推送、不交易。
//
// 冻结定义（2026-10-13 与用户确认，fractal N=2）：
//  - 摆动点：某根 K 的高(低)严格高于(低于)左右各 2 根 → 摆动高(低)点；右侧 2 根收盘后才确认，无未来函数。
//  - 结构：最近两个已确认摆动高、两个摆动低同时抬升 = bull；同时下移 = bear；否则 range。
//  - 区间/溢折价：最近确认摆动高-低为 dealing range；(price-low)/(high-low) ≥ 0.5 = premium，< 0.5 = discount。
//  - FVG：三根 K 失衡缺口；记录当前价上方/下方最近的「未填补」缺口及方向。
//  - 扫荡：某根 15m K 新鲜刺破参考位（前时段高/低 或 摆动高/低）后收盘回到位内（SFP / liquidity sweep）。
//  - 每个扫荡同时记录两个方向：reversal（SFP 反转）与 continuation（延续），事后对比。
//  - 只在三大交易时段（亚洲盘/伦敦盘/纽约盘）内记录（日内）。
//  - 出场与成本口径沿用旧回测（SL 0.5% / TP 0.6% / H 8h），并记录 MFE/MAE 供事后重算其它出场。
//
// 判定逻辑在 ./smcCore（与回测共用同一份代码）。仅在设置 SMC_TRACKING=1 的部署上运行（prod）。

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
import {
  FRACTAL,
  TF,
  SL,
  TP,
  HOLD_H,
  findSwings,
  structureOf,
  nearestFvg,
  alignOf,
  manage,
} from "./smcCore";

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  const value = proc?.env?.[name];
  return value ? String(value).trim() : "";
}

const EXCHANGE: Exchange = "gate";
const SYMBOLS = ["BTC", "XAU"];

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
