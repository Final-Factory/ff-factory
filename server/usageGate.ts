// A usage gate's account (w643, w1109, w1126; docs/orchestrators.md "Waiting, Queued, Blocked"): which vault pool a usage
// blocker's ref names, whether that pool can serve a worker now, and when its hold lifts on its own.
//
// w1126: on 2026-10-12 the dispatcher blocked w1116, w1117, w1118 and w1124 on ref "vault-lothsahn-1" (the vault name, as the
// pool's own banner words it), while the gate matched only the full label "vault-lothsahn-1 …EAAA". The check answered
// "unknown" for two hours after the pool had room again, and would have for its 8-day stuck limit. So a ref is matched by the
// token's label, its bare name, its person or "<person>'s pool", and the ledger keeps the label it resolved to.
import { firstFree, type PoolView } from './tokenPool.ts';

/** A pooled token as the gate reads it: its vault name and last four, whether a new worker would get it now, its state. */
export interface GatePoolToken {
  name: string;
  last4: string;
  priority: boolean;
  view: Pick<PoolView, 'state' | 'until'>;
}

/** What a usage gate's ref names: its pool's person, the ref as the ledger keeps it, whether the pool serves, when it frees. */
export interface UsagePool {
  person: string;
  /** The token's label ("vault-lothsahn-1 …EAAA"): the matched token's, or for a person their pool's first. */
  ref: string;
  serves: boolean;
  /** When the first of its tokens' limits lifts on its own (ISO), while it does not serve. */
  until?: string;
}

/** A ref compared loosely: any case, spaces collapsed, "..." as the label's "…". */
const loose = (s: string) => s.trim().toLowerCase().replace(/\.\.\./g, '…').replace(/\s+/g, ' ');

/** "lothsahn's pool", "lothsahn's Claude pool", "lothsahn's Claude token pool" → "lothsahn". */
const POOL_OF = /^(.+?)['’]s (?:claude )?(?:token )?pool$/;

/**
 * The pool a usage gate's ref names (w1126): a vault token's label ("vault-lothsahn-1 …EAAA"), its bare name
 * ("vault-lothsahn-1"), its person ("lothsahn") or "<person>'s pool"; undefined when none does.
 */
export function poolForRef(ref: string, pools: Iterable<[string, readonly GatePoolToken[]]>): UsagePool | undefined {
  const n = loose(ref);
  if (!n) return undefined;
  const person = POOL_OF.exec(n)?.[1] ?? n;
  const all = [...pools].filter(([, list]) => list.length);
  const answer = (who: string, list: readonly GatePoolToken[], t: GatePoolToken): UsagePool => {
    const serves = list.some((x) => x.priority);
    const until = serves ? undefined : firstFree(list.map((x) => x.view as PoolView));
    return { person: who, ref: `${t.name} …${t.last4}`, serves, ...(until ? { until } : {}) };
  };
  for (const [who, list] of all) {
    const t = list.find((x) => loose(`${x.name} …${x.last4}`) === n || loose(x.name) === n);
    if (t) return answer(who, list, t);
  }
  for (const [who, list] of all) if (who.toLowerCase() === person) return answer(who, list, list[0]);
  return undefined;
}
