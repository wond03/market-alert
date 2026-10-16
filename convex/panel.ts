import { action } from "./_generated/server";
import { v } from "convex/values";
import {
  runStructure,
  computeFvgs,
  computeTrailing,
  computeEqhEql,
  atr,
  ATR_LEN,
  SWING_LEN,
  INTERNAL_LEN,
} from "./luxSmc";
import type { Candle } from "./exchanges";
import {
  HTF,
  LTF,
  MTF_DIR_SWING,
  ZONE_BUF_ATR,
  ZONE_WINDOW_BARS,
  CONFIRM_SPAN_MAX,
  SWEEP_LOOKBACK,
  battleZones,
  buildRisk,
  confirm1Indices,
  confirm2Indices,
  closestPair,
  hasDisplacement,
  intradayLevels,
  reverseClosed,
  sweepQuality,
  type Bias,
  type Zone,
} from "./battleCore";
import * as gate from "./gate";

const candleArg = v.object({
  t: v.number(),
  o: v.number(),
  h: v.number(),
  l: v.number(),
  c: v.number(),
  v: v.optional(v.number()),
});

type CandleArg = { t: number; o: number; h: number; l: number; c: number; v?: number };

const toCandles = (xs: CandleArg[]): Candle[] =>
  xs.map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v ?? 0 }));

export const analyze = action({
  args: {
    candles: v.array(candleArg),
    swing: v.optional(v.number()),
    internal: v.optional(v.number()),
  },
  handler: async (_ctx, { candles, swing, internal }) => {
    const c = toCandles(candles);
    return {
      swing: runStructure(c, swing ?? SWING_LEN, "atr"),
      internal: runStructure(c, internal ?? INTERNAL_LEN, "atr"),
      fvgs: computeFvgs(c),
      trail: computeTrailing(c, swing ?? SWING_LEN),
      eq: computeEqhEql(c, 4, 0.1).map((e) => ({
        fromIdx: e.fromIdx,
        toIdx: e.toIdx,
        price: e.fromPrice,
        kind: e.kind,
      })),
    };
  },
});

type TrigStage = "no-zone" | "invalid" | "in-zone" | "c1" | "c2" | "confirmed";
type Trig = {
  stage: TrigStage;
  inZone: Zone | null;
  confirmed: boolean;
  kind: string;
  internalKind: string;
};

function displayTrigger(
  mtf: Candle[],
  ltf: Candle[],
  bias: Bias,
  price: number,
  ltfAtr: number,
): Trig {
  const empty: Trig = { stage: "no-zone", inZone: null, confirmed: false, kind: "", internalKind: "" };
  const zones = battleZones(mtf, bias);
  const buf = ZONE_BUF_ATR * ltfAtr;
  const zoneAt = (p: number): Zone | null => {
    let z: Zone | null = null;
    for (const zz of zones) {
      if (p >= zz.bottom - buf && p <= zz.top + buf) {
        if (!z || Math.abs(p - (zz.top + zz.bottom) / 2) < Math.abs(p - (z.top + z.bottom) / 2)) z = zz;
      }
    }
    return z;
  };
  const windowBars = ZONE_WINDOW_BARS * 3;
  const n = ltf.length;
  const lo = Math.max(0, n - 1 - windowBars);
  let start = -1;
  let z0: Zone | null = null;
  for (let i = lo; i < n; i++) {
    const zz = zoneAt(ltf[i].c);
    if (zz) {
      start = i;
      z0 = zz;
      break;
    }
  }
  if (start < 0 || !z0) return empty;
  for (let i = start + 1; i < n; i++) {
    if (bias === "bull" ? ltf[i].c < z0.bottom : ltf[i].c > z0.top) {
      return { stage: "invalid", inZone: z0, confirmed: false, kind: "", internalKind: "" };
    }
  }
  const startT = ltf[start].t;
  const lastCloseT = ltf[n - 1].t + LTF.sec;
  const c1 = confirm1Indices(mtf, ltf, bias, startT, lastCloseT);
  const c2 = confirm2Indices(ltf, bias, startT, lastCloseT);
  const pair = closestPair(c1, c2, CONFIRM_SPAN_MAX);
  const inZone = zoneAt(price);
  if (pair) return { stage: "confirmed", inZone, confirmed: true, kind: pair.confirm, internalKind: pair.confirmInternal };
  if (c1.length) return { stage: "c1", inZone, confirmed: false, kind: "", internalKind: "" };
  if (c2.length) return { stage: "c2", inZone, confirmed: false, kind: "", internalKind: "" };
  return { stage: "in-zone", inZone, confirmed: false, kind: "", internalKind: "" };
}

export const battleStatus = action({
  args: {
    htf: v.array(candleArg),
    mtf: v.array(candleArg),
    ltf: v.array(candleArg),
    now: v.number(),
  },
  handler: async (_ctx, { htf, mtf, ltf, now }) => {
    const H = toCandles(htf);
    const M = toCandles(mtf);
    const L = toCandles(ltf);

    const htfSt = runStructure(H, HTF.swing);
    const htfTrend = htfSt.trendAtEnd;
    const htfLast = htfSt.breaks.length ? htfSt.breaks[htfSt.breaks.length - 1] : undefined;
    const bg =
      (htfTrend === "bull" || htfTrend === "bear") && htfLast && !reverseClosed(H, htfLast, H.length - 1)
        ? htfTrend
        : "range";

    const mtfSt = runStructure(M, MTF_DIR_SWING);
    const dir = mtfSt.trendAtEnd;
    const dirLast = mtfSt.breaks.length ? mtfSt.breaks[mtfSt.breaks.length - 1] : undefined;
    const price = L[L.length - 1].c;
    const ltfAtr = atr(L, 14)[L.length - 1] || price * 0.002;

    const dirFresh = !!dirLast && dirLast.t >= gate.currentDayStart(now);
    const dirDisp =
      !!dirLast &&
      hasDisplacement(
        M,
        { kind: "OB", bias: dir as Bias, top: 0, bottom: 0, idx: dirLast.idx, t: dirLast.t } as Zone,
        atr(M, ATR_LEN),
      );
    const dirOk = (dir === "bull" || dir === "bear") && dirFresh && dirDisp;
    const bias: "bull" | "bear" | "range" = dirOk ? (dir as Bias) : "range";

    const rawZones = bias === "range" ? [] : battleZones(M, bias);
    const zones = rawZones
      .map((z) => {
        const dist = z.bottom > price ? z.bottom - price : z.top < price ? price - z.top : 0;
        const side = z.bottom > price ? "上" : z.top < price ? "下" : "内";
        let touched = 0;
        for (let k = z.idx + 1; k < M.length; k++) if (M[k].l <= z.top && M[k].h >= z.bottom) touched++;
        const overlap = rawZones.some(
          (o) => o !== z && o.kind !== z.kind && o.bottom <= z.top && o.top >= z.bottom,
        );
        return { ...z, dist, side, fresh: touched === 0, touched, overlap };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5);
    const sweep = sweepQuality(
      htfSt,
      H,
      (bias === "range" ? (dir === "bear" ? "bear" : "bull") : bias) as Bias,
      SWEEP_LOOKBACK,
    );
    const trig: Trig =
      bias === "range"
        ? { stage: "no-zone", inZone: null, confirmed: false, kind: "", internalKind: "" }
        : displayTrigger(M, L, bias, price, ltfAtr);

    const zoneForRisk = trig.inZone ?? (zones.length ? zones[0] : null);
    const risk =
      bias !== "range" && zoneForRisk
        ? buildRisk(bias, zoneForRisk, htfSt, price, ltfAtr, intradayLevels(M, now))
        : null;
    const trail = computeTrailing(H, SWING_LEN);
    const ltfRes = runStructure(L, INTERNAL_LEN);
    const ltfBreak = ltfRes.breaks.length ? ltfRes.breaks[ltfRes.breaks.length - 1] : null;

    return {
      price,
      bias,
      bg,
      htfTrend,
      dirOk,
      dirFresh,
      dirDisp,
      htfRes: htfSt,
      mtfRes: mtfSt,
      lastBreak: dirLast ?? null,
      zones,
      trig: { ...trig, ltfBreak },
      risk,
      trail,
      atr: ltfAtr,
      sweep,
    };
  },
});
