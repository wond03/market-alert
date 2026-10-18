import json, glob, os, statistics, math, itertools
SYMS = {'BTC': 'BTCUSDT', 'XAU': 'PAXGUSDT'}
FWD, SLIP, COST = 2016, 0.0005, 0.001
MIN_DIST = 0.006
ATR_K = 1.25

def best(prefix, tf):
    out = {}
    for f in glob.glob(f'/tmp/opencode/klines/*-{tf}-*.json'):
        s = os.path.basename(f).split('-')[0]
        if s not in out or os.path.getsize(f) > out[s][0]:
            out[s] = (os.path.getsize(f), f)
    return {k: json.load(open(v[1])) for k, v in out.items()}

m5 = best('', '5m'); m15 = best('', '15m')
i5 = {k: {c['t']: i for i, c in enumerate(a)} for k, a in m5.items()}
i15 = {k: {c['t']: i for i, c in enumerate(a)} for k, a in m15.items()}

def atr(sym, ts):
    a = m5[sym]; j = i5[sym][ts]
    seg = a[max(0, j-14):]
    trs = [max(x['h']-x['l'], abs(x['h']-a[i-1]['c']), abs(x['l']-a[i-1]['c'])) for i, x in zip(range(max(1, j-13), j+1), seg[1:])]
    return statistics.mean(trs) if trs else 0

def entry_price(e, variant):
    sym = SYMS[e['sym']]; up = e['bias'] == 'long'; entry = e['entry']
    a = m5[sym]; j = i5[sym][e['ts']]
    if variant == 'C':
        mid = (entry + e['stop']) / 2
        for k in range(j+1, min(len(a), j+1+FWD)):
            c = a[k]
            if up:
                if e['target'] and c['h'] >= e['target'] and c['l'] > entry: return None, None
                if c['l'] <= mid: return mid, ('limit', k)
            else:
                if e['target'] and c['l'] <= e['target'] and c['h'] < entry: return None, None
                if c['h'] >= mid: return mid, ('limit', k)
        return None, None
    if variant == 'A':
        b = m15[sym]; j15 = None
        for k, c in enumerate(b):
            if c['t'] + 900 > e['ts']: j15 = k; break
        for k in range(j15, min(len(b), j15+96)):
            c = b[k]
            if (up and c['c'] >= entry) or ((not up) and c['c'] <= entry):
                idx = i5[sym].get(c['t'] + 900)
                if idx is None:
                    idx = next((x for x in range(j+1, len(a)) if a[x]['t'] >= c['t'] + 900), None)
                return c['c'], ('market', idx)
        return None, None
    if variant == 'B':
        thr = entry * (1.0005 if up else 0.9995)
        for k in range(j+1, min(len(a), j+1+FWD)):
            c = a[k]
            if (up and c['c'] >= thr) or ((not up) and c['c'] <= thr):
                return c['c'], ('market', k)
        return None, None
    raise ValueError(variant)

def stop_price(e, entry, variant):
    up = e['bias'] == 'long'; struct = abs(entry - e['stop']) / entry
    if variant == 'S0': return e['stop'], False
    if variant == 'S1':
        d = max(struct, MIN_DIST)
        return entry * (1 - d) if up else entry * (1 + d), False
    if variant == 'S2':
        d = max(ATR_K * atr(SYMS[e['sym']], e['ts']) / entry, MIN_DIST)
        return entry * (1 - d) if up else entry * (1 + d), False
    if variant == 'S3':
        if struct < MIN_DIST: return None, True
        return e['stop'], True
    raise ValueError(variant)

def trade(e, ev, sv):
    sym = SYMS[e['sym']]; up = e['bias'] == 'long'; a = m5[sym]
    ep, meta = entry_price(e, ev)
    if ep is None: return None
    kind, k0 = meta
    st, skip = stop_price(e, ep, sv)
    if st is None: return None
    if (up and st >= ep) or ((not up) and st <= ep): return None
    risk = abs(ep - st)
    entryEff = ep * (1 + SLIP) if (up and kind == 'market') else ep * (1 - SLIP) if kind == 'market' else ep
    stopFill = st * (1 - SLIP) if up else st * (1 + SLIP)
    costR = COST * entryEff / risk
    tgt = e['target']
    start = k0 if kind == 'limit' else k0 + 1
    for k in range(start, min(len(a), k0 + 1 + FWD)):
        c = a[k]
        if up:
            if c['l'] <= st: return (stopFill - entryEff) / risk - costR
            if tgt is not None and c['h'] >= tgt: return (tgt * (1 - SLIP) - entryEff) / risk - costR
        else:
            if c['h'] >= st: return (entryEff - stopFill) / risk - costR
            if tgt is not None and c['l'] <= tgt: return (entryEff - tgt * (1 + SLIP)) / risk - costR
    c = a[min(len(a)-1, k0 + FWD)]
    mv = (c['c'] * (1 - SLIP) - entryEff) if up else (entryEff - c['c'] * (1 + SLIP))
    return mv / risk - costR

def stat(rs):
    if not rs: return 'n=0'
    w = [r for r in rs if r > 0]; l = [r for r in rs if r <= 0]
    return f'n={len(rs)} win={len(w)/len(rs)*100:.1f}% avg={statistics.mean(rs):+.2f} sum={sum(rs):+.1f} pf={sum(w)/-sum(l):.2f}' if l else f'n={len(rs)} win=100% avg={statistics.mean(rs):+.2f}'

sig = [e for e in json.load(open('/tmp/opencode/shadow-fill.json')) if e['skip'] == '']
print('signals', len(sig))
res = {}
for ev in 'ABC':
    for sv in ('S0', 'S1', 'S2', 'S3'):
        rs = [r for e in sig if (r := trade(e, ev, sv)) is not None]
        res[(ev, sv)] = rs
        print(ev, sv, stat(rs))
print('--- entry only (S0) ---')
for ev in 'ABC': print(ev, stat(res[(ev, 'S0')]))
print('--- stop only (A) ---')
for sv in ('S0', 'S1', 'S2', 'S3'): print(sv, stat(res[('A', sv)]))
