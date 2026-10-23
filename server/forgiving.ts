// A size or limit slip is not a refusal (w1869, lothsahn: "Analyze your recent tool failures and make it so they don't happen
// in the future"): zod checks a tool's input before its handler runs, so a `.min(5)` on `last` sent the model away with an
// error for asking `last: 1`. A limit argument is a loose number in the schema (`rangedNumber`), moved into its range by the
// handler (`clamped`), and the result says so.
import { z } from 'zod';

/** A numeric argument with a range: the schema takes any number, the handler moves it into [min, max] and warns. */
export const rangedNumber = (min: number, max: number | undefined, what: string) =>
  z.number().describe(`${what} ${max === undefined ? `At least ${min}` : `${min} to ${max}`}.`);

export type Ranges = Record<string, readonly [min: number, max?: number]>;

/** `args` with each named number rounded and moved into its range, and a line for each one that moved. */
export function clampArgs<A extends object>(args: A, ranges: Ranges): { args: A; warnings: string[] } {
  const out = { ...args } as Record<string, unknown>;
  const warnings: string[] = [];
  for (const [name, [min, max]] of Object.entries(ranges)) {
    const v = out[name];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const whole = Math.round(v);
    const to = Math.max(min, Math.min(max ?? Infinity, whole));
    if (to !== whole) warnings.push(`${name} was ${v}, ${whole < min ? `below the least allowed (${min})` : `over the most allowed (${max})`}; used ${to}.`);
    out[name] = to;
  }
  return { args: out as A, warnings };
}

/** A result with the warnings after it, the way blocked_on adds its own. */
export const withWarnings = (text: string, warnings: readonly string[]) => (warnings.length ? `${text} WARNING: ${warnings.join(' ')}` : text);

/** A tool handler whose numeric arguments are clamped into `ranges` first, and whose answer carries the warnings. */
export const clamped =
  <A extends object, X = undefined>(ranges: Ranges, fn: (a: A, extra?: X) => Promise<string> | string) =>
  async (a: A, extra?: X): Promise<string> => {
    const c = clampArgs(a, ranges);
    return withWarnings(await fn(c.args, extra), c.warnings);
  };
