import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendTelegram } from "./alerts";

// 信号系统周报：跨系统（作战面板 battle + SMC 记录器）体检近 7 天的信号质量与盈亏。
// 只统计已了结交易的盈亏（battle 回填的 stop/target、SMC 的 closed），未了结只计数。
// 口径：R = 以止损风险为单位（止损=-1R）；% = 入场价收益率。仅 BATTLE/SMC 开启的部署（prod）执行。

const DAY = 86400;
const BJ = 8 * 3600;
const SYMBOLS = ["BTC", "XAU"];

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } }).process;
  return proc?.env?.[name] ? String(proc.env[name]).trim() : "";
}

type Trade = {
  sys: string;
  symbol: string;
  dir: number; // 1 多 / -1 空
  entry: number;
  stop: number;
  exit: number;
  openedTs: number;
  closedTs: number;
};

type SysData = { openedTs: number[]; closed: Trade[] };
type ReportData = { battle: SysData; smc: SysData };

function tradeR(t: Trade): number {
  const risk = Math.abs(t.entry - t.stop);
  return risk > 0 ? (t.dir * (t.exit - t.entry)) / risk : 0;
}
function tradePct(t: Trade): number {
  return t.entry !== 0 ? (t.dir * (t.exit - t.entry)) / t.entry * 100 : 0;
}
function bjDayKey(ts: number): number {
  return Math.floor((ts + BJ) / DAY);
}
function bjDayLabel(key: number): string {
  const d = new Date(key * DAY * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} 周${["日", "一", "二", "三", "四", "五", "六"][d.getUTCDay()]}`;
}
function sgn(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
}
function pctOf(m: Metrics): string {
  return m.n ? `${Math.round(m.winRate)}%` : "-";
}

type Metrics = {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  sumR: number;
  sumPct: number;
  expR: number;
  mdd: number;
  maxLoss: number;
  avgHoldH: number;
};
function metrics(list: Trade[]): Metrics {
  const n = list.length;
  const wins = list.filter((t) => tradeR(t) > 0).length;
  const sumR = list.reduce((a, t) => a + tradeR(t), 0);
  const sumPct = list.reduce((a, t) => a + tradePct(t), 0);
  let peak = 0;
  let cum = 0;
  let mdd = 0;
  for (const t of list) {
    cum += tradeR(t);
    peak = Math.max(peak, cum);
    mdd = Math.min(mdd, cum - peak);
  }
  let streak = 0;
  let maxLoss = 0;
  for (const t of list) {
    if (tradeR(t) < 0) {
      streak++;
      maxLoss = Math.max(maxLoss, streak);
    } else streak = 0;
  }
  const avgHoldH = n ? list.reduce((a, t) => a + (t.closedTs - t.openedTs), 0) / n / 3600 : NaN;
  return { n, wins, losses: n - wins, winRate: n ? (wins / n) * 100 : NaN, sumR, sumPct, expR: n ? sumR / n : NaN, mdd, maxLoss, avgHoldH };
}

// 取指定时间之后两个系统的信号：已了结交易 + 全部开仓时间（用于按日开仓计数）。
export const reportData = internalQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }): Promise<ReportData> => {
    const bsig = await ctx.db
      .query("battleSignals")
      .withIndex("by_sigTs", (q) => q.gte("sigTs", since))
      .collect();
    const bClosed: Trade[] = [];
    for (const r of bsig) {
      if ((r.result === "stop" || r.result === "target") && r.exitPrice != null && r.closedTs != null) {
        bClosed.push({
          sys: "battle",
          symbol: r.symbol,
          dir: r.bias === "long" ? 1 : -1,
          entry: r.entryPrice,
          stop: r.stopPrice,
          exit: r.exitPrice,
          openedTs: r.sigTs,
          closedTs: r.closedTs,
        });
      }
    }

    const ssig = await ctx.db
      .query("smcSignals")
      .withIndex("by_sigTs", (q) => q.gte("sigTs", since))
      .collect();
    const sClosed: Trade[] = [];
    for (const r of ssig) {
      if (r.status === "closed" && r.exitPrice != null && r.closedAt != null) {
        sClosed.push({
          sys: "smc",
          symbol: r.symbol,
          dir: r.tradeDir === "long" ? 1 : -1,
          entry: r.entryPrice,
          stop: r.sl,
          exit: r.exitPrice,
          openedTs: r.sigTs,
          closedTs: r.closedAt,
        });
      }
    }

    return { battle: { openedTs: bsig.map((r) => r.sigTs), closed: bClosed }, smc: { openedTs: ssig.map((r) => r.sigTs), closed: sClosed } };
  },
});

export const weeklyReport = internalAction({
  args: {},
  handler: async (ctx): Promise<{ skipped?: boolean; sent?: boolean }> => {
    if (env("BATTLE") !== "1" && env("SMC_TRACKING") !== "1") return { skipped: true };

    const now = Math.floor(Date.now() / 1000);
    const todayKey = bjDayKey(now);
    const startKey = todayKey - 6;
    const since = startKey * DAY - BJ; // 北京 00:00（起始日）

    const data = (await ctx.runQuery(internal.report.reportData, { since })) as ReportData;
    const bClosed = data.battle.closed.sort((a, b) => a.closedTs - b.closedTs);
    const sClosed = data.smc.closed.sort((a, b) => a.closedTs - b.closedTs);
    const all = [...bClosed, ...sClosed].sort((a, b) => a.closedTs - b.closedTs);

    const bm = metrics(bClosed);
    const sm = metrics(sClosed);
    const am = metrics(all);
    const bOpen = data.battle.openedTs.length - bClosed.length;
    const sOpen = data.smc.openedTs.length - sClosed.length;

    const lines: string[] = [];
    lines.push("<b>信号系统周报 · 近 7 天</b>");
    lines.push(`区间：${bjDayLabel(startKey)} ~ ${bjDayLabel(todayKey)}（北京）`);
    lines.push("口径：R=止损风险为单位（止损 -1R）；%=入场价收益率");
    lines.push("");

    lines.push("<b>总览</b>");
    lines.push(
      `作战面板：开 ${data.battle.openedTs.length} 平 ${bm.n}（${bm.wins}/${bm.losses} ${pctOf(bm)}）期望 ${sgn(bm.expR)}R 累计 ${sgn(bm.sumR)}R / ${sgn(bm.sumPct)}%`,
    );
    lines.push(
      `SMC 记录：开 ${data.smc.openedTs.length} 平 ${sm.n}（${sm.wins}/${sm.losses} ${pctOf(sm)}）期望 ${sgn(sm.expR)}R 累计 ${sgn(sm.sumR)}R / ${sgn(sm.sumPct)}%`,
    );
    lines.push(`合计：平 ${am.n} 累计 ${sgn(am.sumR)}R / ${sgn(am.sumPct)}%`);
    lines.push("");

    lines.push("<b>按日盈亏（合计）</b>");
    const allOpenedTs = [...data.battle.openedTs, ...data.smc.openedTs];
    let running = 0;
    for (let k = startKey; k <= todayKey; k++) {
      const opened = allOpenedTs.filter((ts) => bjDayKey(ts) === k).length;
      const dayTrades = all.filter((t) => bjDayKey(t.closedTs) === k);
      const dayR = dayTrades.reduce((a, t) => a + tradeR(t), 0);
      const dayPct = dayTrades.reduce((a, t) => a + tradePct(t), 0);
      running += dayR;
      lines.push(`${bjDayLabel(k)}：开 ${opened} 平 ${dayTrades.length}  ${sgn(dayR)}R (${sgn(dayPct)}%)  累计 ${sgn(running)}R`);
    }
    lines.push("");

    lines.push("<b>分标的</b>");
    for (const [name, closed] of [
      ["作战面板", bClosed],
      ["SMC", sClosed],
    ] as [string, Trade[]][]) {
      for (const sym of SYMBOLS) {
        const m = metrics(closed.filter((t) => t.symbol === sym));
        lines.push(`${name} · ${sym}：平 ${m.n} (${m.wins}/${m.losses} ${pctOf(m)}) 累计 ${sgn(m.sumR)}R / ${sgn(m.sumPct)}%`);
      }
    }
    lines.push("");

    lines.push("<b>风险指标</b>");
    lines.push(`作战面板：最大回撤 ${sgn(bm.mdd)}R  最大连亏 ${bm.maxLoss} 笔  平均持仓 ${Number.isNaN(bm.avgHoldH) ? "-" : bm.avgHoldH.toFixed(1) + "h"}`);
    lines.push(`SMC：最大回撤 ${sgn(sm.mdd)}R  最大连亏 ${sm.maxLoss} 笔  平均持仓 ${Number.isNaN(sm.avgHoldH) ? "-" : sm.avgHoldH.toFixed(1) + "h"}`);
    lines.push(`合计：最大回撤 ${sgn(am.mdd)}R  最大连亏 ${am.maxLoss} 笔  平均持仓 ${Number.isNaN(am.avgHoldH) ? "-" : am.avgHoldH.toFixed(1) + "h"}`);

    await sendTelegram(lines.join("\n"));
    return { sent: true };
  },
});
