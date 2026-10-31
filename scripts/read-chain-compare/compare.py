"""w2014: the read-chain pilot's arms compared from sessions.json and prstate.tsv (sessions.py says how to make them): cost, merged
PRs (each to the first in-window session naming it, created in the window), DONE requests and reopens since, the hook's points
and real nudges, per arm, split by model and by the other pilots' marks, and a bootstrap of the pilot/control ratios."""
import json, random, statistics, sys
from collections import defaultdict, Counter

SINCE, UNTIL = '2026-10-24T12:10', '2026-10-31T16:04'
allS = json.load(open('sessions.json'))
st = {}
for ln in open('prstate.tsv', encoding='utf-8'):
    k, *v = ln.rstrip('\n').replace('\r', '').split('\t')
    st[k] = v
S = [s for s in allS if SINCE <= s['start'] < UNTIL]
S.sort(key=lambda s: s['start'])
opus = lambda s: max(s['models'], key=s['models'].get, default='?').startswith('claude-opus-5-5') if s['models'] else False
S = [s for s in S if s['calls'] >= 1]
arm = lambda s: 'pilot' if s['pilot'] else 'control'

# PRs: to the first in-window session naming them; only PRs created in the window
owner = {}
for s in S:
    for p in s['prs']:
        v = st.get(p, [])
        if len(v) >= 2 and v[1] >= SINCE and p not in owner:
            owner[p] = s
merged = {p: s for p, s in owner.items() if st[p][0] == 'MERGED'}

# reopens: any session through now
reo = defaultdict(list)
for s in allS:
    for r, ts in s['reopens']:
        reo[r].append(ts or '')
done_first = {}
for s in S:
    for r, ts in s['done']:
        if r not in done_first or (ts or '') < done_first[r][1]:
            done_first[r] = (s, ts or '')


def block(name, sel):
    ss = [s for s in S if sel(s)]
    out = {}
    for A in ('control', 'pilot'):
        x = [s for s in ss if arm(s) == A]
        if not x:
            continue
        usd = [s['usd_main'] + s['usd_sub'] for s in x]
        ids = {s['id'] for s in x}
        mp = [p for p, s in merged.items() if s['id'] in ids]
        op = [p for p, s in owner.items() if s['id'] in ids]
        dn = [r for r, (s, ts) in done_first.items() if s['id'] in ids]
        ro = [r for r in dn if any(t > done_first[r][1] for t in reo.get(r, []))]
        calls = sum(s['calls'] for s in x)
        ag = Counter(t for s in x for t in s['agents'])
        out[A] = dict(n=len(x), usd=sum(usd), mean=statistics.mean(usd), med=statistics.median(usd),
                      sub=sum(s['usd_sub'] for s in x), calls=calls, mp=len(mp), op=len(op), done=len(dn), reo=len(ro), ro_ids=ro,
                      agents=sum(ag.values()), ag=ag, nudges=sum(s['nudges'] for s in x), on=sum(s['nudges_on_chain'] for s in x),
                      odd=sum(s['nudges_dup'] for s in x), um=sum(s.get('nudges_unmatched', 0) for s in x), pts=sum(s['points'] for s in x),
                      nf=sum(s['nudge_followed'] for s in x), pf=sum(s['point_followed'] for s in x),
                      reads=sum(s['reads'] for s in x), x=x)
    print(f'== {name}')
    for A, o in out.items():
        cpp = o['usd'] / o['mp'] if o['mp'] else float('nan')
        print(f"  {A}: {o['n']} sessions, ${o['usd']:.0f} (subagents ${o['sub']:.0f}), mean ${o['mean']:.2f} median ${o['med']:.2f}; "
              f"calls {o['calls']} ({o['calls']/o['n']:.0f}/session), reads {100*o['reads']/max(o['calls'],1):.0f}%; "
              f"PRs pushed {o['op']}, merged {o['mp']}, $/merged PR {cpp:.2f}; DONE requests {o['done']}, reopened {o['reo']} {o['ro_ids']}")
        print(f"     Agent calls {o['agents']} ({1000*o['agents']/max(o['calls'],1):.1f}/1000 calls) {dict(o['ag'].most_common(5))}; "
              f"would-fire points {o['pts']} (Agent within 3: {o['pf']}); real nudges {o['nudges']} on a 5+ chain {o['on']}, "
              f"not at the 5th {o['odd']} (no matching call {o['um']}), Agent within 3 after a nudge {o['nf']}")
    return out


o = block('all worker sessions, any model', lambda s: True)
o2 = block('Opus 5.5 workers', opus)
for e in (True, False):
    block(f'Opus 5.5, early-compaction mark {e}', lambda s, e=e: opus(s) and s['early'] == e)
for t in (True, False):
    block(f'Opus 5.5, terse-prose mark {t}', lambda s, t=t: opus(s) and s['terse'] == t)

# bootstrap the Opus $/merged PR ratio and $/session ratio (pilot / control), resampling sessions
random.seed(1)
c, p = o2['control']['x'], o2['pilot']['x']
mp_of = Counter(s['id'] for s in merged.values())
r1, r2 = [], []
for _ in range(4000):
    cc = [random.choice(c) for _ in c]
    pp = [random.choice(p) for _ in p]
    cu, pu = sum(s['usd_main'] + s['usd_sub'] for s in cc), sum(s['usd_main'] + s['usd_sub'] for s in pp)
    cm, pm = sum(mp_of[s['id']] for s in cc), sum(mp_of[s['id']] for s in pp)
    if cm and pm:
        r1.append((pu / pm) / (cu / cm))
    r2.append((pu / len(pp)) / (cu / len(cc)))
q = lambda r: (sorted(r)[int(.05 * len(r))], statistics.median(r), sorted(r)[int(.95 * len(r))])
print('bootstrap pilot/control, Opus: $/merged PR 5/50/95%% %.2f %.2f %.2f' % q(r1), '; $/session %.2f %.2f %.2f' % q(r2))
# sessions with no nudge vs with in pilot
pn = [s for s in p if s['nudges']]
print('pilot Opus sessions with >=1 nudge:', len(pn), 'of', len(p), '; nudges per such session median', statistics.median([s['nudges'] for s in pn]) if pn else 0)
cl = Counter()
for A, x in (('control', c), ('pilot', p)):
    L = [l for s in x for l in s['chain_lens']]
    print(A, 'chains of 5+:', sum(1 for l in L if l >= 5), 'calls in them', sum(l for l in L if l >= 5), 'of', sum(s['calls'] for s in x),
          '; reads after the 5th (sum of l-5)', sum(l - 5 for l in L if l >= 5), '; mean length of 5+ chains %.1f' % statistics.mean([l for l in L if l >= 5]))
