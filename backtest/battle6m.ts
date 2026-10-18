import fsSync from "node:fs";
import fsSync from "node:fs";
import { battleZones, evaluateBattle, type BattleState } from "../convex/battleCore";
import { INTERNAL_LEN, runStructure } from "../convex/luxSmc";

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

const SYMS = [
  { name: "BTC", binance: "BTCUSDT" },
  { name: "XAU", binance: "PAXGUSDT" },
];

const DAYS = Number(process.env.BT_DAYS ?? 182);
const FWD_BARS = 288;
const COST_ROUNDTRIP = 0.0010;
const BJ = 8 * 3600;
const SPANS = (process.env.BT_SPANS ?? "6,12").split(",").map(Number);
const PRE_C = process.env.BT_C === "1";
const ZW = Number(process.env.BT_ZW ?? 0);
const STEP: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600 };

const pad = (s: string, w: number) => String(s).padStart(w);
const padE = (s: string, w: number) => String(s).padEnd(w);
const f = (x: number, d = 2) => (isFinite(x) ? x.toFixed(d) : "-");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function weekStart(t: number): number {
  const day = Math.floor((t + BJ) / 86400);
  const monday = day - ((day + 3) % 7);
  return monday * 86400 - BJ;
}

function dayKey(t: number): number {
  return Math.floor((t + BJ) / 86400);
}

async function klines(symbol: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  const stepMs = STEP[interval] * 1000;
  const cacheDir = "/tmp/opencode/klines";
  fsSync.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = `${cacheDir}/${symbol}-${interval}-${startMs}-${endMs}.json`;
  if (fsSync.existsSync(cacheFile)) return JSON.parse(fsSync.readFileSync(cacheFile, "utf8")) as Candle[];
  const startSec = startMs / 1000;
  const endSec = endMs / 1000;
  const need = ((endSec - startSec) / STEP[interval]) * 0.9;
  for (const f of fsSync.readdirSync(cacheDir)) {
    if (!f.startsWith(`${symbol}-${interval}-`)) continue;
    const arr = JSON.parse(fsSync.readFileSync(`${cacheDir}/${f}`, "utf8")) as Candle[];
    if (!arr.length || arr[0].t > startSec || arr[arr.length - 1].t + STEP[interval] < endSec) continue;
    const sub = arr.filter((c) => c.t >= startSec && c.t < endSec);
    if (sub.length >= need) return sub;
  }
  const out: Candle[] = [];
  let cur = startMs;
  for (let guard = 0; guard < 300 && cur < endMs; guard++) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cur}&endTime=${endMs}&limit=1500`;
    let raw: unknown = null;
    for (let a = 0; a < 5; a++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
        break;
      } catch {
        await sleep(500 * (a + 1));
      }
    }
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw as unknown[][]) {
      out.push({ t: Number(k[0]) / 1000, o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) });
    }
    const lastT = Number((raw as unknown[][])[raw.length - 1][0]);
    if (lastT + stepMs <= cur) break;
    cur = lastT + stepMs;
    await sleep(80);
  }
  const map = new Map<number, Candle>();
  for (const c of out) map.set(c.t, c);
  const res = [...map.values()].sort((a, b) => a.t - b.t);
  if (res.length >= ((endMs - startMs) / stepMs) * 0.9) fsSync.writeFileSync(cacheFile, JSON.stringify(res));
  return res;
}

function closedEnd(arr: Candle[], tClose: number, sec: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t + sec <= tClose) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Outcome = { rNet: number; why: "target" | "stop" | "time"; exitIdx: number };

function simulate(
  sig: { bias: "long" | "short"; entry: number; stop: number; target: number | null },
  j: number,
  c5: Candle[],
): Outcome {
  const up = sig.bias === "long";
  const risk = Math.abs(sig.entry - sig.stop);
  const costR = risk > 0 ? (COST_ROUNDTRIP * sig.entry) / risk : 0;
  if (!(risk > 0)) return { rNet: 0, why: "time", exitIdx: j };
  const end = Math.min(c5.length, j + 1 + FWD_BARS);
  for (let k = j + 1; k < end; k++) {
    const c = c5[k];
    if (up) {
      if (c.l <= sig.stop) return { rNet: -1 - costR, why: "stop", exitIdx: k };
      if (sig.target != null && c.h >= sig.target) return { rNet: (sig.target - sig.entry) / risk - costR, why: "target", exitIdx: k };
    } else {
      if (c.h >= sig.stop) return { rNet: -1 - costR, why: "stop", exitIdx: k };
      if (sig.target != null && c.l <= sig.target) return { rNet: (sig.entry - sig.target) / risk - costR, why: "target", exitIdx: k };
    }
  }
  const lastC = c5[end - 1];
  const rGross = up ? (lastC.c - sig.entry) / risk : (sig.entry - lastC.c) / risk;
  return { rNet: rGross - costR, why: "time", exitIdx: end - 1 };
}

type Event = {
  sym: string;
  ts: number;
  week: number;
  bias: "long" | "short";
  zoneKey: string;
  sweep: boolean;
  trig: "CHoCH" | "BOS";
  rr: number | null;
  outcome: Outcome | null;
  skip: "" | "position" | "zone";
};

type Window = { sym: string; stage: number; gap?: number | null; c1n?: number; c2n?: number; c2Kind?: string; startT?: number; lastT?: number; c1T?: number; c2T?: number; zoneKey?: string; bias?: string; preAges?: number[]; preTags?: string[] };

type Run = { events: Event[]; windows: Window[]; days: Set<number>; bars: number; zoneBars: number; zones: Set<string> };

function preBreaks(mtf: Candle[], bias: string, startT: number): { ages: number[]; tags: string[] } {
  if (bias !== "bull" && bias !== "bear") return { ages: [], tags: [] };
  const ages: number[] = [];
  const tags: string[] = [];
  for (const b of runStructure(mtf, INTERNAL_LEN).breaks) {
    if (b.dir !== bias) continue;
    const bc = b.t + 900;
    if (bc > startT || bc <= startT - 24 * 900) continue;
    ages.push(Math.max(0, Math.ceil((startT - bc) / 900)));
    tags.push(b.tag);
  }
  const order = ages.map((a, i) => i).sort((x, y) => ages[x] - ages[y]);
  return { ages: order.map((i) => ages[i]), tags: order.map((i) => tags[i]) };
}

async function runSymbol(sym: { name: string; binance: string }): Promise<Record<string, Run>> {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 86400000;
  const c5 = await klines(sym.binance, "5m", startMs, endMs);
  const c15 = await klines(sym.binance, "15m", startMs, endMs);
  const c1h = await klines(sym.binance, "1h", startMs, endMs);

  const result: Record<string, Run> = {};
  for (const span of SPANS) result[span] = { events: [], windows: [], days: new Set(), bars: 0, zoneBars: 0, zones: new Set() };
  if (c5.length < 400 || c15.length < 250 || c1h.length < 60) {
    console.log(`[${sym.name}] 数据不足 5m=${c5.length} 15m=${c15.length} 1h=${c1h.length}`);
    return result;
  }

  const days = new Set<number>();
  for (const c of c5) days.add(dayKey(c.t));
  for (const span of SPANS) result[span].days = days;

  let bars = 0;
  let zoneBars = 0;
  const zones = new Set<string>();
  const cfgs = SPANS.map((span) => ({
    span,
    key: String(span),
    pre: undefined as { bars: number; atr: number } | undefined,
    state: { firedZone: "", zoneKey: "", zoneStartT: null } as BattleState,
    windows: new Map<string, Window>(),
    tradedZones: new Set<string>(),
    lockUntil: -1,
    events: [] as Event[],
  }));
  if (PRE_C) {
    for (const span of SPANS) {
      cfgs.push({
        span,
        key: `${span}c`,
        pre: { bars: 6, atr: 1.5 },
        state: { firedZone: "", zoneKey: "", zoneStartT: null } as BattleState,
        windows: new Map<string, Window>(),
        tradedZones: new Set<string>(),
        lockUntil: -1,
        events: [] as Event[],
      });
    }
  }

  for (let j = 0; j < c5.length; j++) {
    if (j > 0 && j % 20000 === 0) console.log(`[${sym.name}] ${j}/${c5.length}`);
    const tClose = c5[j].t + 300;
    const ltf = c5.slice(Math.max(0, j - 499), j + 1);
    const mEnd = closedEnd(c15, tClose, 900);
    const hEnd = closedEnd(c1h, tClose, 3600);
    const mtf = c15.slice(Math.max(0, mEnd - 299), mEnd);
    const htf = c1h.slice(Math.max(0, hEnd - 199), hEnd);
    if (mtf.length < 220 || htf.length < 60) continue;
    bars++;

    for (const cfg of cfgs) {
      const res = evaluateBattle(htf, mtf, ltf, cfg.state, tClose, "gate", sym.name, {
      confirmSpanMax: cfg.span,
      preAnchorBars: cfg.pre?.bars,
      exhaustAtr: cfg.pre?.atr,
      zoneWindowSec: ZW > 0 ? ZW * 900 : undefined,
      zoneInvalidateMtf: process.env.BT_ZINV === "15",
    });
      cfg.state = { firedZone: res.firedZone, zoneKey: res.zoneKey, zoneStartT: res.zoneStartT };

      const fn = res.funnel;
      if (cfg === cfgs[0] && j % 12 === 0 && (res.bias === "bull" || res.bias === "bear")) {
        for (const z of battleZones(mtf, res.bias, "close")) zones.add(`${sym.name}|${z.kind}:${z.top}:${z.bottom}`);
      }
      if (cfg === cfgs[0] && fn) zoneBars++;
      if (fn) {
        const wk = `${sym.name}|${fn.zoneKey}|${fn.zoneStartT}`;
        let w = cfg.windows.get(wk);
        if (!w) {
          const pb = preBreaks(mtf, res.bias, fn.zoneStartT);
          w = { sym: sym.name, stage: 1, zoneKey: fn.zoneKey, bias: res.bias, preAges: pb.ages, preTags: pb.tags };
          cfg.windows.set(wk, w);
        }
        const rank = fn.tradable ? 5 : fn.pair ? 4 : fn.c2T != null ? 3 : fn.c1T != null ? 2 : 1;
        if (rank > w.stage) w.stage = rank;
        if (fn.gap != null) w.gap = fn.gap;
        if (fn.c1n != null) w.c1n = Math.max(w.c1n ?? 0, fn.c1n);
        if (fn.c2n != null) w.c2n = Math.max(w.c2n ?? 0, fn.c2n);
        if (fn.c2Kind && w.c2Kind == null) w.c2Kind = fn.c2Kind;
        w.startT = fn.zoneStartT;
        w.lastT = tClose;
        if (fn.c1T != null) w.c1T = fn.c1T;
        if (fn.c2T != null && w.c2T == null) w.c2T = fn.c2T;
      }

      const sig = res.signal;
      if (!sig) continue;

      const base: Event = {
        sym: sym.name,
        ts: sig.sigTs,
        week: weekStart(sig.sigTs),
        bias: sig.bias,
        zoneKey: res.zoneKey,
        sweep: sig.sweep,
        trig: sig.confirmInternal,
        rr: sig.rr,
        outcome: null,
        skip: "",
      };

      if (j < cfg.lockUntil) {
        cfg.events.push({ ...base, skip: "position" });
        continue;
      }
      if (cfg.tradedZones.has(res.zoneKey)) {
        cfg.events.push({ ...base, skip: "zone" });
        continue;
      }

      const out = simulate(
        { bias: sig.bias, entry: sig.entryPrice, stop: sig.stopPrice, target: sig.targetPrice },
        j,
        c5,
      );
      cfg.tradedZones.add(res.zoneKey);
      cfg.lockUntil = out.exitIdx + 1;
      const wk = `${sym.name}|${res.zoneKey}|${res.zoneStartT}`;
      const w = cfg.windows.get(wk);
      if (w) w.stage = 6;
      cfg.events.push({ ...base, outcome: out });
    }
  }

  for (const cfg of cfgs) result[cfg.key] = { events: cfg.events, windows: [...cfg.windows.values()], days, bars, zoneBars, zones };
  return result;
}

function stats(rows: Event[]) {
  const closed = rows.filter((r) => r.outcome);
  const wins = closed.filter((r) => r.outcome!.why === "target").length;
  const losses = closed.filter((r) => r.outcome!.why === "stop").length;
  const time = closed.filter((r) => r.outcome!.why === "time").length;
  const sum = closed.reduce((a, r) => a + r.outcome!.rNet, 0);
  const decided = wins + losses;
  return { n: closed.length, wins, losses, time, winRate: decided ? wins / decided : NaN, avg: closed.length ? sum / closed.length : NaN, sum };
}

function header() {
  return (
    padE("group", 30) +
    pad("N", 5) +
    pad("win", 5) +
    pad("loss", 5) +
    pad("time", 5) +
    pad("win%", 7) +
    pad("avgRnet", 9) +
    pad("sumRnet", 9)
  );
}

function row(label: string, s: ReturnType<typeof stats>) {
  return (
    padE(label, 30) +
    pad(String(s.n), 5) +
    pad(String(s.wins), 5) +
    pad(String(s.losses), 5) +
    pad(String(s.time), 5) +
    pad(isFinite(s.winRate) ? (s.winRate * 100).toFixed(0) + "%" : "-", 7) +
    pad(f(s.avg), 9) +
    pad(f(s.sum), 9)
  );
}

async function main() {
  const keys = SPANS.map(String).concat(PRE_C ? SPANS.map((s) => `${s}c`) : []);
  const runs: Record<string, Run> = {};
  for (const k of keys) runs[k] = { events: [], windows: [], days: new Set(), bars: 0, zoneBars: 0, zones: new Set() };

  for (const sym of SYMS) {
    const r = await runSymbol(sym);
    for (const k of keys) {
      runs[k].events.push(...r[k].events);
      runs[k].windows.push(...r[k].windows);
      for (const d of r[k].days) runs[k].days.add(d);
      runs[k].bars += r[k].bars;
      runs[k].zoneBars += r[k].zoneBars;
      for (const z of r[k].zones) runs[k].zones.add(z);
    }
  }

  console.log(`\n=== 配对间隔对比（Binance 数据，${DAYS} 天；XAU=PAXGUSDT 代理） ===`);
  console.log("spans: " + SPANS.map((s) => `${s}根5m=${s * 5}min`).join(" | "));
  console.log(header());
  for (const span of SPANS) console.log(row(`span=${span}`, stats(runs[span].events)));

  if (runs[12]) {
  const base = runs[6].events;
  const wide = runs[12].events;
  const baseZones = new Set(base.map((e) => `${e.sym}|${e.zoneKey}`));
  const inc = wide.filter((e) => !baseZones.has(`${e.sym}|${e.zoneKey}`));

  console.log("\n=== 增量信号（仅 span=12 的区域） ===");
  console.log(header());
  console.log(row("增量 · 全部", stats(inc)));
  for (const sym of SYMS) console.log(row(`增量 · ${sym}`, stats(inc.filter((e) => e.sym === sym.name))));
  console.log(row("增量 · sweep=Y", stats(inc.filter((e) => e.sweep))));
  console.log(row("增量 · sweep=N", stats(inc.filter((e) => !e.sweep))));
  console.log(`增量信号事件 ${inc.length} | 增量开仓 ${inc.filter((e) => e.outcome).length} | 基线开仓 ${runs[6].events.filter((e) => e.outcome).length} | span12 开仓 ${runs[12].events.filter((e) => e.outcome).length}`);

  console.log("\n=== 每周开仓数（span=6 vs span=12） ===");
  console.log(padE("week", 9) + pad("s6", 5) + pad("s12", 5) + pad("increment", 10));
  const allEvents = [...base, ...wide];
  if (allEvents.length) {
    const start = weekStart(Math.min(...allEvents.map((e) => e.ts)));
    const end = weekStart(Math.max(...allEvents.map((e) => e.ts)));
    for (let w = start; w <= end; w += 7 * 86400) {
      const s6 = base.filter((e) => e.week === w && e.outcome).length;
      const s12 = wide.filter((e) => e.week === w && e.outcome).length;
      const label = new Date((w + BJ) * 1000).toISOString().slice(5, 10);
      console.log(padE(label, 9) + pad(String(s6), 5) + pad(String(s12), 5) + pad(String(s12 - s6), 10));
    }
  }
  }

  const ev = runs[6].events;
  const SIZES = (process.env.BT_SWEEP_N_SIZES ?? "0.75").split(",").map(Number);
  const isCell = (e: Event) => e.sym === "BTC" && !e.sweep && e.trig === "BOS";
  const sizeOf = (e: Event, s: number) => (isCell(e) ? s : 1);
  const pct = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) + "%" : "-");

  console.log("\n=== 三维：品种 × sweep × 扳机（span=6，仅统计已开仓） ===");
  console.log(padE("sym", 6) + padE("sweep", 7) + padE("trig", 8) + pad("N", 5) + pad("win%", 6) + pad("avgR", 8) + pad("sumR", 9));
  for (const sym of ["BTC", "XAU"]) {
    for (const sw of [true, false]) {
      for (const trig of ["CHoCH", "BOS"]) {
        const g = ev.filter((e) => e.sym === sym && e.sweep === sw && e.trig === trig);
        if (!g.length) continue;
        const st = stats(g);
        console.log(padE(sym, 6) + padE(sw ? "Y" : "N", 7) + padE(trig, 8) + pad(st.n, 5) + pad(pct(st.winRate), 6) + pad(f(st.avg), 8) + pad(f(st.sum), 9));
      }
    }
  }

  const ws = runs[6].windows;
  const hist: Record<number, number> = {};
  for (const w of ws) hist[w.stage] = (hist[w.stage] ?? 0) + 1;
  console.log(`\n[诊断] 窗口 ${ws.length} | 阶段 ${JSON.stringify(hist)} | c1n>0 ${ws.filter((w) => (w.c1n ?? 0) > 0).length} | c2n>0 ${ws.filter((w) => (w.c2n ?? 0) > 0).length} | gap非空 ${ws.filter((w) => w.gap != null).length}`);

  const qv = (arr: number[], p: number) => {
    if (!arr.length) return NaN;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  };
  const durMin = (list: Window[]) => list.map((w) => (w.startT != null && w.lastT != null ? (w.lastT - w.startT) / 60 : NaN)).filter((x) => x >= 0);
  const lost = ws.filter((w) => w.stage < 4 && (w.c2n ?? 0) > 0);
  const lostNoC1 = lost.filter((w) => (w.c1n ?? 0) === 0);
  const lat = lost.filter((w) => w.c2T != null && w.startT != null).map((w) => (w.c2T! - w.startT!) / 60);

  const dg = runs[6];
  const entered = new Set(dg.windows.map((w) => `${w.sym}|${w.zoneKey}`));
  const c1Win = dg.windows.filter((w) => (w.c1n ?? 0) > 0);
  const noC1Win = dg.windows.filter((w) => (w.c1n ?? 0) === 0);
  const lat1 = c1Win.filter((w) => w.c1T != null && w.startT != null).map((w) => (w.c1T! - w.startT!) / 60);
  const c1med = qv(lat1, 0.5);
  const shortShare = noC1Win.filter((w) => w.startT != null && w.lastT != null && (w.lastT - w.startT) / 60 < c1med).length / (noC1Win.length || 1);
  const preN = (w: Window, k: number) => (w.preAges ?? []).some((a) => a <= k);
  const recentAge = (w: Window) => ((w.preAges ?? []).length ? (w.preAges ?? [])[0] : NaN);
  console.log("\n=== 入区层 vs 确认1层 ===");
  console.log(`入区窗口 ${dg.windows.length} | 有效5m bar ${dg.bars} | 在区时间 ${pct(dg.zoneBars / (dg.bars || 1))}`);
  console.log(`去重入区区域 ${entered.size} | 每区域入区 ${(dg.windows.length / (entered.size || 1)).toFixed(2)} | 采样区域供给 ${dg.zones.size} | 入区覆盖率 ${pct(entered.size / (dg.zones.size || 1))}`);
  console.log(`确认1生成率 ${pct(c1Win.length / (dg.windows.length || 1))} (${c1Win.length}/${dg.windows.length}) | 有c1 距入区 中位 ${f(c1med, 0)}min / p90 ${f(qv(lat1, 0.9), 0)}min`);
  console.log(`无c1 ${noC1Win.length} | 时长 中位 ${f(qv(durMin(noC1Win), 0.5), 0)}min | 时长 < 有c1中位延迟 占比 ${pct(shortShare)}`);
  const fisher = (a: number, b: number, c: number, d: number) => {
    const n = a + b + c + d;
    if (!n) return 1;
    const lf: number[] = [0];
    for (let i = 1; i <= n; i++) lf[i] = lf[i - 1] + Math.log(i);
    const lc = (x: number, y: number) => (x < 0 || y < 0 || x > y ? -Infinity : lf[y] - lf[x] - lf[y - x]);
    const at = (x: number) => Math.exp(lc(x, a + b) + lc(a + c - x, c + d) - lc(a + c, n));
    const p0 = at(a);
    const lo = Math.max(0, a + c - (c + d));
    const hi = Math.min(a + b, a + c);
    let s = 0;
    for (let x = lo; x <= hi; x++) {
      const p = at(x);
      if (p <= p0 * (1 + 1e-7)) s += p;
    }
    return Math.min(1, s);
  };
  const hit = (g: Window[], k: number) => g.filter((w) => preN(w, k)).length;
  const pp = (x: number) => (100 * x).toFixed(1);
  const rowRate = (g: Window[], k: number) => {
    const h = hit(g, k);
    return { h, n: g.length, r: h / (g.length || 1) };
  };
  console.log("\n=== preBreak 比例差异：有c1 vs 无c1（15m 根） ===");
  console.log(padE("N根", 6) + pad("有c1", 13) + pad("无c1", 14) + pad("差pp", 8) + pad("Fisher", 9));
  for (const k of [3, 6, 9, 12, 24]) {
    const x = rowRate(c1Win, k);
    const y = rowRate(noC1Win, k);
    const p = fisher(x.h, x.n - x.h, y.h, y.n - y.h);
    console.log(
      padE(String(k), 6) +
        pad(`${x.h}/${x.n} ${pp(x.r)}%`, 13) +
        pad(`${y.h}/${y.n} ${pp(y.r)}%`, 14) +
        pad(pp(y.r - x.r), 8) +
        pad(p < 0.001 ? "<.001" : p.toFixed(3), 9),
    );
  }
  console.log("按币种 N=12（差pp = 无c1 − 有c1）：");
  for (const s of ["BTC", "XAU"]) {
    const g1 = c1Win.filter((w) => w.sym === s);
    const g2 = noC1Win.filter((w) => w.sym === s);
    const x = rowRate(g1, 12);
    const y = rowRate(g2, 12);
    const p = fisher(x.h, x.n - x.h, y.h, y.n - y.h);
    console.log(
      padE(s, 6) +
        pad(`${x.h}/${x.n} ${pp(x.r)}%`, 13) +
        pad(`${y.h}/${y.n} ${pp(y.r)}%`, 14) +
        pad(pp(y.r - x.r), 8) +
        pad(p < 0.001 ? "<.001" : p.toFixed(3), 9),
    );
  }

  const noC2 = ws.filter((w) => w.stage < 4 && (w.c2n ?? 0) === 0);
  const paired = ws.filter((w) => w.stage >= 4);
  console.log("\n=== 三情形（分母 = 区域窗口数） ===");
  console.log(`A 扳机从未出现 ${noC2.length} (${pct(noC2.length / (ws.length || 1))})`);
  console.log(`B 扳机已出现、确认1始终未出现 ${lost.length} (${pct(lost.length / (ws.length || 1))})`);
  console.log("C 确认1已出现、扳机在 12 根之后 0 (0%)");
  console.log(`已配对 ${paired.length} (${pct(paired.length / (ws.length || 1))})`);

  console.log("\n=== 流失窗口的扳机时序（span=6） ===");
  console.log(`流失（有 c2 未配对）${lost.length}（BTC ${lost.filter((w) => w.sym === "BTC").length} / XAU ${lost.filter((w) => w.sym === "XAU").length}）| c1n=0 ${lostNoC1.length} (${pct(lostNoC1.length / (lost.length || 1))}) | c1n>0 ${lost.length - lostNoC1.length}`);
  console.log(`流失窗口时长 中位 ${f(qv(durMin(lost), 0.5), 0)}min | p90 ${f(qv(durMin(lost), 0.9), 0)}min`);
  console.log(`首 c2 距入区 中位 ${f(qv(lat, 0.5), 0)}min | p75 ${f(qv(lat, 0.75), 0)}min | p90 ${f(qv(lat, 0.9), 0)}min`);
  console.log("首个 c2 类型：" + ["CHoCH", "BOS", "吞没", "Pin"].map((k) => `${k} ${lost.filter((w) => w.c2Kind === k).length}`).join(" | "));
  console.log(padE("首c2延迟", 12) + pad("窗口", 7) + pad("占比", 7) + pad("累计", 7));
  let cum = 0;
  for (const [lo, hi] of [[0, 15], [16, 30], [31, 60], [61, 120], [121, 240], [241, 1e9]]) {
    const c = lat.filter((d) => d >= lo && d <= hi).length;
    cum += c;
    const label = hi >= 1e9 ? `>${lo - 1}min` : `${lo}-${hi}min`;
    console.log(padE(label, 12) + pad(String(c), 7) + pad(lat.length ? Math.round((c / lat.length) * 100) + "%" : "-", 7) + pad(lat.length ? Math.round((cum / lat.length) * 100) + "%" : "-", 7));
  }

  console.log("\n=== BTC × sweep=N × BOS 仓位乘数（span=6） ===");
  console.log(padE("size", 7) + pad("组N", 6) + pad("胜率", 6) + pad("原始avg", 9) + pad("原始sum", 9) + pad("加权sum", 9) + pad("BTC总R", 10) + pad("总Rnet", 10) + pad("Δ总Rnet", 10));
  const closedAll = ev.filter((e) => e.outcome);
  const baseTotal = closedAll.reduce((a, e) => a + e.outcome!.rNet, 0);
  const cell = ev.filter(isCell);
  const btcAll = ev.filter((e) => e.sym === "BTC");
  for (const s of [1, ...SIZES]) {
    const st = stats(cell);
    const sumW = st.sum * s;
    const total = closedAll.reduce((a, e) => a + e.outcome!.rNet * sizeOf(e, s), 0);
    const btcTotal = btcAll.filter((e) => e.outcome).reduce((a, e) => a + e.outcome!.rNet * sizeOf(e, s), 0);
    console.log(padE(s === 1 ? "1 基线" : String(s), 7) + pad(String(st.n), 6) + pad(pct(st.winRate), 6) + pad(f(st.avg), 9) + pad(f(st.sum), 9) + pad(f(sumW), 9) + pad(f(btcTotal), 10) + pad(f(total), 10) + pad((total - baseTotal >= 0 ? "+" : "") + f(total - baseTotal), 10));
  }
  console.log(`该组信号 ${cell.length} / 开仓 ${cell.filter((e) => e.outcome).length} | 乘数不改信号数与开仓数；组内原始 R 不变，只有加权口径变化`);
  if (PRE_C && runs["6c"]) {
    const b = runs["6"].events.filter((e) => e.outcome);
    const c = runs["6c"].events.filter((e) => e.outcome);
    const ek = (e: Event) => `${e.sym}|${e.zoneKey}|${e.week}`;
    const bk = new Set(b.map(ek));
    const ck = new Set(c.map(ek));
    const added = c.filter((e) => !bk.has(ek(e)));
    const removed = b.filter((e) => !ck.has(ek(e)));
    const bs = stats(b);
    const cs = stats(c);
    console.log("\n=== C 负对照（锚点前移 6根15m + 配对30min + 1.5×ATR200） ===");
    console.log(header());
    console.log(row("B 基线", bs));
    console.log(row("C 锚点前移", cs));
    console.log(row("新增（C−B）", stats(added)));
    console.log(row("移除（B−C）", stats(removed)));
    console.log(`净 Δ 开仓 ${cs.n - bs.n}|净 Δ 胜率 ${pct(bs.winRate)} → ${pct(cs.winRate)}|净 Δ sumRnet ${f(cs.sum - bs.sum)}`);
    for (const s of ["BTC", "XAU"]) console.log(row(`新增 ${s}`, stats(added.filter((e) => e.sym === s))));
    for (const trig of ["BOS", "CHoCH"]) console.log(row(`新增 ${trig}`, stats(added.filter((e) => e.trig === trig))));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
