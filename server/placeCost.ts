/**
 * w6428: where a page's state build spends its placement time. The live portal's 'machines' and 'room' phases took
 * 70-180 ms on 2026-11-27 while scripts/bench-loop-blocks.ts built them in 4-8 ms, so the page line names the parts.
 * Each Cost counts outermost calls only (a nested call of the same kind is inside the outer one's time).
 */
export interface Cost {
  /** Outermost calls. */
  n: number;
  /** Their time in ms. */
  ms: number;
  /** Calls running now (nesting depth). */
  depth: number;
}

export const newCost = (): Cost => ({ n: 0, ms: 0, depth: 0 });

export function timedCost<T>(c: Cost, fn: () => T): T {
  if (c.depth > 0) {
    c.depth++;
    try {
      return fn();
    } finally {
      c.depth--;
    }
  }
  c.depth = 1;
  const t = performance.now();
  try {
    return fn();
  } finally {
    c.depth = 0;
    c.n++;
    c.ms += performance.now() - t;
  }
}

/** A Cost's n and ms now, to subtract from later (costSince). */
export const costMark = (c: Cost): { n: number; ms: number } => ({ n: c.n, ms: c.ms });

/** " free 30ms x48" for what `c` did since `was`, or '' when nothing. */
export function costSince(name: string, c: Cost, was: { n: number; ms: number }): string {
  const n = c.n - was.n;
  return n > 0 ? ` ${name} ${Math.round(c.ms - was.ms)}ms x${n}` : '';
}
