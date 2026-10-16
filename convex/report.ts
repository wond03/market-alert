import { query } from "./_generated/server";
import { v } from "convex/values";

// 作战面板报表：只读聚合，供 report.html 展示。
// 账户口径：本金 100U、名义 500U、杠杆 100x、每笔保证金 5U、双边 taker 0.05%，不加滞点。
// 指标统一用「扣费后净 R」。

const DAY = 86400;

const PRINCIPAL = 100; // 账户本金 USDT
const NOTIONAL = 500; // 每笔名义 USDT
const LEVERAGE = 100; // 杠杆
const MARGIN = NOTIONAL / LEVERAGE; // 每笔保证金 USDT
const TAKER = 0.0005; // 单边 taker
const FEE_PER_TRADE = NOTIONAL * TAKER * 2; // 双边手续费 USDT

type RawTrade = {
  symbol: string;
  dir: number;
  entry: number;
  stop: number;
  exit: number;
  openedTs: number;
  closedTs: number;
  confirm: string;
  zoneKind: string;
};

type Trade = RawTrade & {
  notional: number;
  leverage: number;
  margin: number;
  fee: number;
  riskUsd: number;
  riskPct: number;
  pnlUsd: number;
  rNet: number;
};

function grossR(t: RawTrade): number {
  const risk = Math.abs(t.entry - t.stop);
  if (risk <= 0) return 0;
  return (t.dir * (t.exit - t.entry)) / risk;
}

function decorate(t: RawTrade): Trade {
  const stopPct = Math.abs(t.entry - t.stop) / (t.entry || 1);
  const riskUsd = NOTIONAL * stopPct;
  const pnlUsd = grossR(t) * riskUsd - FEE_PER_TRADE;
  const rNet = riskUsd > 0 ? pnlUsd / riskUsd : 0;
  return {
    ...t,
    notional: NOTIONAL,
    leverage: LEVERAGE,
    margin: MARGIN,
    fee: FEE_PER_TRADE,
    riskUsd,
    riskPct: riskUsd / PRINCIPAL,
    pnlUsd,
    rNet,
  };
}

function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

function curve(trades: Trade[], to: (t: Trade) => number): number[] {
  let acc = 0;
  return trades.map((t) => (acc += to(t)));
}

export const pageData = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const win = days && days > 0 ? Math.floor(days) : 7;
    const now = Math.floor(Date.now() / 1000);
    const since = now - win * DAY;
    const since30 = now - 30 * DAY;

    const rows = await ctx.db
      .query("battleSignals")
      .withIndex("by_sigTs", (q) => q.gte("sigTs", since30))
      .collect();

    const openedTs = rows.map((r) => r.sigTs);
    const raw: RawTrade[] = [];
    for (const r of rows) {
      if (
        (r.result === "stop" || r.result === "target") &&
        r.exitPrice != null &&
        r.closedTs != null
      ) {
        raw.push({
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
    raw.sort((a, b) => a.closedTs - b.closedTs);
    const all = raw.map(decorate);

    // 窗口内已了结交易与开仓计数。
    const closed = all.filter((t) => t.closedTs >= since);
    const openedN = openedTs.filter((ts) => ts >= since).length;

    const n = closed.length;
    const wins = closed.filter((t) => t.pnlUsd > 0).length;
    const losses = closed.filter((t) => t.pnlUsd < 0).length;
    const sumR = closed.reduce((a, t) => a + t.rNet, 0);
    const sumUsd = closed.reduce((a, t) => a + t.pnlUsd, 0);
    const sumPct = (sumUsd / PRINCIPAL) * 100;
    const expR = n > 0 ? sumR / n : 0;

    // R 倍数分布（净 R）。
    const buckets: [string, (x: number) => boolean][] = [
      ["≤-1", (x) => x <= -1],
      ["-1~0", (x) => x > -1 && x < 0],
      ["0~1", (x) => x >= 0 && x < 1],
      ["1~2", (x) => x >= 1 && x < 2],
      ["2~3", (x) => x >= 2 && x < 3],
      ["≥3", (x) => x >= 3],
    ];
    const rBuckets = buckets.map(([label, f]) => ({
      label,
      count: closed.filter((t) => f(t.rNet)).length,
    }));

    // 归因：方向 / 触发 / 区域。
    const trigLabel = (c: string) =>
      c.replace("向上", "").replace("向下", "").trim() || c;
    const dims: { dim: string; key: (t: Trade) => string }[] = [
      { dim: "方向", key: (t) => (t.dir > 0 ? "多" : "空") },
      { dim: "触发", key: (t) => trigLabel(t.confirm) || "其他" },
      { dim: "区域", key: (t) => t.zoneKind },
    ];
    const attribution: { dim: string; label: string; n: number; expR: number; sumR: number }[] =
      [];
    for (const d of dims) {
      const labels = [...new Set(closed.map(d.key))];
      for (const label of labels) {
        const sub = closed.filter((t) => d.key(t) === label);
        if (!sub.length) continue;
        const s = sub.reduce((a, t) => a + t.rNet, 0);
        attribution.push({
          dim: d.dim,
          label,
          n: sub.length,
          expR: s / sub.length,
          sumR: s,
        });
      }
    }

    // 回撤：周（窗口）与月（30 天）。
    const dd = (list: Trade[]) => {
      if (!list.length) return { mddR: 0, mddUsd: 0, mddPct: 0 };
      return {
        mddR: maxDrawdown(curve(list, (t) => t.rNet)),
        mddUsd: maxDrawdown(curve(list, (t) => t.pnlUsd)),
        mddPct: maxDrawdown(curve(list, (t) => (t.pnlUsd / PRINCIPAL) * 100)),
      };
    };

    // 漏斗：区域内各层通过。
    const frows = await ctx.db
      .query("battleFunnel")
      .withIndex("by_ts", (q) => q.gte("zoneStartT", since))
      .collect();
    const entered = frows.length;
    const c1 = frows.filter((r) => r.c1Ts != null).length;
    const c2 = frows.filter((r) => r.c2Ts != null).length;
    const confirmed = frows.filter((r) => r.confirmedTs != null).length;
    const invalid = frows.filter((r) => r.invalidTs != null).length;
    const rate = (a: number, b: number) => (b > 0 ? a / b : 0);
    const funnel = {
      entered,
      c1,
      c2,
      confirmed,
      invalid,
      rateEnteredToC1: rate(c1, entered),
      rateC1ToC2: rate(c2, c1),
      rateC2ToConfirmed: rate(confirmed, c2),
      rateOverall: rate(confirmed, entered),
    };

    // 权益曲线（窗口内）。
    let acc = 0;
    const equity = closed.map((t) => {
      acc += t.pnlUsd;
      return { ts: t.closedTs, usd: acc, pct: (acc / PRINCIPAL) * 100 };
    });

    // 逐笔明细（倒序，最近在前）。
    const trades = [...closed].reverse().map((t) => ({
      symbol: t.symbol,
      dir: t.dir,
      entry: t.entry,
      stop: t.stop,
      exit: t.exit,
      notional: t.notional,
      leverage: t.leverage,
      margin: t.margin,
      fee: t.fee,
      riskUsd: t.riskUsd,
      riskPct: t.riskPct,
      pnlUsd: t.pnlUsd,
      rNet: t.rNet,
      openedTs: t.openedTs,
      closedTs: t.closedTs,
      confirm: t.confirm,
      zoneKind: t.zoneKind,
    }));

    return {
      range: { since, until: now, days: win },
      account: {
        principal: PRINCIPAL,
        notional: NOTIONAL,
        leverage: LEVERAGE,
        margin: MARGIN,
        feePerTrade: FEE_PER_TRADE,
      },
      funnel,
      metrics: {
        opened: openedN,
        n,
        wins,
        losses,
        winRate: n > 0 ? wins / n : 0,
        expR,
        sumR,
        sumUsd,
        sumPct,
      },
      rBuckets,
      attribution,
      drawdown: { week: dd(closed), month: dd(all) },
      equity,
      trades,
    };
  },
});
