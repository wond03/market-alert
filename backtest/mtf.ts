// MTF 决策函数 —— 组件分解回测。
// 信号：1h 结构（size=4）定方向 → 5m/15m 首个同向 BOS/CHoCH 确认。
// 入场：break=确认收盘追进；retest=回踩该突破的订单块;fvg=回踩同向未填补 FVG。
// 出场：固定 SL/TP + 8h 兜底 + 成本/资金费（smcCore.manage）。
// 报告：整体 + 按 突破类型(BOS/CHoCH)、交易时段、方向 分解。
//
// 运行：./node_modules/.bin/esbuild backtest/mtf.ts --bundle --platform=node --format=esm \
//        --outfile=/tmp/mtfbt.mjs && node /tmp/mtfbt.mjs

import { contractOf, type Candle } from "../convex/exchanges";
import { currentSessionName } from "../convex/gate";
import { fetchHistory } from "./history";
import { computeFvgs, runStructure, type Fvg } from "../convex/luxSmc";
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

type Mode = "break" | "retest" | "fvg";

type Row = {
  symbol: string;
  tf: "5m" | "15m";
  ts: number;
  dir: "long" | "short";
  tag: string;
  session: string;
  sl: number;
  tp: number;
  gross: number;
  net: number;
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

type Ctx = { c5: Candle[]; c15: Candle[]; fvg5: Fvg[]; fvg15: Fvg[] };

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
  evs.sort((a, b) => a.t - b.t || a.rank - b.rank);
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

function seriesOf(ctx: Ctx, ev: Ev): { series: Candle[]; fvgs: Fvg[] } {
  return ev.kind === "5m" ? { series: ctx.c5, fvgs: ctx.fvg5 } : { series: ctx.c15, fvgs: ctx.fvg15 };
}

function entryForOB(series: Candle[], ev: Ev): { idx: number; price: number } | null {
  if (ev.obHigh === undefined || ev.obLow === undefined) return null;
  for (let k = ev.idx + 1; k < series.length; k++) {
    if (ev.dir === "bull" && series[k].l <= ev.obHigh) return { idx: k, price: Math.min(ev.obHigh, series[k].o) };
    if (ev.dir === "bear" && series[k].h >= ev.obLow) return { idx: k, price: Math.max(ev.obLow, series[k].o) };
  }
  return null;
}

function entryForFvg(series: Candle[], fvgs: Fvg[], ev: Ev): { idx: number; price: number } | null {
  const cands = fvgs.filter((f) => f.idx <= ev.idx && f.dir === ev.dir && (f.mitigatedIdx === null || f.mitigatedIdx > ev.idx));
  let best: { idx: number; price: number } | null = null;
  for (const f of cands) {
    for (let k = ev.idx + 1; k < series.length; k++) {
      const bar = series[k];
      if (bar.l <= f.top && bar.h >= f.bottom) {
        const price = ev.dir === "bull" ? Math.min(f.top, bar.o) : Math.max(f.bottom, bar.o);
        if (!best || k < best.idx) best = { idx: k, price };
        break;
      }
    }
  }
  return best;
}

function runSignals(symbol: string, sigs: Ev[], ctx: Ctx, mode: Mode): Row[] {
  const rows: Row[] = [];
  for (const ev of sigs) {
    const { series, fvgs } = seriesOf(ctx, ev);
    let entry: { idx: number; price: number } | null;
    if (mode === "break") {
      const bar = series.find((c) => c.t === ev.t);
      entry = bar ? { idx: ev.idx, price: bar.c } : null;
    } else if (mode === "retest") {
      entry = entryForOB(series, ev);
    } else {
      entry = entryForFvg(series, fvgs, ev);
    }
    if (!entry) continue;
    const sigTs = series[entry.idx].t;
    const dir = ev.dir === "bull" ? "long" : "short";
    const tfSec = ev.kind === "5m" ? 300 : 900;
    const dataEnd = series[series.length - 1].t + tfSec;
    if (sigTs + HOLD_H * 3600 > dataEnd) continue;
    const session = currentSessionName(sigTs + tfSec) ?? "时段外";
    for (const cfg of CFGS) {
      const out = manage(series, { tradeDir: dir, entryPrice: entry.price, sl: cfg.sl, tp: cfg.tp, sigTs, holdH: HOLD_H, symbol }, dataEnd);
      if (!out) continue;
      rows.push({ symbol, tf: ev.kind as "5m" | "15m", ts: sigTs, dir, tag: ev.tag, session, sl: cfg.sl, tp: cfg.tp, gross: out.gross, net: out.net });
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
  console.log(`  ${label.padEnd(10)} n=${pad(s.n, 4)}  毛 ${pad(pct(statsOf(rows.map((r) => r.gross)).mean), 8)}  净 ${pad(pct(s.mean), 8)}  胜率 ${pad(pct(s.win), 7)}  t=${s.t.toFixed(2)}`);
}

async function mainAsync() {
  const byMode: Record<Mode, Row[]> = { break: [], retest: [], fvg: [] };
  const byBase: Row[] = [];
  let lo = Infinity;
  let hi = 0;
  for (const sym of SYMBOLS) {
    const contract = contractOf("gate", sym);
    const c1h = await fetchHistory(contract, "1h", 2000);
    const c15 = await fetchHistory(contract, "15m", 9600);
    const c5 = await fetchHistory(contract, "5m", 9000);
    lo = Math.min(lo, c5[0].t);
    hi = Math.max(hi, c5[c5.length - 1].t);
    const ctx: Ctx = { c5, c15, fvg5: computeFvgs(c5), fvg15: computeFvgs(c15) };
    const { mtf, base } = buildSignals(c1h, c5, c15);
    console.log(`${sym}: MTF ${mtf.length}（5m ${mtf.filter((e) => e.kind === "5m").length}/15m ${mtf.filter((e) => e.kind === "15m").length}）  对照 ${base.length}`);
    byMode.break.push(...runSignals(sym, mtf, ctx, "break"));
    byMode.retest.push(...runSignals(sym, mtf, ctx, "retest"));
    byMode.fvg.push(...runSignals(sym, mtf, ctx, "fvg"));
    byBase.push(...runSignals(sym, base, ctx, "break"));
  }
  console.log(`\n窗口：${new Date(lo * 1000).toISOString().slice(0, 10)} ~ ${new Date(hi * 1000).toISOString().slice(0, 10)}  （SL/TP 0.5/0.6，含成本）`);

  const cfg = CFGS[0];
  const pick = (rows: Row[]) => rows.filter((r) => r.sl === cfg.sl && r.tp === cfg.tp);
  const modes: [Mode, string][] = [["break", "追突破"], ["retest", "回踩OB"], ["fvg", "回踩FVG"]];
  for (const [m, label] of modes) {
    const rows = pick(byMode[m]);
    console.log(`\n=== 入场：${label}  (n=${rows.length}) ===`);
    line("全部", rows);
    line("BOS", rows.filter((r) => r.tag === "BOS"));
    line("CHoCH", rows.filter((r) => r.tag === "CHoCH"));
    line("多", rows.filter((r) => r.dir === "long"));
    line("空", rows.filter((r) => r.dir === "short"));
    line("亚洲盘", rows.filter((r) => r.session === "亚洲盘"));
    line("伦敦盘", rows.filter((r) => r.session === "伦敦盘"));
    line("纽约盘", rows.filter((r) => r.session === "纽约盘"));
    line("时段外", rows.filter((r) => r.session === "时段外"));
  }
  console.log(`\n=== 对照：小周期突破追进（无 1h 过滤）n=${pick(byBase).length} ===`);
  line("全部", pick(byBase));
  line("BOS", pick(byBase).filter((r) => r.tag === "BOS"));
  line("CHoCH", pick(byBase).filter((r) => r.tag === "CHoCH"));
}

await mainAsync();
