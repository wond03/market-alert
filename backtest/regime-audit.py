import json, glob, os, sys, statistics, random

DUMP = sys.argv[1] if len(sys.argv) > 1 else '/tmp/opencode/shadow-fill.json'
SYMS = {'BTC': 'BTCUSDT', 'XAU': 'PAXGUSDT'}
best = {}
for f in glob.glob('/tmp/opencode/klines/*-5m-*.json'):
    s = os.path.basename(f).split('-')[0]
    if s not in best or os.path.getsize(f) > best[s][0]:
        best[s] = (os.path.getsize(f), f)
arrs = {k: json.load(open(v[1])) for k, v in best.items()}
idx = {k: {c['t']: i for i, c in enumerate(a)} for k, a in arrs.items()}

def ema(vals, n):
    a = 2 / (n + 1); out = [vals[0]]
    for v in vals[1:]:
        out.append(a * v + (1 - a) * out[-1])
    return out

def pct_rank(xs, x):
    return sum(1 for v in xs if v <= x) / len(xs) if xs else 0.5

def ctx(sym, ts):
    a = arrs[SYMS[sym]]; j = idx[SYMS[sym]][ts]
    w = a[max(0, j - 287):j + 1]
    trs = []
    for i in range(1, len(w)):
        trs.append(max(w[i]['h'] - w[i]['l'], abs(w[i]['h'] - w[i-1]['c']), abs(w[i]['l'] - w[i-1]['c'])))
    atr = statistics.mean(trs[-14:]) if len(trs) >= 14 else statistics.mean(trs)
    closes = [c['c'] for c in a[max(0, j - 400):j + 1]]
    f, s = ema(closes, 12)[-1], ema(closes, 48)[-1]
    trend = abs(f - s) / atr if atr else 0
    atrs = []
    for i in range(14, len(w)):
        seg = w[max(0, i - 14):i]
        atrs.append(statistics.mean(max(seg[k]['h'] - seg[k]['l'], abs(seg[k]['h'] - seg[k-1]['c']), abs(seg[k]['l'] - seg[k-1]['c'])) for k in range(1, len(seg))) / w[i]['c'])
    volp = pct_rank(atrs, atr / a[j]['c'])
    trends = []
    for i in range(48, len(w), 6):
        seg = [x['c'] for x in w[:i + 1]]
        trends.append(abs(ema(seg, 12)[-1] - ema(seg, 48)[-1]) / atr if atr else 0)
    trp = pct_rank(trends, trend)
    return volp, trp

d = json.load(open(DUMP))
sig = [e for e in d if e['skip'] == '']
FWD, SLIP, COST = 2016, 0.0005, 0.001

def stat(rows):
    rs = [e['outcome']['rNet'] for e in rows]
    if not rs: return None
    w = [r for r in rs if r > 0]; l = [r for r in rs if r <= 0]
    return dict(n=len(rs), win=round(len(w) / len(rs) * 100, 1), avg=round(statistics.mean(rs), 2),
                sum=round(sum(rs), 1), pf=round(sum(w) / -sum(l), 2) if l else 99)

rows = []
for e in sig:
    v, t = ctx(e['sym'], e['ts'])
    e['volp'], e['trp'] = v, t
    rows.append(e)
filled = [e for e in rows if e.get('outcome') and e['outcome']['why'] != 'nofill']

print('filled', len(filled), 'signals', len(rows))
for label, pred in [
    ('vol>=0.5', lambda e: e['volp'] >= 0.5),
    ('vol<0.5', lambda e: e['volp'] < 0.5),
    ('trend>=0.5', lambda e: e['trp'] >= 0.5),
    ('trend<0.5', lambda e: e['trp'] < 0.5),
    ('trend>=0.5 or vol>=0.5', lambda e: e['trp'] >= 0.5 or e['volp'] >= 0.5),
    ('trend>=0.5 and vol>=0.5', lambda e: e['trp'] >= 0.5 and e['volp'] >= 0.5),
]:
    sub = [e for e in filled if pred(e)]
    print(label, stat(sub))

days = sorted(e['ts'] for e in rows)
lo, hi = days[0], days[-1]
for i in range(4):
    a = lo + (hi - lo) * i / 4; b = lo + (hi - lo) * (i + 1) / 4
    sub = [e for e in filled if a <= e['ts'] < b]
    print('fold', i + 1, stat(sub))
