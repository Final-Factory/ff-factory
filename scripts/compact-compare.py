"""w2002: the earlier-compaction pilot against its control arm, on worker transcripts (docs/spend.md "Compacting earlier, a pilot").

A worker session is in the pilot's arm when its system prompt (the transcript's prompt_snapshot record) holds --marker, the
pilot's heading (server/autoCompact.ts EARLY_COMPACT_MARK). Per arm and model, from the API's own usage on every main-thread
call (measured): calls, context and cache-read tokens a call, cache-read tokens and list-price cost a session and a request
(sessions grouped by the request their first message names), and compactions (Claude Code's compact_boundary records, the
portal's between-turn /compact and Claude Code's own mid-turn one).

Quality after a compaction, in the --window calls after each one: reads of a file range already read before it (Read with the
same path, offset and limit), shell commands run again word for word, and, per session, whether it wrote a DONE line and how
many messages it got after its first (follow-ups, corrections among them). The same counts in the window before each
compaction are the baseline: a worker re-reads somewhat anyway.

    python scripts/compact-compare.py [--root ~/.claude/projects] [--since 2026-10-24T12:00] [--window 40] [--ids]

Run it on each worker machine (it reads that machine's own Claude Code transcripts). Workers' effort is not in a transcript:
compare sessions started after the same effort change (--since), and only within a model. --ids prints each arm's portal
session ids (from the ffa-<id> temp folder its commands name), to look them up in spend_report.
"""
import argparse, glob, json, os, re, statistics
from collections import defaultdict

ap = argparse.ArgumentParser()
ap.add_argument('--root', default=os.path.expanduser('~/.claude/projects'))
ap.add_argument('--since', default='', help='ISO time: only sessions whose first call is at or after it')
ap.add_argument('--marker', default='## Compaction (pilot)')
ap.add_argument('--worker', default='# You are running inside an FF Sandbox', help="a worker's system prompt holds this; other sessions are left out")
ap.add_argument('--window', type=int, default=40, help='calls after (and before) a compaction that count for re-reads')
ap.add_argument('--min-calls', type=int, default=10, help='leave out sessions shorter than this')
ap.add_argument('--ids', action='store_true')
a = ap.parse_args()

# USD per million tokens, list price (shared/spend.ts PRICES): input, output, cache read; a cache write is 2x input (1-hour).
PRICES = [('claude-fable', (10, 50, 0.25)), ('claude-opus-5-5', (4, 20, 0.2)), ('claude-opus', (5, 25, 0.5)), ('claude-sonnet-5', (2, 10, 0.2)),
          ('claude-sonnet', (3, 15, 0.3)), ('claude-haiku-5', (0.1, 0.5, 0.01)), ('claude-haiku', (1, 5, 0.1))]


def price(model):
    for p, v in PRICES:
        if (model or '').startswith(p):
            return v
    return (2, 10, 0.2)


def text_of(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ''.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
    return ''


def session(path):
    lines = []
    for l in open(path, encoding='utf8'):
        if l.strip():
            try:
                lines.append(json.loads(l))
            except ValueError:
                pass
    arm = None
    for d in lines:
        at = d.get('attachment') or {}
        if at.get('type') == 'prompt_snapshot':
            sp = json.dumps(at.get('systemPrompt'))
            if a.worker not in sp:
                return None
            arm = 'pilot' if a.marker in sp else 'control'
            break
    if arm is None:
        return None
    s = {'path': path, 'arm': arm, 'model': None, 'calls': [], 'events': [], 'users': 0, 'done': False, 'request': None, 'portal': None}
    seen = set()
    for d in lines:
        if d.get('isSidechain'):
            continue
        m = d.get('message') or {}
        if d.get('type') == 'system' and d.get('subtype') == 'compact_boundary':
            meta = d.get('compactMetadata') or {}
            s['events'].append(('compact', meta.get('trigger'), meta.get('preTokens')))
            continue
        if d.get('type') == 'assistant' and m.get('usage') and m.get('model') != '<synthetic>':
            u = m['usage']
            s['model'] = s['model'] or m.get('model')
            if m.get('id') not in seen:
                seen.add(m.get('id'))
                cr, cw, inp = u.get('cache_read_input_tokens') or 0, u.get('cache_creation_input_tokens') or 0, u.get('input_tokens') or 0
                c = {'ts': d.get('timestamp', ''), 'cr': cr, 'cw': cw, 'in': inp, 'out': 0, 'model': m.get('model')}
                s['calls'].append(c)
                s['events'].append(('call', c))
            s['calls'][-1]['out'] = max(s['calls'][-1]['out'], u.get('output_tokens') or 0)
            for b in m.get('content') or []:
                if b.get('type') == 'text' and 'DONE: w' in b.get('text', ''):
                    s['done'] = True
                elif b.get('type') == 'tool_use':
                    inp = b.get('input') or {}
                    if b.get('name') == 'Read':
                        s['events'].append(('read', f"{inp.get('file_path')}:{inp.get('offset')}:{inp.get('limit')}"))
                    elif b.get('name') in ('Bash', 'PowerShell'):
                        cmd = inp.get('command', '')
                        s['events'].append(('cmd', cmd))
                        p = re.search(r'ffa-([0-9a-f]{8})', cmd)
                        s['portal'] = s['portal'] or (p and p.group(1))
        elif d.get('type') == 'user':
            c = m.get('content')
            if isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
                continue
            t = text_of(c)
            if d.get('isMeta') or t.startswith('<command-') or 'This session is being continued from a previous conversation' in t:
                continue
            s['users'] += 1
            if s['request'] is None:
                r = re.search(r'NEW session for (w\d+)', t) or re.search(r'\b(w\d{3,5})\b', t)
                s['request'] = r and r.group(1)
    return s


def repeats(events, i, window, before):
    """Re-reads and re-run commands in `window` calls on one side of the compaction at events[i], of what came before that side."""
    if before:
        lo, n = i, 0
        while lo > 0 and n < window:
            lo -= 1
            n += events[lo][0] == 'call'
        side, prior = events[lo:i], events[:lo]
    else:
        hi, n = i, 0
        while hi < len(events) - 1 and n < window:
            hi += 1
            n += events[hi][0] == 'call'
        side, prior = events[i:hi + 1], events[:i]
    reads = {e[1] for e in prior if e[0] == 'read'}
    cmds = {e[1] for e in prior if e[0] == 'cmd' and len(e[1]) > 20}
    return sum(1 for e in side if e[0] == 'read' and e[1] in reads), sum(1 for e in side if e[0] == 'cmd' and e[1] in cmds)


groups = defaultdict(list)
for f in glob.glob(os.path.join(a.root, '*', '*.jsonl')):
    try:
        s = session(f)
    except OSError:
        continue
    if not s or len(s['calls']) < a.min_calls or (a.since and s['calls'][0]['ts'] < a.since):
        continue
    groups[(s['model'], s['arm'])].append(s)


def mean(xs):
    return statistics.mean(xs) if xs else 0


def usd(s):
    p = price(s['model'])
    return sum((c['in'] * p[0] + c['out'] * p[1] + c['cr'] * p[2] + c['cw'] * 2 * p[0]) / 1e6 for c in s['calls'])


for (model, arm) in sorted(groups, key=lambda k: (k[0] or '', k[1])):
    ss = groups[(model, arm)]
    calls = [c for s in ss for c in s['calls']]
    comps = [(s, i) for s in ss for i, e in enumerate(s['events']) if e[0] == 'compact']
    by_req = defaultdict(list)
    for s in ss:
        by_req[s['request'] or s['path']].append(s)
    after = [repeats(s['events'], i, a.window, False) for s, i in comps]
    before = [repeats(s['events'], i, a.window, True) for s, i in comps]
    trig = defaultdict(int)
    for s, i in comps:
        trig[s['events'][i][1] or '?'] += 1
    pre = [s['events'][i][2] for s, i in comps if s['events'][i][2]]
    print(f'{model} / {arm}: {len(ss)} sessions, {len(by_req)} requests, {len(calls)} calls ({mean([len(s["calls"]) for s in ss]):.0f} a session)')
    print(f'  context a call {mean([c["cr"] + c["cw"] + c["in"] for c in calls]) / 1000:.0f}k, cache read a call {mean([c["cr"] for c in calls]) / 1000:.0f}k; '
          f'cache read a session {mean([sum(c["cr"] for c in s["calls"]) for s in ss]) / 1e6:.2f}M, a request {mean([sum(c["cr"] for s in r for c in s["calls"]) for r in by_req.values()]) / 1e6:.2f}M')
    print(f'  list-price cost a call ${mean([usd(s) / len(s["calls"]) for s in ss]):.3f}, a session ${mean([usd(s) for s in ss]):.2f} (median ${statistics.median([usd(s) for s in ss]):.2f}), '
          f'a request ${mean([sum(usd(s) for s in r) for r in by_req.values()]):.2f}; total ${sum(usd(s) for s in ss):.0f}')
    print(f'  compactions {len(comps)} ({len(comps) / len(ss):.2f} a session; {dict(trig)}), at {mean(pre) / 1000:.0f}k context on average')
    if comps:
        print(f'  in the {a.window} calls after a compaction: {mean([x[0] for x in after]):.2f} re-reads of a range read before, {mean([x[1] for x in after]):.2f} commands run again '
              f'(in the {a.window} before it: {mean([x[0] for x in before]):.2f} and {mean([x[1] for x in before]):.2f})')
    print(f'  DONE line in {sum(1 for s in ss if s["done"])} of {len(ss)} sessions; messages after the first {mean([max(0, s["users"] - 1) for s in ss]):.1f} a session')
    if a.ids:
        print('  portal sessions: ' + ' '.join(sorted({s['portal'] for s in ss if s['portal']})))
