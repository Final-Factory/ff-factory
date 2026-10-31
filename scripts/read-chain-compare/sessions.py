"""w2014 read-chain pilot, 7-day comparison on one machine's Claude Code transcripts (v3).

Per worker session first seen in [--since, --until): arm (system prompt holds '## Read chains (pilot)'), compaction-pilot
mark and terse-prose mark (to keep their splits apart), list-price cost of main thread + subagents by each message's model,
main-thread calls, the real nudges (hook attachments 'five reads in a row', by the tool_use id they followed) and whether each
sat on a real chain (the 5 main-thread calls up to it all reads/searches by this classifier, no new prompt between), points
where the hook would fire (both arms), what followed (Agent within 3 calls), PRs the session pushed (blocked_on ci: prs,
gh pr create / ff-pr push output), DONE lines, and reopen messages ('wNNN ... reopened' in a person's/orchestrator's message).
The classifier is server/readChainHook.ts's, ported (hookcls.py); the count starts again on a new promptId, as the hook's does.
Subagent messages are read from <session>/subagents/*.jsonl (they are not in the main file).

    python -I sessions.py --until 9999 --out sessions.json        # every session; compare.py cuts the window
    python -I -c "import json;print('\\n'.join(sorted({p for s in json.load(open('sessions.json')) for p in s['prs']})))" > prs.txt
    while IFS='#' read repo n; do echo -e "$repo#$n\\t$(gh pr view $n -R $repo --json state,createdAt,mergedAt \\
      -q '[.state,.createdAt,.mergedAt]|@tsv' 2>/dev/null)"; done < <(tr -d '\\r' < prs.txt) > prstate.tsv
    python -I compare.py                                          # SINCE/UNTIL at its top
"""
import argparse, glob, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hookcls import is_read
from collections import defaultdict

ap = argparse.ArgumentParser()
ap.add_argument('--root', default=os.path.expanduser('~/.claude/projects'))
ap.add_argument('--since', default='2026-10-24T12:10')
ap.add_argument('--until', default='2026-10-31T16:04')
ap.add_argument('--out', required=True)
a = ap.parse_args()

MARK, CMARK, TMARK, NUDGE = '## Read chains (pilot)', '## Compaction (pilot)', '## Between tool calls (pilot)', 'five reads in a row'
WORKER = '# You are running inside an FF Sandbox'
PRICES = [('claude-fable', (10, 50, 0.25)), ('claude-opus-5-5', (4, 20, 0.2)), ('claude-opus', (5, 25, 0.5)), ('claude-sonnet-5', (2, 10, 0.2)),
          ('claude-sonnet', (3, 15, 0.3)), ('claude-haiku-5', (0.1, 0.5, 0.01)), ('claude-haiku', (1, 5, 0.1))]


def price(model):
    for p, v in PRICES:
        if (model or '').startswith(p):
            return v
    return (2, 10, 0.2)


def mcost(model, u):
    i, o, r = price(model)
    return ((u.get('input_tokens') or 0) * i + (u.get('output_tokens') or 0) * o + (u.get('cache_read_input_tokens') or 0) * r
            + (u.get('cache_creation_input_tokens') or 0) * 2 * i) / 1e6


def records(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for ln in f:
                try:
                    yield ln, json.loads(ln)
                except ValueError:
                    continue
    except OSError:
        return


def text_of(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ''.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
    return ''


PR_URL = re.compile(r'github\.com/(Final-Factory/[A-Za-z0-9_.-]+)/pull/(\d+)')
CI_PR = re.compile(r'ci:(?:https://github\.com/)?(Final-Factory/[A-Za-z0-9_.-]+)(?:#|/pull/)(\d+)')
DONE = re.compile(r'^DONE: (w\d+)', re.M)
REOPEN = re.compile(r'\b(w\d{3,5})\b[^\n]{0,80}?\b(?:is|has been|was|been) reopened|\b(w\d{3,5})\b[^\n]{0,40}Reopened:|Reopened[^\n]{0,80}\b(w\d{3,5})\b')

out = []
for path in glob.glob(os.path.join(a.root, '*', '*.jsonl')):
    recs = list(records(path))
    if not recs:
        continue
    blob = ''.join(ln for ln, _ in recs)
    if WORKER not in blob:
        continue
    first = next((r.get('timestamp') for _, r in recs if r.get('timestamp')), '') or ''
    if not (a.since <= first < a.until):
        continue
    sid = os.path.splitext(os.path.basename(path))[0]
    s = dict(id=sid, dir=os.path.basename(os.path.dirname(path)), start=first, pilot=MARK in blob, early=CMARK in blob,
             terse=TMARK in blob, models=defaultdict(int), usd_main=0.0, usd_sub=0.0, calls=0, reads=0, agents=[],
             nudges=0, nudges_on_chain=0, nudges_dup=0, points=0, nudge_followed=0, point_followed=0, prs=set(), done=[],
             reopens=[], first_req=None, end=recs[-1][1].get('timestamp') or first)
    seen = set()
    calls, idx = [], {}  # calls: (name, inp, chain_len_at_this_call)
    run, fired_in_chain = 0, False
    nudge_idx, point_idx = [], []
    cur_prompt, nudged = None, set()
    pending_cmd = {}
    for ln, r in recs:
        msg = r.get('message') if isinstance(r.get('message'), dict) else {}
        side = bool(r.get('isSidechain'))
        if not side and r.get('promptId') and r.get('promptId') != cur_prompt:
            cur_prompt = r.get('promptId')
            run, fired_in_chain = 0, False  # the hook starts the count again on a new prompt_id
        if r.get('type') == 'assistant' and isinstance(msg.get('usage'), dict):
            k = msg.get('id') or r.get('uuid')
            if k not in seen:
                seen.add(k)
                c = mcost(msg.get('model'), msg['usage'])
                if side:
                    s['usd_sub'] += c
                else:
                    s['usd_main'] += c
                    s['models'][msg.get('model') or '?'] += 1
        content = msg.get('content')
        if r.get('type') == 'assistant' and not side and isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get('type') == 'tool_use':
                    n, inp = c.get('name'), c.get('input') or {}
                    rd = is_read(n, inp)
                    if rd:
                        run += 1
                    else:
                        run, fired_in_chain = 0, False
                    idx[c.get('id')] = len(calls)
                    calls.append((n, inp, run))
                    if run == 5:
                        point_idx.append(len(calls) - 1)
                    if n in ('Agent', 'Task'):
                        s['agents'].append(str(inp.get('subagent_type', '?')))
                    if n.endswith('blocked_on'):
                        for p in inp.get('prs') or []:
                            m = CI_PR.search(str(p))
                            if m:
                                s['prs'].add(f'{m.group(1)}#{m.group(2)}')
                    if n in ('Bash', 'PowerShell'):
                        cmd = str(inp.get('command', ''))
                        if 'ff-pr push' in cmd or 'gh pr create' in cmd:
                            pending_cmd[c.get('id')] = True
            t = text_of(content)
            for m in DONE.finditer(t):
                s['done'].append((m.group(1), r.get('timestamp')))
        if r.get('type') == 'user' and not side:
            if isinstance(content, str) or (isinstance(content, list) and any(isinstance(b, dict) and b.get('type') == 'text' for b in content)):
                t = text_of(content)
                if not t.startswith('<') and not r.get('isMeta'):
                    if s['first_req'] is None:
                        m = re.search(r'\bw(\d{3,5})\b', t)
                        s['first_req'] = m and 'w' + m.group(1)
                    for m in REOPEN.finditer(t):
                        s['reopens'].append((m.group(1) or m.group(2) or m.group(3), r.get('timestamp')))
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('tool_use_id') in pending_cmd:
                        bt = b.get('content')
                        bt = bt if isinstance(bt, str) else text_of(bt)
                        for m in PR_URL.finditer(bt or ''):
                            s['prs'].add(f'{m.group(1)}#{m.group(2)}')
        if r.get('type') == 'attachment' and not side and NUDGE in ln:
            att = r.get('attachment') or {}
            tid = att.get('toolUseID') or r.get('toolUseID') or (re.search(r'"toolUseID":"([^"]+)"', ln) or [None, None])[1]
            if tid in nudged:
                continue
            nudged.add(tid)
            if tid in idx:
                i = idx[tid]
                nudge_idx.append(i)
                s['nudges'] += 1
                if calls[i][2] >= 5:
                    s['nudges_on_chain'] += 1
                if calls[i][2] != 5:
                    s['nudges_dup'] += 1  # fired at a call that is not this classifier's 5th
            else:
                s['nudges'] += 1
                s['nudges_unmatched'] = s.get('nudges_unmatched', 0) + 1
    for sp in glob.glob(os.path.join(os.path.splitext(path)[0], 'subagents', '*.jsonl')):
        for _, rr in records(sp):
            mm = rr.get('message') if isinstance(rr.get('message'), dict) else {}
            if rr.get('type') == 'assistant' and isinstance(mm.get('usage'), dict):
                kk = mm.get('id') or rr.get('uuid')
                if kk not in seen:
                    seen.add(kk)
                    s['usd_sub'] += mcost(mm.get('model'), mm['usage'])
    s['calls'] = len(calls)
    s['reads'] = sum(1 for c in calls if is_read(c[0], c[1]))
    s['points'] = len(point_idx)
    ag = lambda i: any(n in ('Agent', 'Task') for n, _, _ in calls[i + 1:i + 4])
    s['nudge_followed'] = sum(ag(i) for i in nudge_idx)
    s['point_followed'] = sum(ag(i) for i in point_idx)
    s['chain_lens'] = []
    L = 0
    for n, inp, rl in calls + [('', {}, 0)]:
        if rl == 0 and L:
            s['chain_lens'].append(L)
        L = rl
    s['prs'] = sorted(s['prs'])
    s['models'] = dict(s['models'])
    out.append(s)

json.dump(out, open(a.out, 'w'), indent=0)
print(len(out), 'sessions;', sum(x['pilot'] for x in out), 'pilot')
