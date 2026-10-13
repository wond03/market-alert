// 非价格结构信号源筛查：合约持仓/情绪数据的事件研究。
//
// 变量（Gate contract_stats）：散户多空比(lsr_account)、大户多空比(top_lsr_size)、
// 吃单多空比(lsr_taker)、爆仓量(long_liq_usd/short_liq_usd)、持仓量(open_interest)、资金费(last_funding_rate)。
//
// 做法：每个 bar 收盘按条件产生方向 dir∈{-1,0,1}，看未来 H 根的价格收益（mark_price）。
//       净收益 = dir*收益 - 成本。与「每根都做多」的基准对比，看条件是否真有预测力。
//       完全不做出场规则调参——这是筛查，不是决策机器。
//
// 运行：./node_modules/.bin/esbuild backtest/positioning.ts --bundle --platform=node --format=esm \
//        --outfile=/tmp/posbt.mjs && node /tmp/posbt.mjs

const GATE = "https://api.gateio.ws/api/v4";
const SYMBOLS = ["BTC", "XAU"];
const CONTRACT: Record<string, string> = { BTC: "BTC_USDT", XAU: "XAU_USDT" };
const INTERVAL = "1h";
const SEC = 3600;
const WIN = 168; // z-score 滚动窗口（7 天）
const THR = 1.0; // 极端阈值（|z|>THR 才触发）
const COST = 0.0007; // 单次往返成本
const HORIZONS = [4, 8, 24];

type Stat = {
  t: number;
  mark: number;
  taker: number;
  account: number;
  topLsr: number;
  liqL: number;
  liqS: number;
  oi: number;
  fund: number;
};

async function getJson(url: string, tries = 4): Promise<any> {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "market-alert-backtest/1.0", Accept: "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (k === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 400 * (k + 1)));
    }
  }
}

async function fetchStats(contract: string, interval: string): Promise<Stat[]> {
  const sec = interval === "4h" ? 14400 : SEC;
  const now = Math.floor(Date.now() / 1000);
  let from = now - 179 * 86400;
  const seen = new Map<number, Stat>();
  for (let page = 0; page < 40; page++) {
    const to = Math.min(from + 1000 * sec, now);
    const url = `${GATE}/futures/usdt/contract_stats?contract=${contract}&interval=${interval}&from=${from}&to=${to}&limit=1000`;
    const arr = await getJson(url);
    if (Array.isArray(arr)) {
      for (const s of arr) {
        seen.set(s.time, {
          t: s.time,
          mark: +s.mark_price,
          taker: +s.lsr_taker,
          account: +s.lsr_account,
          topLsr: +s.top_lsr_size,
          liqL: +s.long_liq_usd,
          liqS: +s.short_liq_usd,
          oi: +s.open_interest,
          fund: +s.last_funding_rate,
        });
      }
    }
    if (to >= now) break;
    from = to;
  }
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

function rollingZ(xs: number[], w: number): number[] {
  const out = new Array(xs.length).fill(NaN);
  for (let i = 0; i < xs.length; i++) {
    if (i < w) continue;
    let m = 0;
    for (let k = i - w + 1; k <= i; k++) m += xs[k];
    m /= w;
    let v = 0;
    for (let k = i - w + 1; k <= i; k++) v += (xs[k] - m) ** 2;
    const sd = Math.sqrt(v / w);
    out[i] = sd > 0 ? (xs[i] - m) / sd : 0;
  }
  return out;
}

// 对可能为 0 的正值序列取对数，加下限避免 -Inf 污染滚动统计
const lfloor = (x: number) => Math.log(Math.max(x, 1e-3));

type Cond = { name: string; dir: (r: Row, z: ZS, i: number) => number };
type Row = Stat;
type ZS = { taker: number[]; account: number[]; topLsr: number[]; liqSkew: number[]; oiChg: number[]; fund: number[]; ret: number[] };

function buildSeries(rows: Stat[]): { z: ZS; ret1: number[] } {
  const taker = rollingZ(rows.map((r) => lfloor(r.taker)), WIN);
  const account = rollingZ(rows.map((r) => lfloor(r.account)), WIN);
  const topLsr = rollingZ(rows.map((r) => lfloor(r.topLsr)), WIN);
  const liqSkew = rollingZ(rows.map((r) => Math.log(r.liqL + 1e3) - Math.log(r.liqS + 1e3)), WIN);
  const oi = rows.map((r) => Math.log(Math.max(r.oi, 1)));
  const oiChg = rollingZ(oi.map((x, i) => (i > 0 && isFinite(x) && isFinite(oi[i - 1]) ? x - oi[i - 1] : NaN)), WIN);
  const fund = rollingZ(rows.map((r) => r.fund), WIN);
  const ret1 = rows.map((r, i) => (i > 0 ? r.mark / rows[i - 1].mark - 1 : NaN));
  return { z: { taker, account, topLsr, liqSkew, oiChg, fund, ret: ret1 }, ret1 };
}

function conds(): Cond[] {
  const z = (arr: number[], i: number) => arr[i];
  return [
    { name: "散户多空比 反向(拥挤反做)", dir: (r, zs, i) => (z(zs.account, i) > THR ? -1 : z(zs.account, i) < -THR ? 1 : 0) },
    { name: "吃单多空比 顺势", dir: (r, zs, i) => (z(zs.taker, i) > THR ? 1 : z(zs.taker, i) < -THR ? -1 : 0) },
    { name: "吃单多空比 反向", dir: (r, zs, i) => (z(zs.taker, i) > THR ? -1 : z(zs.taker, i) < -THR ? 1 : 0) },
    { name: "大户多空比 跟随", dir: (r, zs, i) => (z(zs.topLsr, i) > THR ? 1 : z(zs.topLsr, i) < -THR ? -1 : 0) },
    { name: "大户多空比 反向", dir: (r, zs, i) => (z(zs.topLsr, i) > THR ? -1 : z(zs.topLsr, i) < -THR ? 1 : 0) },
    { name: "爆仓失衡 反转(多被杀→做多)", dir: (r, zs, i) => (z(zs.liqSkew, i) > THR ? 1 : z(zs.liqSkew, i) < -THR ? -1 : 0) },
    { name: "爆仓失衡 顺势", dir: (r, zs, i) => (z(zs.liqSkew, i) > THR ? -1 : z(zs.liqSkew, i) < -THR ? 1 : 0) },
    { name: "持仓量扩张 顺势/收缩 反向", dir: (r, zs, i) => { const zo = z(zs.oiChg, i); const pr = zs.ret[i]; if (!isFinite(zo) || !isFinite(pr)) return 0; const s = pr > 0 ? 1 : pr < 0 ? -1 : 0; return zo > THR ? s : zo < -THR ? -s : 0; } },
    { name: "资金费 反向", dir: (r, zs, i) => (z(zs.fund, i) > THR ? -1 : z(zs.fund, i) < -THR ? 1 : 0) },
    { name: "资金费 顺势", dir: (r, zs, i) => (z(zs.fund, i) > THR ? 1 : z(zs.fund, i) < -THR ? -1 : 0) },
  ];
}

function statsOf(xs: number[]) {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, win: n ? xs.filter((x) => x > 0).length / n : 0, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

const pct = (x: number) => ((x * 100).toFixed(3) + "%").padStart(8);
const pad = (s: unknown, w = 4) => String(s).padStart(w);

async function main() {
  const rowsBySym: Record<string, Stat[]> = {};
  for (const sym of SYMBOLS) {
    rowsBySym[sym] = await fetchStats(CONTRACT[sym], INTERVAL);
    const r = rowsBySym[sym];
    console.log(`${sym}: ${r.length} bars  ${new Date(r[0].t * 1000).toISOString().slice(0, 10)} ~ ${new Date(r[r.length - 1].t * 1000).toISOString().slice(0, 10)}`);
  }

  // 基准：每根都做多（用于衡量条件信号相对市场漂移的超额）
  const base: Record<string, number> = {};
  console.log(`\n=== 基准（每根都做多，净=${COST * 100}%/笔）===`);
  for (const sym of SYMBOLS) {
    const { ret1 } = buildSeries(rowsBySym[sym]);
    for (const H of HORIZONS) {
      const fwd: number[] = [];
      for (let i = 0; i + H < ret1.length; i += H) fwd.push(rowsBySym[sym][i + H].mark / rowsBySym[sym][i].mark - 1 - COST);
      const s = statsOf(fwd);
      base[`${sym}|${H}`] = s.mean;
      console.log(`  ${sym} H=${pad(H, 2)}h  n=${pad(s.n, 4)} 均值 ${pct(s.mean)} 胜率 ${(s.win * 100).toFixed(0)}% t=${s.t.toFixed(2)}`);
    }
  }

  console.log(`\n=== 条件信号（净收益，H∈{4,8,24}h）===`);
  for (const c of conds()) {
    console.log(`\n[${c.name}]`);
    for (const sym of SYMBOLS) {
      const rows = rowsBySym[sym];
      const { z } = buildSeries(rows);
      for (const H of HORIZONS) {
        // 非重叠取样：一次进场后至少间隔 H 根才允许下一笔，避免重叠收益抬高 t
        const pnls: number[] = [];
        let last = -1e9;
        for (let i = WIN; i + H < rows.length; i++) {
          const d = c.dir(rows[i], z, i);
          if (!d || i - last < H) continue;
          const fwd = rows[i + H].mark / rows[i].mark - 1;
          pnls.push(d * fwd - COST);
          last = i;
        }
        const s = statsOf(pnls);
        if (s.n < 20) {
          console.log(`  ${sym} H=${pad(H, 2)}h  n=${pad(s.n, 4)}  (样本不足)`);
          continue;
        }
        const ex = s.mean - base[`${sym}|${H}`];
        console.log(`  ${sym} H=${pad(H, 2)}h  n=${pad(s.n, 4)} 均值 ${pct(s.mean)} 超额 ${pct(ex)} 胜率 ${(s.win * 100).toFixed(0)}% t=${s.t.toFixed(2)}`);
      }
    }
  }
}

await main();
