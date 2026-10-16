import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendTelegram } from "./alerts";

// 作战面板周报：体检近 7 天的信号质量与盈亏（入场信号已统一为一条链，只有作战面板）。
// 已了结交易计盈亏（battle 回填的 stop/target），未了结只计数。
// 口径：R = 以止损风险为单位（止损 -1R）；% = 入场价收益率。仅 BATTLE=1 的部署（prod）执行。

const DAY = 86400;
const BJ = 8 * 3600;
const SYMBOLS = ["BTC", "XAU"];

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } }).process;
  return proc?.env?.[name] ? String(proc.env[name]).trim() : "";
}

type Trade = {
  symbol: string;
  dir: number; // 1 多 / -1 空
  entry: number;
  stop: number;
  exit: number;
  openedTs: number;
  closedTs: number;
  confirm?: string; // 5m 触发类型
  zoneKind?: string; // OB | FVG
};
type ReportData = { openedTs: number[]; closed: Trade[] };

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

// 指定时间之后触发的全部作战面板信号：已了结交易 + 全部开仓时间（用于按日开仓计数）。
export const reportData = internalQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }): Promise<ReportData> => {
    const rows = await ctx.db
      .query("battleSignals")
      .withIndex("by_sigTs", (q) => q.gte("sigTs", since))
      .collect();
    const closed: Trade[] = [];
    for (const r of rows) {
      if ((r.result === "stop" || r.result === "target") && r.exitPrice != null && r.closedTs != null) {
        closed.push({
          symbol: r.symbol,
          dir: r.bias === "long" ? 1 : -1,
          entry: r.entryPrice,
          stop: r.stopPrice,
          exit: r.exitPrice,
          openedTs: r.sigTs,
          closedTs: r.closedTs,
          confirm: r.confirm,
          zoneKind: r.zoneKind,
        });
      }
    }
    return { openedTs: rows.map((r) => r.sigTs), closed };
  },
});

export const weeklyReport = internalAction({
  args: {},
  handler: async (ctx): Promise<{ skipped?: boolean; sent?: boolean }> => {
    if (env("BATTLE") !== "1") return { skipped: true };

    const now = Math.floor(Date.now() / 1000);
    const todayKey = bjDayKey(now);
    const startKey = todayKey - 6;
    const since = startKey * DAY - BJ; // 北京 00:00（起始日）

    const data = (await ctx.runQuery(internal.report.reportData, { since })) as ReportData;
    const closed = data.closed.sort((a, b) => a.closedTs - b.closedTs);
    const m = metrics(closed);
    const openN = data.openedTs.length - closed.length;

    const lines: string[] = [];
    lines.push("<b>作战面板周报 · 近 7 天</b>");
    lines.push(`区间：${bjDayLabel(startKey)} ~ ${bjDayLabel(todayKey)}（北京）`);
    lines.push("口径：R=止损风险为单位（止损 -1R）；%=入场价收益率");
    lines.push("");

    lines.push("<b>总览</b>");
    lines.push(
      `开 ${data.openedTs.length} 平 ${m.n}（${m.wins}/${m.losses} ${pctOf(m)}）期望 ${sgn(m.expR)}R 累计 ${sgn(m.sumR)}R / ${sgn(m.sumPct)}%  未平仓 ${openN}`,
    );
    lines.push("");

    lines.push("<b>按日盈亏</b>");
    let running = 0;
    for (let k = startKey; k <= todayKey; k++) {
      const opened = data.openedTs.filter((ts) => bjDayKey(ts) === k).length;
      const dayTrades = closed.filter((t) => bjDayKey(t.closedTs) === k);
      const dayR = dayTrades.reduce((a, t) => a + tradeR(t), 0);
      const dayPct = dayTrades.reduce((a, t) => a + tradePct(t), 0);
      running += dayR;
      lines.push(`${bjDayLabel(k)}：开 ${opened} 平 ${dayTrades.length}  ${sgn(dayR)}R (${sgn(dayPct)}%)  累计 ${sgn(running)}R`);
    }
    lines.push("");

    lines.push("<b>分标的</b>");
    for (const sym of SYMBOLS) {
      const sm = metrics(closed.filter((t) => t.symbol === sym));
      lines.push(`${sym}：平 ${sm.n} (${sm.wins}/${sm.losses} ${pctOf(sm)}) 累计 ${sgn(sm.sumR)}R / ${sgn(sm.sumPct)}%`);
    }
    lines.push("");

    lines.push("<b>归因</b>");
    const trigLabel = (c: string) => c.replace("向上", "").replace("向下", "").trim() || c;
    const dirBuckets: [string, Trade[]][] = [
      ["多", closed.filter((t) => t.dir > 0)],
      ["空", closed.filter((t) => t.dir < 0)],
    ];
    const trigBuckets: [string, Trade[]][] = [...new Set(closed.map((t) => trigLabel(t.confirm ?? "")))].map((k) => [
      k || "其他",
      closed.filter((t) => trigLabel(t.confirm ?? "") === k),
    ]);
    const zoneBuckets: [string, Trade[]][] = ["OB", "FVG"].map((k) => [k, closed.filter((t) => t.zoneKind === k)]);
    const dims: { key: string; buckets: [string, Trade[]][] }[] = [
      { key: "方向", buckets: dirBuckets },
      { key: "触发", buckets: trigBuckets },
      { key: "区域", buckets: zoneBuckets },
    ];
    for (const d of dims) {
      const seg = d.buckets
        .filter(([, ts]) => ts.length > 0)
        .map(([lab, ts]) => {
          const bm = metrics(ts);
          return `${lab} ${bm.wins}/${bm.losses} ${sgn(bm.sumR)}R`;
        })
        .join(" · ");
      if (seg) lines.push(`${d.key}：${seg}`);
    }
    lines.push("");

    lines.push("<b>风险指标</b>");
    lines.push(`最大回撤 ${sgn(m.mdd)}R  最大连亏 ${m.maxLoss} 笔  平均持仓 ${Number.isNaN(m.avgHoldH) ? "-" : m.avgHoldH.toFixed(1) + "h"}`);

    const MIN_N = 3;
    const cands: { dim: string; lab: string; m: Metrics }[] = [];
    for (const d of dims)
      for (const [lab, ts] of d.buckets) if (ts.length >= MIN_N) cands.push({ dim: d.key, lab, m: metrics(ts) });
    const best = cands.filter((c) => c.m.expR > 0).sort((a, b) => b.m.expR - a.m.expR)[0];
    const worst = cands.filter((c) => c.m.expR < 0).sort((a, b) => a.m.expR - b.m.expR)[0];

    lines.push("");
    lines.push("<b>结论</b>");
    lines.push(best ? `最优：${best.dim}=${best.lab}（n=${best.m.n} 胜率 ${pctOf(best.m)} 期望 ${sgn(best.m.expR)}R）` : "最优：样本不足（各维度 n<3）");
    lines.push(worst ? `最差：${worst.dim}=${worst.lab}（n=${worst.m.n} 胜率 ${pctOf(worst.m)} 期望 ${sgn(worst.m.expR)}R）` : "最差：样本不足");
    lines.push(worst ? `建议：${worst.dim}=${worst.lab} 期望为负，考虑收紧条件或暂停该组合。` : "建议：已归因维度期望均为正，维持当前规则。");
    if (m.n < 10) lines.push(`注：本周 ${m.n} 笔了结，样本偏小，结论仅供参考。`);

    await sendTelegram(lines.join("\n"));
    return { sent: true };
  },
});
