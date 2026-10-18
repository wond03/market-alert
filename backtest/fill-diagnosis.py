import json, glob, os, sys, statistics, math
DUMP = sys.argv[1] if len(sys.argv) > 1 else '/tmp/opencode/shadow-fill.json'
SYMS = {'BTC': 'BTCUSDT', 'XAU': 'PAXGUSDT'}
best = {}
for f in glob.glob('/tmp/opencode/klines/*-5m-*.json'):
    s = os.path.basename(f).split('-')[0]
    if s not in best or os.path.getsize(f) > best[s][0]:
        best[s] = (os.path.getsize(f), f)
arrs = {k: json.load(open(v[1])) for k, v in best.items()}
idx = {k: {c['t']: i for i, c in enumerate(a)} for k, a in arrs.items()}
FWD = 2016

def markouts(e):
    a = arrs[SYMS[e['sym']]]; j = idx[SYMS[e['sym']]][e['ts']]
    up = e['bias'] == 'long'; risk = abs(e['entry'] - e['stop'])
    out = {}
    for h in (12, 48, 288):
        k = min(len(a) - 1, j + h)
        mv = a[k]['c'] - e['entry'] if up else e['entry'] - a[k]['c']
        out[h] = mv / risk
    return out

def reason(e):
    a = arrs[SYMS[e['sym']]]; j = idx[SYMS[e['sym']]][e['ts']]
    up = e['bias'] == 'long'; entry = e['entry']; tgt = e['target']
    touched = False
    for k in range(j + 1, min(len(a), j + 1 + FWD)):
        c = a[k]
        tf = (tgt is not None and c['h'] >= tgt and c['l'] > entry) if up else (tgt is not None and c['l'] <= tgt and c['h'] < entry)
        if tf: return 'target_first'
        if (c['l'] <= entry) if up else (c['h'] >= entry):
            touched = True
            if e['outcome']['why'] != 'nofill': return 'fill'
            return 'rejected'
    return 'not_touched' if not touched else 'rejected'

d = json.load(open(DUMP))
sig = [e for e in d if e['skip'] == '']
fill = [e for e in sig if e['outcome']['why'] != 'nofill']
nof = [e for e in sig if e['outcome']['why'] == 'nofill']
print('signals', len(sig), 'fill', len(fill), 'nofill', len(nof))
for name, group in (('fill', fill), ('nofill', nof)):
    for h in (12, 48, 288):
        xs = sorted(markouts(e)[h] for e in group)
        pos = sum(1 for x in xs if x > 0) / len(xs) * 100
        print(f'markout {name} H={h} n={len(xs)} mean={statistics.mean(xs):.2f} med={statistics.median(xs):.2f} pos={pos:.1f}%')
print('nofill reasons', {r: sum(1 for e in nof if reason(e) == r) for r in ('target_first', 'not_touched', 'rejected')})
for r in ('target_first', 'not_touched', 'rejected'):
    xs = [markouts(e)[48] for e in nof if reason(e) == r]
    if xs: print(f'nofill {r} H=48 n={len(xs)} mean={statistics.mean(xs):.2f} med={statistics.median(xs):.2f}')

rs = [e['outcome']['rNet'] for e in fill]
loss = [r for r in rs if r <= 0]; win = [r for r in rs if r > 0]
print('R dist: n', len(rs), 'avg_loss', round(statistics.mean(loss), 2), 'avg_win', round(statistics.mean(win), 2) if win else None,
      'max_loss', round(min(rs), 2), 'max_win', round(max(rs), 2), 'expectancy', round(statistics.mean(rs), 2))
for label, lo, hi in (('<0.3%', 0, 0.003), ('0.3-0.5%', 0.003, 0.005), ('>0.5%', 0.005, 9)):
    g = [e for e in fill if lo <= abs(e['entry'] - e['stop']) / e['entry'] < hi]
    if not g: continue
    gr = [e['outcome']['rNet'] for e in g]
    print(f'stopdist {label} n={len(g)} win={sum(1 for r in gr if r > 0)/len(gr)*100:.1f}% avg={statistics.mean(gr):.2f} sum={sum(gr):.2f}')
