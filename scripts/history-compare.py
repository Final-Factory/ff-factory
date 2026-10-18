"""w1480: pilot against control on worker transcripts (docs/spend.md "What fills a worker's history").

A session is in the pilot when its system prompt (the transcript's prompt_snapshot record) holds --marker, by default the
terse-prose rule's heading. Per group: model calls, context a call, history growth a call (between calls with no compaction
between), output and thinking tokens a call (the API's own usage: measured), the text between tool calls and the end-of-turn
reports (characters: measured), turns, messages to the agent after the first (follow-ups), and how many sessions wrote a DONE line.

    python scripts/history-compare.py [--root ~/.claude/projects] [--since 2026-10-19T00:00] [--marker TEXT] [--reports N]

Run it on each worker machine (it reads that machine's own Claude Code transcripts). --reports prints the last N end-of-turn
reports of each group, to read them for readability.
"""
import argparse, glob, json, os, statistics

ap = argparse.ArgumentParser()
ap.add_argument('--root', default=os.path.expanduser('~/.claude/projects'))
ap.add_argument('--since', default='', help='ISO time: only sessions whose first call is at or after it')
ap.add_argument('--marker', default='## Between tool calls (pilot, w1480)')
ap.add_argument('--worker', default='# You are running inside an FF Sandbox', help="a worker's system prompt holds this; other sessions are left out")
ap.add_argument('--reports', type=int, default=0)
ap.add_argument('--min-calls', type=int, default=10, help='leave out sessions shorter than this')
a = ap.parse_args()


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
    pilot, worker = None, False
    for d in lines:
        at = d.get('attachment') or {}
        if at.get('type') == 'prompt_snapshot':
            sp = json.dumps(at.get('systemPrompt'))
            pilot, worker = a.marker in sp, a.worker in sp
            break
    if not worker:
        return None, [], 0, False
    lines = [d for d in lines if not d.get('isSidechain')]
    calls, cur = [], None
    users, done = 0, False
    for d in lines:
        m = d.get('message') or {}
        if d.get('type') == 'assistant' and m.get('usage') and m.get('model') != '<synthetic>':
            u = m['usage']
            if cur is None or cur['id'] != m.get('id'):
                cur = {'id': m.get('id'), 'ts': d.get('timestamp', ''), 'ctx': (u.get('input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0),
                       'out': 0, 'think': 0, 'text': 0, 'tools': 0, 'end': False}
                calls.append(cur)
            cur['out'] = max(cur['out'], u.get('output_tokens') or 0)
            cur['think'] = max(cur['think'], (u.get('output_tokens_details') or {}).get('thinking_tokens') or 0)
            for b in m.get('content') or []:
                if b.get('type') == 'text':
                    cur['text'] += len(b.get('text', ''))
                    if 'DONE: w' in b.get('text', ''):
                        done = True
                    cur['last_text'] = b.get('text', '')
                elif b.get('type') == 'tool_use':
                    cur['tools'] += 1
        elif d.get('type') == 'user':
            c = m.get('content')
            if isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
                continue
            if d.get('isMeta') or text_of(c).startswith('<command-'):
                continue
            users += 1
            if cur is not None:
                cur['end'] = True
    if calls:
        calls[-1]['end'] = True
    return pilot, calls, users, done


groups = {True: [], False: [], None: []}
for f in glob.glob(os.path.join(a.root, '*', '*.jsonl')):
    try:
        pilot, calls, users, done = session(f)
    except OSError:
        continue
    if len(calls) < a.min_calls or (a.since and calls[0]['ts'] < a.since):
        continue
    groups[pilot].append((f, calls, users, done))


def mean(xs):
    return statistics.mean(xs) if xs else 0


for g, name in ((True, 'pilot'), (False, 'control'), (None, 'no prompt_snapshot')):
    ss = groups[g]
    if not ss:
        print(f'{name}: no sessions')
        continue
    allc = [c for _, cs, _, _ in ss for c in cs]
    growth = [b['ctx'] - c['ctx'] for _, cs, _, _ in ss for c, b in zip(cs, cs[1:]) if b['ctx'] >= c['ctx'] * 0.6]
    between = [c['text'] for c in allc if not (c['end'] and c['tools'] == 0)]
    reports = [c['text'] for c in allc if c['end'] and c['tools'] == 0]
    print(f'{name}: {len(ss)} sessions, {len(allc)} calls ({mean([len(cs) for _, cs, _, _ in ss]):.0f} a session)')
    print(f'  context a call {mean([c["ctx"] for c in allc]) / 1000:.0f}k; history growth a call mean {mean(growth):.0f}, median {statistics.median(growth) if growth else 0:.0f} tokens')
    print(f'  output a call {mean([c["out"] for c in allc]):.0f} tokens, of which thinking {mean([c["think"] for c in allc]):.0f}; output a session {mean([sum(c["out"] for c in cs) for _, cs, _, _ in ss]) / 1000:.0f}k')
    print(f'  text between tool calls {mean(between):.0f} characters a call ({sum(1 for x in between if x) / max(1, len(between)):.0%} of calls write any); end-of-turn reports {mean(reports):.0f} characters ({len(reports)})')
    print(f'  turns a session {mean([u for _, _, u, _ in ss]):.1f} (messages to the agent; follow-ups are the ones after the first); DONE line in {sum(1 for *_, d in ss if d)} of {len(ss)} sessions')
    if a.reports:
        tail = [c.get('last_text', '') for _, cs, _, _ in ss for c in cs if c['end'] and c['tools'] == 0][-a.reports:]
        for t in tail:
            print('  --- report ---\n  ' + t[:1500].replace('\n', '\n  '))
