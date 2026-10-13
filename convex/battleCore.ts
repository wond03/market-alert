// 作战面板纯逻辑（无 Convex 依赖）——被 convex/battle.ts 使用，并可在离线用真实
// K 线复算，保证线上信号与看盘页「作战面板」判定一致。
//
// 口径：HTF(1h) 摆动结构 size=50 定方向 → MTF(15m) 顺方向未缓解且带位移的 OB/FVG 为入区 →
// 价格进入该入区即提示（低周期 5m 确认仅作展示、不作门槛）→ 输出入场/止损/止盈/盈亏比。

import type { Candle } from "./exchanges";
import {
  runStructure,
  computeFvgs,
  atr,
  ATR_LEN,
  type StructureResult,
} from "./luxSmc";
import * as gate from "./gate";

export const HTF = { tf: "1h", sec: 3600, swing: 50 };
export const MTF = { tf: "15m", sec: 900 };
export const LTF = { tf: "5m", sec: 300 };
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
  const swing = runStructure(candles, HTF.swing);
  const internal = runStructure(candles, 5);
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
  // 止盈优选：从入场最近的对手流动性里，取首个 RR≥TARGET_MIN_RR 的；都不到则退回最近的那个。
  const cands = liquiditySide(st, entry, dir);
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

export function buildChecklist(
  bias: Bias,
  htfTag: string,
  htfLevel: number,
  zone: Zone,
  confirm: string,
  stop: number,
  rr: number | null,
  sweepSwept: boolean,
  sweepLevel: number | null,
): string {
  const dirCn = bias === "bull" ? "看涨" : "看跌";
  const dirWord = bias === "bull" ? "向上" : "向下";
  const hTag = `高周期 ${HTF.tf}`;
  const mTag = `中周期 ${MTF.tf}`;
  const lTag = `低周期 ${LTF.tf}`;
  const rows = [
    `✓ [${hTag}] 方向：${dirCn}，低周期与它同向`,
    `✓ [${hTag}] 结构事件：${htfTag} ${dirWord}破 ${gate.fmtPrice(htfLevel)}，方向已确认`,
    `✓ [${mTag}] 入区：${zone.kind} ${gate.fmtPrice(zone.bottom)}–${gate.fmtPrice(zone.top)}（未缓解、未被价格吃掉）`,
    `✓ [${mTag}] 位移：入区形成后 10 根内出现 ≥1.5×ATR 的同向K线`,
    `${sweepSwept ? "✓" : "!"} [${hTag}] 流动性：${sweepSwept ? `已扫前${bias === "bull" ? "低" : "高"} ${gate.fmtPrice(sweepLevel!)}，属更高质量背景` : "未扫到前高/前低，属一般背景"}`,
    `${confirm ? "✓" : "·"} [${lTag}] 确认：${confirm ? confirm + " 出现在区域内" : "暂无（进入入区即提示，非必须）"}`,
    `✓ [${mTag}] 止损：${gate.fmtPrice(stop)}，在区域外（0.2×ATR 缓冲）`,
    `${rr != null && rr >= 2 ? "✓" : "!"} [${mTag}] 盈亏比：${rr == null ? "—" : "1:" + rr.toFixed(2)}${rr != null && rr < 2 ? "（低于 1:2，偏薄）" : ""}`,
  ];
  return `<b>交易前检查清单</b>\n${rows.join("\n")}\n\n`;
}

export function buildMessage(
  exchange: string,
  symbol: string,
  bias: Bias,
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
  const exName = gate.EXCHANGE_NAME[exchange] ?? exchange;
  const sess = gate.currentSessionName(now) ?? "时段间隙";
  const sep = "━━━━━━━━━━";
  return (
    `<b>SMC 作战信号</b> ｜ 进入入区\n\n` +
    `<b>${exName} · ${symbol}/USDT</b>\n` +
    `${sep}\n` +
    `方向（高周期 ${HTF.tf}）：<b>${dirCn}</b>\n` +
    `结构事件：${htfTag} ${dirWord}破 <b>${gate.fmtPrice(htfLevel)}</b>\n` +
    `入区（中周期 ${MTF.tf}）：<b>${zone.kind}</b> ${gate.fmtPrice(zone.bottom)}–${gate.fmtPrice(zone.top)}\n` +
    `流动性：${sweepSwept ? `已扫前${bias === "bull" ? "低" : "高"} ${gate.fmtPrice(sweepLevel!)}（更高质量）` : "无明显扫荡"}\n` +
    `确认（低周期 ${LTF.tf}）：<b>${confirm || "暂无"}</b>\n` +
    `${sep}\n` +
    `入场：<b>${gate.fmtPrice(entry)}</b>（${tradeCn}）\n` +
    `止损：<b>${gate.fmtPrice(stop)}</b>（${(stopPct * 100).toFixed(2)}%）\n` +
    (target === null ? `` : `止盈：<b>${gate.fmtPrice(target)}</b>\n`) +
    (rr === null ? `` : `盈亏比：<b>1:${rr.toFixed(2)}</b>\n`) +
    `\n` +
    buildChecklist(bias, htfTag, htfLevel, zone, confirm, stop, rr, sweepSwept, sweepLevel) +
    `${sep}\n` +
    `时间：${gate.fmtBeijing(now)} 北京时间（${sess}）\n` +
    `<a href="${gate.DASHBOARD_URL}">打开看盘页</a>`
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
  const htfSt = runStructure(htf, HTF.swing);
  const bias = htfSt.trendAtEnd;
  const lastBreak = htfSt.breaks.length ? htfSt.breaks[htfSt.breaks.length - 1] : undefined;
  const sweep = sweepQuality(htfSt, htf, bias as Bias, SWEEP_LOOKBACK);

  let firedZone = prevFiredZone;
  if (bias !== "bull" && bias !== "bear") {
    return { bias, firedZone, signal: null };
  }

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

  const ltfSt = runStructure(ltf, 5);
  const lb = ltfSt.breaks.length ? ltfSt.breaks[ltfSt.breaks.length - 1] : undefined;
  const recentBreak = !!lb && lb.dir === bias && ltf.length - 1 - lb.idx <= CONFIRM_LOOKBACK;
  const last = ltf[ltf.length - 1];
  const prev = ltf[ltf.length - 2];
  const eng = isEngulf(prev, last, bias);
  const pin = isPin(last, bias);
  // 低周期确认仅作展示，不再作为推送门槛（价格进入合格入区即提示）。
  const confirm = recentBreak
    ? `${lb!.tag}${lb!.dir === "bull" ? "向上" : "向下"}`
    : eng
      ? "吞没"
      : pin
        ? "Pin Bar"
        : "";

  const zoneKey = `${bias}#${inZone.kind}#${inZone.idx}#${inZone.bottom}#${inZone.top}`;
  if (firedZone === zoneKey) {
    return { bias, firedZone, signal: null };
  }

  const risk = buildRisk(bias, inZone, htfSt, price, ltfAtr);
  const htfTag = lastBreak ? lastBreak.tag : "结构";
  const htfLevel = lastBreak ? lastBreak.level : inZone.top;
  return {
    bias,
    firedZone: zoneKey,
    signal: {
      bias: bias === "bull" ? "long" : "short",
      htfTag,
      htfLevel,
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
        htfTag,
        htfLevel,
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
