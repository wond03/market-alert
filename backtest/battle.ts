// 回测：猎场信号面板（battle）信号 —— 统一确认窗口版本。
// 复用生产同一套纯逻辑 evaluateBattle（backtest 通过 opts 覆盖 ZONE_WINDOW_SEC / CONFIRM_SPAN_MAX），
// 逐根 5m 收盘推进窗口状态，再按固定风控做前瞻模拟，横向对比不同窗口/间隔参数。
//
// 运行：
//   ./node_modules/.bin/esbuild backtest/battle.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/opencode/bt-battle.mjs && node /tmp/opencode/bt-battle.mjs

import { fetchHistory, type Candle } from "./history";
import { contractOf } from "../convex/exchanges";
import { evaluateBattle, MTF, LTF, type BattleState } from "../convex/battleCore";

const SYMBOLS = ["BTC", "XAU"];
const FWD_BARS = 288; // 前瞻窗口：288 根 5m = 24h
const COST_ROUNDTRIP = 0.0010; // 往返成本 10bps

const FIVE_M = 9000;
const FIFT_M = 3000;
const ONE_H = 900;

type Cfg = { windowSec: number; span: number; label: string };
const CONFIGS: Cfg[] = [
  { windowSec: 12 * 900, span: 6, label: "窗口12×15m span6" },
  { windowSec: 8 * 900, span: 6, label: "窗口8×15m span6" },
  { windowSec: 24 * 900, span: 6, label: "窗口24×15m span6" },
  { windowSec: 12 * 900, span: 3, label: "窗口12×15m span3" },
  { windowSec: 12 * 900, span: 9, label: "窗口12×15m span9" },
];

type Rec = {
  sym: string;
  cfg: string;
  ts: number;
  bias: "long" | "short";
  entry: number;
  stop: number;
  target: number | null;
  rr: number | null;
  rGross: number;
  rNet: number;
  why: "target" | "stop" | "time";
};

const pad = (s: string, w: number) => String(s).padStart(w);
const padE = (s: string, w: number) => String(s).padEnd(w);
const f = (x: number, d = 2) => (isFinite(x) ? x.toFixed(d) : "-");

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

function simulate(sig: { bias: "long" | "short"; entry: number; stop: number; target: number | null }, j: number, c5: Candle[]): { rGross: number; why: Rec["why"] } {
  const up = sig.bias === "long";
  const risk = Math.abs(sig.entry - sig.stop);
  if (!(risk > 0)) return { rGross: 0, why: "time" };
  const end = Math.min(c5.length, j + 1 + FWD_BARS);
  for (let k = j + 1; k < end; k++) {
    const c = c5[k];
    if (up) {
      if (c.l <= sig.stop) return { rGross: -1, why: "stop" };
      if (sig.target != null && c.h >= sig.target) return { rGross: (sig.target - sig.entry) / risk, why: "target" };
    } else {
      if (c.h >= sig.stop) return { rGross: -1, why: "stop" };
      if (sig.target != null && c.l <= sig.target) return { rGross: (sig.entry - sig.target) / risk, why: "target" };
    }
  }
  const lastC = c5[end - 1];
  const rGross = up ? (lastC.c - sig.entry) / risk : (sig.entry - lastC.c) / risk;
  return { rGross, why: "time" };
}

async function runSymbol(sym: string): Promise<Rec[]> {
  const c5 = await fetchHistory(contractOf("gate", sym), "5m", FIVE_M);
  const c15 = await fetchHistory(contractOf("gate", sym), "15m", FIFT_M);
  const c1h = await fetchHistory(contractOf("gate", sym), "1h", ONE_H);
  if (c5.length < 400 || c15.length < 250 || c1h.length < 60) {
    console.log(`[${sym}] 数据不足，跳过 (5m=${c5.length} 15m=${c15.length} 1h=${c1h.length})`);
    return [];
  }
  const states: Record<string, BattleState> = {};
  for (const cfg of CONFIGS) states[cfg.label] = { firedZone: "", zoneKey: "", zoneStartT: null };

  const recs: Rec[] = [];
  for (let j = 0; j < c5.length; j++) {
    const tClose = c5[j].t + 300;
    const ltf = c5.slice(Math.max(0, j - 499), j + 1);
    const mEnd = closedEnd(c15, tClose, 900);
    const hEnd = closedEnd(c1h, tClose, 3600);
    const mtf = c15.slice(Math.max(0, mEnd - 299), mEnd);
    const htf = c1h.slice(Math.max(0, hEnd - 199), hEnd);
    if (mtf.length < 220 || htf.length < 60) continue;

    for (const cfg of CONFIGS) {
      const res = evaluateBattle(htf, mtf, ltf, states[cfg.label], tClose, "gate", sym, {
        zoneWindowSec: cfg.windowSec,
        confirmSpanMax: cfg.span,
      });
      states[cfg.label] = { firedZone: res.firedZone, zoneKey: res.zoneKey, zoneStartT: res.zoneStartT };
      const sig = res.signal;
      if (!sig) continue;
      const { rGross, why } = simulate(
        { bias: sig.bias, entry: sig.entryPrice, stop: sig.stopPrice, target: sig.targetPrice },
        j,
        c5,
      );
      const risk = Math.abs(sig.entryPrice - sig.stopPrice);
      const costR = risk > 0 ? (COST_ROUNDTRIP * sig.entryPrice) / risk : 0;
      recs.push({
        sym,
        cfg: cfg.label,
        ts: sig.sigTs,
        bias: sig.bias,
        entry: sig.entryPrice,
        stop: sig.stopPrice,
        target: sig.targetPrice,
        rr: sig.rr,
        rGross,
        rNet: rGross - costR,
        why,
      });
    }
  }
  return recs;
}

function summarize(recs: Rec[]) {
  const n = recs.length;
  const wins = recs.filter((r) => r.why === "target").length;
  const losses = recs.filter((r) => r.why === "stop").length;
  const time = recs.filter((r) => r.why === "time").length;
  const sumNet = recs.reduce((a, r) => a + r.rNet, 0);
  const sumGross = recs.reduce((a, r) => a + r.rGross, 0);
  const decided = wins + losses;
  return { n, wins, losses, time, winRate: decided ? wins / decided : NaN, avgNet: n ? sumNet / n : NaN, avgGross: n ? sumGross / n : NaN, sumNet, sumGross };
}

async function main() {
  const all: Rec[] = [];
  for (const sym of SYMBOLS) {
    const recs = await runSymbol(sym);
    console.log(`[${sym}] 生成 ${recs.length} 条 (各配置合计)`);
    all.push(...recs);
  }

  const groups: { label: string; recs: Rec[] }[] = [];
  for (const cfg of CONFIGS) {
    groups.push({ label: cfg.label, recs: all.filter((r) => r.cfg === cfg.label) });
    for (const sym of SYMBOLS) groups.push({ label: `${sym} · ${cfg.label}`, recs: all.filter((r) => r.cfg === cfg.label && r.sym === sym) });
  }

  console.log("\n=== 分组统计（R 为风险单位；net 已扣 10bps 往返） ===");
  console.log(padE("group", 30) + pad("N", 5) + pad("win", 5) + pad("loss", 5) + pad("time", 5) + pad("win%", 7) + pad("avgRnet", 9) + pad("sumRnet", 9));
  for (const g of groups) {
    const s = summarize(g.recs);
    console.log(
      padE(g.label, 30) +
        pad(String(s.n), 5) +
        pad(String(s.wins), 5) +
        pad(String(s.losses), 5) +
        pad(String(s.time), 5) +
        pad(isFinite(s.winRate) ? (s.winRate * 100).toFixed(0) + "%" : "-", 7) +
        pad(f(s.avgNet), 9) +
        pad(f(s.sumNet), 9),
    );
  }

  console.log("\n=== 明细 ===");
  console.log(padE("sym", 5) + padE("cfg", 20) + padE("time", 16) + padE("bias", 6) + pad("rr", 6) + pad("Rnet", 7) + padE(" why", 7));
  for (const r of all.sort((a, b) => a.ts - b.ts)) {
    const t = new Date((r.ts + 8 * 3600) * 1000).toISOString().slice(5, 16).replace("T", " ");
    console.log(padE(r.sym, 5) + padE(r.cfg, 20) + padE(t + " BJ", 16) + padE(r.bias, 6) + pad(r.rr == null ? "-" : f(r.rr, 1), 6) + pad(f(r.rNet), 7) + padE(" " + r.why, 7));
  }
  console.log(`\nMTF=${MTF.tf} LTF=${LTF.tf} 前瞻=${FWD_BARS}根5m(24h) 成本=${COST_ROUNDTRIP * 1e4}bps`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
