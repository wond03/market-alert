// 交易时段 / 时间与价格格式化工具（供作战面板 battleCore、panel 使用）。
// 交易所 K 线抓取见 exchanges.ts。

export const BJ_OFFSET = 8 * 3600; // 北京时间相对 UTC 的偏移（秒）

export const EXCHANGE_NAME: Record<string, string> = {
  gate: "Gate",
};

// 看盘页地址（GitHub Pages），用于推送里附上可点击链接。
export const DASHBOARD_URL = "https://wond03.github.io/market-alert/";

// 交易时段（与看盘页「交易时段 Sessions」指标默认值一致，用各自交易所所在时区）
export type Session = { name: string; tz: string; start: number; end: number };
export const SESSIONS: Session[] = [
  { name: "亚洲盘", tz: "Asia/Tokyo", start: 9 * 60, end: 15 * 60 },
  { name: "伦敦盘", tz: "Europe/London", start: 8 * 60, end: 16 * 60 + 30 },
  { name: "纽约盘", tz: "America/New_York", start: 9 * 60 + 30, end: 16 * 60 },
];

// 时段循环顺序：亚洲盘 → 伦敦盘 → 纽约盘 →（次日）亚洲盘
export const SESSION_CYCLE = ["亚洲盘", "伦敦盘", "纽约盘"];

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
function tzMinutes(ts: number, tz: string): number {
  const parts = tzFormatter(tz).formatToParts(new Date(ts * 1000));
  let hh = 0, mm = 0;
  for (const p of parts) {
    if (p.type === "hour") hh = parseInt(p.value, 10) % 24;
    else if (p.type === "minute") mm = parseInt(p.value, 10);
  }
  return hh * 60 + mm;
}

function inWindow(m: number, start: number, end: number): boolean {
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

// 该时段本地时钟在上次走到 s.start 时的 UTC 秒时间戳。
function sessionStartBefore(now: number, s: Session): number {
  const locNow = tzMinutes(now, s.tz);
  let delta = locNow - s.start;
  if (delta < 0) delta += 1440;
  return now - delta * 60;
}

function sessionDurSec(s: Session): number {
  let dur = s.end - s.start;
  if (dur <= 0) dur += 1440; // 跨午夜
  return dur * 60;
}

// 当前北京时间「当天 00:00」的 UTC 秒；用于 15m 日内方向「当天有效」的新鲜度判断。
export function currentDayStart(now: number): number {
  return Math.floor((now + BJ_OFFSET) / 86400) * 86400 - BJ_OFFSET;
}

// 当前进行的时段窗口（含名称）；不在任何时段内（间隙）返回 null。
export function currentSessionWindow(
  now: number,
): { name: string; start: number; end: number } | null {
  const cur = currentSessionName(now);
  if (!cur) return null;
  const s = SESSIONS.find((x) => x.name === cur);
  if (!s) return null;
  const start = sessionStartBefore(now, s);
  return { name: cur, start, end: start + sessionDurSec(s) };
}

// 指定时段「最近一次已结束」的窗口（UTC 秒）；用于取上一个盘口的高低。
export function lastClosedSessionWindow(
  now: number,
  name: string,
): { start: number; end: number } {
  const s = SESSIONS.find((x) => x.name === name) ?? SESSIONS[0];
  const start = sessionStartBefore(now, s);
  const dur = sessionDurSec(s);
  const base = start + dur > now ? start - 86400 : start;
  return { start: base, end: base + dur };
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
