import json, glob, os, statistics, math
SYMS = {'BTC': 'BTCUSDT', 'XAU': 'PAXGUSDT'}
COST = 0.002
FEE = float(os.environ.get('FEE', COST))
FWD = 2016
TOL = 0.0005
K_ATR = 0.25

def best(tf):
    out = {}
    for f in glob.glob(f'/tmp/opencode/klines/*-{tf}-*.json'):
        s = os.path.basename(f).split('-')[0]
        if s not in out or os.path.getsize(f) > out[s][0]:
            out[s] = (os.path.getsize(f), f)
    return {k: json.load(open(v[1])) for k, v in out.items()}

m5 = best('5m'); m15 = best('15m')
i5 = {k: {c['t']: i for i, c in enumerate(a)} for k, a in m5.items()}

def atr(a, i):
    seg = a[max(0, i-14):i+1]
    return statistics.mean(max(seg[k]['h']-seg[k]['l'], abs(seg[k]['h']-seg[k-1]['c']), abs(seg[k]['l']-seg[k-1]['c'])) for k in range(1, len(seg))) if len(seg) > 1 else 0

def sweeps(a):
    out = []
    for i in range(21, len(a)-1):
        H = max(x['h'] for x in a[i-20:i]); L = min(x['l'] for x in a[i-20:i])
        c = a[i]; A = atr(a, i)
        if c['h'] > H * (1 + TOL) and c['c'] < H and max(0, c['h']-H) >= K_ATR * A:
            out.append((i, 'short', H, L))
        elif c['l'] < L * (1 - TOL) and c['c'] > L and max(0, L-c['l']) >= K_ATR * A:
            out.append((i, 'long', H, L))
    return out

def confirmA(a, i, side):
    if side == 'short':
        ref = min(x['l'] for x in a[i-5:i])
        for k in range(i+1, min(len(a), i+25)):
            if a[k]['c'] < ref: return k + 1
    else:
        ref = max(x['h'] for x in a[i-5:i])
        for k in range(i+1, min(len(a), i+25)):
            if a[k]['c'] > ref: return k + 1
    return None

def confirmB(a, i, side, pool):
    b = m15[SYMS[sym]]; t0 = a[i]['t']
    for c in b:
        if c['t'] + 900 <= t0: continue
        if (side == 'short' and c['c'] < pool) or (side == 'long' and c['c'] > pool):
            k = i5[SYMS[sym]].get(c['t'] + 900)
            if k is None:
                k = next((x for x in range(i+1, len(a)) if a[x]['t'] >= c['t'] + 900), None)
            return k
    return None

def sim(a, entry_idx, side, stop, target, k):
    if entry_idx is None or entry_idx >= len(a): return None
    entry = a[entry_idx]['o']
    dist = abs(entry - stop)
    if dist <= 0: return None
    min_d = k * COST
    if abs(entry - stop) / entry < min_d:
        stop = entry * (1 - min_d) if side == 'long' else entry * (1 + min_d)
    rr = abs(entry - target) / abs(entry - stop)
    if rr < 1.5: return None
    costR = FEE * entry / abs(entry - stop)
    for x in range(entry_idx, min(len(a), entry_idx + 1 + FWD)):
        c = a[x]
        if side == 'long':
            if c['l'] <= stop: return (stop - entry) / abs(entry - stop) - costR
            if c['h'] >= target: return (target - entry) / abs(entry - stop) - costR
        else:
            if c['h'] >= stop: return (entry - stop) / abs(entry - stop) - costR
            if c['l'] <= target: return (entry - target) / abs(entry - stop) - costR
    c = a[min(len(a)-1, entry_idx + FWD)]
    mv = (c['c'] - entry) if side == 'long' else (entry - c['c'])
    return mv / abs(entry - stop) - costR

raw = {}
for sym in SYMS:
    a = m5[SYMS[sym]]
    raw[sym] = sweeps(a)
print('raw sweeps', {k: len(v) for k, v in raw.items()})

def run(confirm, k):
    rs = []; conf = 0; rr_skip = 0
    for sym in SYMS:
        a = m5[SYMS[sym]]; busy = -1
        for i, side, H, L in raw[sym]:
            if i < busy: continue
            if confirm == 'A':
                ei = confirmA(a, i, side)
            else:
                pool = H if side == 'short' else L
                ei = confirmB(a, i, side, pool)
            if ei is None: continue
            conf += 1
            stop = H if side == 'short' else L
            target = L if side == 'short' else H
            r = sim(a, ei, side, stop, target, k)
            if r is None: rr_skip += 1; continue
            rs.append(r); busy = ei + 1
    w = [r for r in rs if r > 0]; l = [r for r in rs if r <= 0]
    eq = pk = dd = 0
    for r in rs:
        eq += r; pk = max(pk, eq); dd = max(dd, pk - eq)
    return dict(n=len(rs), win=round(len(w)/len(rs)*100, 1) if rs else 0,
                avg=round(statistics.mean(rs), 3) if rs else 0,
                pf=round(sum(w)/-sum(l), 2) if l else 0,
                sum=round(sum(rs), 1), dd=round(dd, 1), conf=conf, rr_skip=rr_skip)

out = {}
for cf in 'AB':
    for k in (3, 4, 5):
        out[f'{cf}{k}'] = run(cf, k)
        print(cf, 'k', k, out[f'{cf}{k}'])
json.dump(out, open('/tmp/opencode/sweep-results.json', 'w'), indent=1)
