// SMC 入场信号 —— 价格进入合格入区且出现低周期 5m 同向确认时推送 Telegram（只提示，不交易）。
// 口径见 ./battleCore（纯逻辑，与看盘页「猎场信号面板」/ ./luxSmc 同一套判定）。
//
// 仅在设置 BATTLE=1 的部署上运行（prod）。

import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import * as exchanges from "./exchanges";
import type { Candle, Exchange } from "./exchanges";
import { buildMessage, evaluateBattle, HTF, MTF, LTF, resolveSignal } from "./battleCore";
import { sendTelegram } from "./telegram";

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  const value = proc?.env?.[name];
  return value ? String(value).trim() : "";
}

// 由入场/止损/止盈反推盈亏比。
function rrOf(
  entry: number | null,
  stop: number | null,
  target: number | null,
): number | null {
  if (entry == null || stop == null || target == null) return null;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  return Math.abs(target - entry) / risk;
}

const EXCHANGE: Exchange = "gate";
const SYMBOLS = ["BTC", "XAU"];
// 对齐 backtest/battle6m.ts 的 FWD_BARS：持有满 288 根 5m 未触及止损/止盈即按 time 了结。
const TIMEOUT_BARS = 288;

export const scan = internalAction({
  args: {},
  handler: async (ctx) => {
    if (env("BATTLE") !== "1") return { skipped: true };

    const now = Math.floor(Date.now() / 1000);
    let fired = 0;

    for (const symbol of SYMBOLS) {
      const key = `${EXCHANGE}:${symbol}`;
      const contract = exchanges.contractOf(EXCHANGE, symbol);

      let htf: Candle[];
      let mtf: Candle[];
      let ltf: Candle[];
      try {
        htf = (await exchanges.getCandles(EXCHANGE, contract, HTF.tf, 300)).filter(
          (c) => c.t + HTF.sec <= now,
        );
        mtf = (await exchanges.getCandles(EXCHANGE, contract, MTF.tf, 300)).filter(
          (c) => c.t + MTF.sec <= now,
        );
        ltf = (await exchanges.getCandles(EXCHANGE, contract, LTF.tf, 300)).filter(
          (c) => c.t + LTF.sec <= now,
        );
      } catch (e) {
        console.error(`battle fetch ${key} failed: ${e}`);
        continue;
      }
      if (htf.length < 60 || mtf.length < 60 || ltf.length < 30) continue;

      const state = await ctx.runQuery(internal.battle.getState, { key });

      // 未了结信号（用于了结记录：扫止损 / 到止盈）。
      let openDir = state?.openDir ?? null;
      let openEntry = state?.openEntry ?? null;
      let openStop = state?.openStop ?? null;
      let openTarget = state?.openTarget ?? null;
      let openTs = state?.openTs ?? null;
      let openSignalId = state?.openSignalId ?? null;

      // 了结检查：影线触及止损或止盈 → 写入记录并解除。
      if (openTs != null && openDir) {
        const r = resolveSignal(ltf, openTs, openDir, openStop, openTarget);
        if (r) {
          await ctx.runMutation(internal.battle.insertOutcome, {
            exchange: EXCHANGE,
            symbol,
            bias: openDir,
            entryPrice: openEntry ?? openStop ?? r.price,
            stopPrice: openStop ?? r.price,
            targetPrice: openTarget,
            rr: rrOf(openEntry, openStop, openTarget),
            openedTs: openTs,
            closedTs: r.ts,
            result: r.result,
            exitPrice: r.price,
            createdAt: now,
          });
          // 把了结结果回填到对应的信号记录（「最近信号」列表可直接显示结果）。
          if (openSignalId != null) {
            await ctx.runMutation(internal.battle.closeSignal, {
              id: openSignalId,
              result: r.result,
              exitPrice: r.price,
              closedTs: r.ts,
            });
          }
          openDir = null;
          openEntry = null;
          openStop = null;
          openTarget = null;
          openTs = null;
          openSignalId = null;
        } else {
          const cutT = openTs + TIMEOUT_BARS * LTF.sec;
          const last = ltf[ltf.length - 1];
          if (last && last.t >= cutT) {
            const cutBar = ltf.find((c) => c.t === cutT) ?? last;
            await ctx.runMutation(internal.battle.insertOutcome, {
              exchange: EXCHANGE,
              symbol,
              bias: openDir,
              entryPrice: openEntry ?? openStop ?? cutBar.c,
              stopPrice: openStop ?? cutBar.c,
              targetPrice: openTarget,
              rr: rrOf(openEntry, openStop, openTarget),
              openedTs: openTs,
              closedTs: cutBar.t,
              result: "time",
              exitPrice: cutBar.c,
              createdAt: now,
            });
            if (openSignalId != null) {
              await ctx.runMutation(internal.battle.closeSignal, {
                id: openSignalId,
                result: "time",
                exitPrice: cutBar.c,
                closedTs: cutBar.t,
              });
            }
            openDir = null;
            openEntry = null;
            openStop = null;
            openTarget = null;
            openTs = null;
            openSignalId = null;
          }
        }
      }

const prev = {
  firedZone: state?.firedZone ?? "",
  zoneKey: state?.zoneKey ?? "",
  zoneStartT: state?.zoneStartT ?? null,
};
 const res = evaluateBattle(htf, mtf, ltf, prev, now, EXCHANGE, symbol, {
  zoneInvalidateMtf: true,
  confirm5m: true,
 });

 // 漏斗：活动区域推进到哪一层，落库（每层只记一次）。
 if (res.funnel) {
 await ctx.runMutation(internal.battle.recordFunnel, {
 key,
 exchange: EXCHANGE,
 symbol,
 zoneKey: res.funnel.zoneKey,
 zoneStartT: res.funnel.zoneStartT,
 c1T: res.funnel.c1T,
 c2T: res.funnel.c2T,
 confirmed: res.funnel.confirmed,
 now,
 });
 }
 // 上一个跟踪区域未经确认就离场 / 失效 → 记为失效层。
 if (prev.zoneKey && prev.zoneKey !== res.zoneKey) {
 await ctx.runMutation(internal.battle.recordFunnel, {
 key,
 exchange: EXCHANGE,
 symbol,
 zoneKey: prev.zoneKey,
 zoneStartT: prev.zoneStartT ?? now,
 c1T: null,
 c2T: null,
 confirmed: false,
 invalid: true,
 now,
 });
 }

 let firedZone = res.firedZone;
      if (res.signal) {
        // 上一笔未了结信号仍在（新信号到来）→ 记为「被取代」。
        if (openTs != null && openDir) {
          await ctx.runMutation(internal.battle.insertOutcome, {
            exchange: EXCHANGE,
            symbol,
            bias: openDir,
            entryPrice: openEntry ?? openStop ?? ltf[ltf.length - 1].c,
            stopPrice: openStop ?? ltf[ltf.length - 1].c,
            targetPrice: openTarget,
            rr: rrOf(openEntry, openStop, openTarget),
            openedTs: openTs,
            closedTs: now,
            result: "cancel",
            exitPrice: ltf[ltf.length - 1].c,
            createdAt: now,
          });
          if (openSignalId != null) {
            await ctx.runMutation(internal.battle.closeSignal, {
              id: openSignalId,
              result: "cancel",
              exitPrice: ltf[ltf.length - 1].c,
              closedTs: now,
            });
          }
        }
        openDir = res.signal.bias;
        openEntry = res.signal.entryPrice;
        openStop = res.signal.stopPrice;
        openTarget = res.signal.targetPrice;
        openTs = now;
        const ids = await ctx.runMutation(internal.battle.insertSignals, {
          signals: [{ exchange: EXCHANGE, symbol, createdAt: now, ...res.signal }],
        });
        openSignalId = ids.length ? ids[0] : null;
        if (ids.length) {
          await ctx.scheduler.runAfter(0, internal.weex.placeSignalOrder, {
            signalId: String(ids[0]),
            symbol,
            bias: res.signal.bias,
            entry: res.signal.entryPrice,
            stop: res.signal.stopPrice,
            target: res.signal.targetPrice ?? undefined,
          });
        }
        let pushFail: string | null = null;
        try {
          pushFail = await sendTelegram(res.signal.text);
        } catch (e) {
          pushFail = `exception: ${String(e)}`.slice(0, 160);
        }
        if (pushFail) {
          await ctx.runMutation(internal.battle.recordPushFailure, {
            symbol,
            ts: Date.now(),
            reason: pushFail,
          });
        }
        fired++;
      }

await ctx.runMutation(internal.battle.upsertState, {
  key,
  firedZone,
  zoneKey: res.zoneKey,
  zoneStartT: res.zoneStartT,
  openDir,
        openEntry,
        openStop,
        openTarget,
        openTs,
        openSignalId,
        updatedAt: now,
      });
    }

    console.log(`battle scan: fired=${fired}`);
    return { fired };
  },
});


// ---- 内部读写 ----

export const getState = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) =>
    ctx.db
      .query("battleState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
});

export const upsertState = internalMutation({
  args: {
    key: v.string(),
    firedZone: v.string(),
    zoneKey: v.string(),
    zoneStartT: v.union(v.number(), v.null()),
    openDir: v.union(v.string(), v.null()),
    openEntry: v.union(v.number(), v.null()),
    openStop: v.union(v.number(), v.null()),
    openTarget: v.union(v.number(), v.null()),
    openTs: v.union(v.number(), v.null()),
    openSignalId: v.union(v.id("battleSignals"), v.null()),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("battleState")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing) await ctx.db.patch(existing._id, args);
    else await ctx.db.insert("battleState", args);
  },
});

const signalValidator = v.object({
  exchange: v.string(),
  symbol: v.string(),
  bias: v.string(),
  bg: v.string(),
  htfTag: v.string(),
  htfLevel: v.number(),
  zoneKind: v.string(),
  zoneTop: v.number(),
  zoneBottom: v.number(),
  confirm: v.string(),
  confirmInternal: v.string(),
  entryPrice: v.number(),
  stopPrice: v.number(),
  targetPrice: v.union(v.number(), v.null()),
  rr: v.union(v.number(), v.null()),
  sweep: v.boolean(),
  sweepLevel: v.union(v.number(), v.null()),
  sigTs: v.number(),
  text: v.string(),
  createdAt: v.number(),
});

export const insertSignals = internalMutation({
  args: { signals: v.array(signalValidator) },
  handler: async (ctx, { signals }) => {
    const ids = [];
    for (const s of signals) ids.push(await ctx.db.insert("battleSignals", s));
    return ids;
  },
});

export const recordPushFailure = internalMutation({
  args: {
    symbol: v.string(),
    ts: v.number(),
    reason: v.string(),
    synthetic: v.optional(v.boolean()),
  },
  handler: async (ctx, { symbol, ts, reason, synthetic }) => {
    await ctx.db.insert("battlePushFailures", {
      symbol,
      ts,
      reason,
      synthetic: synthetic ?? false,
    });
  },
});

function monthKeyUtc(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type PushFailureStat = { month: string; failures: number; signals: number };

// 推送失败按月汇总；发送数取 battleSignals 数（每次信号一条告警）。
export const pushFailureStats = internalQuery({
  args: { since: v.number(), includeSynthetic: v.optional(v.boolean()) },
  handler: async (ctx, { since, includeSynthetic }): Promise<PushFailureStat[]> => {
    const fails = await ctx.db
      .query("battlePushFailures")
      .withIndex("by_ts", (q) => q.gte("ts", since))
      .collect();
    const signals = await ctx.db
      .query("battleSignals")
      .withIndex("by_sigTs", (q) => q.gte("sigTs", Math.floor(since / 1000)))
      .collect();
    const byMonth = new Map<string, { month: string; failures: number; signals: number }>();
    const rowOf = (k: string) => {
      const row = byMonth.get(k) ?? { month: k, failures: 0, signals: 0 };
      byMonth.set(k, row);
      return row;
    };
    for (const f of fails) {
      if (!includeSynthetic && f.synthetic) continue;
      rowOf(monthKeyUtc(f.ts)).failures++;
    }
    for (const s of signals) rowOf(monthKeyUtc(s.sigTs * 1000)).signals++;
    return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  },
});

// 每周审计：命中阈值才推一条监控消息；暂停与否仍人工决策。
export const auditPushFailures = internalAction({
  args: { includeSynthetic: v.optional(v.boolean()) },
  handler: async (ctx, { includeSynthetic }): Promise<{ breach: boolean; month: PushFailureStat; week: { failures: number; signals: number } }> => {
    const now = Date.now();
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const weekStart = now - 7 * 86400_000;
    const monthRows = await ctx.runQuery(internal.battle.pushFailureStats, {
      since: monthStart,
      includeSynthetic,
    });
    const weekRows = await ctx.runQuery(internal.battle.pushFailureStats, {
      since: weekStart,
      includeSynthetic,
    });
    const month = monthRows.find((r) => r.month === monthKeyUtc(now)) ?? {
      month: monthKeyUtc(now),
      failures: 0,
      signals: 0,
    };
    const week = weekRows.reduce<{ failures: number; signals: number }>(
      (a, r) => ({ failures: a.failures + r.failures, signals: a.signals + r.signals }),
      { failures: 0, signals: 0 },
    );
    const monthRate = month.signals > 0 ? month.failures / month.signals : 0;
    const breach = monthRate > 0.05 || week.failures >= 2;
    if (!breach) return { breach: false, month, week };
    const text =
      "<b>[监控] 猎场推送失败率</b>\n" +
      `本月 ${month.failures}/${month.signals}（${(monthRate * 100).toFixed(1)}%）\n` +
      `近 7 天 ${week.failures}/${week.signals}\n` +
      "暂停计入窗口的决策仍需人工。";
    const fail = await sendTelegram(text);
    if (fail) console.warn(`push failure audit notify failed: ${fail}`);
    return { breach: true, month, week };
  },
});

// 了结结果回填到信号记录（扫止损 / 到止盈 / 被取代）。
export const closeSignal = internalMutation({
  args: {
    id: v.id("battleSignals"),
    result: v.string(),
    exitPrice: v.number(),
    closedTs: v.number(),
  },
  handler: async (ctx, { id, result, exitPrice, closedTs }) => {
    await ctx.db.patch(id, { result, exitPrice, closedTs });
  },
});

export const insertOutcome = internalMutation({
  args: {
    exchange: v.string(),
    symbol: v.string(),
    bias: v.string(),
    entryPrice: v.number(),
    stopPrice: v.number(),
    targetPrice: v.union(v.number(), v.null()),
    rr: v.union(v.number(), v.null()),
    openedTs: v.number(),
    closedTs: v.number(),
    result: v.string(),
    exitPrice: v.number(),
    createdAt: v.number(),
  },
 handler: async (ctx, args) => {
 await ctx.db.insert("battleOutcomes", args);
 },
});

// 漏斗：按区域指纹 upsert，只补齐缺失的层级时间戳，不覆盖已记录层级。
export const recordFunnel = internalMutation({
 args: {
 key: v.string(),
 exchange: v.string(),
 symbol: v.string(),
 zoneKey: v.string(),
 zoneStartT: v.number(),
 c1T: v.union(v.number(), v.null()),
 c2T: v.union(v.number(), v.null()),
 confirmed: v.boolean(),
 invalid: v.optional(v.boolean()),
 now: v.number(),
 },
 handler: async (ctx, a) => {
 const fp = `${a.key}|${a.zoneKey}`;
 const existing = await ctx.db
 .query("battleFunnel")
 .withIndex("by_fp", (q) => q.eq("fp", fp))
 .unique();
 if (!existing) {
 await ctx.db.insert("battleFunnel", {
 key: a.key,
 exchange: a.exchange,
 symbol: a.symbol,
 zoneKey: a.zoneKey,
 fp,
 zoneStartT: a.zoneStartT,
 enteredTs: a.now,
 c1Ts: a.c1T ?? null,
 c2Ts: a.c2T ?? null,
 confirmedTs: a.confirmed ? a.now : null,
 invalidTs: a.invalid ? a.now : null,
 updatedAt: a.now,
 });
 return;
 }
 const patch: {
 updatedAt: number;
 c1Ts?: number | null;
 c2Ts?: number | null;
 confirmedTs?: number | null;
 invalidTs?: number | null;
 } = { updatedAt: a.now };
 if (existing.c1Ts == null && a.c1T != null) patch.c1Ts = a.c1T;
 if (existing.c2Ts == null && a.c2T != null) patch.c2Ts = a.c2T;
 if (existing.confirmedTs == null && a.confirmed) patch.confirmedTs = a.now;
 if (
 a.invalid &&
 existing.confirmedTs == null &&
 existing.invalidTs == null
 )
 patch.invalidTs = a.now;
 await ctx.db.patch(existing._id, patch);
 },
});

// ---- 公开查询（只读） ----

export const recentBattleSignals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) =>
    ctx.db
      .query("battleSignals")
      .withIndex("by_sigTs")
      .order("desc")
      .take(limit ?? 50),
});

// 信号了结记录（扫止损 / 到止盈 / 被取代），用于复盘每笔的止盈止损结果。
export const recentBattleOutcomes = query({
 args: { limit: v.optional(v.number()) },
 handler: async (ctx, { limit }) =>
 ctx.db
 .query("battleOutcomes")
 .withIndex("by_closedTs")
 .order("desc")
 .take(limit ?? 100),
});

// ---- 报表 ----
// 见 ./report.ts（跨信号系统的周报）。

