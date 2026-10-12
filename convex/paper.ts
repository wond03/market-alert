// 纸面跟踪记录器（paper trading recorder）——只记录、不推送、不交易。
// 策略：15m 影线逆势（假突破反向） + 刺破≥0.2% + 剔除「与 1h 趋势同向」的逆势信号。
// 由 cron 定时扫描 Gate BTC/XAU 前时段 high/low，记录候选信号与假设成交的后续走势。
// 仅在设置 PAPER_TRACKING=1 的部署上运行（prod），避免 dev 重复记录。

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

// 策略参数（与回测 baseCfg / trend 过滤一致）
const SL = 0.005; // 止损 0.5%
const TP = 0.006; // 止盈 0.6%
const HOLD_H = 8; // 持有上限 8h
const PEN_MIN = 0.002; // 刺破 ≥ 0.2%
const TREND_BARS = 4; // 1h = 4 × 15m
const TREND_THR = 0.0015; // 1h 趋势 0.15%

// 成本口径（单边 bps），与回测一致
const MAKER_BPS = 2;
const TAKER_BPS = 5;
const SLIP_BPS = 2;
const TARGET_COST = (MAKER_BPS + MAKER_BPS) / 10000; // 止盈限价成交
const STOP_COST = (MAKER_BPS + TAKER_BPS + SLIP_BPS) / 10000; // 止损市价成交

// 资金费均值（每 8h），量级极小，仅作近似
const FUNDING_8H: Record<string, number> = { BTC: 0.000027, XAU: 0.000043 };

const CONFIGS: { symbol: string; field: "high" | "low"; dir: "up" | "down" }[] = [
  { symbol: "BTC", field: "high", dir: "up" },
  { symbol: "BTC", field: "low", dir: "down" },
  { symbol: "XAU", field: "high", dir: "up" },
  { symbol: "XAU", field: "low", dir: "down" },
];

type TradeInsert = {
  exchange: string;
  symbol: string;
  field: string;
  dir: string;
  tradeDir: string;
  sigTs: number;
  level: number;
  entryPrice: number;
  entryTs: number;
  pen: number;
  trend1h: number;
  vol24h: number;
  sl: number;
  tp: number;
  holdH: number;
  status: string;
  skipReason?: string;
  openedAt: number;
};

function vol24h(candles: gate.Candle[], i: number, win = 96): number {
  if (i < win) return 0;
  const rs: number[] = [];
  for (let k = i - win + 1; k <= i; k++) rs.push(Math.log(candles[k].c / candles[k - 1].c));
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  return Math.sqrt(rs.reduce((a, x) => a + (x - m) ** 2, 0) / rs.length);
}

function finalize(
  t: { tradeDir: string; entryPrice: number; holdH: number; symbol: string },
  reason: "stop" | "target" | "timeout",
  exitTs: number,
  exitPrice: number,
  gross: number,
): { exitTs: number; exitPrice: number; reason: string; gross: number; net: number } {
  const dir = t.tradeDir === "short" ? -1 : 1;
  const funding = (FUNDING_8H[t.symbol] ?? 0) * dir * (t.holdH / 8);
  const cost = reason === "target" ? TARGET_COST : STOP_COST;
  return { exitTs, exitPrice, reason, gross, net: gross - cost - funding };
}

// 与回测同一套保守口径：信号 K 线只判止损；其后逐根先判止损再判止盈；到期市价平。
function evaluate(
  candles: gate.Candle[],
  t: {
    tradeDir: string;
    entryPrice: number;
    sl: number;
    tp: number;
    sigTs: number;
    entryTs: number;
    holdH: number;
    symbol: string;
  },
  now: number,
): { exitTs: number; exitPrice: number; reason: string; gross: number; net: number } | null {
  const short = t.tradeDir === "short";
  const entry = t.entryPrice;
  const stop = short ? entry * (1 + t.sl) : entry * (1 - t.sl);
  const tgt = short ? entry * (1 - t.tp) : entry * (1 + t.tp);
  const endT = t.entryTs + t.holdH * 3600;
  let last: gate.Candle | null = null;
  for (const c of candles) {
    if (c.t < t.sigTs) continue;
    if (c.t > endT) break;
    const hitStop = short ? c.h >= stop : c.l <= stop;
    if (c.t === t.sigTs) {
      if (hitStop) return finalize(t, "stop", c.t, stop, -t.sl);
      continue;
    }
    last = c;
    const hitTgt = short ? c.l <= tgt : c.h >= tgt;
    if (hitStop) return finalize(t, "stop", c.t, stop, -t.sl);
    if (hitTgt) return finalize(t, "target", c.t, tgt, t.tp);
  }
  if (last && now >= endT) {
    const raw = short ? (entry - last.c) / entry : (last.c - entry) / entry;
    return finalize(t, "timeout", last.t, last.c, raw);
  }
  return null;
}

// 每 5 分钟运行：扫描新增 15m 影线信号并跟踪已开纸面单。
export const scan = internalAction({
  args: {},
  handler: async (ctx) => {
    if (env("PAPER_TRACKING") !== "1") return { skipped: true };

    const now = Math.floor(Date.now() / 1000);
    const cache = new Map<string, gate.Candle[]>();
    const candlesBySym = new Map<string, gate.Candle[]>();
    const get15 = async (symbol: string): Promise<gate.Candle[]> => {
      let c = candlesBySym.get(symbol);
      if (!c) {
        c = await exchanges.getCandles(
          EXCHANGE,
          exchanges.contractOf(EXCHANGE, symbol),
          gate.BREAK_INTERVAL,
        );
        candlesBySym.set(symbol, c);
      }
      return c;
    };

    let opened = 0;
    let skipped = 0;
    for (const cfg of CONFIGS) {
      const key = `${EXCHANGE}:${cfg.symbol}:${cfg.field}:${cfg.dir}`;
      const isUp = cfg.dir === "up";
      const rule: gate.RuleDoc = {
        _id: key,
        exchange: EXCHANGE,
        symbol: cfg.symbol,
        label: `${cfg.symbol} ${cfg.field}`,
        type: "breakout",
        indicator: "prev_session",
        field: cfg.field,
        dir: cfg.dir,
        enabled: true,
      };

      let level: number;
      try {
        level = (await gate.resolveLevel(rule, cache)).level;
      } catch (e) {
        console.error(`paper resolve ${key} failed: ${e}`);
        continue;
      }

      const candles = await get15(cfg.symbol);
      const closed = candles.filter((c) => c.t + gate.BREAK_SECONDS <= now);

      const st = await ctx.runQuery(internal.paper.getState, { key });
      const prevChecked = st?.checked;
      const sameLevel = st !== null && Math.abs(st.level - level) < 1e-9;

      const newRows =
        prevChecked === undefined ? closed : closed.filter((c) => c.t > prevChecked);

      let res: { events: gate.BreakEvent[]; side: gate.Side; wickDone: boolean };
      if (!sameLevel || prevChecked === undefined) {
        // 首次布防 / 关键位滚动：按最新收盘布防，不回扫历史。
        const last = closed.length ? closed[closed.length - 1] : undefined;
        const side: gate.Side = last
          ? last.c >= level
            ? "above"
            : "below"
          : (st?.side ?? "below");
        res = { events: [], side, wickDone: false };
      } else {
        res = gate.scanBreakout(newRows, level, isUp, st!.side, st!.wickDone);
      }

      const newest = closed.length ? closed[closed.length - 1].t : prevChecked;
      if (newest !== undefined && (prevChecked === undefined || newest > prevChecked)) {
        await ctx.runMutation(internal.paper.upsertState, {
          key,
          level,
          side: res.side,
          wickDone: res.wickDone,
          checked: newest,
        });
      }

      const trades: TradeInsert[] = [];
      for (const ev of res.events) {
        if (ev.kind !== "wick") continue; // 影线逆势策略只关注影线信号
        const sigIdx = candles.findIndex((c) => c.t === ev.ts);
        if (sigIdx < 0) continue;
        const sc = candles[sigIdx];
        const pen = isUp ? (sc.h - level) / level : (level - sc.l) / level;
        const trend1h =
          sigIdx >= TREND_BARS
            ? (candles[sigIdx].c - candles[sigIdx - TREND_BARS].c) /
              candles[sigIdx - TREND_BARS].c
            : 0;
        const v = vol24h(candles, sigIdx);
        const base: TradeInsert = {
          exchange: EXCHANGE,
          symbol: cfg.symbol,
          field: cfg.field,
          dir: cfg.dir,
          tradeDir: isUp ? "short" : "long",
          sigTs: ev.ts,
          level,
          entryPrice: level,
          entryTs: ev.ts,
          pen,
          trend1h,
          vol24h: v,
          sl: SL,
          tp: TP,
          holdH: HOLD_H,
          status: "open",
          openedAt: now,
        };
        const aligned = (isUp && trend1h > TREND_THR) || (!isUp && trend1h < -TREND_THR);
        if (pen < PEN_MIN) {
          trades.push({ ...base, status: "skipped", skipReason: "pen<0.2%" });
          skipped++;
        } else if (aligned) {
          trades.push({ ...base, status: "skipped", skipReason: "aligned_1h" });
          skipped++;
        } else {
          trades.push(base);
          opened++;
        }
      }
      if (trades.length) await ctx.runMutation(internal.paper.insertTrades, { trades });
    }

    const openTrades = await ctx.runQuery(internal.paper.openTrades, {});
    let closedN = 0;
    for (const t of openTrades) {
      let candles: gate.Candle[];
      try {
        candles = await get15(t.symbol);
      } catch (e) {
        console.error(`paper manage ${t.symbol} fetch failed: ${e}`);
        continue;
      }
      const out = evaluate(candles, t, now);
      if (out) {
        await ctx.runMutation(internal.paper.closeTrade, {
          id: t._id,
          ...out,
          closedAt: now,
        });
        closedN++;
      }
    }

    console.log(`paper scan: opened=${opened} skipped=${skipped} closed=${closedN} open=${openTrades.length - closedN}`);
    return { opened, skipped, closed: closedN };
  },
});

// ---- 内部读写 ----

export const getState = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) =>
    ctx.db
      .query("paperState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
});

export const upsertState = internalMutation({
  args: {
    key: v.string(),
    level: v.number(),
    side: v.union(v.literal("above"), v.literal("below")),
    wickDone: v.boolean(),
    checked: v.number(),
  },
  handler: async (ctx, { key, level, side, wickDone, checked }) => {
    const existing = await ctx.db
      .query("paperState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { level, side, wickDone, checked });
    else await ctx.db.insert("paperState", { key, level, side, wickDone, checked });
  },
});

const tradeValidator = v.object({
  exchange: v.string(),
  symbol: v.string(),
  field: v.string(),
  dir: v.string(),
  tradeDir: v.string(),
  sigTs: v.number(),
  level: v.number(),
  entryPrice: v.number(),
  entryTs: v.number(),
  pen: v.number(),
  trend1h: v.number(),
  vol24h: v.number(),
  sl: v.number(),
  tp: v.number(),
  holdH: v.number(),
  status: v.string(),
  skipReason: v.optional(v.string()),
  openedAt: v.number(),
});

export const insertTrades = internalMutation({
  args: { trades: v.array(tradeValidator) },
  handler: async (ctx, { trades }) => {
    for (const t of trades) await ctx.db.insert("paperTrades", t);
  },
});

export const openTrades = internalQuery({
  args: {},
  handler: async (ctx) =>
    ctx.db
      .query("paperTrades")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect(),
});

export const closeTrade = internalMutation({
  args: {
    id: v.id("paperTrades"),
    exitTs: v.number(),
    exitPrice: v.number(),
    reason: v.string(),
    gross: v.number(),
    net: v.number(),
    closedAt: v.number(),
  },
  handler: async (ctx, { id, ...rest }) => {
    await ctx.db.patch(id, { status: "closed", ...rest });
  },
});

// ---- 公开查询（看盘/排查用，只读） ----

export const recentPaperTrades = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) =>
    ctx.db
      .query("paperTrades")
      .withIndex("by_entryTs")
      .order("desc")
      .take(limit ?? 50),
});

export const paperSummary = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("paperTrades").collect();
    const closed = all.filter((t) => t.status === "closed" && t.net !== undefined);
    const opens = all.filter((t) => t.status === "open");
    const skippeds = all.filter((t) => t.status === "skipped");
    const nets = closed.map((t) => t.net as number);
    const sum = nets.reduce((a, b) => a + b, 0);
    const n = nets.length;
    const mean = n ? sum / n : 0;
    const sd = n > 1 ? Math.sqrt(nets.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
    return {
      total: all.length,
      open: opens.length,
      skipped: skippeds.length,
      closed: n,
      netMean: mean,
      netSum: sum,
      win: n ? nets.filter((x) => x > 0).length / n : 0,
      t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    };
  },
});
