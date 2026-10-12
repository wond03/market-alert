// SMC 回测：用与线上记录器完全相同的判定（convex/smcCore）跑 Gate BTC/XAU 15m 历史。
// 只统计三大交易时段内的扫荡信号；每个扫荡同时评估 reversal(SFP) 与 continuation 两个方向。
//
// 运行：./node_modules/.bin/esbuild backtest/smc.ts --bundle --platform=node --format=esm \
//        --outfile=/tmp/smcbt.mjs && node /tmp/smcbt.mjs

import {
  currentSessionName,
  inWindow,
  tzMinutes,
  SESSIONS,
  SESSION_PREV,
  type Candle,
} from "../convex/gate";
import { contractOf } from "../convex/exchanges";
import { fetchHistory } from "./history";
import {
  FRACTAL,
  TF,
  SL,
  TP,
  HOLD_H,
  findSwings,
  structureOf,
  nearestFvg,
  alignOf,
  manage,
} from "../convex/smcCore";

const LOOKBACK_POINTS = 9600; // 约 100 天
const SYMBOLS = ["BTC", "XAU"];

const pct = (x: number) => (x * 100).toFixed(2) + "%";
const pad = (s: unknown, w = 4) => String(s).padStart(w);

type Occ = { name: string; startT: number; endT: number; high: number; low: number };

function buildOccurrences(candles: Candle[]): Occ[] {
  const out: Occ[] = [];
  for (const s of SESSIONS) {
    let i = 0;
    while (i < candles.length) {
      if (!inWindow(tzMinutes(candles[i].t, s.tz), s.start, s.end)) {
        i++;
        continue;
      }
      let high = -Infinity;
      let low = Infinity;
      let j = i;
      while (j < candles.length && inWindow(tzMinutes(candles[j].t, s.tz), s.start, s.end)) {
        high = Math.max(high, candles[j].h);
        low = Math.min(low, candles[j].l);
        j++;
      }
      out.push({ name: s.name, startT: candles[i].t, endT: candles[j - 1].t, high, low });
      i = j;
    }
  }
  return out;
}

function targetSession(T: number, occ: Occ[]): string | null {
  const cur = currentSessionName(T);
  if (cur) return SESSION_PREV[cur] ?? cur;
  let best: Occ | null = null;
  for (const o of occ) if (o.endT <= T && (!best || o.endT > best.endT)) best = o;
  return best ? best.name : null;
}

function latestOcc(occ: Occ[], name: string, T: number): Occ | null {
  let best: Occ | null = null;
  for (const o of occ) {
    if (o.name !== name) continue;
    if (o.endT <= T && (!best || o.endT > best.endT)) best = o;
  }
  return best;
}

function agg1h(c15: Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of c15) {
    const key = Math.floor(c.t / 3600) * 3600;
    if (!cur || cur.t !== key) {
      if (cur) out.push(cur);
      cur = { t: key, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

type Row = {
  symbol: string;
  sigTs: number;
  session: string;
  bias: string;
  tradeDir: string;
  align1h: boolean;
  align15: boolean;
  zone: string;
  levelKind: string;
  pen: number;
  gross: number;
  net: number;
  reason: string;
  mfe: number;
  mae: number;
};

function simulate(symbol: string, c15: Candle[]): Row[] {
  const occ = buildOccurrences(c15);
  const swings15 = findSwings(c15, FRACTAL);
  const h1 = agg1h(c15);
  const swings1h = findSwings(h1, FRACTAL);
  const dataEnd = c15[c15.length - 1].t + TF;
  const rows: Row[] = [];

  for (let j = FRACTAL + 2; j < c15.length; j++) {
    const bar = c15[j];
    const dt = bar.t + TF;
    const session = currentSessionName(dt);
    if (!session) continue; // 日内：仅三大时段
    if (bar.t + HOLD_H * 3600 > dataEnd) continue; // 前向数据不足，跳过

    // 1h 结构 as-of dt（只用到 dt 前已收盘的 1h K）
    let k = -1;
    for (let m = h1.length - 1; m >= 0; m--) {
      if (h1[m].t + 3600 <= dt) {
        k = m;
        break;
      }
    }
    const hi1 = swings1h.highs.filter((s) => s.idx <= k - FRACTAL);
    const lo1 = swings1h.lows.filter((s) => s.idx <= k - FRACTAL);
    const trend1h = structureOf(hi1, lo1);

    const hi = swings15.highs.filter((s) => s.idx <= j - FRACTAL);
    const lo = swings15.lows.filter((s) => s.idx <= j - FRACTAL);
    const trend15 = structureOf(hi, lo);
    const lastHi = hi.length ? hi[hi.length - 1] : null;
    const lastLo = lo.length ? lo[lo.length - 1] : null;

    let zone = "mid";
    if (lastHi && lastLo && lastHi.price > lastLo.price) {
      const pos = (bar.c - lastLo.price) / (lastHi.price - lastLo.price);
      zone = pos >= 0.5 ? "premium" : "discount";
    }
    const fvg = nearestFvg(c15, j, bar.c);
    const prev = c15[j - 1];

    const levels: { kind: string; price: number }[] = [];
    if (lastHi) levels.push({ kind: "swing_high", price: lastHi.price });
    if (lastLo) levels.push({ kind: "swing_low", price: lastLo.price });
    const tname = targetSession(dt, occ);
    if (tname) {
      const o = latestOcc(occ, tname, dt);
      if (o) {
        levels.push({ kind: "session_high", price: o.high });
        levels.push({ kind: "session_low", price: o.low });
      }
    }

    for (const L of levels) {
      const up = bar.h > L.price && bar.c < L.price && prev.h <= L.price;
      const dn = bar.l < L.price && bar.c > L.price && prev.l >= L.price;
      if (!up && !dn) continue;
      const pen = up ? (bar.h - L.price) / L.price : (L.price - bar.l) / L.price;
      const revDir = up ? "short" : "long";
      const contDir = up ? "long" : "short";
      for (const [bias, td] of [
        ["reversal", revDir],
        ["continuation", contDir],
      ] as const) {
        const out = manage(
          c15,
          { tradeDir: td, entryPrice: bar.c, sl: SL, tp: TP, sigTs: bar.t, holdH: HOLD_H, symbol },
          dataEnd,
        );
        if (!out) continue;
        rows.push({
          symbol,
          sigTs: bar.t,
          session,
          bias,
          tradeDir: td,
          align1h: alignOf(td, trend1h),
          align15: alignOf(td, trend15),
          zone,
          levelKind: L.kind,
          pen,
          gross: out.gross,
          net: out.net,
          reason: out.reason,
          mfe: out.mfe,
          mae: out.mae,
        });
      }
    }
  }
  return rows;
}

function statsOf(nets: number[]) {
  const n = nets.length;
  const mean = n ? nets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(nets.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, win: n ? nets.filter((x) => x > 0).length / n : 0, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

function line(label: string, rows: Row[]) {
  const s = statsOf(rows.map((r) => r.net));
  console.log(
    `  ${label.padEnd(26)} n=${pad(s.n, 4)}  ${pad(pct(s.mean), 8)}  胜率 ${pad(pct(s.win), 7)}  t=${s.t.toFixed(2)}`,
  );
}

function main(rows: Row[]) {
  console.log(`\n总样本 ${rows.length}（两品种、三时段、两方向合计）`);
  console.log("\n=== 方向基线 ===");
  line("reversal (SFP 反转)", rows.filter((r) => r.bias === "reversal"));
  line("continuation (延续)", rows.filter((r) => r.bias === "continuation"));

  const gl = (label: string, rs: Row[]) => {
    const s = statsOf(rs.map((r) => r.gross));
    console.log(`  ${label.padEnd(26)} n=${pad(s.n, 4)}  ${pad(pct(s.mean), 8)}  胜率 ${pad(pct(s.win), 7)}  t=${s.t.toFixed(2)}`);
  };
  console.log("\n=== 毛收益（未扣成本，检验方向性边际本身）===");
  gl("reversal", rows.filter((r) => r.bias === "reversal"));
  gl("continuation", rows.filter((r) => r.bias === "continuation"));
  gl("全部", rows);

  console.log("\n=== reversal × 时段 ===");
  for (const s of ["亚洲盘", "伦敦盘", "纽约盘"]) {
    line(s, rows.filter((r) => r.bias === "reversal" && r.session === s));
  }
  console.log("\n=== continuation × 时段 ===");
  for (const s of ["亚洲盘", "伦敦盘", "纽约盘"]) {
    line(s, rows.filter((r) => r.bias === "continuation" && r.session === s));
  }

  console.log("\n=== 结构对齐（1h） ===");
  line("reversal 顺 1h 结构", rows.filter((r) => r.bias === "reversal" && r.align1h));
  line("reversal 逆 1h 结构", rows.filter((r) => r.bias === "reversal" && !r.align1h));
  line("continuation 顺 1h", rows.filter((r) => r.bias === "continuation" && r.align1h));
  line("continuation 逆 1h", rows.filter((r) => r.bias === "continuation" && !r.align1h));

  console.log("\n=== 溢价/折价 ===");
  line("reversal@premium", rows.filter((r) => r.bias === "reversal" && r.zone === "premium"));
  line("reversal@discount", rows.filter((r) => r.bias === "reversal" && r.zone === "discount"));

  console.log("\n=== 参考位类型 ===");
  for (const k of ["swing_high", "swing_low", "session_high", "session_low"]) {
    line(k, rows.filter((r) => r.levelKind === k));
  }

  console.log("\n=== 分品种 ===");
  for (const sym of SYMBOLS) {
    line(sym, rows.filter((r) => r.symbol === sym));
    line(`${sym} reversal`, rows.filter((r) => r.symbol === sym && r.bias === "reversal"));
    line(`${sym} continuation`, rows.filter((r) => r.symbol === sym && r.bias === "continuation"));
  }

  console.log("\n=== 前后半段（按时间，稳健性检查） ===");
  const sorted = [...rows].sort((a, b) => a.sigTs - b.sigTs);
  const cut = sorted[Math.floor(sorted.length * 0.7)]?.sigTs ?? 0;
  const first = sorted.filter((r) => r.sigTs < cut);
  const last = sorted.filter((r) => r.sigTs >= cut);
  line("前半（训练线）", first);
  line("后半（测试线）", last);
  line("前半 reversal", first.filter((r) => r.bias === "reversal"));
  line("后半 reversal", last.filter((r) => r.bias === "reversal"));

  const mfeAvg = rows.reduce((a, r) => a + r.mfe, 0) / rows.length;
  const maeAvg = rows.reduce((a, r) => a + r.mae, 0) / rows.length;
  console.log(`\n平均 MFE ${pct(mfeAvg)}  平均 MAE ${pct(maeAvg)}（含两个方向）`);
}

async function mainAsync() {
  const all: Row[] = [];
  for (const sym of SYMBOLS) {
    console.log(`拉取 ${sym} 15m 历史…`);
    const c15 = await fetchHistory(contractOf("gate", sym), "15m", LOOKBACK_POINTS);
    console.log(`  ${sym}: ${c15.length} 根（${new Date(c15[0].t * 1000).toISOString().slice(0, 10)} ~ ${new Date(c15[c15.length - 1].t * 1000).toISOString().slice(0, 10)}）`);
    const rows = simulate(sym, c15);
    console.log(`  ${sym}: ${rows.length} 条信号`);
    all.push(...rows);
  }
  main(all);
}

await mainAsync();
