// MTF（多周期）SMC 入场信号 —— 记录 + 推送，不交易。
//
// 判定用 LuxAlgo 开源定义（见 ./luxSmc，与看盘指标、回测同一套代码）：
//  - 1h 用摆动结构（size=4）找 BOS/CHoCH；最近一次 1h 突破决定「武装方向」，
//    直到出现新的 1h 突破（同向刷新、反向作废）才更新。
//  - 5m 与 15m 同时监控，任一出现与 1h 同向的 BOS/CHoCH（收盘确认）即触发。
//  - 每个 1h 结构窗口最多触发一次（首个同向小周期确认）；1h 出现新的突破后重新放行。
//  - 触发即入库 + Telegram 推送。
//
// 仅在设置 MTF_SMC=1 的部署上运行（prod）。

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
import { runStructure, type StructBreak } from "./luxSmc";
import { sendTelegram } from "./alerts";

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  const value = proc?.env?.[name];
  return value ? String(value).trim() : "";
}

const EXCHANGE: Exchange = "gate";
const SYMBOLS = ["BTC", "XAU"];
const MTF_SWING = 4; // 摆动结构长度
const SEC_1H = 3600;
const SEC_5M = 300;
const SEC_15M = 900;

type SignalRow = {
  exchange: string;
  symbol: string;
  tf: string; // 触发的小周期：5m | 15m
  armedDir: string; // 1h 方向：bull | bear
  armedTag: string; // 1h 突破类型：BOS | CHoCH
  armedLevel: number; // 1h 被突破的关键位
  armedTs: number; // 1h 突破 K 线时间
  tag: string; // 小周期突破类型：BOS | CHoCH
  level: number; // 小周期被突破的关键位
  entryPrice: number;
  sigTs: number; // 小周期突破 K 线时间
  bias: string; // long | short
  text: string; // 推送文案
  createdAt: number;
};

function buildMessage(
  symbol: string,
  tf: string,
  dir: string,
  tag: string,
  level: number,
  armedTag: string,
  armedLevel: number,
  armedTs: number,
  entryPrice: number,
  sigTs: number,
): string {
  const dirCn = dir === "bull" ? "看涨" : "看跌";
  const tfSec = tf === "15m" ? SEC_15M : SEC_5M;
  const sess = (ts: number, dur: number) =>
    gate.currentSessionName(ts + dur) ?? "时段间隙";
  return (
    `MTF SMC 入场信号\n\n` +
    `<b>${gate.EXCHANGE_NAME[EXCHANGE]} ${symbol}/USDT</b>\n` +
    `1h ${armedTag} ${dirCn}（关键位 ${gate.fmtPrice(armedLevel)}）\n` +
    `${tf} 同向 ${tag} 确认（关键位 ${gate.fmtPrice(level)}）\n` +
    `入场价：${gate.fmtPrice(entryPrice)}（${tf} 收盘）\n` +
    `1h 结构：${gate.fmtBeijing(armedTs)} 北京时间（${sess(armedTs, SEC_1H)}）\n` +
    `确认时间：${gate.fmtBeijing(sigTs)} 北京时间（${sess(sigTs, tfSec)}）\n\n` +
    `<a href="${gate.DASHBOARD_URL}">打开看盘页</a>`
  );
}

export const scan = internalAction({
  args: {},
  handler: async (ctx) => {
    if (env("MTF_SMC") !== "1") return { skipped: true };

    const now = Math.floor(Date.now() / 1000);
    let fired = 0;

    for (const symbol of SYMBOLS) {
      const key = `${EXCHANGE}:${symbol}`;
      const contract = exchanges.contractOf(EXCHANGE, symbol);

      let c1h: gate.Candle[];
      let c5: gate.Candle[];
      let c15: gate.Candle[];
      try {
        c1h = (
          await exchanges.getCandles(EXCHANGE, contract, "1h", 300)
        ).filter((c) => c.t + SEC_1H <= now);
        c5 = (
          await exchanges.getCandles(EXCHANGE, contract, "5m", 300)
        ).filter((c) => c.t + SEC_5M <= now);
        c15 = (
          await exchanges.getCandles(EXCHANGE, contract, "15m", 300)
        ).filter((c) => c.t + SEC_15M <= now);
      } catch (e) {
        console.error(`mtf fetch ${key} failed: ${e}`);
        continue;
      }
      if (
        c1h.length < MTF_SWING + 5 ||
        c5.length < MTF_SWING + 5 ||
        c15.length < MTF_SWING + 5
      ) {
        continue;
      }

      const st1h = runStructure(c1h, MTF_SWING);
      const st5 = runStructure(c5, MTF_SWING);
      const st15 = runStructure(c15, MTF_SWING);

      const state = await ctx.runQuery(internal.mtfSmc.getState, { key });
      const newest1h = c1h[c1h.length - 1].t;
      const newest5 = c5[c5.length - 1].t;
      const newest15 = c15[c15.length - 1].t;

      // ---- 1h 武装方向 ----
      let armedDir = state?.armedDir;
      let armedTag = state?.armedTag;
      let armedLevel = state?.armedLevel;
      let armedTs = state?.armedTs;
      let armedFired = state?.fired ?? false;

      if (state?.last1hT === undefined) {
        // 首轮：只按最新一次 1h 突破布防，不回扫历史、不推送。
        const last = st1h.breaks.length
          ? st1h.breaks[st1h.breaks.length - 1]
          : undefined;
        if (last) {
          armedDir = last.dir;
          armedTag = last.tag;
          armedLevel = last.level;
          armedTs = last.t;
        }
        armedFired = false;
      } else {
        const new1h = st1h.breaks.filter((b) => b.t > (state.last1hT as number));
        for (const b of new1h) {
          armedDir = b.dir;
          armedTag = b.tag;
          armedLevel = b.level;
          armedTs = b.t;
          armedFired = false; // 新的 1h 结构窗口
        }
      }

      // ---- 小周期同向确认（5m + 15m，按时间先后，窗口内只触发一次）----
      const events: SignalRow[] = [];
      if (
        armedDir &&
        state?.last5mT !== undefined &&
        state?.last15mT !== undefined
      ) {
        const pick = (
          breaks: StructBreak[],
          tf: string,
          lastT: number,
        ): { tf: string; closed: gate.Candle[]; b: StructBreak }[] =>
          breaks
            .filter((b) => b.t > lastT)
            .map((b) => ({ tf, closed: tf === "5m" ? c5 : c15, b }));
        const merged = [
          ...pick(st5.breaks, "5m", state.last5mT),
          ...pick(st15.breaks, "15m", state.last15mT),
        ].sort((a, b) => a.b.t - b.b.t);

        for (const e of merged) {
          if (armedFired) break;
          if (e.b.dir !== armedDir) continue;
          const bar = e.closed.find((c) => c.t === e.b.t);
          const entryPrice = bar ? bar.c : e.b.level;
          const bias = e.b.dir === "bull" ? "long" : "short";
          events.push({
            exchange: EXCHANGE,
            symbol,
            tf: e.tf,
            armedDir,
            armedTag: armedTag ?? "",
            armedLevel: armedLevel ?? e.b.level,
            armedTs: armedTs ?? e.b.t,
            tag: e.b.tag,
            level: e.b.level,
            entryPrice,
            sigTs: e.b.t,
            bias,
            text: buildMessage(
              symbol,
              e.tf,
              e.b.dir,
              e.b.tag,
              e.b.level,
              armedTag ?? "",
              armedLevel ?? e.b.level,
              armedTs ?? e.b.t,
              entryPrice,
              e.b.t,
            ),
            createdAt: now,
          });
          armedFired = true;
        }
      }

      await ctx.runMutation(internal.mtfSmc.upsertState, {
        key,
        last1hT: newest1h,
        last5mT: newest5,
        last15mT: newest15,
        armedDir,
        armedTag,
        armedLevel,
        armedTs,
        fired: armedFired,
        updatedAt: now,
      });

      if (events.length) {
        await ctx.runMutation(internal.mtfSmc.insertSignals, {
          signals: events,
        });
        for (const s of events) {
          await sendTelegram(s.text);
          fired++;
        }
      }
    }

    console.log(`mtf scan: fired=${fired}`);
    return { fired };
  },
});

// ---- 内部读写 ----

export const getState = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) =>
    ctx.db
      .query("mtfSmcState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
});

export const upsertState = internalMutation({
  args: {
    key: v.string(),
    last1hT: v.number(),
    last5mT: v.number(),
    last15mT: v.number(),
    armedDir: v.optional(v.string()),
    armedTag: v.optional(v.string()),
    armedLevel: v.optional(v.number()),
    armedTs: v.optional(v.number()),
    fired: v.boolean(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mtfSmcState")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing) await ctx.db.patch(existing._id, args);
    else await ctx.db.insert("mtfSmcState", args);
  },
});

const signalValidator = v.object({
  exchange: v.string(),
  symbol: v.string(),
  tf: v.string(),
  armedDir: v.string(),
  armedTag: v.string(),
  armedLevel: v.number(),
  armedTs: v.number(),
  tag: v.string(),
  level: v.number(),
  entryPrice: v.number(),
  sigTs: v.number(),
  bias: v.string(),
  text: v.string(),
  createdAt: v.number(),
});

export const insertSignals = internalMutation({
  args: { signals: v.array(signalValidator) },
  handler: async (ctx, { signals }) => {
    for (const s of signals) await ctx.db.insert("mtfSmcSignals", s);
  },
});

// ---- 公开查询（只读） ----

export const recentMtfSignals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) =>
    ctx.db
      .query("mtfSmcSignals")
      .withIndex("by_sigTs")
      .order("desc")
      .take(limit ?? 50),
});
