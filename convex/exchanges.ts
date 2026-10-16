// Gate 合约 K 线抓取适配层：统一输出升序、去重的 Candle[]。

export type Exchange = "gate";

export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

// 规范标的 -> Gate 原生合约代码
export const SYMBOLS: Record<string, Record<Exchange, string>> = {
  BTC: { gate: "BTC_USDT" },
  XAU: { gate: "XAU_USDT" },
};

export function contractOf(exchange: Exchange, symbol: string): string {
  const map = SYMBOLS[symbol];
  if (!map) throw new Error(`unknown symbol: ${symbol}`);
  const contract = map[exchange];
  if (!contract) throw new Error(`no ${exchange} contract for ${symbol}`);
  return contract;
}

const GATE_BASE = "https://api.gateio.ws/api/v4";

const JSON_HEADERS = { "User-Agent": "market-alert/1.0", Accept: "application/json" };

// 升序排序 + 去重（Gate 返回顺序可能含重复时间）
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

export async function getCandles(
  exchange: Exchange,
  contract: string,
  interval: string,
  limit: number = 1000,
): Promise<Candle[]> {
  if (exchange !== "gate") throw new Error(`unsupported exchange: ${exchange}`);
  return gateCandles(contract, interval, limit);
}
