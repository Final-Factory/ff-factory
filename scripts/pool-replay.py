"""Claude token pool: room left at each weekly reset (measured) and a replay of pick orders over the measured meters (w1539).

Input: CSV files with the columns ts,token,last4,weekly,session, one row per `usage:` line of the portal journal
(`portal_logs source=journal regex="T..:(0.|1[0-4]):..-06:00 fff-portal node.*usage: "`: one poll per token an hour), e.g.
  2026-10-18T23:42:56-06:00,vault-ben-2,dAAA,88,25
Older lines name a token differently (token file, host-ben-claude-1): --alias LAST4=NAME files them under one name.

  python scripts/pool-replay.py usage.csv [more.csv] --alias nQAA=vault-ben-1 --pool vault-ben-1,vault-ben-2,vault-ben-3

Part 1 (measured): every weekly reset seen (a drop of 30 points or more between two readings), the last reading before it
(the room lost), and how long the token sat at >=95 / >=99 / 100% in that week.
Part 2 (an estimate, only with --pool): the pool's measured demand (its tokens' weekly rises, an hour at a time) handed out in
0.25% chunks by each pick order, with the caps of server/tokenPool.ts, over the measured week repeated (--tile) and over
shuffled quiet and busy weeks of the measured days (--seeds). Assumptions: every token is the same plan; a token's 5-hour
meter rises K points per weekly point (fitted to the readings) and closes 5 h after it opened; one process burns at most
--one-proc % weekly an hour; work no token may take waits and is served first the next hour. It does not model processes
running past the 99% retire cap (the measured resets show they do), so it overstates what lifting that cap gains.
Schemes (w1659): the w971 score alone, w1539's near-reset "goes first" with its caps lifted, the score with a hard offset
(hours less 12 or 18, floored at 1 h) and with a soft one (--soft: h - o (1 - e^(-h/o)), the w1659 effectiveHours, retired by w2722),
each with and without the caps lifted (--near-h, --floor), and with a burst guard on the weight (--guard N:ROOM). Columns:
room lost per reset, room left 24 h before a reset (lower: used sooner), waiting work, hours with <= 1 token ready,
token-hours unusable for the weekly caps, and the worst-case / mean share of the busiest measured 5 h the pool could absorb.
"""
import argparse, csv, datetime as dt, math, random
from collections import defaultdict

H = 3600.0
WEEK = 7 * 24 * H
CHUNK = 0.25
HOLD, ONE, RETIRE = 80.0, 95.0, 99.0


def iso(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime('%a %m-%d %H:%MZ')


def load(paths, alias):
    rows = defaultdict(list)
    for p in paths:
        with open(p, newline='', encoding='utf-8') as f:
            for r in csv.DictReader(f):
                try:
                    t = dt.datetime.fromisoformat(r['ts'].strip()).timestamp()
                    w, s = float(r['weekly']), float(r['session'])
                except (ValueError, KeyError, TypeError):
                    continue
                name = alias.get((r.get('last4') or '').strip(), r['token'].strip())
                rows[name].append((t, w, s))
    for k in rows:
        rows[k].sort()
    return rows


def resets(rs):
    return [(b[0], a, b) for a, b in zip(rs, rs[1:]) if a[1] - b[1] >= 30]


def measured(rows):
    print('## Measured: the room left at each weekly reset')
    for tok, rs in sorted(rows.items()):
        print(f'{tok}: {len(rs)} readings, {iso(rs[0][0])} .. {iso(rs[-1][0])}')
        cuts = [rs[0][0]] + [b[0] for _, _, b in resets(rs)] + [rs[-1][0] + 1]
        for (t, a, b), start in zip(resets(rs), cuts):
            seg = [r for r in rs if start <= r[0] < t]
            band = {95: 0.0, 99: 0.0, 100: 0.0}
            for (t0, w0, _), (t1, _, _) in zip(seg, seg[1:]):
                for k in band:
                    if w0 >= k:
                        band[k] += min(t1 - t0, 2 * H) / H
            print(f'  reset {iso(b[0])}: last reading {iso(a[0])} weekly {a[1]:.0f}% -> room lost {100 - a[1]:.0f}%; '
                  f'hours at >=95: {band[95]:.0f}, >=99: {band[99]:.0f}, 100: {band[100]:.0f}')


def fit_k(rows):
    best = None
    for k in [x / 4 for x in range(4, 61)]:
        err = n = 0
        for rs in rows.values():
            start, s = None, 0.0
            for (t0, w0, _), (t1, w1, s1) in zip(rs, rs[1:]):
                if t1 - t0 > 3 * H:
                    start, s = None, 0.0
                    continue
                dw = max(0.0, w1 - w0) if w1 >= w0 - 1 else max(0.0, w1)
                if start is not None and t1 - start >= 5 * H:
                    start, s = None, 0.0
                if dw > 0:
                    if start is None:
                        start, s = t0, 0.0
                    s += k * dw
                err += (min(s, 100) - s1) ** 2
                n += 1
        e = math.sqrt(err / max(n, 1))
        if best is None or e < best[1]:
            best = (k, e)
    return best


class Tok:
    def __init__(self, name, reset, w):
        self.name, self.reset, self.w, self.s, self.win, self.use = name, reset, w, 0.0, None, 0.0
        self.lost, self.full = [], 0


# ---- the rules of server/tokenPool.ts, in the same order

def plain_ok(t, now, one_proc):
    """judge(): may a new process start on it, the caps as they are (w739/w747)."""
    if t.w >= 100 or t.s >= 100 or t.w >= RETIRE or t.s >= HOLD:
        return False
    return not (t.w >= ONE and t.use >= one_proc)


def views(pool, now, near_h, floor, one_proc):
    """judgePool() (w1539): {token: (usable, nearReset)}."""
    out = {}
    for t in pool:
        ok = plain_ok(t, now, one_proc)
        h = (t.reset - now) / H
        if near_h > 0 and h <= near_h and sum(1 for o in pool if o is not t and plain_ok(o, now, one_proc)) >= floor:
            # the 95/99% caps lifted; the 5-hour hold and 100 stay
            out[t] = (t.w < 100 and t.s < HOLD, True)
        else:
            out[t] = (ok, False)
    return out


def eff_hours(h, offset=0.0, soft=0.0):
    """The hours the score divides by: the hours to the reset, less a hard offset (floored at 1 h), or less a soft one
    (w1659): soft - soft * exp(-h / soft), about h - soft far from the reset and h^2 / (2 soft) near it, never below 0."""
    if soft > 0:
        h = h - soft * (1 - math.exp(-h / soft))
    return max(1.0, h - offset)


def score(t, now, offset=0.0, soft=0.0):
    h = eff_hours((t.reset - now) / H, offset, soft)
    return (100 - t.w) / h * (100 - t.s) / 100


def burst_ready(o, now, one_proc, K, room):
    """Another token that can take a 5-hour burst (w1659): it may start a process, and has `room` weekly % before its retire
    cap (one 5-hour window is about HOLD / K of the week)."""
    return plain_ok(o, now, one_proc) and RETIRE - o.w >= room


def guarded(t, pool, now, one_proc, K, guard, offset, soft):
    """The boosted score while at least `guard[0]` other tokens can take a burst of `guard[1]` weekly %, else the plain one."""
    n, room = guard
    if n and sum(1 for o in pool if o is not t and burst_ready(o, now, one_proc, K, room)) < n:
        return score(t, now)
    return score(t, now, offset, soft)


def pace(pool, now):
    rates = [t.w / max(1.0, (WEEK - (t.reset - now)) / H) for t in pool]
    return sum(rates) / len(rates)


def pick_near(cand, v, pool, now):
    """pickOrder() (w1539): near-reset tokens whose room would be lost first (soonest reset), else the w971 score."""
    p = pace(pool, now)
    first = [t for t in cand if v[t][1] and (100 - t.w) - p * (t.reset - now) / H > 0]
    if first:
        return min(first, key=lambda t: (t.reset, -score(t, now)))
    return max(cand, key=lambda t: (score(t, now), -t.reset))


def run(names, start, demand, resets_at, w0, scheme, K, one_proc, near_h=0.0, floor=1, offset=0.0, soft=0.0, guard=(0, 0.0)):
    pool = [Tok(n, resets_at[n], w0[n]) for n in names]
    m = dict(backlog=0.0, ready1=0, burst=[], dry=0, room24=[])
    busiest = max(sum(demand[i:i + 5]) for i in range(len(demand) - 4)) or 1.0
    backlog = 0.0
    for i, d in enumerate(demand):
        now = start + i * H
        for t in pool:
            if 23 * H < t.reset - now <= 24 * H:
                m['room24'].append(100 - t.w)
            if now >= t.reset:
                t.lost.append(100 - t.w)
                t.w, t.reset = 0.0, t.reset + WEEK
            if t.win is not None and now - t.win >= 5 * H:
                t.win, t.s = None, 0.0
            t.use = 0.0
        v = views(pool, now, near_h, floor, one_proc)
        ready = [t for t in pool if v[t][0]]
        m['ready1'] += len(ready) <= 1
        m['dry'] += sum(1 for t in pool if t.w >= (100 if v[t][1] else RETIRE))
        cap = sum(min((100 - t.s) / K, (100 if v[t][1] else RETIRE) - t.w) for t in ready)
        m['burst'].append(min(1.0, max(0.0, cap) / busiest))
        want, got = d + backlog, 0.0
        while want - got > 1e-9:
            v = views(pool, now, near_h, floor, one_proc)
            cand = [t for t in pool if v[t][0]]
            if not cand:
                break
            if scheme == 'near':
                t = pick_near(cand, v, pool, now)
            else:
                t = max(cand, key=lambda t: (guarded(t, pool, now, one_proc, K, guard, offset, soft), -t.reset))
            c = min(CHUNK, want - got)
            t.w = min(100.0, t.w + c)
            t.win = now if t.win is None else t.win
            t.s = min(100.0, t.s + K * c)
            t.use += c
            got += c
        backlog = want - got
        m['backlog'] += backlog
        for t in pool:
            t.full += t.w >= 100
    n = sum(len(t.lost) for t in pool) or 1
    m['lost'] = sum(sum(t.lost) for t in pool) / n
    m['full'] = sum(t.full for t in pool)
    m['room24'] = sum(m['room24']) / max(1, len(m['room24']))
    return m


def replay(rows, names, args):
    K, rmse = fit_k({n: rows[n] for n in names})
    start = max(rows[n][0][0] for n in names)
    end = min(rows[n][-1][0] for n in names)
    hours = int((end - start) // H)
    demand = [0.0] * hours
    resets_at, w0 = {}, {}
    for n in names:
        rs = rows[n]
        for (a, wa, _), (b, wb, _) in zip(rs, rs[1:]):
            if start <= b < end:
                d = wb - wa if wb >= wa - 1 else wb
                if d > 0:
                    demand[int((b - start) // H)] += d
        seen = resets(rs)
        r = seen[0][0] if seen else start + WEEK
        while r - WEEK > start:
            r -= WEEK
        while r <= start:
            r += WEEK
        resets_at[n] = r
        w0[n] = next(x[1] for x in rs if x[0] >= start)
    days = [demand[i:i + 24] for i in range(0, hours - 23, 24)]
    print(f'\n## Replay (an estimate): {", ".join(names)}, {iso(start)} .. {iso(end)}; K {K} (rmse {rmse:.0f} points); '
          f'daily demand {" ".join(f"{sum(d):.0f}" for d in days)} (% of one token)')
    lift = dict(near_h=args.near_h, floor=args.floor)
    schemes = [('w971 score alone', dict(scheme='score')),
               (f'live: w1539 {args.near_h:g} h first+lift', dict(scheme='near', **lift)),
               ('offset 12 h, hard', dict(scheme='score', offset=12)),
               ('offset 18 h, hard', dict(scheme='score', offset=18)),
               ('offset 12 h, hard + lift', dict(scheme='score', offset=12, **lift)),
               ('offset 18 h, hard + lift', dict(scheme='score', offset=18, **lift))]
    for o in args.soft:
        schemes += [(f'soft offset {o:g} h', dict(scheme='score', soft=o)), (f'soft offset {o:g} h + lift', dict(scheme='score', soft=o, **lift))]
        for g in args.guard:
            n, room = g.split(':')
            schemes += [(f'soft {o:g} h + lift, guard {n}x{room}%', dict(scheme='score', soft=o, guard=(int(n), float(room)), **lift))]
    if args.only:
        schemes = [x for x in schemes if any(k in x[0] for k in args.only)]
    head = 'lost/reset  room@-24h  backlog %h  h<=1 ready  tok-h dry  burst min/mean'
    for label, scale in [('the measured week repeated', None), ('shuffled quiet and busy weeks', 'shuffle')]:
        for level in args.levels:
            print(f'\n{label}, demand x{level}: {head}')
            for name, kw in schemes:
                acc = defaultdict(float)
                seeds = 1 if scale is None else args.seeds
                for seed in range(seeds):
                    if scale is None:
                        seq = [x * level for x in demand] * args.tile
                    else:
                        rnd, seq = random.Random(seed), []
                        for _ in range(args.tile + 1):
                            f = level * rnd.uniform(0.6, 1.4)
                            for _ in range(7):
                                seq += [x * f for x in rnd.choice(days)]
                    m = run(names, start, seq, resets_at, w0, K=K, one_proc=args.one_proc, **kw)
                    for k in ('lost', 'backlog', 'ready1', 'full', 'dry', 'room24'):
                        acc[k] += m[k] / seeds
                    acc['bmin'] += min(m['burst']) / seeds
                    acc['bmean'] += sum(m['burst']) / len(m['burst']) / seeds
                print(f'  {name:34} {acc["lost"]:10.2f} {acc["room24"]:10.1f} {acc["backlog"]:10.0f} {acc["ready1"]:11.1f} {acc["dry"]:9.1f}   {acc["bmin"]:.2f}/{acc["bmean"]:.3f}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('csv', nargs='+')
    ap.add_argument('--alias', action='append', default=[], help='LAST4=NAME')
    ap.add_argument('--pool', help='comma-separated token names: replay this pool')
    ap.add_argument('--near-h', type=float, default=12.0)
    ap.add_argument('--floor', type=int, default=1)
    ap.add_argument('--one-proc', type=float, default=2.0)
    ap.add_argument('--soft', type=float, nargs='*', default=[12.0, 18.0, 24.0], help='soft offsets to replay (w1659)')
    ap.add_argument('--guard', nargs='*', default=[], help='N:ROOM burst guards to replay with each soft offset (w1659)')
    ap.add_argument('--only', nargs='*', default=[], help='replay only the schemes whose label holds one of these')
    ap.add_argument('--tile', type=int, default=4)
    ap.add_argument('--seeds', type=int, default=30)
    ap.add_argument('--levels', type=float, nargs='+', default=[0.7, 0.85, 1.0])
    a = ap.parse_args()
    rows = load(a.csv, dict(x.split('=', 1) for x in a.alias))
    measured(rows)
    if a.pool:
        replay(rows, a.pool.split(','), a)
