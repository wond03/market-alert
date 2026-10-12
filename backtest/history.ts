// 历史 K 线抓取：Gate 期货 candlesticks 单次最多 2000 根，且只允许「最近 10000 点」。
// 因此按块向前翻页，直到达到目标点数或触达历史边界。

export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

const GATE = "https://api.gateio.ws/api/v4";
const HEADERS = { "User-Agent": "market-alert-backtest/1.0", Accept: "application/json" };

const SEC: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

function normalize(list: Candle[]): Candle[] {
  const clean = list.filter(
    (c) => isFinite(c.t) && isFinite(c.o) && isFinite(c.h) && isFinite(c.l) && isFinite(c.c) && c.t > 0,
  );
  clean.sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  for (const c of clean) {
    if (out.length && out[out.length - 1].t === c.t) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}

async function fetchChunk(contract: string, interval: string, from: number, to: number): Promise<Candle[]> {
  const url =
    `${GATE}/futures/usdt/candlesticks` +
    `?contract=${contract}&interval=${interval}&from=${from}&to=${to}`;
  const res = await fetch(url, { headers: HEADERS });
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) {
    const msg = JSON.stringify(raw);
    if (msg.includes("too long ago")) throw new Error("TOO_OLD");
    throw new Error(`gate error: ${msg}`);
  }
  return normalize(
    (raw as Record<string, unknown>[]).map((cd) => ({
      t: Number(cd.t),
      o: Number(cd.o),
      h: Number(cd.h),
      l: Number(cd.l),
      c: Number(cd.c),
      v: Number(cd.v),
    })),
  );
}

// 抓取截至现在的最近 maxPoints 根【已收盘】K 线（升序）。
export async function fetchHistory(
  contract: string,
  interval: string,
  maxPoints: number,
  chunkPoints = 2000,
): Promise<Candle[]> {
  const sec = SEC[interval];
  if (!sec) throw new Error(`unsupported interval: ${interval}`);
  const now = Math.floor(Date.now() / 1000);
  let to = now;
  const out: Candle[] = [];
  const seen = new Set<number>();
  while (out.length < maxPoints) {
    const from = to - chunkPoints * sec;
    let chunk: Candle[];
    try {
      chunk = await fetchChunk(contract, interval, from, to);
    } catch (e) {
      if (String(e).includes("TOO_OLD")) break;
      throw e;
    }
    if (chunk.length === 0) break;
    for (const c of chunk) {
      if (!seen.has(c.t)) {
        seen.add(c.t);
        out.push(c);
      }
    }
    const first = chunk[0].t;
    if (first >= to) break;
    to = first;
  }
  out.sort((a, b) => a.t - b.t);
  const closed = out.filter((c) => c.t + sec <= now);
  return closed;
}
