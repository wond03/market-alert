#!/usr/bin/env python3
import base64, hashlib, hmac, json, os, sys, time, urllib.parse, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load_env(path):
    if not os.path.exists(path): return
    for line in open(path):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip())

load_env(os.path.join(ROOT, '.env.local'))
BASE = os.environ.get('WEEX_DEMO_BASE', 'https://api-sim.weex.com')
KEY = os.environ.get('WEEX_API_KEY', '')
SECRET = os.environ.get('WEEX_API_SECRET', '')
PASS = os.environ.get('WEEX_API_PASSPHRASE', '')

def sign(ts, method, path, query='', body=''):
    msg = ts + method.upper() + path + query + body
    return base64.b64encode(hmac.new(SECRET.encode(), msg.encode(), hashlib.sha256).digest()).decode()

def request(method, path, params=None, body=None):
    query = '?' + urllib.parse.urlencode(params) if params else ''
    raw = json.dumps(body, separators=(',', ':')) if body is not None else ''
    ts = str(int(time.time() * 1000))
    headers = {
        'ACCESS-KEY': KEY,
        'ACCESS-SIGN': sign(ts, method, path, query, raw),
        'ACCESS-TIMESTAMP': ts,
        'Content-Type': 'application/json',
    }
    if PASS: headers['ACCESS-PASSPHRASE'] = PASS
    req = urllib.request.Request(BASE + path + query, data=raw.encode() if raw else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'balance'
    if cmd == 'balance':
        print(json.dumps(request('GET', '/capi/v3/account/balance'), ensure_ascii=False, indent=1))
    elif cmd == 'positions':
        print(json.dumps(request('GET', '/capi/v3/account/position/allPosition'), ensure_ascii=False, indent=1))
    elif cmd == 'orders':
        print(json.dumps(request('GET', '/capi/v3/order/history'), ensure_ascii=False, indent=1))
    elif cmd == 'leverage':
        args = dict(a.split('=', 1) for a in sys.argv[2:])
        body = {
            'symbol': args.get('symbol', 'BTCUSDT'),
            'marginType': 'ISOLATED',
            'isolatedLongLeverage': int(args.get('lev', 100)),
            'isolatedShortLeverage': int(args.get('lev', 100)),
        }
        print(json.dumps(request('POST', '/capi/v3/account/leverage', body=body), ensure_ascii=False, indent=1))
    elif cmd == 'open':
        args = dict(a.split('=', 1) for a in sys.argv[2:])
        side = args.get('side', 'long').lower()
        body = {
            'symbol': args.get('symbol', 'BTCUSDT'),
            'side': 'BUY' if side == 'long' else 'SELL',
            'positionSide': 'LONG' if side == 'long' else 'SHORT',
            'type': 'MARKET',
            'quantity': args['qty'],
            'newClientOrderId': args.get('cid', 'sig-' + str(int(time.time()))),
        }
        print(json.dumps(request('POST', '/capi/v3/order', body=body), ensure_ascii=False, indent=1))
    else:
        print('usage: weex-demo.py [balance|positions|orders]')
