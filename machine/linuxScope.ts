import { spawnSync } from 'node:child_process';
import { run as runAsync } from '../server/proc.ts';

/**
 * w2474: on a Linux PC the daemon starts every Unity editor and every agent host in a transient systemd scope of its own
 * (`systemd-run --user --scope`), so they are not in the daemon's own cgroup.
 *
 * Why: the daemon's unit has `KillMode=process` (server/machineDeployLinux.ts) so that a restart leaves its agents and
 * editors running, and with that alone they all stayed in the unit's one cgroup. On biscuit on 2026-10-28, Unity filled
 * RAM and swap, the kernel's OOM killer ended an editor at 10:23 and another at 10:52 UTC, and systemd, whose default
 * OOMPolicy=stop ends a unit when any of its processes is OOM-killed, stopped the daemon with them: the portal saw biscuit
 * close its link at 10:23:11 and come back 11 s later, which is the unit's RestartSec=10. In its own scope an editor (or
 * an agent with its batch Unity) is all that goes, and the daemon and its link stay up (the unit also has
 * OOMPolicy=continue now, server/machineDeployLinux.ts).
 *
 * w2884: a scope also gets `OOMPolicy=continue`. A scope's default is systemd's DefaultOOMPolicy=, `stop` (systemd.scope(5):
 * OOMPolicy= for scopes since systemd 253), so when the kernel's OOM killer ended one process of an agent's scope (its
 * batch Unity build, the biggest process there), systemd stopped the whole scope, the agent host and its claude with it:
 * on biscuit on 2026-11-02 workers 0b897db6 (mid-build) and 3215a6aa stopped with "its agent host stopped unexpectedly"
 * while biscuit's RAM stood at ~96%. With `continue` only the killed process goes, and the agent hears its build died.
 * A systemd older than 253 refuses the property (systemd-run fails, nothing runs), so it is probed first, as the scope is.
 *
 * `--scope` runs the command in place: the process systemd-run starts IS the command after an exec, so the pid the
 * daemon keeps, its start time (machine/hostWatch.ts) and its stdin are the command's (measured in Ubuntu 24.04,
 * systemd 255). Where no user manager answers (a container, no session bus), the command starts as before.
 */

/** How long a probe's answer is kept. */
const PROBE_TTL_MS = 10 * 60_000;

let probed: { ok: boolean; at: number } | undefined;
let probedOom: { ok: boolean; at: number } | undefined;
let probedLimits: { ok: boolean; at: number } | undefined;
let seq = 0;

const PROBE_MARK = 'ffw-scope-ok';

/**
 * Whether `systemd-run --user --scope` works here: a scope whose command says PROBE_MARK. The exit status is not enough:
 * with no user bus systemd 255 says "Failed to connect to bus", runs nothing and still exits 0 (measured, Ubuntu 24.04).
 * Exported for tests.
 */
export function probeScopes(run: (() => { status: number | null; stdout: string }) | { status: number | null; stdout: string } = () => spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'echo', PROBE_MARK], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })): boolean {
  const r = typeof run === 'function' ? run() : run;
  return r.status === 0 && (r.stdout ?? '').includes(PROBE_MARK);
}

/** Whether scopes can be used now: probed once, the answer kept PROBE_TTL_MS. Exported for tests. */
export function scopesUsable(probe: () => boolean = probeScopes, now = Date.now()): boolean {
  if (!probed || now - probed.at > PROBE_TTL_MS) probed = { ok: probe(), at: now };
  return probed.ok;
}

/** Whether a scope here takes `-p OOMPolicy=continue` (systemd 253 and later, w2884): a scope whose command ran. Exported for tests. */
export function probeOomPolicy(run: () => { status: number | null; stdout: string } = () => spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', ...OOM_CONTINUE, '--', 'echo', PROBE_MARK], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })): boolean {
  return probeScopes(run);
}

/** Whether scopes take OOMPolicy=continue now: probed once, the answer kept PROBE_TTL_MS. Exported for tests. */
export function oomPolicyUsable(probe: () => boolean = probeOomPolicy, now = Date.now()): boolean {
  if (!probedOom || now - probedOom.at > PROBE_TTL_MS) probedOom = { ok: probe(), at: now };
  return probedOom.ok;
}

/**
 * Whether a scope here enforces MemoryMax and TasksMax (w5554, machine/workerCaps.ts): the user manager must delegate the memory
 * and pids controllers (systemd's user@.service does, `Delegate=pids memory cpu`, since systemd 252: a guess for older ones), or
 * systemd takes the properties and nothing holds them. So the probe reads its own scope's memory.max back. Exported for tests.
 */
export function probeLimits(run: () => { status: number | null; stdout: string } = () => spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', ...LIMITS_PROBE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })): boolean {
  return limitsAnswer(run());
}

function limitsAnswer(r: { status: number | null; stdout: string }): boolean {
  const lines = (r.stdout ?? '').split(/\s+/);
  return r.status === 0 && lines.includes(String(PROBE_MEMORY)) && lines.includes('4096');
}

const PROBE_MEMORY = 1073741824;
const LIMITS_PROBE = ['-p', `MemoryMax=${PROBE_MEMORY}`, '-p', 'TasksMax=4096', '--', 'sh', '-c', 'cat "/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)/memory.max" "/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)/pids.max"'];

/** Whether scopes enforce limits now: probed once, the answer kept PROBE_TTL_MS. Exported for tests. */
export function limitsUsable(probe: () => boolean = probeLimits, now = Date.now()): boolean {
  if (!probedLimits || now - probedLimits.at > PROBE_TTL_MS) probedLimits = { ok: probe(), at: now };
  return probedLimits.ok;
}

type ProbeRunAsync = (args: string[]) => Promise<{ status: number | null; stdout: string }>;
const realProbeRunAsync: ProbeRunAsync = async (args) => {
  const r = await runAsync('systemd-run', args, { timeoutMs: 10_000 });
  return { status: r.code, stdout: r.stdout };
};
let warming: Promise<void> | undefined;

/**
 * w5973: the three probes, run as child processes the daemon's loop does not wait on, before their answers go stale
 * (at half PROBE_TTL_MS), so scoped() at an editor's or an agent host's launch finds them kept and never runs
 * systemd-run on the loop (up to 3 x 10 s before). The daemon calls it at start and on a timer; Linux only. One at a time.
 */
export function warmScopeProbes(o: { platform?: NodeJS.Platform; run?: ProbeRunAsync; now?: () => number } = {}): Promise<void> {
  if ((o.platform ?? process.platform) !== 'linux') return Promise.resolve();
  if (warming) return warming;
  const now = o.now ?? Date.now;
  const due = (p: { at: number } | undefined) => !p || now() - p.at > PROBE_TTL_MS / 2;
  const run = o.run ?? realProbeRunAsync;
  const base = ['--user', '--scope', '--quiet', '--collect'];
  warming = (async () => {
    if (due(probed)) probed = { ok: probeScopes(await run([...base, '--', 'echo', PROBE_MARK]).catch(() => FAILED)), at: now() };
    if (!probed?.ok) return;
    if (due(probedOom)) probedOom = { ok: probeScopes(await run([...base, ...OOM_CONTINUE, '--', 'echo', PROBE_MARK]).catch(() => FAILED)), at: now() };
    if (due(probedLimits)) probedLimits = { ok: limitsAnswer(await run([...base, ...LIMITS_PROBE]).catch(() => FAILED)), at: now() };
  })().finally(() => (warming = undefined));
  return warming;
}
const FAILED = { status: null, stdout: '' };

/** Forget the probes' answers (tests). */
export function resetScopeProbe() {
  probed = undefined;
  probedOom = undefined;
  probedLimits = undefined;
}

/** A scope's limits (w5554, enforce mode only): the bytes and tasks the whole scope may use. */
export interface ScopeLimits {
  memoryBytes: number;
  tasks: number;
}

/** The property that keeps a scope running when the OOM killer ends one of its processes (w2884). */
const OOM_CONTINUE = ['-p', 'OOMPolicy=continue'];

/**
 * A scope's unit name: `ffw-<kind>-<tag>-<time><n>`, unique (systemd refuses a second scope of the same name while the
 * first is loaded) and within systemd's unit-name characters. Exported for tests.
 */
export function scopeUnit(kind: 'unity' | 'agent', tag: string, now = Date.now()): string {
  const t = tag.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[._-]+/, '').slice(0, 48) || 'x';
  seq = (seq + 1) % 1296;
  return `ffw-${kind}-${t}-${now.toString(36)}${seq.toString(36)}.scope`;
}

/** The command line that runs bin args in a scope of its own. Exported for tests. */
export function inScope(unit: string, bin: string, args: string[], oomContinue = false, limits?: ScopeLimits): { bin: string; args: string[]; unit: string } {
  // MemorySwapMax stays unset: a worker's build may page, as before; MemoryMax bounds what it holds in RAM.
  const lim = limits ? ['-p', `MemoryMax=${limits.memoryBytes}`, '-p', `TasksMax=${limits.tasks}`] : [];
  return { bin: 'systemd-run', args: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, ...(oomContinue ? OOM_CONTINUE : []), ...lim, '--', bin, ...args], unit };
}

/**
 * bin args, run in a scope of their own on a Linux PC whose user manager answers (with OOMPolicy=continue where systemd
 * takes it); unchanged anywhere else. `unit`: the scope's name, when there is one.
 */
export function scoped(
  kind: 'unity' | 'agent',
  tag: string,
  bin: string,
  args: string[],
  o: { platform?: NodeJS.Platform; usable?: () => boolean; oom?: () => boolean; limits?: ScopeLimits; limitsOk?: () => boolean } = {},
): { bin: string; args: string[]; unit?: string; limited?: boolean } {
  if ((o.platform ?? process.platform) !== 'linux') return { bin, args };
  if (!(o.usable ?? scopesUsable)()) return { bin, args };
  const oom = (o.oom ?? oomPolicyUsable)();
  // Limits only where the scope also takes OOMPolicy=continue: without it systemd's default (`stop`) ends the whole scope, the
  // host and its claude with it, when the kernel's OOM killer ends one process of it (w2884), so MemoryMax would be a way to
  // kill the agent. The scope then runs with no limits, and the caller says so (`limited` unset).
  const limits = o.limits && oom && (o.limitsOk ?? limitsUsable)() ? o.limits : undefined;
  return { ...inScope(scopeUnit(kind, tag), bin, args, oom, limits), ...(limits ? { limited: true } : {}) };
}

/**
 * Why a scope's process tree ended, from the user journal of that scope (w2884): systemd's own line when the OOM killer
 * (or systemd-oomd) ended a process of it, else undefined. Best effort: no journal, no answer, within 3 s. w5973: a child
 * process the daemon's loop does not wait on (it ran from the agent host's 100 ms poll).
 */
export async function scopeEndCause(unit: string, run: () => Promise<{ status: number | null; stdout: string }> = async () => {
  const r = await runAsync('journalctl', ['--user', '-u', unit, '-o', 'cat', '-n', '40', '--no-pager'], { timeoutMs: 3000 });
  return { status: r.code, stdout: r.stdout };
}): Promise<string | undefined> {
  let out = '';
  try {
    out = (await run()).stdout ?? '';
  } catch {
    return undefined;
  }
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.reverse().find((l) => /oom|out of memory|memory pressure/i.test(l));
  return hit ? hit.slice(0, 240) : undefined;
}
