// MTF 决策函数回测：1h 结构（size=4）定方向 → 5m/15m 首个同向 BOS/CHoCH。
// 两种入场对比：
//  - break：确认 K 收盘价立即进场（追突破）。
//  - retest：确认后等价格回踩该突破生成的订单块(OB)再进场（不追）。
// 出场沿用旧口径（固定 SL/TP + 8h 兜底 + 成本/资金费，smcCore.manage）。
// 另附「只做小周期突破、不加 1h 过滤」的对照。
//
// 运行：./node_modules/.bin/esbuild backtest/mtf.ts --bundle --platform=node --format=esm \
//        --outfile=/tmp/mtfbt.mjs && node /tmp/mtfbt.mjs

import { contractOf, type Candle } from "../convex/exchanges";
import { fetchHistory } from "./history";
import { runStructure } from "../convex/luxSmc";
import { manage } from "../convex/smcCore";

const SYMBOLS = ["BTC", "XAU"];
const SWING = 4;
const HOLD_H = 8;
const CFGS = [
  { sl: 0.005, tp: 0.006, name: "0.5/0.6" },
  { sl: 0.008, tp: 0.012, name: "0.8/1.2" },
  { sl: 0.01, tp: 0.02, name: "1.0/2.0" },
];

const pct = (x: number) => (x * 100).toFixed(2) + "%";
const pad = (s: unknown, w = 4) => String(s).padStart(w);

type Row = {
  symbol: string;
  tf: "5m" | "15m";
  ts: number;
  dir: "long" | "short";
  group: string;
  sl: number;
  tp: number;
  gross: number;
  net: number;
  reason: string;
};

type Ev = {
  t: number;
  kind: "1h" | "15m" | "5m";
  rank: number;
  dir: "bull" | "bear";
  idx: number;
  tag: string;
  level: number;
  obHigh?: number;
  obLow?: number;
};

function eventsOf(c1h: Candle[], c5: Candle[], c15: Candle[]): Ev[] {
  const s1h = runStructure(c1h, SWING);
  const s5 = runStructure(c5, SWING);
  const s15 = runStructure(c15, SWING);
  const evs: Ev[] = [];
  s1h.breaks.forEach((b) => evs.push({ t: b.t, kind: "1h", rank: 0, dir: b.dir, idx: b.idx, tag: b.tag, level: b.level }));
  s15.breaks.forEach((b, i) =>
    evs.push({ t: b.t, kind: "15m", rank: 1, dir: b.dir, idx: b.idx, tag: b.tag, level: b.level, obHigh: s15.orderBlocks[i]?.high, obLow: s15.orderBlocks[i]?.low }),
  );
  s5.breaks.forEach((b, i) =>
    evs.push({ t: b.t, kind: "5m", rank: 2, dir: b.dir, idx: b.idx, tag: b.tag, level: b.level, obHigh: s5.orderBlocks[i]?.high, obLow: s5.orderBlocks[i]?.low }),
  );
  evs.sort((a, b) => (a.t - b.t) || (a.rank - b.rank));
  return evs;
}

function buildSignals(c1h: Candle[], c5: Candle[], c15: Candle[]): { mtf: Ev[]; base: Ev[] } {
  const evs = eventsOf(c1h, c5, c15);
  const mtf: Ev[] = [];
  const base: Ev[] = [];
  let armed: { dir: "bull" | "bear"; ts: number } | null = null;
  let fired = false;
  for (const ev of evs) {
    if (ev.kind === "1h") {
      armed = { dir: ev.dir, ts: ev.t };
      fired = false;
      continue;
    }
    base.push(ev);
    if (armed && !fired && ev.dir === armed.dir && ev.t >= armed.ts) {
      mtf.push(ev);
      fired = true;
    }
  }
  return { mtf, base };
}

// 回踩订单块进场：突破后价格首次回到该突破的 OB 区间。
function entryForOB(series: Candle[], ev: Ev): { idx: number; price: number } | null {
  if (ev.obHigh === undefined || ev.obLow === undefined) return null;
  for (let k = ev.idx + 1; k < series.length; k++) {
    if (ev.dir === "bull" && series[k].l <= ev.obHigh) return { idx: k, price: Math.min(ev.obHigh, series[k].o) };
    if (ev.dir === "bear" && series[k].h >= ev.obLow) return { idx: k, price: Math.max(ev.obLow, series[k].o) };
  }
  return null;
}

function runSignals(
  symbol: string,
  sigs: Ev[],
  seriesFor: (ev: Ev) => Candle[],
  group: string,
  mode: "break" | "retest",
): Row[] {
  const rows: Row[] = [];
  for (const ev of sigs) {
    const series = seriesFor(ev);
    let entryIdx: number;
    let entryPrice: number;
    if (mode === "break") {
      const bar = series.find((c) => c.t === ev.t);
      if (!bar) continue;
      entryIdx = ev.idx;
      entryPrice = bar.c;
    } else {
      const e = entryForOB(series, ev);
      if (!e) continue;
      entryIdx = e.idx;
      entryPrice = e.price;
    }
    const sigTs = series[entryIdx].t;
    const dir = ev.dir === "bull" ? "long" : "short";
    const dataEnd = series[series.length - 1].t + (ev.kind === "5m" ? 300 : 900);
    if (sigTs + HOLD_H * 3600 > dataEnd) continue;
    for (const cfg of CFGS) {
      const out = manage(
        series,
        { tradeDir: dir, entryPrice, sl: cfg.sl, tp: cfg.tp, sigTs, holdH: HOLD_H, symbol },
        dataEnd,
      );
      if (!out) continue;
      rows.push({ symbol, tf: ev.kind as "5m" | "15m", ts: sigTs, dir, group, sl: cfg.sl, tp: cfg.tp, gross: out.gross, net: out.net, reason: out.reason });
    }
  }
  return rows;
}

function statsOf(xs: number[]) {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, win: n ? xs.filter((x) => x > 0).length / n : 0, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

function line(label: string, rows: Row[], key: "net" | "gross" = "net") {
  const s = statsOf(rows.map((r) => r[key]));
  console.log(`  ${label.padEnd(24)} n=${pad(s.n, 4)}  ${pad(pct(s.mean), 8)}  胜率 ${pad(pct(s.win), 7)}  t=${s.t.toFixed(2)}`);
}

function report(name: string, rows: Row[], tsLo: number, tsHi: number) {
  console.log(`\n================ ${name} ================`);
  for (const cfg of CFGS) {
    const rs = rows.filter((r) => r.sl === cfg.sl && r.tp === cfg.tp);
    console.log(`\n[SL/TP ${cfg.name}]  毛/净`);
    line("全部(净)", rs, "net");
    line("全部(毛)", rs, "gross");
    line("5m", rs.filter((r) => r.tf === "5m"));
    line("15m", rs.filter((r) => r.tf === "15m"));
    const mid = tsLo + (tsHi - tsLo) * 0.7;
    line("前70%(内)", rs.filter((r) => r.ts <= mid));
    line("后30%(外)", rs.filter((r) => r.ts > mid));
    for (const sym of SYMBOLS) line(sym, rs.filter((r) => r.symbol === sym));
  }
}

async function main() {
  const mtfBreak: Row[] = [];
  const mtfRetest: Row[] = [];
  const baseBreak: Row[] = [];
  let lo = Infinity;
  let hi = 0;
  for (const sym of SYMBOLS) {
    const contract = contractOf("gate", sym);
    console.log(`拉取 ${sym} 1h/15m/5m 历史…`);
    const c1h = await fetchHistory(contract, "1h", 2000);
    const c15 = await fetchHistory(contract, "15m", 9600);
    const c5 = await fetchHistory(contract, "5m", 9000);
    console.log(
      `  ${sym}: 1h ${c1h.length} / 15m ${c15.length} / 5m ${c5.length}  ` +
        `(${new Date(c5[0].t * 1000).toISOString().slice(0, 10)} ~ ${new Date(c5[c5.length - 1].t * 1000).toISOString().slice(0, 10)})`,
    );
    lo = Math.min(lo, c5[0].t);
    hi = Math.max(hi, c5[c5.length - 1].t);
    const { mtf, base } = buildSignals(c1h, c5, c15);
    console.log(`  事件：MTF 信号 ${mtf.length}（5m ${mtf.filter((e) => e.kind === "5m").length} / 15m ${mtf.filter((e) => e.kind === "15m").length}），对照 ${base.length}`);
    const seriesFor = (ev: Ev) => (ev.kind === "5m" ? c5 : c15);
    mtfBreak.push(...runSignals(sym, mtf, seriesFor, "mtf-break", "break"));
    mtfRetest.push(...runSignals(sym, mtf, seriesFor, "mtf-retest", "retest"));
    baseBreak.push(...runSignals(sym, base, seriesFor, "base-break", "break"));
  }
  console.log(`\n窗口：${new Date(lo * 1000).toISOString().slice(0, 10)} ~ ${new Date(hi * 1000).toISOString().slice(0, 10)}`);
  report("MTF · 追突破进场", mtfBreak, lo, hi);
  report("MTF · 回踩 OB 进场", mtfRetest, lo, hi);
  report("对照 · 小周期突破追进（无 1h 过滤）", baseBreak, lo, hi);
}

await main();
