#!/usr/bin/env python3
"""Market alert checker: polls Gate.io futures data, evaluates rules from
config.json, and pushes alerts to Telegram.

Runs on GitHub Actions on a schedule. Keeps a small state file so each rule
fires only once per crossing (re-arms after price returns to the other side).

Two rule types are supported:
  - fixed price:  {"symbol","label","type":"cross_up"|"cross_down","price"}
  - indicator:    {"symbol","label","type":"breakout","indicator":"prev_ohlc",
                   "tf":"1h"|"4h"|"1d","offset":N,"field":"high"|"low"|
                   "open"|"close","dir":"up"|"down"}
    The breakout rule derives its level from the previous period's OHLC
    (Beijing time aligned, matching the dashboard indicator). `offset` counts
    back from the newest period: 2 = last completed period, 3 = the one before.

Only the Python standard library is used, so no pip install is needed.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://api.gateio.ws/api/v4"
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")
BJ = timezone(timedelta(hours=8))

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

# 与看盘页保持一致：北京时间对齐；聚合基准周期用 1h
BJ_OFFSET = 8 * 3600
BASE_INTERVAL = "1h"
CANDLE_LIMIT = 1000
TF_SECONDS = {"1h": 3600, "4h": 14400, "1d": 86400}
TF_NAME = {"1h": "1小时", "4h": "4小时", "1d": "日"}
FIELD_NAME = {"open": "开", "high": "高", "low": "低", "close": "收"}


def http_json(url, timeout=20):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "market-alert/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_price(contract):
    data = http_json(f"{BASE}/futures/usdt/tickers?contract={contract}")
    row = data[0] if isinstance(data, list) else data
    return float(row["last"])


def get_candles(contract, interval=BASE_INTERVAL, limit=CANDLE_LIMIT):
    url = (
        f"{BASE}/futures/usdt/candlesticks"
        f"?contract={contract}&interval={interval}&limit={limit}"
    )
    data = http_json(url)
    return data if isinstance(data, list) else []


def aggregate_periods(candles, secs):
    """Aggregate ascending 1h candles into Beijing-aligned periods of `secs`."""
    out = []
    cur = None
    for cd in candles:
        try:
            t = int(cd["t"])
            o = float(cd["o"])
            h = float(cd["h"])
            low = float(cd["l"])
            c = float(cd["c"])
        except (KeyError, TypeError, ValueError):
            continue
        key = (t + BJ_OFFSET) // secs
        if cur is None or cur["key"] != key:
            if cur is not None:
                out.append(cur)
            cur = {"key": key, "open": o, "high": h, "low": low, "close": c}
        else:
            cur["high"] = max(cur["high"], h)
            cur["low"] = min(cur["low"], low)
            cur["close"] = c
    if cur is not None:
        out.append(cur)
    return out


def prev_ohlc_level(contract, tf, offset, field):
    secs = TF_SECONDS.get(tf)
    if secs is None:
        raise ValueError(f"unsupported tf: {tf}")
    if field not in FIELD_NAME:
        raise ValueError(f"unsupported field: {field}")
    if offset < 2:
        raise ValueError("breakout 需要 offset >= 2（当前正在形成的周期不适用）")
    periods = aggregate_periods(get_candles(contract), secs)
    idx = len(periods) - offset
    if idx < 0:
        raise ValueError(f"offset {offset} 超出可用周期数 {len(periods)}")
    return periods[idx][field]


def period_name(tf, offset):
    prev = offset - 1
    if tf == "1d":
        return "前日" if prev == 1 else f"前{prev}日"
    unit = TF_NAME.get(tf, tf)
    return ("前" + unit) if prev == 1 else f"前{prev}个{unit}"


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def rule_id(rule):
    if rule.get("type") == "breakout":
        return "{}:breakout:{}:{}:{}:{}".format(
            rule["symbol"],
            rule.get("tf"),
            rule.get("offset"),
            rule.get("field"),
            rule.get("dir", "up"),
        )
    return f'{rule["symbol"]}:{rule["type"]}:{rule["price"]}'


def resolve_level(rule):
    """Return (level, is_up) for a rule.

    is_up=True means the rule watches an upward break / cross above.
    """
    if rule.get("type") == "breakout":
        indicator = rule.get("indicator", "prev_ohlc")
        if indicator != "prev_ohlc":
            raise ValueError(f"unsupported indicator: {indicator}")
        level = prev_ohlc_level(
            rule["symbol"],
            rule.get("tf", "1d"),
            int(rule.get("offset", 2)),
            rule.get("field", "high"),
        )
        return level, rule.get("dir", "up") == "up"
    return float(rule["price"]), rule["type"] == "cross_up"


def rule_desc(rule):
    if rule.get("type") == "breakout":
        return "{}{}".format(
            period_name(rule.get("tf", "1d"), int(rule.get("offset", 2))),
            FIELD_NAME.get(rule.get("field", "high"), rule.get("field")),
        )
    return ""


def fmt_price(value):
    if value >= 1000:
        return f"{value:,.1f}"
    if value >= 10:
        return f"{value:.2f}"
    return f"{value:.4f}"


def send_telegram(text):
    if not BOT_TOKEN or not CHAT_ID:
        print("!! TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; skipping push")
        return False
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = urllib.parse.urlencode(
        {"chat_id": CHAT_ID, "text": text, "disable_web_page_preview": "true"}
    ).encode("utf-8")
    req = urllib.request.Request(url, data=payload)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        ok = body.get("ok", False)
        if not ok:
            print(f"!! telegram error: {body}")
        return ok
    except urllib.error.HTTPError as e:
        print(f"!! telegram http error {e.code}: {e.read().decode('utf-8', 'ignore')}")
    except Exception as e:  # noqa: BLE001
        print(f"!! telegram send failed: {e}")
    return False


def main():
    config = load_json(CONFIG_PATH, {"rules": []})
    rules = config.get("rules", [])
    if not rules:
        print("no rules configured; nothing to do")
        return 0

    state = load_json(STATE_PATH, {"rules": {}})
    seen = state.setdefault("rules", {})
    changed = False
    messages = []

    price_cache = {}
    for rule in rules:
        symbol = rule["symbol"]
        label = rule.get("label", symbol)
        rid = rule_id(rule)

        try:
            level, is_up = resolve_level(rule)
        except Exception as e:  # noqa: BLE001
            print(f"!! resolve {rid} failed: {e}")
            continue

        if symbol not in price_cache:
            try:
                price_cache[symbol] = get_price(symbol)
            except Exception as e:  # noqa: BLE001
                print(f"!! fetch {symbol} failed: {e}")
                price_cache[symbol] = None
        price = price_cache[symbol]
        if price is None:
            continue

        side = "above" if price >= level else "below"
        prev = seen.get(rid)
        if isinstance(prev, str):  # 兼容旧状态格式
            prev = {"side": prev, "level": None}
        prev_side = prev.get("side") if isinstance(prev, dict) else None
        prev_level = prev.get("level") if isinstance(prev, dict) else None

        same_level = (
            isinstance(prev_level, (int, float))
            and abs(float(prev_level) - level) < 1e-9
        )
        fired = False
        if prev_side is not None and prev_side != side and same_level:
            if is_up and prev_side == "below" and side == "above":
                fired = True
            elif (not is_up) and prev_side == "above" and side == "below":
                fired = True

        if prev_side != side or not same_level:
            seen[rid] = {"side": side, "level": level}
            changed = True

        direction = "上破" if is_up else "下破"
        print(
            f"{label} {symbol} last={price} level={level} side={side} "
            f"prev={prev_side} fired={fired}"
        )

        if fired:
            arrow = "\U0001F53C" if is_up else "\U0001F53D"
            ts = datetime.now(BJ).strftime("%Y-%m-%d %H:%M")
            desc = rule_desc(rule)
            subject = f"{label} {direction}"
            if desc:
                subject += f" {desc}"
            else:
                subject += f" {fmt_price(level)}"
            messages.append(f"{arrow} {subject}\n现价 {fmt_price(price)}（{ts} 北京时间）")

    if changed:
        save_json(STATE_PATH, state)

    if messages:
        header = "\U0001F4C8 行情警报"
        send_telegram(header + "\n\n" + "\n\n".join(messages))
    else:
        print("no alert triggered")

    return 0


if __name__ == "__main__":
    sys.exit(main())
