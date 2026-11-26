/**
 * w4258: a worker that holds an ffu slot builds in the slot's target, never in a private one in its temp folder (lothsahn:
 * "A worker that holds an ffu slot builds in that slot's target and never in a private $TMPDIR/ffu-target").
 *
 * LothDesktop, 2026-11-15 (the clean-up log): four slot targets of 30, 29, 21 and 10 GB, and beside them a worker's own
 * `V:\ffw\tmp\ffa-bfebc855\ffu-target` of 4.9 GB, a second cold copy of what its slot already held warm. The ffu-build-test
 * skill had taught `CARGO_TARGET_DIR="$TMPDIR/ffu-target"` for a worker without a slot, and workers with one kept it.
 *
 * The guard refuses a command that points cargo at a folder in the worker's temp folder (`CARGO_TARGET_DIR=...` as an
 * assignment, an export or PowerShell's `$env:CARGO_TARGET_DIR = ...`, or `--target-dir ...`) while the worker's session
 * holds a slot in `<install>/ffu-sandboxes/slots.json`. A worker with no slot (all were held) still builds in its temp folder.
 */
import path from 'node:path';
import { expandVars } from './guard.ts';
import { heldSlots, readSlotState, slotTarget } from '../machine/ffuSlots.ts';

type ShellEnv = Record<string, string | undefined>;

export interface FfuTargetContext {
  env?: ShellEnv;
  /** The machine's worker install folder (where ffu-sandboxes/ is). */
  root?: string;
  /** The worker's session (FF_SESSION_ID): a slot's holder. */
  session?: string;
  /** The slots the session holds (w5885: one per branch), the most recently used first; default: read slots.json. */
  heldSlot?: () => string | string[] | undefined;
}

const VALUE = String.raw`("[^"]*"|'[^']*'|(?:\$\([^)]*\)|[^\s;&|)])+)`;
const SETS = [new RegExp(String.raw`\$env:CARGO_TARGET_DIR\s*=\s*` + VALUE, 'gi'), new RegExp(String.raw`(?<![\w:])CARGO_TARGET_DIR=` + VALUE, 'g'), new RegExp(String.raw`--target-dir(?:=|\s+)` + VALUE, 'g')];

const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (p: string, dir: string) => key(p) === key(dir) || key(p).startsWith(key(dir) + '/');

/** The cargo target folders a command names, as written (quotes off). */
export function targetDirsIn(cmd: string): string[] {
  const out: string[] = [];
  for (const re of SETS) for (const m of cmd.matchAll(re)) out.push(m[1].replace(/^(["'])(.*)\1$/, '$2'));
  return out;
}

/** Why the command is refused, or undefined. */
export function checkPrivateFfuTarget(cmd: string, ctx: FfuTargetContext): string | undefined {
  if (!/CARGO_TARGET_DIR|--target-dir/i.test(cmd)) return undefined;
  const dirs = targetDirsIn(cmd);
  if (!dirs.length || !ctx.session || !ctx.root) return undefined;
  const got = ctx.heldSlot ? ctx.heldSlot() : heldSlots(readSlotState(ctx.root), ctx.session).map((s) => s.id);
  const ids = (Array.isArray(got) ? got : got ? [got] : []).filter(Boolean);
  if (!ids.length) return undefined;
  const held = ids[0];
  const env = ctx.env ?? {};
  const temps = [env.TMPDIR, env.TEMP, env.TMP].filter((x): x is string => !!x);
  const mine = slotTarget(ctx.root, held);
  for (const d of dirs) {
    const e = expandVars(d, env);
    const temp = e === undefined ? /\$\{?(TMPDIR|TEMP|TMP)\b|\$env:(TEMP|TMP)\b|%(TEMP|TMP)%/i.test(d) : !ids.some((id) => inside(e, slotTarget(ctx.root!, id))) && temps.some((t) => inside(path.resolve(e), path.resolve(t)));
    if (!temp) continue;
    return (
      `w4258: you hold ffu ${ids.join(' and ')}, so cargo builds in ${ids.length > 1 ? 'their' : 'its'} warm target, not in your temp folder (${d}). ` +
      `Run \`eval "$(ffu-slot where)"\` to set CARGO_TARGET_DIR to ${mine.replace(/\\/g, '/')} and cd into the checkout; ` +
      `a build in the checkout lands there even without it (the slot's .cargo/config.toml). For a baseline of another commit ` +
      `(a RED run on main), check that commit out in your slot and build it there: both stay warm in the one target. ` +
      `A second checkout of another branch gets a second slot of its own (w5885): \`eval "$(ffu-slot take --branch <that branch>)"\` ` +
      `(it waits, exit 4, only while no other slot is free; your own slot never counts as another worker's).`
    );
  }
  return undefined;
}
