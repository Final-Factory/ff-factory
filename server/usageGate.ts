// A usage gate's account (w643, w1109, w1126; docs/orchestrators.md "Waiting, Queued, Blocked"): which vault pool a usage
// blocker's ref names, whether that pool can serve a worker now, and when its hold lifts on its own.
import type { PoolView } from './tokenPool.ts';

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
  ref: string;
  serves: boolean;
  until?: string;
}

/** The pool of the vault token called `ref` ("vault-lothsahn-1 …EAAA"), or undefined when no pooled token has that label. */
export function poolForRef(ref: string, pools: Iterable<[string, readonly GatePoolToken[]]>): UsagePool | undefined {
  const n = ref.trim().toLowerCase();
  for (const [person, list] of pools) {
    const t = list.find((x) => `${x.name} …${x.last4}`.toLowerCase() === n);
    if (t) return { person, ref: `${t.name} …${t.last4}`, serves: list.some((x) => x.priority) };
  }
  return undefined;
}
