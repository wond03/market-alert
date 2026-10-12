// 多交易所 K 线抓取适配层：统一输出升序、去重的 Candle[]。
// 新增交易所：在 Exchange 联合类型、SYMBOLS、以及 getCandles 的 switch 中补一条。

export type Exchange = "gate" | "weex" | "okx";

export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

// 规范标的 -> 各交易所原生合约代码
export const SYMBOLS: Record<string, Record<Exchange, string>> = {
  BTC: { gate: "BTC_USDT", weex: "BTCUSDT", okx: "BTC-USDT-SWAP" },
  XAU: { gate: "XAU_USDT", weex: "XAUUSDT", okx: "XAU-USDT-SWAP" },
};

export function contractOf(exchange: Exchange, symbol: string): string {
  const map = SYMBOLS[symbol];
  if (!map) throw new Error(`unknown symbol: ${symbol}`);
  const contract = map[exchange];
  if (!contract) throw new Error(`no ${exchange} contract for ${symbol}`);
  return contract;
}

const GATE_BASE = "https://api.gateio.ws/api/v4";
const WEEX_BASE = "https://api-contract.weex.com";
const OKX_BASE = "https://www.okx.com";

const JSON_HEADERS = { "User-Agent": "market-alert/1.0", Accept: "application/json" };

// OKX 的 bar 取值与通用写法不同
const OKX_BAR: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D",
};
const OKX_MAX_LIMIT = 300;

// 升序排序 + 去重（各交易所返回顺序不一致，如 WEEX 会乱序且末尾追加未收盘蜡烛）
function normalize(list: Candle[]): Candle[] {
  const clean = list.filter(
    (c) =>
      isFinite(c.t) && isFinite(c.o) && isFinite(c.h) && isFinite(c.l) &&
      isFinite(c.c) && c.t > 0,
  );
  clean.sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  for (const c of clean) {
    if (out.length && out[out.length - 1].t === c.t) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}

async function gateCandles(
  contract: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const url =
    `${GATE_BASE}/futures/usdt/candlesticks` +
    `?contract=${contract}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: JSON_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} gate ${contract} ${interval}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) return [];
  return normalize(
    raw.map((cd: Record<string, unknown>) => ({
      t: Number(cd.t),
      o: Number(cd.o),
      h: Number(cd.h),
      l: Number(cd.l),
      c: Number(cd.c),
      v: Number(cd.v),
    })),
  );
}

async function weexCandles(
  contract: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const url =
    `${WEEX_BASE}/capi/v3/market/klines` +
    `?symbol=${contract}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: JSON_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} weex ${contract} ${interval}`);
  const raw = await res.json();
  const arr: unknown[] = Array.isArray(raw) ? raw : ((raw?.data as unknown[]) ?? []);
  return normalize(
    arr.map((r) => {
      const row = r as unknown[];
      return {
        t: Math.floor(Number(row[0]) / 1000),
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
        v: Number(row[5]),
      };
    }),
  );
}

async function okxCandles(
  contract: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const bar = OKX_BAR[interval] ?? interval;
  const lim = Math.min(limit, OKX_MAX_LIMIT);
  const url =
    `${OKX_BASE}/api/v5/market/candles` +
    `?instId=${encodeURIComponent(contract)}&bar=${bar}&limit=${lim}`;
  const res = await fetch(url, { headers: JSON_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} okx ${contract} ${interval}`);
  const raw = await res.json();
  if (!raw || raw.code !== "0" || !Array.isArray(raw.data)) return [];
  return normalize(
    raw.data.map((r: unknown[]) => ({
      t: Math.floor(Number(r[0]) / 1000),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]),
    })),
  );
}

export async function getCandles(
  exchange: Exchange,
  contract: string,
  interval: string,
  limit: number = 1000,
): Promise<Candle[]> {
  switch (exchange) {
    case "gate":
      return gateCandles(contract, interval, limit);
    case "weex":
      return weexCandles(contract, interval, limit);
    case "okx":
      return okxCandles(contract, interval, limit);
    default:
      throw new Error(`unsupported exchange: ${exchange}`);
  }
}
