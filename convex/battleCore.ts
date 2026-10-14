// 作战面板纯逻辑（无 Convex 依赖）——被 convex/battle.ts 使用，并可在离线用真实
// K 线复算，保证线上信号与看盘页「作战面板」判定一致。
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

export const HTF = { tf: "1h", sec: 3600, swing: SWING_LEN }; // 背景：只定偏置与流动性
export const MTF = { tf: "15m", sec: 900 }; // 日内方向 + 入区
export const LTF = { tf: "5m", sec: 300 }; // 入场确认（仅展示）
export const MTF_DIR_SWING = INTERNAL_LEN; // 15m 日内方向的结构 size（内部结构）
export const CONFIRM_LOOKBACK = 3; // 最近 N 根 LTF 内的同向突破算确认
export const ZONE_BUF_ATR = 0.15; // 判定「价格在区域内」的 ATR 缓冲
export const STOP_BUF_ATR = 0.2; // 止损外扩的 ATR 缓冲
export const DISP_WINDOW = 10; // 位移检测窗口：区域内起 N 根
export const DISP_MULT = 1.5; // 位移 K 线：范围 ≥ N×ATR（且方向与区域一致）
export const SWEEP_LOOKBACK = 20; // 扫荡检测回看根数（HTF）
export const TARGET_MIN_RR = 2; // 止盈优选：取距入场 ≥ N×风险 的最近对手流动性

type Bias = "bull" | "bear";

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

export function battleZones(candles: Candle[], bias: Bias): Zone[] {
  const swing = runStructure(candles, SWING_LEN);
  const internal = runStructure(candles, INTERNAL_LEN);
  const atrArr = atr(candles, ATR_LEN);
  const zones: Zone[] = [];
  for (const o of swing.orderBlocks.concat(internal.orderBlocks)) {
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
  entry: number,
  stop: number,
  stopPct: number,
  target: number | null,
  rr: number | null,
  sweepSwept: boolean,
  sweepLevel: number | null,
  now: number,
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

export type BattleEval = {
  bias: string; // bull | bear | range
  firedZone: string;
  signal: BattleSignal | null;
};

// 给定已收盘的 HTF/MTF/LTF K 线（升序、末尾为最近已收盘 K），返回本次扫描结果。
export function evaluateBattle(
  htf: Candle[],
  mtf: Candle[],
  ltf: Candle[],
  prevFiredZone: string,
  now: number,
  exchange = "gate",
  symbol = "BTC",
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

  let firedZone = prevFiredZone;

  // 日内方向：由 15m 结构刷新，且须落在当前北京日内（「当天有效」）。
  // 出现反向 CHoCH/BOS 时 trendAtEnd 会翻向，方向即自动降级，无需额外收盘破坏判据。
  const mtfSt = runStructure(mtf, MTF_DIR_SWING);
  const dir = mtfSt.trendAtEnd;
  const dirLast = mtfSt.breaks.length ? mtfSt.breaks[mtfSt.breaks.length - 1] : undefined;
  const dirFresh = !!dirLast && dirLast.t >= gate.currentDayStart(now);
  if ((dir !== "bull" && dir !== "bear") || !dirFresh) {
    return { bias: "range", firedZone: "", signal: null };
  }
  const bias: Bias = dir;

  const sweep = sweepQuality(htfSt, htf, bias, SWEEP_LOOKBACK);

  const price = ltf[ltf.length - 1].c;
  const ltfAtr = atr(ltf, 14)[ltf.length - 1] || price * 0.002;
  const zones = battleZones(mtf, bias);
  const buf = ZONE_BUF_ATR * ltfAtr;

  let inZone: Zone | null = null;
  for (const z of zones) {
    if (price >= z.bottom - buf && price <= z.top + buf) {
      if (
        !inZone ||
        Math.abs(price - (z.top + z.bottom) / 2) <
          Math.abs(price - (inZone.top + inZone.bottom) / 2)
      ) {
        inZone = z;
      }
    }
  }

  if (!inZone) {
    return { bias, firedZone: "", signal: null }; // 离开所有入区 → 重新布防
  }

  const ltfSt = runStructure(ltf, INTERNAL_LEN);
  const lb = ltfSt.breaks.length ? ltfSt.breaks[ltfSt.breaks.length - 1] : undefined;
  const recentBreak = !!lb && lb.dir === bias && ltf.length - 1 - lb.idx <= CONFIRM_LOOKBACK;
  const last = ltf[ltf.length - 1];
  const prev = ltf[ltf.length - 2];
  const eng = isEngulf(prev, last, bias);
  const pin = isPin(last, bias);
  const dirWord = bias === "bull" ? "向上" : "向下";
  // 入场信号：进入合格入区且出现低周期 5m 同向确认（结构突破 / 吞没 / Pin Bar）才提示。
  const confirm = recentBreak
    ? `${lb!.tag} ${dirWord} 破 ${gate.fmtPrice(lb!.level)}`
    : eng
      ? "吞没"
      : pin
        ? "Pin Bar"
        : "";
  if (!confirm) {
    // 已到入区但尚无低周期同向确认：不推送，保持布防等待确认。
    return { bias, firedZone, signal: null };
  }

  const zoneKey = `${bias}#${inZone.kind}#${inZone.idx}#${inZone.bottom}#${inZone.top}`;
  if (firedZone === zoneKey) {
    return { bias, firedZone, signal: null };
  }

  const risk = buildRisk(bias, inZone, htfSt, price, ltfAtr, intradayLevels(mtf, now));
  const dirTag = dirLast ? dirLast.tag : "结构";
  const dirLevel = dirLast ? dirLast.level : inZone.top;
  const bgOk = bg === "bull" || bg === "bear";
  const bgTag = bgOk && htfLast ? htfLast.tag : "";
  const bgLevel = bgOk && htfLast ? htfLast.level : 0;
  return {
    bias,
    firedZone: zoneKey,
    signal: {
      bias: bias === "bull" ? "long" : "short",
      bg,
      htfTag: dirTag,
      htfLevel: dirLevel,
      zoneKind: inZone.kind,
      zoneTop: inZone.top,
      zoneBottom: inZone.bottom,
      confirm,
      entryPrice: risk.entry,
      stopPrice: risk.stop,
      targetPrice: risk.target,
      rr: risk.rr,
      sweep: sweep.swept,
      sweepLevel: sweep.level,
      sigTs: last.t,
      text: buildMessage(
        exchange,
        symbol,
        bias,
        bg,
        bgTag,
        bgLevel,
        dirTag,
        dirLevel,
        inZone,
        confirm,
        risk.entry,
        risk.stop,
        risk.stopPct,
        risk.target,
        risk.rr,
        sweep.swept,
        sweep.level,
        now,
      ),
    },
  };
}
