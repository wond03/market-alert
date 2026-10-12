// LuxAlgo SMC 回测：用与看盘指标同一套判定（convex/luxSmc）跑 Gate BTC/XAU 15m 历史。
//
// 两种用法：
//  - M（结构突破顺势）：收盘价突破摆动结构（BOS/CHoCH）时，按突破方向在收盘价进场。
//  - O（订单块回踩）：结构突破后，价格首次回踩到该突破生成的订单块时进场。
//
// 出场沿用旧口径（固定 SL/TP + 8h 兜底 + 成本/资金费），便于与之前结论对比；附带 MFE/MAE。
//
// 运行：./node_modules/.bin/esbuild backtest/luxsmc.ts --bundle --platform=node --format=esm \
//        --outfile=/tmp/luxbt.mjs && node /tmp/luxbt.mjs

import { type Candle, currentSessionName } from "../convex/gate";
import { contractOf } from "../convex/exchanges";
import { fetchHistory } from "./history";
import { SWING_LEN, runStructure, type OrderBlock, type StructBreak } from "../convex/luxSmc";
import { manage } from "../convex/smcCore";

const LOOKBACK_POINTS = 9600; // 约 100 天
const SYMBOLS = ["BTC", "XAU"];
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
  strat: "M" | "O";
  sigTs: number;
  session: string | null;
  dir: "long" | "short";
  tag: string; // BOS/CHoCH（O 用触发突破的 tag）
  sl: number;
  tp: number;
  gross: number;
  net: number;
  reason: string;
  mfe: number;
  mae: number;
};

function sessions(c15: Candle[], j: number): string | null {
  return currentSessionName(c15[j].t + 900);
}

function entryForOB(c15: Candle[], ob: OrderBlock, fromIdx: number): { idx: number; price: number } | null {
  for (let k = fromIdx + 1; k < c15.length; k++) {
    if (ob.bias === "bull" && c15[k].l <= ob.high) {
      return { idx: k, price: Math.min(ob.high, c15[k].o) };
    }
    if (ob.bias === "bear" && c15[k].h >= ob.low) {
      return { idx: k, price: Math.max(ob.low, c15[k].o) };
    }
  }
  return null;
}

function simulate(symbol: string, c15: Candle[]): Row[] {
  const st = runStructure(c15, SWING_LEN);
  const dataEnd = c15[c15.length - 1].t + 900;
  const rows: Row[] = [];

  const test = (
    strat: "M" | "O",
    j: number, // 信号 bar
    dir: "long" | "short",
    tag: string,
    entryPrice: number,
    entryIdx: number,
  ) => {
    if (c15[entryIdx].t + HOLD_H * 3600 > dataEnd) return;
    for (const cfg of CFGS) {
      const out = manage(
        c15,
        { tradeDir: dir, entryPrice, sl: cfg.sl, tp: cfg.tp, sigTs: c15[entryIdx].t, holdH: HOLD_H, symbol },
        dataEnd,
      );
      if (!out) continue;
      rows.push({
        symbol,
        strat,
        sigTs: c15[entryIdx].t,
        session: sessions(c15, entryIdx),
        dir,
        tag,
        sl: cfg.sl,
        tp: cfg.tp,
        gross: out.gross,
        net: out.net,
        reason: out.reason,
        mfe: out.mfe,
        mae: out.mae,
      });
    }
  };

  // runStructure 中 breaks 与 orderBlocks 一一对应、同序
  for (let bi = 0; bi < st.breaks.length; bi++) {
    const br: StructBreak = st.breaks[bi];
    const dir = br.dir === "bull" ? "long" : "short";
    test("M", br.idx, dir, br.tag, c15[br.idx].c, br.idx);
    const ob = st.orderBlocks[bi];
    if (ob) {
      const e = entryForOB(c15, ob, br.idx);
      if (e) test("O", e.idx, dir, br.tag, e.price, e.idx);
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
  console.log(`  ${label.padEnd(28)} n=${pad(s.n, 4)}  ${pad(pct(s.mean), 8)}  胜率 ${pad(pct(s.win), 7)}  t=${s.t.toFixed(2)}`);
}

function report(name: string, rows: Row[]) {
  console.log(`\n================ ${name} ================`);
  for (const cfg of CFGS) {
    const rs = rows.filter((r) => r.sl === cfg.sl && r.tp === cfg.tp);
    console.log(`\n[SL/TP ${cfg.name}]  毛/净`);
    line("全部(净)", rs, "net");
    line("全部(毛)", rs, "gross");
    line("多", rs.filter((r) => r.dir === "long"));
    line("空", rs.filter((r) => r.dir === "short"));
    line("BOS", rs.filter((r) => r.tag === "BOS"));
    line("CHoCH", rs.filter((r) => r.tag === "CHoCH"));
    for (const sym of SYMBOLS) line(sym, rs.filter((r) => r.symbol === sym));
  }
}

function main(rows: Row[]) {
  const M = rows.filter((r) => r.strat === "M");
  const O = rows.filter((r) => r.strat === "O");
  console.log(`\n总样本：M=${M.length} O=${O.length}（两品种 × 3 组 SL/TP）`);
  report("M 结构突破顺势（收盘进场）", M);
  report("O 订单块回踩进场", O);

  // 时段过滤（仅纽约盘）
  console.log("\n=== M 按时段（SL/TP 0.5/0.6）===");
  const m = M.filter((r) => r.sl === 0.005);
  for (const s of ["亚洲盘", "伦敦盘", "纽约盘"]) line(s, m.filter((r) => r.session === s));
  line("时段外", m.filter((r) => !r.session));

  const avg = (rs: Row[], k: "mfe" | "mae") => (rs.length ? rs.reduce((a, r) => a + r[k], 0) / rs.length : 0);
  console.log(`\n平均 MFE/MAE  M: ${pct(avg(M, "mfe"))}/${pct(avg(M, "mae"))}   O: ${pct(avg(O, "mfe"))}/${pct(avg(O, "mae"))}`);
}

async function mainAsync() {
  const all: Row[] = [];
  for (const sym of SYMBOLS) {
    console.log(`拉取 ${sym} 15m 历史…`);
    const c15 = await fetchHistory(contractOf("gate", sym), "15m", LOOKBACK_POINTS);
    console.log(`  ${sym}: ${c15.length} 根（${new Date(c15[0].t * 1000).toISOString().slice(0, 10)} ~ ${new Date(c15[c15.length - 1].t * 1000).toISOString().slice(0, 10)}）`);
    const st = runStructure(c15, SWING_LEN);
    console.log(`  结构：摆动高 ${st.highs.length} / 摆动低 ${st.lows.length} / 突破 ${st.breaks.length} / 订单块 ${st.orderBlocks.length}`);
    const rows = simulate(sym, c15);
    all.push(...rows);
  }
  main(all);
}

await mainAsync();
