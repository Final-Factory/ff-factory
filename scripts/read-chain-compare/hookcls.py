import re
READERS = set('cat head tail sed grep egrep fgrep rg find ls wc awk cut sort uniq nl less more file stat jq diff tree column tr xxd od strings realpath basename dirname git'.split())
NEUTRAL = set('cd echo printf true pwd'.split())
GIT_READS = set('log show diff grep status blame ls-files ls-tree cat-file rev-parse describe shortlog reflog merge-base rev-list name-rev'.split())
def segments(cmd):
    out, seg, word, has, quote = [], [], '', False, None
    i = 0
    def endword():
        nonlocal word, has
        if has: seg.append(word)
        word, has = '', False
    def endseg():
        nonlocal seg
        endword()
        if seg: out.append(seg)
        seg = []
    n = len(cmd)
    while i < n:
        c = cmd[i]
        if quote:
            if c == quote: quote = None
            elif c == chr(92) and quote == '"' and i + 1 < n: i += 1; word += cmd[i]
            else: word += c
            i += 1; continue
        if c in '"\'': quote = c; has = True
        elif c == chr(92) and i + 1 < n: i += 1; word += cmd[i]; has = True
        elif c in (';', chr(10), '|', '&'):
            if c == '&' and word.endswith('>'): word += c; has = True; i += 1; continue
            endseg()
            if c in '|&' and i + 1 < n and cmd[i + 1] == c: i += 1
        elif c in ' \t': endword()
        else: word += c; has = True
        i += 1
    if quote: return None
    endseg()
    return out
def writes(words):
    for i, w in enumerate(words):
        m = re.match(r'^\d*(>>?|&>)(.*)$', w)
        if not m: continue
        t = m.group(2) or (words[i + 1] if i + 1 < len(words) else '')
        if t.startswith('&') or t in ('/dev/null', 'NUL'): continue
        return True
    return False
def kind(words):
    if writes(words): return 'other'
    i = 0
    while i < len(words) and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', words[i]): i += 1
    cmd = re.sub(r'^.*/', '', words[i] if i < len(words) else '')
    args = words[i + 1:]
    if not cmd: return 'neutral'
    if cmd in NEUTRAL: return 'neutral'
    if cmd not in READERS: return 'other'
    if cmd == 'sed' and any(re.match(r'^-[^-]*i', a) or a.startswith('--in-place') for a in args): return 'other'
    if cmd == 'awk' and any(a == 'inplace' or a.startswith('-i') for a in args): return 'other'
    if cmd == 'find' and any(a in ('-delete', '-exec', '-execdir', '-ok', '-fprint') for a in args): return 'other'
    if cmd == 'git':
        j = 0
        while j < len(args) and args[j].startswith('-'): j += 2 if args[j] in ('-C', '-c') else 1
        return 'read' if (args[j] if j < len(args) else '') in GIT_READS else 'other'
    return 'read'
def is_read(name, inp):
    if name in ('Read', 'Grep', 'Glob'): return True
    if name == 'Bash':
        c = inp.get('command')
        if not isinstance(c, str): return False
        s = segments(c)
        if not s: return False
        k = [kind(w) for w in s]
        return 'read' in k and 'other' not in k
    return False
