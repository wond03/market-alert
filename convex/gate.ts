// 告警判定逻辑（穿越/突破/聚合/文案），移植自 alerts/check.py。
// 交易所 K 线抓取见 exchanges.ts。

import { getCandles, contractOf, type Candle, type Exchange } from "./exchanges";

export type { Candle };
export const BJ_OFFSET = 8 * 3600; // 北京时间相对 UTC 的偏移（秒）
export const BASE_INTERVAL = "1h";
export const SCAN_INTERVAL = "1m";
export const CANDLE_LIMIT = 1000;
// 突破类规则统一用 15 分钟 K 线判定（区分影线/实体），收盘后才触发。
export const BREAK_INTERVAL = "15m";
export const BREAK_SECONDS = 900;

// 15m/1h/4h 的北京时间边界与 UTC 边界重合，可直接取原生周期；
// 日线需按北京时间聚合，故统一用 1h 聚合（见 prevOhlcLevel）。
export const NATIVE_TFS: Record<string, boolean> = { "15m": true };
export const TF_SECONDS: Record<string, number> = {
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};
export const TF_NAME: Record<string, string> = {
  "15m": "15分钟",
  "1h": "1小时",
  "4h": "4小时",
  "1d": "日",
};
export const FIELD_NAME: Record<string, string> = {
  open: "开",
  high: "高",
  low: "低",
  close: "收",
};
export const EXCHANGE_NAME: Record<string, string> = {
  gate: "Gate",
  weex: "WEEX",
  okx: "OKX",
};

// 看盘页地址（GitHub Pages），用于告警推送里附上可点击链接。
export const DASHBOARD_URL = "https://wond03.github.io/market-alert/";

// 交易时段（与看盘页「交易时段 Sessions」指标默认值一致，用各自交易所所在时区）
export type Session = { name: string; tz: string; start: number; end: number };
export const SESSIONS: Session[] = [
  { name: "亚洲盘", tz: "Asia/Tokyo", start: 9 * 60, end: 15 * 60 },
  { name: "伦敦盘", tz: "Europe/London", start: 8 * 60, end: 16 * 60 + 30 },
  { name: "纽约盘", tz: "America/New_York", start: 9 * 60 + 30, end: 16 * 60 },
];
export const SESSION_INTERVAL = "5m";
export const SESSION_CANDLE_LIMIT = 700; // 约 2.4 天，足够覆盖最近一个已结束时段

// 时段循环顺序：亚洲盘 → 伦敦盘 → 纽约盘 →（次日）亚洲盘
export const SESSION_CYCLE = ["亚洲盘", "伦敦盘", "纽约盘"];
// 「前一时段」映射：当前时段的上一段（亚洲盘取前一个纽约盘）
export const SESSION_PREV: Record<string, string> = {
  亚洲盘: "纽约盘",
  伦敦盘: "亚洲盘",
  纽约盘: "伦敦盘",
};

export type Side = "above" | "below";

export type RuleDoc = {
  _id: string;
  exchange: Exchange;
  symbol: string;
  label: string;
  type: "cross_up" | "cross_down" | "breakout";
  price?: number;
  indicator?: string;
  tf?: string;
  offset?: number;
  field?: string;
  dir?: string;
  enabled: boolean;
};

export type Fired = {
  rule: RuleDoc;
  firedTs: number;
  firedPrice: number;
  level: number;
  isUp: boolean;
};

type Period = { key: number; open: number; high: number; low: number; close: number };

// 把升序蜡烛聚合为按北京时间对齐的周期。
export function aggregatePeriods(candles: Candle[], secs: number): Period[] {
  const out: Period[] = [];
  let cur: Period | null = null;
  for (const cd of candles) {
    const key = Math.floor((cd.t + BJ_OFFSET) / secs);
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur);
      cur = { key, open: cd.o, high: cd.h, low: cd.l, close: cd.c };
    } else {
      cur.high = Math.max(cur.high, cd.h);
      cur.low = Math.min(cur.low, cd.l);
      cur.close = cd.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function prevOhlcLevel(
  exchange: Exchange,
  symbol: string,
  tf: string,
  offset: number,
  field: string,
  cache: Map<string, Candle[]>,
): Promise<number> {
  const secs = TF_SECONDS[tf];
  if (!secs) throw new Error(`unsupported tf: ${tf}`);
  if (!FIELD_NAME[field]) throw new Error(`unsupported field: ${field}`);
  if (offset < 2) {
    throw new Error("breakout 需要 offset >= 2（当前正在形成的周期不适用）");
  }
  const base = NATIVE_TFS[tf] ? tf : BASE_INTERVAL;
  const cacheKey = `${exchange}:${symbol}:${base}`;
  let candles = cache.get(cacheKey);
  if (!candles) {
    candles = await getCandles(exchange, contractOf(exchange, symbol), base);
    cache.set(cacheKey, candles);
  }
  const periods = aggregatePeriods(candles, secs);
  const idx = periods.length - offset;
  if (idx < 0) {
    throw new Error(`offset ${offset} 超出可用周期数 ${periods.length}`);
  }
  return (periods[idx] as unknown as Record<string, number>)[field];
}

/* ================= 交易时段（亚洲盘/伦敦盘/纽约盘） ================= */
const _tzFmt: Record<string, Intl.DateTimeFormat> = {};
function tzFormatter(tz: string): Intl.DateTimeFormat {
  let f = _tzFmt[tz];
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
      });
    } catch {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false,
      });
    }
    _tzFmt[tz] = f;
  }
  return f;
}
// 该时刻在指定时区的「当日分钟数」(0..1439)
export function tzMinutes(ts: number, tz: string): number {
  const parts = tzFormatter(tz).formatToParts(new Date(ts * 1000));
  let hh = 0, mm = 0;
  for (const p of parts) {
    if (p.type === "hour") hh = parseInt(p.value, 10) % 24;
    else if (p.type === "minute") mm = parseInt(p.value, 10);
  }
  return hh * 60 + mm;
}
export function inWindow(m: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return m >= start && m < end;
  return m >= start || m < end;
}

// 该时刻所处时段名；重叠时取循环顺序靠后的那个（伦敦/纽约重叠时算纽约盘）。
export function currentSessionName(now: number): string | null {
  let best: string | null = null;
  let bestIdx = -1;
  for (const s of SESSIONS) {
    if (!inWindow(tzMinutes(now, s.tz), s.start, s.end)) continue;
    const idx = SESSION_CYCLE.indexOf(s.name);
    if (idx > bestIdx) {
      best = s.name;
      bestIdx = idx;
    }
  }
  return best;
}

// 找出「最近一个已结束的交易时段」的高/低（跳过仍在进行中的那个）。
export function latestCompletedSession(
  candles: Candle[],
): { name: string; high: number; low: number; endT: number } | null {
  if (candles.length === 0) return null;
  const lastIdx = candles.length - 1;
  const cache = new Map<string, number[]>();
  const minsFor = (tz: string): number[] => {
    let arr = cache.get(tz);
    if (!arr) {
      arr = candles.map((c) => tzMinutes(c.t, tz));
      cache.set(tz, arr);
    }
    return arr;
  };
  let best: { name: string; high: number; low: number; endT: number } | null = null;
  for (const s of SESSIONS) {
    const arr = minsFor(s.tz);
    let i = 0;
    while (i < candles.length) {
      if (!inWindow(arr[i], s.start, s.end)) { i++; continue; }
      let high = -Infinity, low = Infinity;
      while (i < candles.length && inWindow(arr[i], s.start, s.end)) {
        high = Math.max(high, candles[i].h);
        low = Math.min(low, candles[i].l);
        i++;
      }
      const i1 = i - 1;
      if (i1 >= lastIdx) continue; // 该时段仍在进行中
      const endT = candles[i1].t;
      if (!best || endT > best.endT) best = { name: s.name, high, low, endT };
    }
  }
  return best;
}

type SessionRange = { name: string; high: number; low: number; endT: number; open: boolean };

// candles 中「最近一段」指定时段的区间（该段可能仍在进行中，open=true）。
function latestSessionRange(
  candles: Candle[],
  s: Session,
  now: number,
): SessionRange | null {
  if (candles.length === 0) return null;
  const lastIdx = candles.length - 1;
  const mins = candles.map((c) => tzMinutes(c.t, s.tz));
  let range: SessionRange | null = null;
  let i = 0;
  while (i < candles.length) {
    if (!inWindow(mins[i], s.start, s.end)) { i++; continue; }
    let high = -Infinity, low = Infinity, j = i;
    while (j < candles.length && inWindow(mins[j], s.start, s.end)) {
      high = Math.max(high, candles[j].h);
      low = Math.min(low, candles[j].l);
      j++;
    }
    const endIdx = j - 1;
    const open = endIdx >= lastIdx && inWindow(tzMinutes(now, s.tz), s.start, s.end);
    range = { name: s.name, high, low, endT: candles[endIdx].t, open };
    i = j;
  }
  return range;
}

async function prevSessionLevel(
  exchange: Exchange,
  symbol: string,
  field: string,
  cache: Map<string, Candle[]>,
): Promise<{ level: number; name: string }> {
  if (field !== "high" && field !== "low") {
    throw new Error("prev_session 仅支持 field=high/low");
  }
  const cacheKey = `${exchange}:${symbol}:${SESSION_INTERVAL}`;
  let candles = cache.get(cacheKey);
  if (!candles) {
    candles = await getCandles(
      exchange,
      contractOf(exchange, symbol),
      SESSION_INTERVAL,
      SESSION_CANDLE_LIMIT,
    );
    cache.set(cacheKey, candles);
  }
  const now = Math.floor(Date.now() / 1000);
  // 参考时段：处于某时段时取其「前一段」（亚洲盘→纽约盘、伦敦盘→亚洲盘、纽约盘→伦敦盘）；
  // 时段间隙时取「最近一个已结束的时段」。
  let targetName: string;
  const cur = currentSessionName(now);
  if (cur) {
    targetName = SESSION_PREV[cur] ?? cur;
  } else {
    const sess = latestCompletedSession(candles);
    if (!sess) throw new Error("尚无可用的交易时段参考");
    targetName = sess.name;
  }
  const s = SESSIONS.find((x) => x.name === targetName);
  if (!s) throw new Error(`未知时段: ${targetName}`);
  const r = latestSessionRange(candles, s, now);
  if (!r) throw new Error(`暂无「${targetName}」区间数据`);
  return { level: field === "low" ? r.low : r.high, name: r.name };
}

// 返回 (level, isUp, desc)。isUp=true 表示关注向上穿越。
export async function resolveLevel(
  rule: RuleDoc,
  cache: Map<string, Candle[]>,
): Promise<{ level: number; isUp: boolean; desc?: string }> {
  if (rule.type === "breakout") {
    const indicator = rule.indicator ?? "prev_ohlc";
    const field = rule.field ?? "high";
    const isUp = (rule.dir ?? "up") === "up";
    if (indicator === "prev_session") {
      const { level, name } = await prevSessionLevel(
        rule.exchange,
        rule.symbol,
        field,
        cache,
      );
      return { level, isUp, desc: `前时段(${name})${FIELD_NAME[field] ?? field}` };
    }
    if (indicator !== "prev_ohlc") {
      throw new Error(`unsupported indicator: ${indicator}`);
    }
    const level = await prevOhlcLevel(
      rule.exchange,
      rule.symbol,
      rule.tf ?? "1d",
      rule.offset ?? 2,
      field,
      cache,
    );
    return { level, isUp };
  }
  return { level: Number(rule.price), isUp: rule.type === "cross_up" };
}

// 顺序遍历蜡烛，返回首次进入监控侧的时刻与收盘价，以及最终所在侧。
export function scanCross(
  candles: Candle[],
  level: number,
  prevSide: Side,
  isUp: boolean,
): { firedTs: number | null; firedPrice: number | null; side: Side } {
  let side: Side = prevSide;
  let firedTs: number | null = null;
  let firedPrice: number | null = null;
  for (const cd of candles) {
    const cur: Side = cd.c >= level ? "above" : "below";
    if (cur !== side && firedTs === null) {
      if (
        (isUp && side === "below" && cur === "above") ||
        (!isUp && side === "above" && cur === "below")
      ) {
        firedTs = cd.t;
        firedPrice = cd.c;
      }
    }
    side = cur;
  }
  return { firedTs, firedPrice, side };
}

// 突破信号类型：body=实体突破（收盘站上/跌破），wick=影线突破（最高/最低触及但收盘未破）。
export type SignalKind = "body" | "wick";
export type BreakEvent = { kind: SignalKind; ts: number; price: number };

// 逐根遍历 15 分钟 K 线，按「先影线后实体」判断突破：
//   - 收盘在关键位另一侧 → 实体突破（仅在由另一侧转过来时触发）
//   - 收盘未破但最高/最低触及关键位 → 影线突破（每段触碰只报一次）
// prevSide 为空表示首次布防/周期滚动：以第一根收盘为基准布防，不回扫。
export function scanBreakout(
  candles: Candle[],
  level: number,
  isUp: boolean,
  prevSide: Side | undefined,
  prevWickDone: boolean | undefined,
): { events: BreakEvent[]; side: Side; wickDone: boolean } {
  const events: BreakEvent[] = [];
  const first = prevSide === undefined;
  const initSide: Side = prevSide ??
    (candles.length > 0 && candles[0].c >= level ? "above" : "below");
  let side: Side = initSide;
  let wickDone = prevWickDone ?? false;
  for (let i = 0; i < candles.length; i++) {
    const cd = candles[i];
    if (first && i === 0) {
      side = cd.c >= level ? "above" : "below";
      wickDone = false;
      continue;
    }
    const closing = isUp ? cd.c >= level : cd.c <= level;
    const touched = isUp ? cd.h >= level : cd.l <= level;
    if (closing) {
      const crossed = isUp ? side === "below" : side === "above";
      if (crossed) events.push({ kind: "body", ts: cd.t, price: cd.c });
      side = isUp ? "above" : "below";
      wickDone = false;
    } else {
      if (touched && !wickDone) {
        events.push({ kind: "wick", ts: cd.t, price: isUp ? cd.h : cd.l });
        wickDone = true;
      }
      if (!touched) wickDone = false;
      side = isUp ? "below" : "above";
    }
  }
  return { events, side, wickDone };
}

export function ruleId(rule: RuleDoc): string {
  const ex = rule.exchange ?? "gate";
  if (rule.type === "breakout") {
    const ind = rule.indicator ?? "prev_ohlc";
    return `${ex}:${rule.symbol}:breakout:${ind}:${rule.tf}:${rule.offset}:${rule.field}:${
      rule.dir ?? "up"
    }`;
  }
  return `${ex}:${rule.symbol}:${rule.type}:${rule.price}`;
}

export function periodName(tf: string, offset: number): string {
  const prev = offset - 1;
  if (tf === "1d") return prev === 1 ? "前日" : `前${prev}日`;
  const unit = TF_NAME[tf] ?? tf;
  return prev === 1 ? `前${unit}` : `前${prev}个${unit}`;
}

export function ruleDesc(rule: RuleDoc): string {
  if (rule.type === "breakout") {
    const field = rule.field ?? "high";
    if ((rule.indicator ?? "prev_ohlc") === "prev_session") {
      return `前时段${FIELD_NAME[field] ?? field}`;
    }
    const tf = rule.tf ?? "1d";
    return `${periodName(tf, rule.offset ?? 2)}${FIELD_NAME[field] ?? field}`;
  }
  return "";
}

export function fmtPrice(value: number): string {
  if (value >= 1000) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }
  if (value >= 10) return value.toFixed(2);
  return value.toFixed(4);
}

// 用 UTC getter 读取 (ts + 8h) 得到北京时间墙钟。
export function fmtBeijing(ts: number): string {
  const d = new Date((ts + BJ_OFFSET) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const SIGNAL_NAME: Record<SignalKind, string> = {
  body: "实体突破",
  wick: "影线突破",
};

// 生成 Telegram（HTML parse_mode）告警文案。
export function buildMessage(
  rule: RuleDoc,
  level: number,
  isUp: boolean,
  firedTs: number,
  firedPrice: number,
  descOverride?: string,
  signal?: SignalKind,
): string {
  const arrow = isUp ? "\u{1F53C}" : "\u{1F53D}";
  const direction = isUp ? "上破" : "下破";
  const desc = descOverride ?? ruleDesc(rule);
  const exName = EXCHANGE_NAME[rule.exchange ?? "gate"] ?? rule.exchange ?? "Gate";
  const tag = signal ? ` · ${SIGNAL_NAME[signal]}` : "";
  const title =
    `${exName} ${rule.label} ${direction}${desc ? "「" + desc + "」" : ""}${tag}`;
  const link = `<a href="${DASHBOARD_URL}">\u{1F4C8} 打开看盘页</a>`;
  return (
    `${arrow} <b>${escHtml(title)}</b>\n` +
    `\n` +
    (signal ? `信号：<b>${SIGNAL_NAME[signal]}</b>\n` : "") +
    `关键位：<b>${fmtPrice(level)}</b>\n` +
    `触发价：${fmtPrice(firedPrice)}\n` +
    `时间：${fmtBeijing(firedTs)} 北京时间\n` +
    `\n` +
    `${link}`
  );
}
