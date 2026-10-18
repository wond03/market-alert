import json, glob, os, sys, random, statistics, math

DUMP = sys.argv[1] if len(sys.argv) > 1 else '/tmp/opencode/shadow-fill217.json'
N = int(sys.argv[2]) if len(sys.argv) > 2 else 20
SEED = int(sys.argv[3]) if len(sys.argv) > 3 else 7
SYMS = {'BTC': 'BTCUSDT', 'XAU': 'PAXGUSDT'}
best = {}
for f in glob.glob('/tmp/opencode/klines/*-5m-*.json'):
    s = os.path.basename(f).split('-')[0]
    if s not in best or os.path.getsize(f) > best[s][0]:
        best[s] = (os.path.getsize(f), f)
arrs = {k: json.load(open(v[1])) for k, v in best.items()}
idx = {k: {c['t']: i for i, c in enumerate(a)} for k, a in arrs.items()}
FWD, SLIP, COST = 2016, 0.0005, 0.001

def trailing(a, k, n=288):
    vs = sorted(x['v'] for x in a[max(0, k-n):k])
    rs = sorted((x['h'] - x['l']) / x['c'] for x in a[max(0, k-n):k])
    pick = lambda xs, q: xs[math.floor((len(xs)-1)*q)] if xs else 0
    return pick(vs, 0.2), pick(rs, 0.5)

def replay(e):
    a = arrs[SYMS[e['sym']]]; j = idx[SYMS[e['sym']]][e['ts']]
    up = e['bias'] == 'long'; entry = e['entry']; stop = e['stop']; tgt = e['target']
    risk = abs(entry - stop)
    entryEff = entry * (1 + SLIP) if up else entry * (1 - SLIP)
    stopFill = stop * (1 - SLIP) if up else stop * (1 + SLIP)
    costR = COST * entryEff / risk
    fill = -1
    for k in range(j + 1, min(len(a), j + 1 + FWD)):
        c = a[k]
        if up:
            if tgt is not None and c['h'] >= tgt and c['l'] > entry:
                return 'nofill', 0.0
            if c['l'] <= entry:
                p20, rm = trailing(a, k)
                nxt = a[k+1] if k+1 < len(a) else None
                if c['v'] > p20 and (c['h']-c['l'])/c['c'] <= rm and (c['c'] <= entry or (nxt and nxt['l'] <= entry)):
                    fill = k; break
        else:
            if tgt is not None and c['l'] <= tgt and c['h'] < entry:
                return 'nofill', 0.0
            if c['h'] >= entry:
                p20, rm = trailing(a, k)
                nxt = a[k+1] if k+1 < len(a) else None
                if c['v'] > p20 and (c['h']-c['l'])/c['c'] <= rm and (c['c'] >= entry or (nxt and nxt['h'] >= entry)):
                    fill = k; break
    if fill < 0:
        return 'nofill', 0.0
    for k in range(fill, min(len(a), fill + 1 + FWD)):
        c = a[k]
        if up:
            if c['l'] <= stop:
                return 'stop', (stopFill - entryEff) / risk - costR if up else (entryEff - stopFill) / risk - costR
            if tgt is not None and c['h'] >= tgt:
                return 'target', (tgt * (1 - SLIP) - entryEff) / risk - costR
        else:
            if c['h'] >= stop:
                return 'stop', (stopFill - entryEff) / risk - costR if up else (entryEff - stopFill) / risk - costR
            if tgt is not None and c['l'] <= tgt:
                return 'target', (entryEff - tgt * (1 + SLIP)) / risk - costR
    c = a[min(len(a)-1, fill + FWD)]
    move = (c['c'] * (1 - SLIP) - entryEff) if up else (entryEff - c['c'] * (1 + SLIP))
    return 'time', move / risk - costR

rows = [e for e in json.load(open(DUMP)) if e['skip'] == '']
random.seed(SEED)
sample = random.sample(rows, min(N, len(rows)))
ok = 0
for e in sample:
    why, r = replay(e)
    ew = e['outcome']['why'] if e.get('outcome') else '?'
    er = e['outcome']['rNet'] if e.get('outcome') else 0
    good = (why == 'nofill' and ew == 'nofill') or (why != 'nofill' and ew == why and abs(r - er) <= 0.05)
    ok += good
    print(e['sym'], e['ts'], e['bias'], 'engine', ew, round(er, 2), 'audit', why, round(r, 2), 'OK' if good else 'MISMATCH')
print(f'sample {len(sample)} valid {ok}')
