// SMC（Smart Money Concepts）纸面记录器 —— 只记录、不推送、不交易。
//
// 判定改用 LuxAlgo 开源定义（见 ./luxSmc，与看盘指标、回测同一套代码）：
//  - 摆动点：leg(size) 确认的摆动高/低；摆动结构 size=50。
//  - 结构 BOS/CHoCH：收盘价上/下穿最近未被穿过的摆动高/低点；上穿时原趋势跌→CHoCH 否则 BOS。
//  - 订单块(OB)：突破时在「摆动点 bar → 当前 bar」区间取的整根 K（含高波动 K 过滤），右侧延伸至被缓解。
//  - 等高等低 EQH/EQL、FVG、溢价/折价、强弱高/低：均按 LuxAlgo 定义。
//
// 每个结构突破记录两个方向假设（事后对比）：
//  - bias="break"  ：突破顺势 —— 在突破 K 收盘价进场。
//  - bias="retest" ：订单块回撤 —— 突破后价格首次回踩该突破生成的订单块时进场。
//  - 两者入场方向均 = 突破方向（bull→long / bear→short）。
//
// 只在三大交易时段（亚洲盘/伦敦盘/纽约盘）内记录（日内）。
// 出场与成本口径沿用旧回测（SL 0.5% / TP 0.6% / 8h 兜底），并记录 MFE/MAE 供事后重算。
// 仅在设置 SMC_TRACKING=1 的部署上运行（prod）。

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
import { SL, TP, HOLD_H, TF, alignOf, manage } from "./smcCore";
import {
  SWING_LEN,
  runStructure,
  computeFvgs,
  computeTrailing,
  type OrderBlock,
  type StructureResult,
} from "./luxSmc";

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
  tag?: string;
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

type Trend = "bull" | "bear" | "range";

// 结构方向「截至某根 bar」：取最后一根 idx<=j 的突破方向，无则 range。
function trendAsOf(res: StructureResult, j: number): Trend {
  let t: Trend = "range";
  for (const br of res.breaks) {
    if (br.idx <= j) t = br.dir;
    else break;
  }
  return t;
}

// 订单块回踩进场：突破后价格首次触及该 OB（看涨 low<=ob.high / 看跌 high>=ob.low）。
function entryForOB(
  closed: gate.Candle[],
  ob: OrderBlock,
  fromIdx: number,
): { idx: number; price: number } | null {
  for (let k = fromIdx + 1; k < closed.length; k++) {
    if (ob.bias === "bull" && closed[k].l <= ob.high) {
      return { idx: k, price: Math.min(ob.high, closed[k].o) };
    }
    if (ob.bias === "bear" && closed[k].h >= ob.low) {
      return { idx: k, price: Math.max(ob.low, closed[k].o) };
    }
  }
  return null;
}

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
      let closed: gate.Candle[];
      let c1h: gate.Candle[];
      try {
        const c15 = await get15(symbol);
        closed = c15.filter((c) => c.t + TF <= now);
        c1h = (await exchanges.getCandles(EXCHANGE, exchanges.contractOf(EXCHANGE, symbol), "1h", 200)).filter(
          (c) => c.t + 3600 <= now,
        );
      } catch (e) {
        console.error(`smc fetch ${symbol} failed: ${e}`);
        continue;
      }
      if (closed.length < SWING_LEN + 5) continue;

      const st = runStructure(closed, SWING_LEN);
      const stH = runStructure(c1h, SWING_LEN);

      // 按 bar 索引归集事件：突破 / 订单块回踩
      const evByBar = new Map<number, { kind: "break" | "retest"; bi: number }[]>();
      const pushEv = (idx: number, ev: { kind: "break" | "retest"; bi: number }) => {
        const a = evByBar.get(idx);
        if (a) a.push(ev);
        else evByBar.set(idx, [ev]);
      };
      for (let bi = 0; bi < st.breaks.length; bi++) {
        pushEv(st.breaks[bi].idx, { kind: "break", bi });
        const ob = st.orderBlocks[bi];
        if (ob) {
          const e = entryForOB(closed, ob, st.breaks[bi].idx);
          if (e) pushEv(e.idx, { kind: "retest", bi });
        }
      }

      const key = `${EXCHANGE}:${symbol}`;
      const state = await ctx.runQuery(internal.smc.getState, { key });
      const prevChecked = state?.checked;
      const newBars = prevChecked === undefined ? [] : closed.filter((c) => c.t > prevChecked);

      const rows: SignalInsert[] = [];
      for (const bar of newBars) {
        const j = closed.findIndex((c) => c.t === bar.t);
        if (j < SWING_LEN + 2) continue;
        // 日内：仅记录三大交易时段（亚洲盘/伦敦盘/纽约盘）内收盘的信号。
        const session = gate.currentSessionName(bar.t + TF);
        if (!session) continue;
        const evs = evByBar.get(j);
        if (!evs || !evs.length) continue;

        const trend15 = trendAsOf(st, j);
        let jh = -1;
        for (let i = 0; i < c1h.length; i++) {
          if (c1h[i].t <= bar.t) jh = i;
          else break;
        }
        const trend1h = trendAsOf(stH, jh);

        // 溢价/折价（trailing 极值，截至当前 bar）
        const slice = closed.slice(0, j + 1);
        const tr = computeTrailing(slice, SWING_LEN);
        let rangeHigh: number | undefined;
        let rangeLow: number | undefined;
        let posPct: number | undefined;
        let zone = "mid";
        if (tr.top > tr.bottom) {
          rangeHigh = tr.top;
          rangeLow = tr.bottom;
          posPct = (bar.c - rangeLow) / (rangeHigh - rangeLow);
          zone = posPct >= 0.5 ? "premium" : "discount";
        }

        // 最近未填补 FVG（LuxAlgo 定义）
        let fvgAbove: { dist: number; dir: string } | null = null;
        let fvgBelow: { dist: number; dir: string } | null = null;
        for (const f of computeFvgs(slice)) {
          if (f.mitigatedIdx !== null) continue;
          const mid = (f.top + f.bottom) / 2;
          const dist = Math.abs(mid - bar.c) / bar.c;
          if (mid > bar.c) {
            if (!fvgAbove || dist < fvgAbove.dist) fvgAbove = { dist, dir: f.dir };
          } else {
            if (!fvgBelow || dist < fvgBelow.dist) fvgBelow = { dist, dir: f.dir };
          }
        }

        for (const ev of evs) {
          const br = st.breaks[ev.bi];
          const dir = br.dir === "bull" ? "long" : "short";
          let entryPrice = bar.c;
          if (ev.kind === "retest") {
            const ob = st.orderBlocks[ev.bi];
            if (!ob) continue;
            const e = entryForOB(closed, ob, br.idx);
            if (!e || e.idx !== j) continue;
            entryPrice = e.price;
          }
          rows.push({
            exchange: EXCHANGE,
            symbol,
            sigTs: bar.t,
            session,
            level: br.level,
            levelKind: "structural",
            tag: br.tag,
            sweepSide: br.dir,
            bias: ev.kind,
            tradeDir: dir,
            entryPrice,
            pen: Math.abs((entryPrice - br.level) / br.level),
            rangeHigh,
            rangeLow,
            posPct,
            zone,
            trend1h,
            trend15,
            align1h: alignOf(dir, trend1h),
            align15: alignOf(dir, trend15),
            fvgAbove: fvgAbove ? fvgAbove.dist : undefined,
            fvgBelow: fvgBelow ? fvgBelow.dist : undefined,
            fvgAboveDir: fvgAbove ? fvgAbove.dir : undefined,
            fvgBelowDir: fvgBelow ? fvgBelow.dir : undefined,
            sl: SL,
            tp: TP,
            holdH: HOLD_H,
            status: "open",
            openedAt: now,
          });
          opened++;
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
  tag: v.optional(v.string()),
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
        break: group((s) => s.bias === "break"),
        retest: group((s) => s.bias === "retest"),
      },
      byTag: {
        BOS: group((s) => s.tag === "BOS"),
        CHoCH: group((s) => s.tag === "CHoCH"),
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
