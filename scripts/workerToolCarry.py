"""w2016: would carrying a set of machine tools in every worker call (alwaysLoad) cost less than the ToolSearch calls it saves?
Reads workers' main Claude Code session files on this machine. Usage: python scripts/workerToolCarry.py <since ISO UTC> <sizes.json>
sizes.json: {"tool": tokens}. Token-equivalents (input = 1): cache read 0.1, cache write (1 h) 2, input 1, output 5.
w2016 sizes.json: {"wake_me":250,"blocked_on":1350,"waiting_on_person":1500,"read_work":1270,"unity":650,"publish_attachment":350}
(characters / 2.9 of the definitions ToolSearch returned). Results: docs/tool-manifest.md, "Re-measured by w2016".
"""
import glob, json, os, re, statistics as st, sys
from datetime import datetime, timezone

since = datetime.fromisoformat(sys.argv[1]).replace(tzinfo=timezone.utc)
sizes = json.load(open(sys.argv[2]))
SETS = {k: v.split(',') for k, v in {
    'six': 'wake_me,blocked_on,waiting_on_person,read_work,unity,publish_attachment',
    'wake_me': 'wake_me', 'unity': 'unity', 'read_work': 'read_work', 'blocked_on': 'blocked_on',
    'wake+unity+read_work': 'wake_me,unity,read_work',
}.items()}
P = 'mcp__machine__'

def cost(u):
    return u.get('cache_read_input_tokens', 0) * .1 + u.get('cache_creation_input_tokens', 0) * 2 + u.get('input_tokens', 0) + u.get('output_tokens', 0) * 5

def ctx(u):
    return u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('input_tokens', 0)

sessions = []
for f in glob.glob(os.path.expanduser('~/.claude/projects/F--ffw-sandboxes-*/*.jsonl')):
    if os.path.getmtime(f) < since.timestamp():
        continue
    calls = {}  # message id -> (order, usage, [tool_use])
    order = []
    first_ts = None
    events = []  # ('call', id) | ('compact',)
    for line in open(f, encoding='utf8'):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get('isSidechain'):
            continue
        ts = d.get('timestamp')
        if ts and first_ts is None:
            first_ts = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        if d.get('type') == 'system' and d.get('subtype') == 'compact_boundary':
            events.append(('compact',))
        m = d.get('message') or {}
        if d.get('type') == 'assistant' and m.get('id'):
            mid = m['id']
            if mid not in calls:
                calls[mid] = {'u': m.get('usage', {}), 'tools': []}
                events.append(('call', mid))
            calls[mid]['u'] = m.get('usage', calls[mid]['u'])
            for c in m.get('content') or []:
                if c.get('type') == 'tool_use':
                    calls[mid]['tools'].append((c['name'], c.get('input', {})))
    if not first_ts or first_ts < since or len(calls) < 3:
        continue
    sessions.append((f, events, calls))

def selected(q):
    q = q.get('query', '')
    if q.startswith('select:'):
        return [x.strip().replace(P, '') for x in q[7:].split(',')], 'select'
    return [], 'group' if q.startswith('group_') or '+' in q else 'keyword'

out = {}
elim = {}
first_ctx = []
ncalls = []
ts_calls = []
kinds = {'select': 0, 'group': 0, 'keyword': 0}
for name, tools in SETS.items():
    S = sum(sizes[t] for t in tools)
    saved = carry = 0.0
    for f, events, calls in sessions:
        loaded = set()
        for i, e in enumerate(events):
            if e[0] == 'compact':
                loaded = set()
                continue
            c = calls[e[1]]
            # carry: the set's tools not yet loaded in this window ride this call as cache reads
            carry += .1 * sum(sizes[t] for t in tools if t not in loaded)
            for n, inp in c['tools']:
                if n != 'ToolSearch':
                    continue
                sel, kind = selected(inp)
                loaded |= set(sel)
                # the next call is the one a ToolSearch costs; it is saved only if every tool it selected is in the set
                if kind == 'select' and sel and all(s in tools for s in sel) and len(c['tools']) == 1:
                    nxt = next((calls[x[1]] for x in events[i + 1:] if x[0] == 'call'), None)
                    if nxt:
                        saved += cost(nxt['u']); elim[name]=elim.get(name,0)+1
        # one cache write of the set per window (start + each compaction)
        carry += 2 * S * (1 + sum(1 for e in events if e[0] == 'compact'))
    out[name] = (S, saved, carry)

for f, events, calls in sessions:
    ids = [e[1] for e in events if e[0] == 'call']
    first_ctx.append(ctx(calls[ids[0]]['u']))
    ncalls.append(len(ids))
    n = 0
    for mid in ids:
        for t, inp in calls[mid]['tools']:
            if t == 'ToolSearch':
                n += 1
                kinds[selected(inp)[1]] += 1
    ts_calls.append(n)

N = len(sessions)
tot = sum(cost(c['u']) for f,e,cs in sessions for c in cs.values())
print(f'mean session cost {tot/N/1e3:.0f}k token-eq; selects removed per session', {k: round(v/N,2) for k,v in elim.items()})
sm = {}
for f,e,cs in sessions:
  for c in cs.values():
    for n,i in c['tools']:
      if n=='ToolSearch' and i.get('query','').startswith('select:'):
        for t in i['query'][7:].split(','): t=t.strip(); sm[t.split('__')[1] if '__' in t else t]=sm.get(t.split('__')[1] if '__' in t else t,0)+1
print('selects by server', sm)
print(f'sessions since {since:%Y-%m-%d %H:%M} UTC: {N}')
print(f'first-call context: median {st.median(first_ctx):.0f} tokens; calls/session median {st.median(ncalls):.0f}, mean {st.mean(ncalls):.0f}')
print(f'ToolSearch calls/session: mean {st.mean(ts_calls):.2f}, median {st.median(ts_calls)}; kinds {kinds}')
for k, (S, saved, carry) in out.items():
    print(f'{k:22s} size {S:5d} tok  saved {saved / N / 1e3:7.1f}k  carry {carry / N / 1e3:7.1f}k  per session  net {(saved - carry) / N / 1e3:+7.1f}k')
