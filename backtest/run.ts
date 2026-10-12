// 回测：当前 4 条规则（Gate BTC/XAU，前时段 high/low，15m 突破）。
// 用与生产相同的判定逻辑（gate:scanBreakout + 前时段取值），统计信号后的前瞻收益。
// 含：动量/反转对照、组合策略、影线逆势 + maker 成本 + 止损止盈网格。
//
// 运行：./node_modules/.bin/esbuild backtest/run.ts --bundle --platform=node --format=esm \
//        --outfile=/tmp/bt.mjs && node /tmp/bt.mjs

import {
  currentSessionName,
  inWindow,
  tzMinutes,
  scanBreakout,
  SESSIONS,
  SESSION_PREV,
  type Side,
  type SignalKind,
  type Candle,
} from "../convex/gate";
import { contractOf } from "../convex/exchanges";
import { fetchHistory, fetchFundingMean } from "./history";

const INTERVAL = "15m";
const SEC = 900;
const LOOKBACK_POINTS = 9600; // 约 100 天
const SYMBOLS = ["BTC", "XAU"];
const HORIZONS_H = [1, 2, 4, 8, 24];

// 成本口径（单边，bps）
const TAKER_BPS = 5; // 市价/taker 手续费
const MAKER_BPS = 2; // 限价/maker 手续费
const SLIP_BPS = 2; // 市价滑点
const COST_TAKER = (2 * (TAKER_BPS + SLIP_BPS)) / 10000; // 14bps：双边市价
const COST_MIXED = (MAKER_BPS + TAKER_BPS + SLIP_BPS) / 10000; // 9bps：限价进、市价出
const COST_MAKER = (2 * MAKER_BPS) / 10000; // 4bps：双边限价
const COST = COST_TAKER; // 默认基准（保持前几节口径一致）

// 影线逆势专用：限价挂在关键位入场
const WICKFADE_TARGET_COST = (MAKER_BPS + MAKER_BPS) / 10000; // 止盈限价成交
const WICKFADE_STOP_COST = (MAKER_BPS + TAKER_BPS + SLIP_BPS) / 10000; // 止损市价成交

// 各标的资金费均值（每 8h 结算），main 启动时填充。
const FUNDING: Record<string, number> = {};

type Occ = { name: string; startT: number; endT: number; high: number; low: number };

type Event = {
  symbol: string;
  isUp: boolean;
  kind: SignalKind;
  ts: number;
  level: number;
  entryPrice: number;
  entryTs: number;
};

const pad = (n: number, w = 4) => String(n).padStart(w);
const pct = (x: number) => (x * 100).toFixed(2) + "%";
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

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

// T 时刻的「前一时段」名（复用生产语义：有进行中时段取固定循环前一段；间隙取最近已结束时段）。
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

function simulate(symbol: string, candles: Candle[], occ: Occ[]): Event[] {
  const events: Event[] = [];
  const rules = [
    { field: "high" as const, isUp: true, level: undefined as number | undefined, side: undefined as Side | undefined, wickDone: false },
    { field: "low" as const, isUp: false, level: undefined as number | undefined, side: undefined as Side | undefined, wickDone: false },
  ];
  for (const cd of candles) {
    const T = cd.t;
    const tname = targetSession(T, occ);
    if (!tname) continue;
    const o = latestOcc(occ, tname, T);
    if (!o) continue;
    for (const r of rules) {
      const level = r.field === "high" ? o.high : o.low;
      const rearm = r.level === undefined || Math.abs(r.level - level) > 1e-9;
      if (rearm) {
        r.level = level;
        r.side = cd.c >= level ? "above" : "below";
        r.wickDone = false;
        continue;
      }
      const res = scanBreakout([cd], level, r.isUp, r.side, r.wickDone);
      r.level = level;
      r.side = res.side;
      r.wickDone = res.wickDone;
      for (const ev of res.events) {
        const entryPrice = ev.kind === "body" ? cd.c : level;
        const entryTs = ev.kind === "body" ? cd.t + SEC : cd.t;
        events.push({ symbol, isUp: r.isUp, kind: ev.kind, ts: cd.t, level, entryPrice, entryTs });
      }
    }
  }
  return events;
}

function idxAtOrAfter(candles: Candle[], ts: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (candles[m].t < ts) lo = m + 1;
    else hi = m;
  }
  return lo;
}

type Outcome = { gross: number; net: number; mfe: number; mae: number };

function forward(candles: Candle[], e: Event, H: number): Outcome | null {
  const endT = e.entryTs + H * 3600;
  const i0 = idxAtOrAfter(candles, e.entryTs);
  if (i0 >= candles.length) return null;
  const dir = e.isUp ? 1 : -1;
  const P0 = e.entryPrice;
  let mfe = 0;
  let mae = 0;
  let lastClose: number | null = null;
  for (let i = i0; i < candles.length; i++) {
    const cd = candles[i];
    if (cd.t > endT) break;
    lastClose = cd.c;
    const hi = ((cd.h - P0) / P0) * dir;
    const lo = ((cd.l - P0) / P0) * dir;
    mfe = Math.max(mfe, hi, lo);
    mae = Math.min(mae, hi, lo);
  }
  if (lastClose === null) return null;
  const gross = ((lastClose - P0) / P0) * dir;
  return { gross, net: gross - COST, mfe, mae };
}

// reversal=true 时按「反向」方向结算（突破方向取负）。
function groupStats(evs: Event[], series: Record<string, Candle[]>, title: string, reversal = false) {
  if (evs.length === 0) {
    console.log(`\n=== ${title} ===  (无样本)`);
    return;
  }
  console.log(`\n=== ${title} ===  样本 ${evs.length}`);
  for (const H of HORIZONS_H) {
    const outs: Outcome[] = [];
    for (const e of evs) {
      const o = forward(series[e.symbol], e, H);
      if (o) outs.push(o);
    }
    if (!outs.length) continue;
    const sign = reversal ? -1 : 1;
    const grossArr = outs.map((o) => sign * o.gross);
    const nets = grossArr.map((g) => g - COST);
    const wins = nets.filter((x) => x > 0).length;
    const mfes = outs.map((o) => (reversal ? -o.mae : o.mfe));
    const maes = outs.map((o) => (reversal ? -o.mfe : o.mae));
    console.log(
      `  +${pad(H, 2)}h  n=${pad(outs.length, 3)}  毛均 ${pct(avg(grossArr)).padStart(8)}  ` +
        `净均 ${pct(avg(nets)).padStart(8)}  胜率 ${pct(wins / nets.length).padStart(7)}  ` +
        `MFE ${pct(avg(mfes)).padStart(7)}  MAE ${pct(avg(maes)).padStart(7)}`,
    );
  }
}

// 组合策略：实体突破→顺势（sign +1），影线突破→逆势（sign -1）。
function portfolioStats(
  evs: Event[],
  series: Record<string, Candle[]>,
  title: string,
  signOf: (e: Event) => number,
) {
  if (evs.length === 0) {
    console.log(`\n=== ${title} ===  (无样本)`);
    return;
  }
  console.log(`\n=== ${title} ===  样本 ${evs.length}`);
  for (const H of HORIZONS_H) {
    const grossArr: number[] = [];
    const mfes: number[] = [];
    const maes: number[] = [];
    for (const e of evs) {
      const o = forward(series[e.symbol], e, H);
      if (!o) continue;
      const sign = signOf(e);
      grossArr.push(sign * o.gross);
      mfes.push(sign > 0 ? o.mfe : -o.mae);
      maes.push(sign > 0 ? o.mae : -o.mfe);
    }
    if (!grossArr.length) continue;
    const nets = grossArr.map((g) => g - COST);
    const wins = nets.filter((x) => x > 0).length;
    const totalNet = nets.reduce((a, b) => a + b, 0);
    console.log(
      `  +${pad(H, 2)}h  n=${pad(grossArr.length, 3)}  毛均 ${pct(avg(grossArr)).padStart(8)}  ` +
        `净均 ${pct(avg(nets)).padStart(8)}  胜率 ${pct(wins / nets.length).padStart(7)}  ` +
        `MFE ${pct(avg(mfes)).padStart(7)}  MAE ${pct(avg(maes)).padStart(7)}  ` +
        `累计净 ${pct(totalNet).padStart(8)}`,
    );
  }
}

/* ================= 影线逆势 + 成本敏感性 + 止损止盈 ================= */

// 固定持有期下，影线逆势在不同成本假设下的净收益。
function fixedHorizonCosts(evs: Event[], series: Record<string, Candle[]>, title: string) {
  console.log(`\n=== ${title} ===  样本 ${evs.length}`);
  const costs: [string, number][] = [
    ["双边市价 14bps", COST_TAKER],
    ["限价进/市价出 9bps", COST_MIXED],
    ["双边限价 4bps", COST_MAKER],
  ];
  for (const H of HORIZONS_H) {
    const gross: number[] = [];
    for (const e of evs) {
      const o = forward(series[e.symbol], e, H);
      if (o) gross.push(-o.gross); // 逆势
    }
    if (!gross.length) continue;
    const g = avg(gross);
    const cells = costs
      .map(([name, c]) => `${name}=${pct(g - c)}`)
      .join("  ");
    console.log(`  +${pad(H, 2)}h  毛均 ${pct(g).padStart(8)}  |  ${cells}`);
  }
}

type TradeResult = { r: number; net: number; hit: "stop" | "target" | "timeout" } | null;

// 影线逆势：限价挂在关键位入场；随后用止损/止盈管理，未触发则到期市价平仓。
function simTrade(
  candles: Candle[],
  e: Event,
  sl: number,
  tp: number,
  H: number,
  targetCost = WICKFADE_TARGET_COST,
  stopCost = WICKFADE_STOP_COST,
): TradeResult {
  const entry = e.entryPrice;
  const short = e.isUp; // 影线上破→做空；影线下破→做多
  const dir = short ? -1 : 1;
  // 资金费：多头付、空头收（费率>0）；按持有上限 H 近似结算次数。
  const funding = (FUNDING[e.symbol] ?? 0) * dir * (H / 8);
  const endT = e.entryTs + H * 3600;
  const i0 = idxAtOrAfter(candles, e.entryTs); // 含信号 K 线
  const stopPrice = short ? entry * (1 + sl) : entry * (1 - sl);
  const tgtPrice = short ? entry * (1 - tp) : entry * (1 + tp);
  let lastClose: number | null = null;
  for (let i = i0; i < candles.length; i++) {
    const cd = candles[i];
    if (cd.t > endT) break;
    const hitStop = short ? cd.h >= stopPrice : cd.l <= stopPrice;
    if (cd.t === e.ts) {
      // 信号 K 线：影线极值必然发生在入场之后，只判止损（保守）；不判止盈（极值/回撤时序不确定）。
      if (hitStop) return { r: -sl, net: -sl - stopCost - funding, hit: "stop" };
      continue;
    }
    lastClose = cd.c;
    const hitTgt = short ? cd.l <= tgtPrice : cd.h >= tgtPrice;
    if (hitStop) return { r: -sl, net: -sl - stopCost - funding, hit: "stop" };
    if (hitTgt) return { r: tp, net: tp - targetCost - funding, hit: "target" };
  }
  if (lastClose === null) return null;
  const raw = short ? (entry - lastClose) / entry : (lastClose - entry) / entry;
  return { r: raw, net: raw - stopCost - funding, hit: "timeout" };
}

function wickFadeGrid(
  evs: Event[],
  series: Record<string, Candle[]>,
  title: string,
  targetCost = WICKFADE_TARGET_COST,
  stopCost = WICKFADE_STOP_COST,
) {
  const TP = [0.002, 0.003, 0.004, 0.006, 0.008, 0.012];
  const SL = [0.002, 0.003, 0.004, 0.005, 0.008];
  console.log(`\n=== ${title} · 止损止盈网格 ===  样本 ${evs.length}`);
  for (const H of [4, 8, 24]) {
    const rows: { sl: number; tp: number; n: number; win: number; net: number; sum: number; stop: number; tgt: number }[] = [];
    for (const sl of SL) {
      for (const tp of TP) {
        if (tp <= sl) continue; // 赔率至少 1:1
        let n = 0;
        let wins = 0;
        let sum = 0;
        let stopN = 0;
        let tgtN = 0;
        for (const e of evs) {
          const t = simTrade(series[e.symbol], e, sl, tp, H, targetCost, stopCost);
          if (!t) continue;
          n++;
          sum += t.net;
          if (t.net > 0) wins++;
          if (t.hit === "stop") stopN++;
          if (t.hit === "target") tgtN++;
        }
        if (!n) continue;
        rows.push({ sl, tp, n, win: wins / n, net: sum / n, sum, stop: stopN / n, tgt: tgtN / n });
      }
    }
    rows.sort((a, b) => b.net - a.net);
    console.log(`  --- 持有上限 ${H}h（按净均排序，前 3） ---`);
    for (const r of rows.slice(0, 3)) {
      console.log(
        `    SL ${pct(r.sl).padStart(6)}  TP ${pct(r.tp).padStart(6)}  n=${pad(r.n, 3)}  ` +
          `胜率 ${pct(r.win).padStart(6)}  净均 ${pct(r.net).padStart(7)}  累计净 ${pct(r.sum).padStart(8)}  ` +
          `止损 ${pct(r.stop).padStart(6)}/止盈 ${pct(r.tgt).padStart(6)}`,
      );
    }
  }
}

/* ================= 下一根 K 线确认 ================= */

type ConfirmMode = "next_close_dir" | "no_new_extreme" | "two_bars_dir";

// 对影线信号做「下一根 K 线确认」过滤：通过则把入场推迟到确认 K 线收盘（市价）。
// 返回新的事件列表（实体信号原样保留）。
function applyConfirmation(evs: Event[], series: Record<string, Candle[]>, mode: ConfirmMode): Event[] {
  const idxMap: Record<string, Map<number, number>> = {};
  for (const sym of Object.keys(series)) {
    const m = new Map<number, number>();
    series[sym].forEach((c, i) => m.set(c.t, i));
    idxMap[sym] = m;
  }
  const out: Event[] = [];
  for (const e of evs) {
    if (e.kind !== "wick") {
      out.push(e);
      continue;
    }
    const c = series[e.symbol];
    const m = idxMap[e.symbol];
    const i = m.get(e.ts);
    if (i === undefined || i + 2 >= c.length) continue;
    const short = e.isUp; // 影线上破→做空
    const n0 = c[i];
    const n1 = c[i + 1];
    const n2 = c[i + 2];
    let ok = false;
    if (mode === "next_close_dir") {
      ok = short ? n1.c < n0.c : n1.c > n0.c;
    } else if (mode === "no_new_extreme") {
      ok = short ? n1.h < n0.h : n1.l > n0.l;
    } else {
      ok = short ? n1.c < n0.c && n2.c < n1.c : n1.c > n0.c && n2.c > n1.c;
    }
    if (!ok) continue;
    // 确认 K 线（next_close_dir / no_new_extreme 用第 1 根；two_bars_dir 用第 2 根）收盘市价入场
    const entryCandle = mode === "two_bars_dir" ? n2 : n1;
    out.push({ ...e, entryPrice: entryCandle.c, entryTs: entryCandle.t + SEC });
  }
  return out;
}

// 确认后固定持有期的毛/净（市价进、市价出 14bps），并给出胜率。
function confirmSummary(evs: Event[], series: Record<string, Candle[]>, title: string) {
  console.log(`\n=== ${title} ===  样本 ${evs.length}`);
  for (const H of [2, 4, 8]) {
    const gross: number[] = [];
    for (const e of evs) {
      const o = forward(series[e.symbol], e, H);
      if (o) gross.push(-o.gross); // 逆势方向
    }
    if (!gross.length) continue;
    const g = avg(gross);
    const net = gross.map((x) => x - COST_TAKER);
    const w = net.filter((x) => x > 0).length / net.length;
    console.log(`  +${pad(H, 2)}h  毛均 ${pct(g).padStart(8)}  净均(14bps) ${pct(avg(net)).padStart(8)}  胜率 ${pct(w).padStart(6)}`);
  }
}

/* ================= 影线逆势 · 刺破幅度过滤（不延迟入场） ================= */

function idxMaps(series: Record<string, Candle[]>): Record<string, Map<number, number>> {
  const out: Record<string, Map<number, number>> = {};
  for (const sym of Object.keys(series)) {
    const m = new Map<number, number>();
    series[sym].forEach((c, i) => m.set(c.t, i));
    out[sym] = m;
  }
  return out;
}

// 刺破幅度 = 影线超过关键位相对比例。keep 由 pred 决定。
function filterByPenetration(
  evs: Event[],
  series: Record<string, Candle[]>,
  maxPen: number | null,
  minPen = 0,
): Event[] {
  const maps = idxMaps(series);
  const out: Event[] = [];
  for (const e of evs) {
    if (e.kind !== "wick") continue;
    const c = series[e.symbol];
    const i = maps[e.symbol].get(e.ts);
    if (i === undefined) continue;
    const n0 = c[i];
    const pen = e.isUp ? (n0.h - e.level) / e.level : (e.level - n0.l) / e.level;
    if (pen < 0) continue;
    if (maxPen !== null && pen > maxPen) continue;
    if (pen < minPen) continue;
    out.push(e);
  }
  return out;
}

/* ================= 滚动样本外 ================= */

type Config = { penMin: number; sl: number; tp: number; H: number };
type Stats = { n: number; net: number; win: number; sum: number; sd: number; t: number };

// 某配置下的每笔净收益序列。
function tradeNets(ents: Event[], series: Record<string, Candle[]>, cfg: Config): number[] {
  const f = cfg.penMin > 0 ? filterByPenetration(ents, series, null, cfg.penMin) : ents;
  const out: number[] = [];
  for (const e of f) {
    const t = simTrade(series[e.symbol], e, cfg.sl, cfg.tp, cfg.H);
    if (t) out.push(t.net);
  }
  return out;
}

// 汇总为一个配置的统计（含样本标准差 sd 与 t = mean / (sd/√n)）。
function statsOf(nets: number[]): Stats {
  const n = nets.length;
  const sum = nets.reduce((a, b) => a + b, 0);
  const net = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(nets.reduce((a, x) => a + (x - net) ** 2, 0) / (n - 1)) : 0;
  const wins = nets.filter((x) => x > 0).length;
  const t = n > 1 && sd > 0 ? net / (sd / Math.sqrt(n)) : 0;
  return { n, net, win: n ? wins / n : 0, sum, sd, t };
}

function evalConfig(ents: Event[], series: Record<string, Candle[]>, cfg: Config): Stats {
  return statsOf(tradeNets(ents, series, cfg));
}

const PEN_GRID = [0, 0.0005, 0.001, 0.002, 0.003];
const SL_GRID = [0.003, 0.004, 0.005];
const TP_GRID = [0.004, 0.006, 0.008];
const H_GRID = [4, 8];

// 在给定（训练）样本上按净均选最优配置；返回试过的组合数以便披露多重检验规模。
function selectBest(train: Event[], series: Record<string, Candle[]>): { best: { cfg: Config; stats: Stats } | null; tried: number } {
  let best: { cfg: Config; stats: Stats } | null = null;
  let tried = 0;
  for (const penMin of PEN_GRID) {
    for (const sl of SL_GRID) {
      for (const tp of TP_GRID) {
        if (tp <= sl) continue;
        for (const H of H_GRID) {
          tried++;
          const cfg: Config = { penMin, sl, tp, H };
          const st = evalConfig(train, series, cfg);
          if (st.n < 15) continue;
          if (!best || st.net > best.stats.net) best = { cfg, stats: st };
        }
      }
    }
  }
  return { best, tried };
}

function walkForward(ents: Event[], series: Record<string, Candle[]>, title: string, K = 4) {
  const sorted = [...ents].sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) {
    console.log(`\n=== ${title} · 滚动样本外 ===  (无样本)`);
    return;
  }
  const tmin = sorted[0].ts;
  const tmax = sorted[sorted.length - 1].ts;
  const span = Math.max(1, tmax - tmin);
  const blocks: Event[][] = Array.from({ length: K }, () => []);
  for (const e of sorted) {
    const idx = Math.min(K - 1, Math.floor(((e.ts - tmin) / span) * K));
    blocks[idx].push(e);
  }
  console.log(`\n=== ${title} · 滚动样本外（扩窗 K=${K}） ===`);
  const oosNets: number[] = [];
  let tried = 0;
  let foldPositive = 0;
  let folds = 0;
  for (let k = 1; k < K; k++) {
    const train = blocks.slice(0, k).flat();
    const test = blocks[k];
    const sel = selectBest(train, series);
    tried = sel.tried;
    if (!sel.best) {
      console.log(`  fold ${k}: 训练样本不足（跳过）`);
      continue;
    }
    const nets = tradeNets(test, series, sel.best.cfg);
    oosNets.push(...nets);
    folds++;
    const te = statsOf(nets);
    if (te.net > 0) foldPositive++;
    console.log(
      `  fold ${k}: 选参 pen≥${pct(sel.best.cfg.penMin)} SL${pct(sel.best.cfg.sl)} TP${pct(sel.best.cfg.tp)} H${sel.best.cfg.H}h` +
        `  | 训练 n=${pad(sel.best.stats.n, 3)} 净均 ${pct(sel.best.stats.net).padStart(7)}` +
        `  || 测试 n=${pad(te.n, 3)} 净均 ${pct(te.net).padStart(7)} 胜率 ${pct(te.win).padStart(6)} t=${te.t.toFixed(2)}`,
    );
  }
  const pooled = statsOf(oosNets);
  console.log(
    `  —— 样本外汇总：n=${pooled.n}  净均 ${pct(pooled.net)}  胜率 ${pct(pooled.win)}  累计净 ${pct(pooled.sum)}` +
      `  t=${pooled.t.toFixed(2)}  （每折试 ${tried} 组 · 正收益折 ${foldPositive}/${folds}）`,
  );
}

// 真·嵌套样本外：仅用前 split 段选参，后段从未参与选参，再评一次。
function nestedHoldout(ents: Event[], series: Record<string, Candle[]>, title: string, split = 0.7) {
  const sorted = [...ents].sort((a, b) => a.ts - b.ts);
  const cut = Math.floor(sorted.length * split);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  const { best, tried } = selectBest(train, series);
  if (!best) {
    console.log(`\n=== ${title} · 嵌套样本外 ===  (训练样本不足)`);
    return;
  }
  const te = evalConfig(test, series, best.cfg);
  console.log(
    `\n=== ${title} · 嵌套样本外（前 ${Math.round(split * 100)}% 选参，后段未参与选择） ===\n` +
      `  选定 pen≥${pct(best.cfg.penMin)} SL${pct(best.cfg.sl)} TP${pct(best.cfg.tp)} H${best.cfg.H}h（共试 ${tried} 组）\n` +
      `  训练 n=${pad(best.stats.n, 3)} 净均 ${pct(best.stats.net).padStart(7)} t=${best.stats.t.toFixed(2)}\n` +
      `  测试 n=${pad(te.n, 3)} 净均 ${pct(te.net).padStart(7)} 胜率 ${pct(te.win).padStart(6)} t=${te.t.toFixed(2)}`,
  );
}

async function main() {
  const series: Record<string, Candle[]> = {};
  const events: Event[] = [];

  for (const sym of SYMBOLS) {
    const candles = await fetchHistory(contractOf("gate", sym), INTERVAL, LOOKBACK_POINTS);
    series[sym] = candles;
    FUNDING[sym] = await fetchFundingMean(contractOf("gate", sym));
    const occ = buildOccurrences(candles);
    const evs = simulate(sym, candles, occ);
    const from = candles.length ? new Date(candles[0].t * 1000).toISOString().slice(0, 10) : "-";
    const to = candles.length
      ? new Date(candles[candles.length - 1].t * 1000).toISOString().slice(0, 10)
      : "-";
    console.log(
      `[${sym}] 15m ${candles.length} 根  ${from} ~ ${to}  信号 ${evs.length} 条  ` +
        `资金费均值 ${(FUNDING[sym] * 100).toFixed(4)}%/8h`,
    );
    events.push(...evs);
  }

  const allCandles: Record<string, Candle[]> = series;

  console.log("\n################ 顺突破方向（动量） ################");
  for (const sym of SYMBOLS) {
    const s = events.filter((e) => e.symbol === sym);
    groupStats(s.filter((e) => e.kind === "body"), series, `${sym} 实体突破`);
    groupStats(s.filter((e) => e.kind === "wick"), series, `${sym} 影线突破`);
  }
  groupStats(events.filter((e) => e.kind === "body"), allCandles, "全部 实体突破");
  groupStats(events.filter((e) => e.kind === "wick"), allCandles, "全部 影线突破");

  console.log("\n################ 反向（影线视作假突破/反转） ################");
  groupStats(events.filter((e) => e.kind === "body"), allCandles, "全部 实体突破 反向", true);
  groupStats(events.filter((e) => e.kind === "wick"), allCandles, "全部 影线突破 反向", true);

  console.log("\n################ 组合策略：实体顺势 + 影线逆势 ################");
  const bodyFollowWickFade = (e: Event) => (e.kind === "body" ? 1 : -1);
  portfolioStats(events, allCandles, "全部 实体顺势 + 影线逆势", bodyFollowWickFade);
  for (const sym of SYMBOLS) {
    const s = events.filter((e) => e.symbol === sym);
    portfolioStats(s, series, `${sym} 实体顺势 + 影线逆势`, bodyFollowWickFade);
  }
  portfolioStats(events.filter((e) => e.kind === "body"), allCandles, "仅实体顺势", () => 1);
  portfolioStats(events.filter((e) => e.kind === "wick"), allCandles, "仅影线逆势", () => -1);

  console.log("\n################ 影线逆势 · 成本敏感性 ################");
  const wick = events.filter((e) => e.kind === "wick");
  fixedHorizonCosts(wick, allCandles, "全部影线逆势");
  fixedHorizonCosts(wick.filter((e) => e.symbol === "BTC"), series, "BTC 影线逆势");
  fixedHorizonCosts(wick.filter((e) => e.symbol === "XAU"), series, "XAU 影线逆势");

  console.log("\n################ 影线逆势 · 止损止盈网格 ################");
  wickFadeGrid(wick, allCandles, "全部影线逆势");

  console.log("\n################ 影线逆势 · 下一根 K 线确认 ################");
  const modes: ConfirmMode[] = ["next_close_dir", "no_new_extreme", "two_bars_dir"];
  const MODE_CN: Record<ConfirmMode, string> = {
    next_close_dir: "确认①下一根收盘同向",
    no_new_extreme: "确认②下一根不创新极值",
    two_bars_dir: "确认③连续两根同向",
  };
  for (const mode of modes) {
    const conf = applyConfirmation(wick, allCandles, mode);
    const pctKeep = ((conf.length / wick.length) * 100).toFixed(0);
    confirmSummary(conf, allCandles, `${MODE_CN[mode]}（保留 ${conf.length}/${wick.length}=${pctKeep}%）`);
  }
  // 挑一个确认模式跑止损止盈网格（市价进 → 止盈8bps/止损14bps）
  const confA = applyConfirmation(wick, allCandles, "next_close_dir");
  wickFadeGrid(confA, allCandles, "确认①下一根收盘同向 · 市价进", (MAKER_BPS + TAKER_BPS + SLIP_BPS) / 10000, COST_TAKER);

  console.log("\n################ 影线逆势 · 刺破幅度过滤（不延迟入场） ################");
  const penCuts: [string, number | null, number][] = [
    ["刺破 ≤ 0.05%", 0.0005, 0],
    ["刺破 ≤ 0.10%", 0.001, 0],
    ["刺破 ≤ 0.20%", 0.002, 0],
    ["刺破 0.10%~0.50%", 0.005, 0.001],
    ["刺破 ≥ 0.20%", null, 0.002],
    ["刺破 ≥ 0.50%", null, 0.005],
  ];
  for (const [name, maxPen, minPen] of penCuts) {
    const f = filterByPenetration(wick, allCandles, maxPen, minPen);
    const keep = ((f.length / wick.length) * 100).toFixed(0);
    confirmSummary(f, allCandles, `${name}（保留 ${f.length}/${wick.length}=${keep}%）`);
  }

  console.log("\n################ 影线逆势 · 刺破≥0.20% + 止损止盈 ################");
  const deep = filterByPenetration(wick, allCandles, null, 0.002);
  wickFadeGrid(deep, allCandles, "刺破≥0.20%（限价进）");
  for (const sym of SYMBOLS) {
    wickFadeGrid(
      deep.filter((e) => e.symbol === sym),
      series,
      `刺破≥0.20% · ${sym}（限价进）`,
    );
  }

  console.log("\n################ 滚动样本外 / 时间切分（含资金费） ################");
  walkForward(wick, allCandles, "影线逆势 全部", 4);
  nestedHoldout(wick, allCandles, "影线逆势 全部");
  const btcWick = wick.filter((e) => e.symbol === "BTC");
  walkForward(btcWick, series, "影线逆势 BTC", 4);
  nestedHoldout(btcWick, series, "影线逆势 BTC");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
