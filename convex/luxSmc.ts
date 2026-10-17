// LuxAlgo「Smart Money Concepts (SMC)」定义的纯逻辑移植（无 Convex 依赖）。
//
// 移植自官方开源 Pine 脚本（CC BY-NC-SA 4.0，© LuxAlgo，
// 「Smart Money Concepts [LuxAlgo]」）。逐条对照原脚本，保持同一套判定：
//  - 摆动点：leg(size) —— high[size] > highest(size) 视为新腿高点、low[size] < lowest(size) 为新腿低点；
//      leg 由 0(空腿) 翻 1(多腿) = 刚确认一个摆动低点，1→0 = 刚确认一个摆动高点。
//      摆动结构 size=50，内部结构 size=5。
//  - 结构 BOS/CHoCH：收盘价「上穿/下穿」最近一个尚未被穿过的摆动高/低点。
//      上穿时若原趋势为跌 → CHoCH，否则 → BOS（反之亦然）。
//  - 订单块(OB)：发生结构突破时，在「该摆动点 bar 索引 → 当前 bar」区间内，
//      看涨取 parsedLow 最小者、看跌取 parsedHigh 最大者所在的整根 K。
//      parsedHigh/Low 含「高波动 K」过滤：(high-low) ≥ 2×波动率时把高低互换。
//      波动率 = ATR(200)（或累积平均区间）。OB 右侧延伸至被「缓解」为止。
//  - FVG：low[0] > high[2] 且 close[1] > high[2] 且 中间 K 实体% > 自适应阈值（看涨）；
//      看跌对称。被回补(low < bottom / high > top) 后移除。
//  - EQH/EQL：size=3 的摆动高/低，相邻两个价位差 < 0.1×ATR 视为等高等低。
//  - 溢价/折价区：由 trailing 极值（最近摆动高/低并不断被新高/低刷新）划分
//      溢价(顶5%)、均衡(0.525/0.475 带)、折价(底5%)。
//  - 强/弱高、强/弱低：trailing 高/低按当前摆动结构方向标注。

import type { Candle } from "./exchanges";

export const SWING_LEN = 8; // 摆动结构 size
export const INTERNAL_LEN = 4; // 内部结构 size
export const EQ_LEN = 3; // 等高等低 size（equalHighsLowsLengthInput 默认 3）
export const EQ_THRESHOLD = 0.1; // 等高等低阈值（×ATR200）
export const ATR_LEN = 200;

export type Bias = "bull" | "bear";
export type Tag = "BOS" | "CHoCH";

export type Pivot = {
  idx: number;
  t: number;
  price: number;
  prevPrice: number; // 同类上一个摆动点价位
};

export type StructBreak = {
  idx: number;
  t: number;
  dir: Bias;
  tag: Tag;
  // level 与 anchor 含义不同，勿混用：
  //   level  = 本次 BOS/CHoCH 的「突破位」= 被上/下穿的摆动高/低点（做多=前高，做空=前低），用于展示突破价位。
  //   anchor = 定方向的结构「锚点」= 突破前最后一个反向摆动点（做多=Higher Low 摆动低，做空=Lower High 摆动高），
  //            用于判定结构失效（价格反向收盘穿过锚点）。
  level: number;
  anchor: number;
  pivotIdx: number;
  pivotT: number;
};

export type OrderBlock = {
  idx: number;
  t: number;
  high: number;
  low: number;
  bias: Bias;
  mitigatedIdx: number | null;
  mitigatedT: number | null;
};

export type Fvg = {
  idx: number;
  t: number; // 形成 K（第 3 根）的时间
  top: number;
  bottom: number;
  dir: Bias;
  mitigatedIdx: number | null;
};

export type Trend = Bias | "range";

export type StructureResult = {
  size: number;
  highs: Pivot[];
  lows: Pivot[];
  breaks: StructBreak[];
  orderBlocks: OrderBlock[];
  trendAtEnd: Trend;
};

// ---- 基础指标 ----

function trueRange(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out.push(c.h - c.l);
      continue;
    }
    const pc = candles[i - 1].c;
    out.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
  }
  return out;
}

// Wilder RMA（等价 Pine ta.rma / ta.atr 的平滑方式）
export function atr(candles: Candle[], period: number): number[] {
  const tr = trueRange(candles);
  const out: number[] = new Array(candles.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      sum += tr[i];
      if (i === period - 1) out[i] = sum / period;
      continue;
    }
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  // 数据不足 period 时，退化为到目前位置的均值，避免 NaN 断链
  if (candles.length < period) {
    let acc = 0;
    for (let i = 0; i < candles.length; i++) {
      acc += tr[i];
      out[i] = acc / (i + 1);
    }
  }
  let last = NaN;
  for (let i = 0; i < candles.length; i++) {
    if (!isNaN(out[i])) last = out[i];
    else if (!isNaN(last)) out[i] = last; // 前段用首个可用值回填
  }
  return out;
}

function cumulativeMeanRange(candles: Candle[]): number[] {
  // Pine: ta.cum(ta.tr) / bar_index
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr =
      i === 0
        ? c.h - c.l
        : Math.max(
            c.h - c.l,
            Math.abs(c.h - candles[i - 1].c),
            Math.abs(c.l - candles[i - 1].c),
          );
    acc += tr;
    out.push(i === 0 ? tr : acc / i);
  }
  return out;
}

// ---- 摆动点（leg） ----

type LegState = { leg: number };

// 单一 size 的 leg 序列：返回每根 K 的 leg 值（0 空腿 / 1 多腿）
function legSeries(candles: Candle[], size: number): number[] {
  const n = candles.length;
  const legs: number[] = new Array(n).fill(0);
  let leg = 0;
  for (let i = 0; i < n; i++) {
    if (i >= size) {
      let hiMax = -Infinity;
      let loMin = Infinity;
      for (let k = 0; k < size; k++) {
        const b = candles[i - k];
        if (b.h > hiMax) hiMax = b.h;
        if (b.l < loMin) loMin = b.l;
      }
      const newLegHigh = candles[i - size].h > hiMax;
      const newLegLow = candles[i - size].l < loMin;
      if (newLegHigh) leg = 0;
      else if (newLegLow) leg = 1;
    }
    legs[i] = leg;
  }
  return legs;
}

// 结构（摆动点 + BOS/CHoCH + 订单块）
export function runStructure(
  candles: Candle[],
  size: number,
  obFilter: "atr" | "range" = "atr",
  mitigation: "wick" | "close" = "wick",
): StructureResult {
  const n = candles.length;
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  const breaks: StructBreak[] = [];
  const orderBlocks: OrderBlock[] = [];
  const legs = legSeries(candles, size);

  const atrArr = atr(candles, ATR_LEN);
  const cmrArr = cumulativeMeanRange(candles);
  const volAt = (i: number) => (obFilter === "atr" ? atrArr[i] : cmrArr[i]);
  const parsedHigh = (i: number) => {
    const c = candles[i];
    const hv = c.h - c.l >= 2 * (isNaN(volAt(i)) ? Infinity : volAt(i));
    return hv ? c.l : c.h;
  };
  const parsedLow = (i: number) => {
    const c = candles[i];
    const hv = c.h - c.l >= 2 * (isNaN(volAt(i)) ? Infinity : volAt(i));
    return hv ? c.h : c.l;
  };

  let curHigh = { level: NaN, idx: -1, t: 0, crossed: false, prev: NaN };
  let curLow = { level: NaN, idx: -1, t: 0, crossed: false, prev: NaN };
  let trend: Trend = "range";
  let prevClose = NaN;

  for (let i = 0; i < n; i++) {
    if (i >= 1) {
      const changed = legs[i] !== legs[i - 1];
      if (changed) {
        if (legs[i] === 1) {
          // 刚确认一个摆动低点（位于 i-size）
          const bi = i - size;
          curLow = {
            level: candles[bi].l,
            idx: bi,
            t: candles[bi].t,
            crossed: false,
            prev: curLow.level,
          };
          lows.push({ idx: bi, t: candles[bi].t, price: candles[bi].l, prevPrice: curLow.prev });
        } else {
          const bi = i - size;
          curHigh = {
            level: candles[bi].h,
            idx: bi,
            t: candles[bi].t,
            crossed: false,
            prev: curHigh.level,
          };
          highs.push({ idx: bi, t: candles[bi].t, price: candles[bi].h, prevPrice: curHigh.prev });
        }
      }
    }

    const close = candles[i].c;
    // 看涨结构突破：收盘上穿摆动高点
    if (!isNaN(curHigh.level) && !isNaN(prevClose) && !curHigh.crossed && prevClose <= curHigh.level && close > curHigh.level) {
      const tag: Tag = trend === "bear" ? "CHoCH" : "BOS";
      curHigh.crossed = true;
      trend = "bull";
      breaks.push({ idx: i, t: candles[i].t, dir: "bull", tag, level: curHigh.level, anchor: lows.length ? lows[lows.length - 1].price : curLow.level, pivotIdx: curHigh.idx, pivotT: curHigh.t });
      orderBlocks.push(makeOrderBlock(candles, curHigh.idx, i, "bull", parsedHigh, parsedLow));
    }
    // 看跌结构突破：收盘下穿摆动低点
    if (!isNaN(curLow.level) && !isNaN(prevClose) && !curLow.crossed && prevClose >= curLow.level && close < curLow.level) {
      const tag: Tag = trend === "bull" ? "CHoCH" : "BOS";
      curLow.crossed = true;
      trend = "bear";
      breaks.push({ idx: i, t: candles[i].t, dir: "bear", tag, level: curLow.level, anchor: highs.length ? highs[highs.length - 1].price : curHigh.level, pivotIdx: curLow.idx, pivotT: curLow.t });
      orderBlocks.push(makeOrderBlock(candles, curLow.idx, i, "bear", parsedHigh, parsedLow));
    }
    prevClose = close;
  }

  // 订单块被缓解的时间：看涨 OB 当 low < OB.low；看跌 OB 当 high > OB.high
  for (const ob of orderBlocks) {
    for (let k = ob.idx + 1; k < n; k++) {
      const breached =
        mitigation === "close"
          ? ob.bias === "bull"
            ? candles[k].c < ob.low
            : candles[k].c > ob.high
          : ob.bias === "bull"
            ? candles[k].l < ob.low
            : candles[k].h > ob.high;
      if (breached) {
        ob.mitigatedIdx = k;
        ob.mitigatedT = candles[k].t;
        break;
      }
    }
  }

  return { size, highs, lows, breaks, orderBlocks, trendAtEnd: trend };
}

function makeOrderBlock(
  candles: Candle[],
  pivotIdx: number,
  breakIdx: number,
  bias: Bias,
  parsedHigh: (i: number) => number,
  parsedLow: (i: number) => number,
): OrderBlock {
  // 区间 [pivotIdx, breakIdx)（Pine slice 右端不含当前）
  const start = Math.max(0, pivotIdx);
  const end = breakIdx; // exclusive
  let bestIdx = start;
  if (bias === "bull") {
    let best = Infinity;
    for (let k = start; k < end; k++) {
      const v = parsedLow(k);
      if (v < best) {
        best = v;
        bestIdx = k;
      }
    }
  } else {
    let best = -Infinity;
    for (let k = start; k < end; k++) {
      const v = parsedHigh(k);
      if (v > best) {
        best = v;
        bestIdx = k;
      }
    }
  }
  return {
    idx: bestIdx,
    t: candles[bestIdx].t,
    high: parsedHigh(bestIdx),
    low: parsedLow(bestIdx),
    bias,
    mitigatedIdx: null,
    mitigatedT: null,
  };
}

// ---- FVG ----

export function computeFvgs(candles: Candle[]): Fvg[] {
  const n = candles.length;
  const out: Fvg[] = [];
  let cumAbs = 0; // ta.cum(|barDeltaPercent|)
  let count = 0;
  for (let i = 2; i < n; i++) {
    const prev = candles[i - 1]; // "last" bar in Pine
    const barDeltaPercent = (prev.c - prev.o) / (prev.o * 100);
    count++;
    cumAbs += Math.abs(barDeltaPercent);
    const threshold = (cumAbs / count) * 2; // ~ ta.cum(..)/bar_index*2
    const curLow = candles[i].l;
    const curHigh = candles[i].h;
    const last2High = candles[i - 2].h;
    const last2Low = candles[i - 2].l;
    const lastClose = prev.c;

    if (curLow > last2High && lastClose > last2High && barDeltaPercent > threshold) {
      out.push({ idx: i, t: candles[i].t, top: curLow, bottom: last2High, dir: "bull", mitigatedIdx: null });
    } else if (curHigh < last2Low && lastClose < last2Low && -barDeltaPercent > threshold) {
      out.push({ idx: i, t: candles[i].t, top: last2Low, bottom: curHigh, dir: "bear", mitigatedIdx: null });
    }
  }
  // 缓解检测
  for (const f of out) {
    for (let k = f.idx + 1; k < n; k++) {
      if (f.dir === "bull" ? candles[k].l < f.bottom : candles[k].h > f.top) {
        f.mitigatedIdx = k;
        break;
      }
    }
  }
  return out;
}

// ---- 等高等低 EQH/EQL ----

export type EqLine = { fromIdx: number; fromT: number; fromPrice: number; toIdx: number; toT: number; toPrice: number; kind: "EQH" | "EQL" };

export function computeEqhEql(
  candles: Candle[],
  size = EQ_LEN,
  threshold = EQ_THRESHOLD,
): EqLine[] {
  const n = candles.length;
  const legs = legSeries(candles, size);
  const atrArr = atr(candles, ATR_LEN);
  const out: EqLine[] = [];
  let curHigh = { level: NaN, idx: -1, t: 0 };
  let curLow = { level: NaN, idx: -1, t: 0 };
  for (let i = 1; i < n; i++) {
    if (legs[i] === legs[i - 1]) continue;
    const eps = threshold * atrArr[i];
    if (legs[i] === 1) {
      const bi = i - size;
      if (!isNaN(curLow.level) && !isNaN(eps) && Math.abs(curLow.level - candles[bi].l) < eps) {
        out.push({ fromIdx: curLow.idx, fromT: curLow.t, fromPrice: curLow.level, toIdx: bi, toT: candles[bi].t, toPrice: candles[bi].l, kind: "EQL" });
      }
      curLow = { level: candles[bi].l, idx: bi, t: candles[bi].t };
    } else {
      const bi = i - size;
      if (!isNaN(curHigh.level) && !isNaN(eps) && Math.abs(curHigh.level - candles[bi].h) < eps) {
        out.push({ fromIdx: curHigh.idx, fromT: curHigh.t, fromPrice: curHigh.level, toIdx: bi, toT: candles[bi].t, toPrice: candles[bi].h, kind: "EQH" });
      }
      curHigh = { level: candles[bi].h, idx: bi, t: candles[bi].t };
    }
  }
  return out;
}

// ---- 溢价/折价 + 强弱高/低（trailing 极值） ----

export type TrailingExtremes = {
  top: number;
  bottom: number;
  topIdx: number;
  topT: number;
  bottomIdx: number;
  bottomT: number;
};

export function computeTrailing(candles: Candle[], size = SWING_LEN): TrailingExtremes {
  const n = candles.length;
  const legs = legSeries(candles, size);
  let top = NaN, bottom = NaN, topIdx = -1, topT = 0, bottomIdx = -1, bottomT = 0;
  for (let i = 0; i < n; i++) {
    if (i >= 1 && legs[i] !== legs[i - 1]) {
      const bi = i - size;
      if (legs[i] === 1) {
        bottom = candles[bi].l;
        bottomIdx = bi;
        bottomT = candles[bi].t;
      } else {
        top = candles[bi].h;
        topIdx = bi;
        topT = candles[bi].t;
      }
    }
    const c = candles[i];
    if (isNaN(top) || c.h > top) {
      top = c.h;
      topIdx = i;
      topT = c.t;
    }
    if (isNaN(bottom) || c.l < bottom) {
      bottom = c.l;
      bottomIdx = i;
      bottomT = c.t;
    }
  }
  return { top, bottom, topIdx, topT, bottomIdx, bottomT };
}

