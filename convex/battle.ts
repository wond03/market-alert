// SMC 作战面板信号 —— 低周期确认入场时推送 Telegram（只提示，不交易）。
// 口径见 ./battleCore（纯逻辑，与看盘页「作战面板」/ ./luxSmc 同一套判定）。
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
import { buildMessage, evaluateBattle, HTF, MTF, LTF } from "./battleCore";
import { sendTelegram } from "./alerts";

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  const value = proc?.env?.[name];
  return value ? String(value).trim() : "";
}

const EXCHANGE: Exchange = "gate";
const SYMBOLS = ["BTC", "XAU"];

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
      const res = evaluateBattle(
        htf,
        mtf,
        ltf,
        state?.firedZone ?? "",
        now,
        EXCHANGE,
        symbol,
      );

      await ctx.runMutation(internal.battle.upsertState, {
        key,
        firedZone: res.firedZone,
        updatedAt: now,
      });

      if (res.signal) {
        await ctx.runMutation(internal.battle.insertSignals, {
          signals: [{ exchange: EXCHANGE, symbol, createdAt: now, ...res.signal }],
        });
        await sendTelegram(res.signal.text);
        fired++;
      }
    }

    console.log(`battle scan: fired=${fired}`);
    return { fired };
  },
});

// 手动发送一条样例信号（仅用于预览 TG 排版，不代表实时行情）。
export const sendSample = internalAction({
  args: {},
  handler: async () => {
    const now = Math.floor(Date.now() / 1000);
    const text =
      "【样例 · 非实时信号】\n\n" +
      buildMessage(
        "gate",
        "BTC",
        "bear",
        "CHoCH",
        82236.7,
        { kind: "OB", bias: "bear", top: 83400, bottom: 83250, idx: 0, t: now },
        "Pin Bar",
        83250,
        83420,
        0.00204,
        81500,
        1.59,
        true,
        83499.6,
        now,
      );
    await sendTelegram(text);
    return { sent: true };
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
  htfTag: v.string(),
  htfLevel: v.number(),
  zoneKind: v.string(),
  zoneTop: v.number(),
  zoneBottom: v.number(),
  confirm: v.string(),
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
    for (const s of signals) await ctx.db.insert("battleSignals", s);
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
