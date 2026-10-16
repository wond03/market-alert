// SMC 入场信号 —— 价格进入合格入区且出现低周期 5m 同向确认时推送 Telegram（只提示，不交易）。
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

// 信号了结判定：按时间顺序逐根，先触及止损（收盘穿过）或止盈（影线触及）者即判定了结。
type Resolution = { result: "stop" | "target"; ts: number; price: number };

function resolveSignal(
  ltf: Candle[],
  fromTs: number,
  dir: string,
  stop: number | null,
  target: number | null,
): Resolution | null {
  for (const c of ltf) {
    if (c.t < fromTs) continue;
    if (dir === "short") {
      if (stop != null && c.c >= stop) return { result: "stop", ts: c.t, price: stop };
      if (target != null && c.l <= target) return { result: "target", ts: c.t, price: target };
    } else {
      if (stop != null && c.c <= stop) return { result: "stop", ts: c.t, price: stop };
      if (target != null && c.h >= target) return { result: "target", ts: c.t, price: target };
    }
  }
  return null;
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

      // 了结检查：收盘穿过止损或触及止盈 → 写入记录并解除。
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
        }
      }

const prev = {
  firedZone: state?.firedZone ?? "",
  zoneKey: state?.zoneKey ?? "",
  zoneStartT: state?.zoneStartT ?? null,
};
const res = evaluateBattle(htf, mtf, ltf, prev, now, EXCHANGE, symbol);

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
        await sendTelegram(res.signal.text);
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
        "bear",
        "BOS",
        84100,
        "CHoCH",
        82236.7,
        { kind: "OB", bias: "bear", top: 83400, bottom: 83250, idx: 0, t: now },
        "Pin Bar",
        "CHoCH",
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

// ---- 周报（近 7 天） ----

type ReportRow = {
  symbol: string;
  bias: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number | null;
  rr: number | null;
  sigTs: number;
  result: string | null;
  closedTs: number | null;
  confirm: string;
  zoneKind: string;
};

// 北京时间字符串（Convex 运行时按 UTC，加 8h 后取 UTC 分量即北京墙上时间）。
function bjTime(ts: number): string {
  const d = new Date((ts + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 单笔已了结信号的风险单位收益：止盈=rr（或按价位折算），止损=-1，未了结=null。
function rOf(s: ReportRow): number | null {
  if (s.result === "stop") return -1;
  if (s.result === "target") {
    if (s.rr != null) return s.rr;
    const risk = Math.abs(s.entryPrice - s.stopPrice);
    if (s.targetPrice != null && risk > 0) return (s.targetPrice - s.entryPrice) / risk;
  }
  return null;
}

function priceFmt(x: number): string {
  return x >= 100 ? x.toFixed(1) : x.toFixed(4);
}

// 报表数据：指定时间之后触发的全部作战面板信号（含了结回填结果）。
export const reportData = internalQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }): Promise<ReportRow[]> => {
    const rows = await ctx.db
      .query("battleSignals")
      .withIndex("by_sigTs", (q) => q.gte("sigTs", since))
      .collect();
    return rows.map((r) => ({
      symbol: r.symbol,
      bias: r.bias,
      entryPrice: r.entryPrice,
      stopPrice: r.stopPrice,
      targetPrice: r.targetPrice,
      rr: r.rr,
      sigTs: r.sigTs,
      result: r.result ?? null,
      closedTs: r.closedTs ?? null,
      confirm: r.confirm,
      zoneKind: r.zoneKind,
    }));
  },
});

// 近 7 天周报 → Telegram。仅 BATTLE=1 的部署（prod）执行，避免 dev/prod 双推。
export const weeklyBattleReport = internalAction({
  args: {},
  handler: async (ctx): Promise<{ skipped?: boolean; sent?: boolean; count?: number }> => {
    if (env("BATTLE") !== "1") return { skipped: true };
    const now = Math.floor(Date.now() / 1000);
    const since = now - 7 * 86400;
    const rows = ((await ctx.runQuery(internal.battle.reportData, { since })) as ReportRow[]).sort(
      (a, b) => a.sigTs - b.sigTs,
    );

    const closed = rows.filter((r) => r.result === "stop" || r.result === "target");
    const openN = rows.length - closed.length;
    const wins = closed.filter((r) => r.result === "target");
    const losses = closed.filter((r) => r.result === "stop");
    const sumR = closed.reduce((a, r) => a + (rOf(r) ?? 0), 0);
    const winRate = closed.length ? Math.round((wins.length / closed.length) * 100) : NaN;
    const dirCn = (b: string) => (b === "long" ? "多" : "空");

    const stat = (rs: ReportRow[]) => {
      const c = rs.filter((r) => r.result === "stop" || r.result === "target");
      const w = c.filter((r) => r.result === "target").length;
      const l = c.filter((r) => r.result === "stop").length;
      const sr = c.reduce((a, r) => a + (rOf(r) ?? 0), 0);
      return { n: rs.length, c: c.length, w, l, sr, pct: c.length ? Math.round((w / c.length) * 100) : 0 };
    };

    const lines: string[] = [];
    lines.push("<b>作战面板 · 周报（近 7 天）</b>");
    lines.push(`区间：${bjTime(since)} ~ ${bjTime(now)}（北京）`);
    lines.push("");
    lines.push("<b>汇总</b>");
    lines.push(`信号 ${rows.length} 条（已了结 ${closed.length} / 未平仓 ${openN}）`);
    lines.push(`胜/负：${wins.length} / ${losses.length}（胜率 ${Number.isNaN(winRate) ? "-" : winRate + "%"}）`);
    lines.push(`累计 R：${sumR.toFixed(2)}`);
    lines.push("");
    lines.push("<b>分标的</b>");
    for (const sym of SYMBOLS) {
      const s = stat(rows.filter((r) => r.symbol === sym));
      lines.push(`${sym}：${s.n} 条  ${s.w}/${s.l}  ${s.c ? s.pct + "%" : "-"}  R ${s.sr.toFixed(2)}`);
    }
    lines.push("");
    lines.push("<b>信号清单</b>");
    if (rows.length === 0) {
      lines.push("（本周无信号）");
    } else {
      const list = rows.slice(-40);
      list.forEach((r, i) => {
        const rv = rOf(r);
        const resCn = r.result === "target" ? "止盈" : r.result === "stop" ? "止损" : "未平仓";
        const rTxt = rv == null ? "" : ` ${rv >= 0 ? "+" : ""}${rv.toFixed(2)}R`;
        lines.push(
          `${i + 1}. ${bjTime(r.sigTs)} ${r.symbol} ${dirCn(r.bias)} 入${priceFmt(r.entryPrice)} 止${priceFmt(r.stopPrice)} 盈${r.targetPrice == null ? "-" : priceFmt(r.targetPrice)} → ${resCn}${rTxt}`,
        );
      });
      if (rows.length > list.length) lines.push(`…（仅列最近 ${list.length} 条）`);
    }

    await sendTelegram(lines.join("\n"));
    return { sent: true, count: rows.length };
  },
});
