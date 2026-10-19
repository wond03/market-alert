// 猎场信号面板纯逻辑（无 Convex 依赖）——被 convex/battle.ts 使用，并可在离线用真实
// K 线复算，保证线上信号与看盘页「猎场信号面板」判定一致。
//
// 口径：MTF(15m) 结构定日内方向（1h 仅作背景，被反向收盘破坏即作废）→ MTF(15m) 顺方向、未缓解且带
// 位移的 OB/FVG 为入区 → 价格进入该入区且出现低周期 5m 同向确认（结构突破/吞没/Pin Bar）才提示 → 输出入场/止损/止盈/盈亏比。
// 止盈：距入场 ≥TARGET_MIN_RR×风险 的最近对手流动性（1h 摆动点 + 前日/亚洲/开盘区间高低）。

import type { Candle } from "./exchanges";
import {
  runStructure,
  computeFvgs,
  atr,
  ATR_LEN,
  SWING_LEN,
  INTERNAL_LEN,
  type StructureResult,
  type StructBreak,
} from "./luxSmc";
import * as gate from "./gate";

export const HTF = { tf: "1h", sec: 3600, swing: 4 }; // 背景：只定偏置与流动性
export const MTF = { tf: "15m", sec: 900 }; // 日内方向 + 入区
export const LTF = { tf: "5m", sec: 300 }; // 入场确认（仅展示）
export const MTF_DIR_SWING = 16; // 15m 日内方向的结构 size（摆动结构，定方向）

// 统一确认窗口：自「首次入区」起算的最大时长，窗口内必须同时出现过入区、确认1、确认2，且区域未失效。
export const ZONE_WINDOW_BARS = 24; // 24 根 15m
export const ZONE_WINDOW_SEC = ZONE_WINDOW_BARS * 900; // 21600s = 6h
// 被用到的「确认1」与「确认2」两根 5m K 的索引差绝对值上限（顺序不限）。
export const CONFIRM_SPAN_MAX = 12; // 12 根 5m = 60 分钟
export const ZONE_BUF_ATR = 0.15; // 判定「价格在区域内」的 ATR 缓冲
export const STOP_BUF_ATR = 0.2; // 止损外扩的 ATR 缓冲
export const DISP_WINDOW = 10; // 位移检测窗口：区域内起 N 根
export const DISP_MULT = 1.5; // 位移 K 线：范围 ≥ N×ATR（且方向与区域一致）
export const SWEEP_LOOKBACK = 20; // 扫荡检测回看根数（HTF）
export const TARGET_MIN_RR = 2; // 止盈优选：取距入场 ≥ N×风险 的最近对手流动性
const SIZE_BASE_NOTIONAL = 500; // 报表口径：每笔名义 USDT
const SIZE_MULT = 0.75; // BTC × sweep=N × BOS 折价
const SIZE_LEVERAGE = 100; // 报表口径：杠杆
const BTC_QUANTO = 0.0001; // Gate BTC_USDT 每张 BTC 数量

export type Bias = "bull" | "bear";

// 逐标的持久化状态：当天去重指纹 + 统一确认窗口（当前跟踪区域及其首次入区时间）。
export type BattleState = {
  firedZone: string; // 最近已推送的区域指纹；空串表示可重新布防
  zoneKey: string; // 当前窗口跟踪的区域指纹；空串 = 无活动窗口
  zoneStartT: number | null; // 首次入区所在的 5m K 开盘时间（UTC 秒）
};


// 回测可覆盖的可调阈值；生产不传，沿用上方常量。
export type BattleEvalOpts = {
  zoneWindowSec?: number; // 覆盖 ZONE_WINDOW_SEC
  zoneInvalidateMtf?: boolean;
 confirm5m?: boolean; // 确认1改用 5m 内部结构突破（默认 15m）
  confirmSpanMax?: number; // 覆盖 CONFIRM_SPAN_MAX
  obMitigation?: "wick"|"close"; // OB 缓解判定，默认 close（收盘确认，避免扫荡 K 自我抵消）
  preAnchorBars?: number; // 回测实验：无窗口内确认1时，允许用入区前 N 根 15m 的同向内部突破作锚点
  exhaustAtr?: number; // 上述锚点的衰竭过滤：|入区价 − 锚点结构位| ≤ N×ATR200(15m)
};

export type Zone = {
  kind: "OB" | "FVG";
  bias: Bias;
  top: number;
  bottom: number;
  idx: number;
  t: number;
};

export type BattleSignal = {
  bias: "long" | "short";
  bg: string; // 1h 背景：bull | bear | range
  htfTag: string;
  htfLevel: number;
  zoneKind: string;
  zoneTop: number;
  zoneBottom: number;
  confirm: string;
  confirmInternal: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number | null;
  rr: number | null;
  sweep: boolean;
  sweepLevel: number | null;
  sigTs: number;
  text: string;
};

// 位移过滤：区域内起 DISP_WINDOW 根内，需出现一根方向一致且范围 ≥ DISP_MULT×ATR 的
// 决定性 K 线（Displacement）。文档将「明确位移」列为 OB 识别与有效 FVG 的关键背景。
export function hasDisplacement(
  candles: Candle[],
  zone: Zone,
  atrArr: number[],
): boolean {
  const end = Math.min(candles.length, zone.idx + DISP_WINDOW + 1);
  for (let k = zone.idx; k < end; k++) {
    const c = candles[k];
    const dir = zone.bias === "bull" ? c.c > c.o : c.c < c.o;
    const a = atrArr[k];
    if (dir && isFinite(a) && a > 0 && c.h - c.l >= DISP_MULT * a) return true;
  }
  return false;
}

// ---- 统一确认窗口辅助 ----
function zoneToKey(z: Zone): string {
  return `${z.bias}#${z.kind}#${z.t}#${z.bottom}#${z.top}`;
}
function parseZoneKey(key: string): Zone | null {
  const p = key.split("#");
  if (p.length < 5) return null;
  return { bias: p[0] as Bias, kind: p[1] as Zone["kind"], idx: 0, bottom: Number(p[3]), top: Number(p[4]), t: Number(p[2]) };
}
// 区域失效：窗口内任一 5m 收盘价穿过远端边界（做多=收盘 < 下沿；做空=收盘 > 上沿）。
function zoneInvalidated(candles: Candle[], startT: number, lastCloseT: number, z: Zone, tfSec: number): boolean {
  for (const c of candles) {
    const closeT = c.t + tfSec;
    if (closeT <= startT || closeT > lastCloseT) continue;
    if (z.bias === "bull" ? c.c < z.bottom : c.c > z.top) return true;
  }
  return false;
}
function firstLtfIdxClosingAtOrAfter(ltf: Candle[], tClose: number): number {
  for (let i = 0; i < ltf.length; i++) if (ltf[i].t + LTF.sec >= tClose) return i;
  return -1;
}
export type C1 = { i: number; tag: string };
export type C2 = { i: number; label: string; kind: string };
// 确认1：窗口内出现的 15m 内部结构同向突破（映射到其被确认后的 5m K 索引）。
export function confirm1Indices(mtf: Candle[], ltf: Candle[], bias: Bias, startT: number, lastCloseT: number): C1[] {
  const out: C1[] = [];
  for (const b of runStructure(mtf, INTERNAL_LEN).breaks) {
    if (b.dir !== bias) continue;
    const bc = b.t + MTF.sec; // 15m 收盘时间
    if (bc <= startT || bc > lastCloseT) continue;
    const i = firstLtfIdxClosingAtOrAfter(ltf, bc);
    if (i >= 0) out.push({ i, tag: b.tag });
  }
  return out;
}
// 回测实验：用 5m 内部结构突破替代 15m 确认1。
export function confirm1Indices5m(ltf: Candle[], bias: Bias, startT: number, lastCloseT: number): C1[] {
 const out: C1[] = [];
 for (const b of runStructure(ltf, INTERNAL_LEN).breaks) {
 if (b.dir !== bias) continue;
 const bc = b.t + LTF.sec;
 if (bc <= startT||bc > lastCloseT) continue;
 const i = firstLtfIdxClosingAtOrAfter(ltf, bc);
 if (i >= 0) out.push({ i, tag: b.tag });
 }
 return out;
}
// 回测实验：把入区前的同向 15m 内部突破当作确认1锚点（索引取入区前一根 5m，使配对待确认2按入区后计时）。
export function preAnchorC1(
  mtf: Candle[],
  ltf: Candle[],
  bias: Bias,
  startT: number,
  entry: number,
  lookBars: number,
  atrMult: number,
): C1 | null {
  if (lookBars <= 0) return null;
  let best: StructBreak | null = null;
  for (const b of runStructure(mtf, INTERNAL_LEN).breaks) {
    if (b.dir !== bias) continue;
    const bc = b.t + MTF.sec;
    if (bc > startT || bc <= startT - lookBars * MTF.sec) continue;
    if (!best || b.t > best.t) best = b;
  }
  if (!best) return null;
  let mi = mtf.length - 1;
  while (mi > 0 && mtf[mi].t + MTF.sec > startT) mi--;
  const a = atr(mtf, ATR_LEN)[mi];
  if (!(a > 0) || Math.abs(entry - best.level) > atrMult * a) return null;
  const i0 = firstLtfIdxClosingAtOrAfter(ltf, startT);
  return i0 > 0 ? { i: i0 - 1, tag: best.tag } : null;
}
// 确认2：窗口内出现的 5m 同向触发（内部突破 / 吞没 / Pin Bar）。
export function confirm2Indices(ltf: Candle[], bias: Bias, startT: number, lastCloseT: number): C2[] {
  const breaks = runStructure(ltf, INTERNAL_LEN).breaks;
  const dirWord = bias === "bull" ? "向上" : "向下";
  const out: C2[] = [];
  for (let i = 0; i < ltf.length; i++) {
    const closeT = ltf[i].t + LTF.sec;
    if (closeT <= startT || closeT > lastCloseT) continue;
    const b = breaks.find((x) => x.idx === i && x.dir === bias);
    if (b) {
      out.push({ i, label: `${b.tag} ${dirWord} 破 ${gate.fmtPrice(b.level)}`, kind: b.tag });
    } else if (i > 0 && isEngulf(ltf[i - 1], ltf[i], bias)) {
      out.push({ i, label: "吞没", kind: "吞没" });
    } else if (isPin(ltf[i], bias)) {
      out.push({ i, label: "Pin Bar", kind: "Pin" });
    }
  }
  return out;
}
// 取索引差最小且 ≤ maxSpan 的「确认1×确认2」组合（顺序不限）；返回用于展示的两个确认文案。
export function closestPair(c1: C1[], c2: C2[], maxSpan: number): { confirm: string; confirmInternal: string } | null {
  let best: { confirm: string; confirmInternal: string } | null = null;
  let bestD = Infinity;
  for (const a of c1) {
    for (const b of c2) {
      const d = Math.abs(a.i - b.i);
      if (d <= maxSpan && d < bestD) {
        bestD = d;
        best = { confirm: b.label, confirmInternal: a.tag === "CHoCH" ? "CHoCH" : "BOS" };
      }
    }
  }
  return best;
}

function minGap(c1: C1[], c2: C2[]): number | null {
  let best: number | null = null;
  for (const a of c1) {
    for (const b of c2) {
      const d = a.i - b.i;
      if (best === null || Math.abs(d) < Math.abs(best)) best = d;
    }
  }
  return best;
}

export function battleZones(
  candles: Candle[],
  bias: Bias,
  obMitigation: "wick" | "close" = "close",
): Zone[] {
  const swing = runStructure(candles, SWING_LEN, "atr", obMitigation);
  const atrArr = atr(candles, ATR_LEN);
  const zones: Zone[] = [];
  for (const o of swing.orderBlocks) {
    if (o.mitigatedIdx === null && o.bias === bias) {
      zones.push({ kind: "OB", bias, top: o.high, bottom: o.low, idx: o.idx, t: o.t });
    }
  }
  for (const f of computeFvgs(candles)) {
    if (f.mitigatedIdx === null && f.dir === bias) {
      zones.push({ kind: "FVG", bias, top: f.top, bottom: f.bottom, idx: f.idx, t: f.t });
    }
  }
  const seen = new Set<string>();
  return zones.filter((z) => {
    if (!hasDisplacement(candles, z, atrArr)) return false;
    const k = `${z.kind}#${z.idx}#${z.bottom}#${z.top}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function isEngulf(prev: Candle | undefined, last: Candle, bias: Bias): boolean {
  if (!prev) return false;
  if (bias === "bull") {
    return last.c > last.o && prev.c < prev.o && last.c >= prev.o && last.o <= prev.c;
  }
  return last.c < last.o && prev.c > prev.o && last.c <= prev.o && last.o >= prev.c;
}

export function isPin(c: Candle, bias: Bias): boolean {
  const rng = c.h - c.l;
  if (rng <= 0) return false;
  if (Math.abs(c.c - c.o) > rng * 0.34) return false;
  if (bias === "bull") return Math.min(c.c, c.o) - c.l >= rng * 0.5;
  return c.h - Math.max(c.c, c.o) >= rng * 0.5;
}

// 反向收盘破坏：结构突破后若出现反向收盘穿过被突破的价位，则该结构方向作废。
export function reverseClosed(candles: Candle[], brk: StructBreak, lastIdx: number): boolean {
  for (let k = brk.idx + 1; k <= lastIdx; k++) {
    if (brk.dir === "bull" ? candles[k].c < brk.level : candles[k].c > brk.level) return true;
  }
  return false;
}

// [from, to) 区间内的高低。
function rangeOf(candles: Candle[], from: number, to: number): { hi: number; lo: number } | null {
  let hi = -Infinity;
  let lo = Infinity;
  let any = false;
  for (const c of candles) {
    if (c.t < from || c.t >= to) continue;
    any = true;
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  return any ? { hi, lo } : null;
}

// 前一日（北京时间）高低。
function prevDayRange(candles: Candle[], now: number): { hi: number; lo: number } | null {
  const dayKey = (t: number) => Math.floor((t + gate.BJ_OFFSET) / 86400);
  const today = dayKey(now);
  let best = -Infinity;
  let hi = -Infinity;
  let lo = Infinity;
  let any = false;
  for (const c of candles) {
    const k = dayKey(c.t);
    if (k >= today) continue;
    if (k > best) {
      best = k;
      hi = c.h;
      lo = c.l;
      any = true;
    } else if (k === best) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
    }
  }
  return any ? { hi, lo } : null;
}

// 日内流动性止盈候选：前日高低 + 上一个亚洲盘高低 + 当前盘口开盘 30 分钟区间高低。
export function intradayLevels(candles: Candle[], now: number): number[] {
  const out: number[] = [];
  const push = (r: { hi: number; lo: number } | null) => {
    if (r && isFinite(r.hi) && isFinite(r.lo)) out.push(r.hi, r.lo);
  };
  push(prevDayRange(candles, now));
  const asia = gate.lastClosedSessionWindow(now, "亚洲盘");
  push(rangeOf(candles, asia.start, asia.end));
  const cur = gate.currentSessionWindow(now);
  if (cur) push(rangeOf(candles, cur.start, cur.start + 1800));
  return out;
}

// 参考点 ref 同侧的对手流动性（做多取 ref 上方摆动高点、做空取下方摆动低点），
// 按距 ref 由近到远排序。
export function liquiditySide(
  st: StructureResult,
  ref: number,
  dir: "up" | "down",
): number[] {
  const arr = dir === "up" ? st.highs : st.lows;
  return arr
    .map((p) => p.price)
    .filter((lv) => (dir === "up" ? lv > ref : lv < ref))
    .sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref));
}

// 流动性扫荡质量：看跌(setup 做空)看是否扫过前高、看涨(做多)看是否扫过前低——
// 某根 HTF K 线影线越过前摆动点但收盘回到内侧，即「扫流动性后反转」，文档视为更高质量。
export function sweepQuality(
  st: StructureResult,
  candles: Candle[],
  bias: Bias,
  lookback: number,
): { swept: boolean; level: number | null } {
  const arr = bias === "bull" ? st.lows : st.highs;
  const n = candles.length;
  const from = Math.max(0, n - lookback);
  for (let i = from; i < n; i++) {
    const c = candles[i];
    for (const p of arr) {
      if (p.idx >= i) continue;
      if (bias === "bull") {
        if (c.l < p.price && c.c > p.price) return { swept: true, level: p.price };
      } else if (c.h > p.price && c.c < p.price) {
        return { swept: true, level: p.price };
      }
    }
  }
  return { swept: false, level: null };
}

export function buildRisk(
  bias: Bias,
  zone: Zone,
  st: StructureResult,
  price: number,
  atrVal: number,
  extras: number[] = [],
): { entry: number; stop: number; target: number | null; rr: number | null; stopPct: number } {
  const buf = STOP_BUF_ATR * atrVal;
  let entry: number;
  let stop: number;
  let dir: "up" | "down";
  if (bias === "bull") {
    entry = zone.top;
    stop = zone.bottom - buf;
    dir = "up";
  } else {
    entry = zone.bottom;
    stop = zone.top + buf;
    dir = "down";
  }
  const riskUnit = Math.abs(entry - stop);
  // 止盈候选 = 1h 摆动点 + 日内流动性（前日/亚洲/开盘区间高低），按距入场由近到远。
  const cands = liquiditySide(st, entry, dir);
  for (const lv of extras) {
    if (isFinite(lv) && (dir === "up" ? lv > entry : lv < entry)) cands.push(lv);
  }
  cands.sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry));
  // 取首个 RR≥TARGET_MIN_RR 的；都不到则退回最近的那个。
  let target: number | null = null;
  for (const lv of cands) {
    if (riskUnit > 0 && Math.abs(lv - entry) / riskUnit >= TARGET_MIN_RR) {
      target = lv;
      break;
    }
  }
  if (target === null && cands.length) target = cands[0];
  const reward = target === null ? null : Math.abs(target - entry);
  const rr = reward === null || riskUnit <= 0 ? null : reward / riskUnit;
  return { entry, stop, target, rr, stopPct: riskUnit / price };
}

// BTC × sweep=N × BOS 的执行提示：按基准名义 × 0.75，换算成整数张（Gate BTC_USDT）。
export function sizeNoteOf(symbol: string, confirmInternal: string, swept: boolean, px: number): string {
  if (symbol !== "BTC" || swept || confirmInternal !== "BOS" || !(px > 0)) return "";
  const target = SIZE_BASE_NOTIONAL * SIZE_MULT;
  const per = px * BTC_QUANTO;
  const qty = Math.max(1, Math.floor(target / per));
  const notional = qty * per;
  return `子组　BTC · sweep=N · BOS　仓位 <b>${qty} 张</b>（参考价 ${gate.fmtPrice(px)} · 名义 ${notional.toFixed(2)}U · 保证金 ${(notional / SIZE_LEVERAGE).toFixed(2)}U）\n`;
}

export function buildMessage(
  exchange: string,
  symbol: string,
  bias: Bias,
  bg: string,
  bgTag: string,
  bgLevel: number,
  htfTag: string,
  htfLevel: number,
  zone: Zone,
  confirm: string,
  confirmInternal: string,
  entry: number,
  stop: number,
  stopPct: number,
  target: number | null,
  rr: number | null,
  sweepSwept: boolean,
  sweepLevel: number | null,
  now: number,
  sizeNote = "",
): string {
  const dirCn = bias === "bull" ? "看涨" : "看跌";
  const dirWord = bias === "bull" ? "向上" : "向下";
  const tradeCn = bias === "bull" ? "做多" : "做空";
  const bgCn = bg === "bull" ? "看涨" : bg === "bear" ? "看跌" : "震荡";
  const exName = gate.EXCHANGE_NAME[exchange] ?? exchange;
  const sess = gate.currentSessionName(now) ?? "时段间隙";
  const sep = "━━━━━━━━━━";
  const liq = sweepSwept
    ? `已扫前${bias === "bull" ? "低" : "高"} ${gate.fmtPrice(sweepLevel!)}`
    : "无明显扫荡";
  const bgLine =
    bgTag && bgLevel
      ? `${bgCn} · ${bgTag} ${dirWord}破 ${gate.fmtPrice(bgLevel)}`
      : bgCn;
  return (
    `<b>SMC 入场信号</b>\n` +
    `<b>${exName} · ${symbol}/USDT</b>\n` +
    `${sep}\n` +
    `背景 ${HTF.tf}　${bgLine}\n` +
    `方向 ${MTF.tf}　${dirCn} · ${htfTag} ${dirWord}破 <b>${gate.fmtPrice(htfLevel)}</b>\n` +
    `入区 ${MTF.tf}　${zone.kind} ${gate.fmtPrice(zone.bottom)}–${gate.fmtPrice(zone.top)}\n` +
    `流动性　　${liq}\n` +
    `确认 ${LTF.tf}　<b>${confirm}</b>\n` +
    `${sep}\n` +
    `入场 <b>${gate.fmtPrice(entry)}</b>（${tradeCn}）\n` +
    sizeNote +
    `止损 <b>${gate.fmtPrice(stop)}</b>（${(stopPct * 100).toFixed(2)}%）\n` +
    (target === null
      ? ``
      : `止盈 <b>${gate.fmtPrice(target)}</b>` +
        (rr === null ? `` : `　盈亏比 <b>1:${rr.toFixed(2)}</b>`) +
        `\n`) +
    `${sep}\n` +
    `${gate.fmtBeijing(now)} 北京（${sess}）　｜　<a href="${gate.DASHBOARD_URL}">看盘页</a>`
  );
}

// 区域分层漏斗：本次扫描时活动区域推进到的层级（用于信号质量通过率）。
export type FunnelInfo = {
  zoneKey: string;
  zoneStartT: number;
  c1T: number | null;
  c2T: number | null;
  confirmed: boolean;
  pair?: boolean;
  tradable?: boolean;
  gap?: number | null;
  c1n?: number;
  c2n?: number;
  c2Kind?: string | null;
};

export type BattleEval = {
  bias: string; // bull|bear|range
  firedZone: string;
  zoneKey: string;
  zoneStartT: number | null;
  signal: BattleSignal | null;
  blockedSignal?: BattleSignal | null;
  funnel?: FunnelInfo | null;
};

// 给定已收盘的 HTF/MTF/LTF K 线（升序、末尾为最近已收盘 K）与上次持久化状态，返回本次扫描结果。
export function evaluateBattle(
  htf: Candle[],
  mtf: Candle[],
  ltf: Candle[],
  prev: BattleState,
  now: number,
  exchange = "gate",
  symbol = "BTC",
  opts: BattleEvalOpts = {},
): BattleEval {
  // 1h 背景：只定偏置；被反向收盘破坏即作废（不看经过多少根 K 线）。
  const htfSt = runStructure(htf, HTF.swing);
  const htfTrend = htfSt.trendAtEnd;
  const htfLast = htfSt.breaks.length ? htfSt.breaks[htfSt.breaks.length - 1] : undefined;
  const bg: string =
    (htfTrend === "bull" || htfTrend === "bear") &&
    htfLast &&
    !reverseClosed(htf, htfLast, htf.length - 1)
      ? htfTrend
      : "range";

  // 方向失效 → 清空窗口与去重，观望。
  const resetRange: BattleEval = { bias: "range", firedZone: "", zoneKey: "", zoneStartT: null, signal: null };

  // 日内方向：由 15m 结构刷新，且须落在当前北京日内（「当天有效」）。
  const mtfSt = runStructure(mtf, MTF_DIR_SWING);
  const dir = mtfSt.trendAtEnd;
  const dirLast = mtfSt.breaks.length ? mtfSt.breaks[mtfSt.breaks.length - 1] : undefined;
  const dirFresh = !!dirLast && dirLast.t >= gate.currentDayStart(now);
  if ((dir !== "bull" && dir !== "bear") || !dirFresh) return resetRange;
  // 位移硬过滤：定方向的这根 15m 摆动 BOS/CHoCH 必须带明确位移（同向且范围 ≥ DISP_MULT×ATR）。
  const dirDisp = hasDisplacement(
    mtf,
    { kind: "OB", bias: dir as Bias, top: 0, bottom: 0, idx: dirLast!.idx, t: dirLast!.t },
    atr(mtf, ATR_LEN),
  );
  if (!dirDisp) return resetRange;
  const bias: Bias = dir;

  const sweep = sweepQuality(htfSt, htf, bias, SWEEP_LOOKBACK);
  const last = ltf[ltf.length - 1];
  const price = last.c;
  const lastCloseT = last.t + LTF.sec;
  const ltfAtr = atr(ltf, 14)[ltf.length - 1] || price * 0.002;

  // ---- 统一确认窗口状态机 ----
  let zoneKey = prev.zoneKey;
  let zoneStartT = prev.zoneStartT;
  let firedZone = prev.firedZone;
  let funnel: FunnelInfo | null = null;

  // 方向变化：跟踪的区域作废，清窗口（去重指纹保留，由失效判据决定是否重置）。
  if (zoneKey && zoneKey.split("#")[0] !== bias) {
    zoneKey = "";
    zoneStartT = null;
  }

  if (zoneKey && zoneStartT != null) {
    const z = parseZoneKey(zoneKey)!;
    const expired = lastCloseT - zoneStartT > (opts.zoneWindowSec ?? ZONE_WINDOW_SEC);
    const invalid = zoneInvalidated(
      opts.zoneInvalidateMtf ? mtf : ltf,
      zoneStartT,
      lastCloseT,
      z,
      opts.zoneInvalidateMtf ? MTF.sec : LTF.sec,
    );
    if (expired || invalid) {
      if (firedZone === zoneKey) firedZone = "";
      zoneKey = "";
      zoneStartT = null;
    }
  }

  // 无活动窗口：若价格此刻正落在某个顺方向合格区域内，则记为「首次入区」开启窗口。
  if (!zoneKey) {
    const buf = ZONE_BUF_ATR * ltfAtr;
    const zones = battleZones(mtf, bias, opts.obMitigation ?? "close");
    const inside = zones.filter(
      (z) => price >= z.bottom - buf && price <= z.top + buf,
    );
    const gapTo = (a: Zone, b: Zone) =>
      a.bottom > b.top ? a.bottom - b.top : b.bottom > a.top ? b.bottom - a.top : 0;
    const centerDist = (z: Zone) => Math.abs(price - (z.top + z.bottom) / 2);
 const obs = zones.filter((z) => z.kind === "OB");
 let inZone: Zone | null = null;
 const fvgs = inside.filter((z) => z.kind === "FVG");
 if (fvgs.length) {
 if (obs.length) {
 for (const z of fvgs) {
 if (!inZone) {
 inZone = z;
 continue;
 }
 const best = inZone;
 const dz = Math.min(...obs.map((o) => gapTo(z, o)));
 const db = Math.min(...obs.map((o) => gapTo(best, o)));
 if (dz < db) inZone = z;
 }
 } else {
 for (const z of fvgs) {
 if (!inZone || centerDist(z) < centerDist(inZone)) inZone = z;
 }
 }
 } else {
 for (const z of inside) {
 if (z.kind !== "OB") continue;
 if (!inZone||centerDist(z) < centerDist(inZone)) inZone = z;
 }
 }
 if (!inZone) return { bias, firedZone, zoneKey: "", zoneStartT: null, signal: null, funnel: null };
    zoneKey = zoneToKey(inZone);
    zoneStartT = last.t;
    funnel = { zoneKey, zoneStartT: last.t, c1T: null, c2T: null, confirmed: false };
  }

  const z = parseZoneKey(zoneKey)!;
  const startT = zoneStartT as number;

  // 窗口内：仅需 5m 触发（结构突破 / 吞没 / Pin Bar）。
  const span = opts.confirmSpanMax ?? CONFIRM_SPAN_MAX;
  const c2 = confirm2Indices(ltf, bias, startT, lastCloseT).filter(
    (c) => ltf[c.i].t - startT < span * LTF.sec,
  );
  // 右侧确认：触发后下一根 5m 必须顺势收盘并继续朝信号方向。
  let trig: (typeof c2)[number] | null = null;
  let rightT: number | null = null;
  for (const c of c2) {
    const j = c.i + 1;
    if (j >= ltf.length) break;
    if (ltf[j].t - startT >= span * LTF.sec) break;
    const tc = ltf[c.i];
    const nc = ltf[j];
    const ok =
      bias === "bull" ? nc.c > nc.o && nc.c > tc.c : nc.c < nc.o && nc.c < tc.c;
    if (!ok) continue;
    trig = c;
    rightT = nc.t;
    break;
  }
  const c2T = trig && rightT != null ? rightT : c2.length ? ltf[c2[0].i]?.t ?? null : null;
  funnel = {
    zoneKey,
    zoneStartT: startT,
    c1T: null,
    c2T,
    confirmed: false,
    pair: c2.length > 0,
    gap: c2.length ? 0 : null,
    c1n: 0,
    c2n: c2.length,
    c2Kind: (trig ?? c2[0])?.kind ?? null,
  };
  if (!trig) return { bias, firedZone, zoneKey, zoneStartT, signal: null, funnel };
  const pair = { confirm: `${trig.label}·右侧`, confirmInternal: trig.kind };

  // 当天去重：同一区域只推一次。
  if (firedZone === zoneKey) return { bias, firedZone, zoneKey, zoneStartT, signal: null, funnel };
  const risk = buildRisk(bias, z, htfSt, price, ltfAtr, intradayLevels(mtf, now));
  const dirTag = dirLast ? dirLast.tag : "结构";
  const dirLevel = dirLast ? dirLast.level : z.top;
  const bgOk = bg === "bull" || bg === "bear";
  const bgTag = bgOk && htfLast ? htfLast.tag : "";
 const bgLevel = bgOk && htfLast ? htfLast.level : 0;
  const signal: BattleSignal = {
      bias: bias === "bull" ? "long" : "short",
      bg,
      htfTag: dirTag,
      htfLevel: dirLevel,
      zoneKind: z.kind,
      zoneTop: z.top,
      zoneBottom: z.bottom,
      confirm: pair.confirm,
      confirmInternal: pair.confirmInternal,
      entryPrice: risk.entry,
      stopPrice: risk.stop,
      targetPrice: risk.target,
      rr: risk.rr,
      sweep: sweep.swept,
      sweepLevel: sweep.level,
      sigTs: rightT ?? last.t,
      text: buildMessage(
        exchange,
        symbol,
        bias,
        bg,
        bgTag,
        bgLevel,
        dirTag,
        dirLevel,
        z,
        pair.confirm,
        pair.confirmInternal,
        risk.entry,
        risk.stop,
        risk.stopPct,
        risk.target,
        risk.rr,
        sweep.swept,
        sweep.level,
        now,
        sizeNoteOf(symbol, pair.confirmInternal, sweep.swept, risk.entry),
      ),
    };
  funnel = { zoneKey, zoneStartT: startT, c1T: null, c2T, confirmed: true, pair: true, tradable: true };
  return { bias, firedZone: zoneKey, zoneKey, zoneStartT, funnel, signal };
}

export type Resolution = { result: "stop" | "target"; ts: number; price: number };

// 信号了结判定：从信号根之后（fromTs + LTF.sec）逐根扫描；止损/止盈均按影线触及，同根先判止损。
export function resolveSignal(
  ltf: Candle[],
  fromTs: number,
  dir: string,
  stop: number | null,
  target: number | null,
): Resolution | null {
  for (const c of ltf) {
    if (c.t < fromTs + LTF.sec) continue;
    if (dir === "short") {
      if (stop != null && c.h >= stop) return { result: "stop", ts: c.t, price: stop };
      if (target != null && c.l <= target) return { result: "target", ts: c.t, price: target };
    } else {
      if (stop != null && c.l <= stop) return { result: "stop", ts: c.t, price: stop };
      if (target != null && c.h >= target) return { result: "target", ts: c.t, price: target };
    }
  }
  return null;
}
