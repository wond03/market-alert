#!/usr/bin/env python3
"""Market alert checker: polls Gate.io futures prices, evaluates price-cross
rules from config.json, and pushes alerts to Telegram.

Runs on GitHub Actions on a schedule. Keeps a small state file so each rule
fires only once per crossing (re-arms after price returns to the other side).

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
    return f'{rule["symbol"]}:{rule["type"]}:{rule["price"]}'


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
        level = float(rule["price"])
        rtype = rule["type"]

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
        rid = rule_id(rule)
        prev = seen.get(rid)

        fired = False
        if prev is not None and prev != side:
            if rtype == "cross_up" and prev == "below" and side == "above":
                fired = True
            elif rtype == "cross_down" and prev == "above" and side == "below":
                fired = True

        if prev != side:
            seen[rid] = side
            changed = True

        direction = "上破" if rtype == "cross_up" else "下破"
        print(f"{label} {symbol} last={price} level={level} side={side} prev={prev} fired={fired}")

        if fired:
            arrow = "\U0001F53C" if rtype == "cross_up" else "\U0001F53D"
            ts = datetime.now(BJ).strftime("%Y-%m-%d %H:%M")
            messages.append(
                f"{arrow} {label} {direction} {fmt_price(level)}\n"
                f"现价 {fmt_price(price)}（{ts} 北京时间）"
            )

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
