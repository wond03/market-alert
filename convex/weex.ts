import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { sendTelegram } from "./telegram";

const SYMBOL_MAP: Record<string, string> = {
  BTC: "BTCUSDT",
  XAU: "XAUTUSDT",
};

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  const value = proc?.env?.[name];
  return value ? String(value).trim() : "";
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} not set`);
  return value;
}

function baseUrl(): string {
  return env("WEEX_BASE_URL") || "https://api-sim.weex.com";
}

async function hmacBase64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  let binary = "";
  for (const byte of new Uint8Array(sig)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signedRequest(
  method: "GET" | "POST",
  path: string,
  query: Record<string, string> = {},
  body?: unknown,
): Promise<unknown> {
  const apiKey = requireEnv("WEEX_API_KEY");
  const secret = requireEnv("WEEX_API_SECRET");
  const passphrase = requireEnv("WEEX_API_PASSPHRASE");
  const queryString = new URLSearchParams(query).toString();
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = await hmacBase64(
    secret,
    timestamp + method + path + queryString + bodyText,
  );
  const url = `${baseUrl()}${path}${queryString ? `?${queryString}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      "ACCESS-KEY": apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-PASSPHRASE": passphrase,
      "ACCESS-TIMESTAMP": timestamp,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : bodyText,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep raw text
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

function dataOf(payload: unknown): any {
  if (Array.isArray(payload) && payload.length === 2) return payload[1];
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

async function hasOpenPosition(contract: string): Promise<boolean> {
  const payload = await signedRequest("GET", "/capi/v3/account/position/allPosition");
  const rows = dataOf(payload);
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    const size = Math.abs(Number(row?.size ?? 0));
    return row?.symbol === contract && size > 0;
  });
}

async function setLeverage(contract: string, leverage: number): Promise<void> {
  await signedRequest("POST", "/capi/v3/account/leverage", {}, {
    symbol: contract,
    marginType: "ISOLATED",
    isolatedLongLeverage: leverage,
    isolatedShortLeverage: leverage,
  });
}

async function lastPrice(contract: string): Promise<number> {
  const res = await fetch(
    `${baseUrl()}/capi/v3/market/ticker/24hr?symbol=${contract}`,
  );
  if (!res.ok) throw new Error(`ticker ${res.status}`);
  const payload = await res.json();
  const rows = dataOf(payload);
  const row = Array.isArray(rows) ? rows[0] : rows;
  const price = Number(row?.lastPrice ?? row?.price ?? 0);
  if (!price) throw new Error(`no price for ${contract}`);
  return price;
}

async function contractSpec(contract: string): Promise<{ precision: number; minSize: number }> {
  const res = await fetch(`${baseUrl()}/capi/v3/market/exchangeInfo`);
  if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
  const payload = await res.json();
  const symbols = (payload as { symbols?: any[] }).symbols ?? [];
  const row = symbols.find((item) => item?.symbol === contract);
  return {
    precision: Number(row?.quantityPrecision ?? 3),
    minSize: Number(row?.minOrderSize ?? 0),
  };
}

function floorTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.floor(value * factor) / factor;
}

function roundPrice(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export const placeSignalOrder = internalAction({
  args: {
    signalId: v.string(),
    symbol: v.string(),
    bias: v.string(),
    entry: v.number(),
    stop: v.number(),
    target: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    if (env("WEEX_AUTO") === "0") return { skipped: "disabled" };
    const contract = SYMBOL_MAP[args.symbol];
    if (!contract) return { skipped: `unsupported ${args.symbol}` };

    const margin = Number(env("WEEX_MARGIN_USDT") || "5");
    const leverage = Number(env("WEEX_LEVERAGE") || "100");
    const long = args.bias === "long";

    try {
      if (await hasOpenPosition(contract)) {
        await sendTelegram(`${contract} 已有持仓，本次信号跳过自动下单`);
        return { skipped: `position exists ${contract}` };
      }
      const [price, spec] = await Promise.all([
        lastPrice(contract),
        contractSpec(contract),
      ]);
      const quantity = floorTo((margin * leverage) / price, spec.precision);
      if (!(quantity > 0) || quantity < spec.minSize) {
        throw new Error(
          `quantity ${quantity} below min ${spec.minSize} for ${contract}`,
        );
      }
      await setLeverage(contract, leverage);
      const payload = await signedRequest("POST", "/capi/v3/order", {}, {
        symbol: contract,
        side: long ? "BUY" : "SELL",
        positionSide: long ? "LONG" : "SHORT",
        type: "MARKET",
        quantity: quantity.toFixed(spec.precision),
        newClientOrderId: `smc-${args.signalId}`.slice(0, 36),
      });
      const rows = dataOf(payload);
      const order = Array.isArray(rows) ? rows[0] : rows;
      const orderId = String(order?.orderId ?? order?.clientOrderId ?? "unknown");
      const stopPrice = roundPrice(args.stop, 2);
      const targetPrice =
        args.target != null
          ? roundPrice(args.target, 2)
          : roundPrice(args.entry + (long ? 1 : -1) * Math.abs(args.entry - args.stop) * 2, 2);
      await sendTelegram(
        [
          `${long ? "多" : "空"} ${contract} 自动入场`,
          `${margin}U x${leverage} @ ~${roundPrice(price, 2)} 数量 ${quantity}`,
          `实际保证金约 ${(quantity * price / leverage).toFixed(2)}U`,
          `参考止损 ${stopPrice}　参考止盈 ${targetPrice}（未挂单）`,
          `订单 ${orderId}，止盈止损由你手动设置`,
        ].join("\n"),
      );
      return { placed: orderId, quantity, price };
    } catch (e) {
      const reason = String(e).slice(0, 200);
      await sendTelegram(`${contract} 自动下单失败：${reason}`);
      return { error: reason };
    }
  },
});
