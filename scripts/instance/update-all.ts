// Update every FF Factory instance on this computer to the commit the lead portal verified (w14, report r4; docs/instances.md).
//
// Final Factory's portal on the VM deploys itself (server/autoDeploy.ts, deploy/vm/guest/fff-update) and then updates its
// machines' daemons (server/machineRollout.ts). Every other instance (a portal started by a logon task or a LaunchAgent on a
// person's computer: Light Tree, Lens Scout, the audiology demo) stayed on whatever commit someone last checked out. This
// script is their deploy. Run by the `ff-instances-update` task every few minutes, from its own checkout of ff-factory:
//
//   1. Reads the lead portal's /api/health. Once it has reported the same commit for `leader.stableMinutes` (a VM deploy
//      that does not verify is rolled back within minutes, and /api/health shows the old commit again), that commit is the
//      target, provided it is on origin/main.
//   2. Moves its own checkout to the target first and runs again from it, so the updater is always the target's.
//   3. Then, one instance at a time in the list's order, each whose /api/health reports another commit:
//      - drains it the way fff-update drains the VM's portal (data/restart.request, drain "auto", auto: true, hold): busy
//        workers are asked to wrap up and the portal's own coordinators (orchestrators, dispatcher) are waited for, at most
//        `drainMinutes`; then a plain restart.request stops it, and it records the sessions to resume;
//      - stops the instance's daemon too when that daemon runs from the portal's app folder (`daemonInApp`, the hand-made
//        layout before w14): npm ci replaces node_modules under it;
//      - checks the target out, runs npm ci and the web build, writes data/update.result.json (the portal's restart summary
//        tells its dispatcher how the update went), starts the task(s) and waits for /api/health to report the target;
//      - verified: writes data/update.verified.json, so that portal updates its own machines' daemons over their links,
//        exactly as FFF's does after a verified deploy (server/machineRollout.ts);
//      - not verified: puts the previous commit back (checkout, npm ci, build, start), records the commit as failed for this
//        computer and stops the batch, so the instances after it stay on code that works. A failed commit is not tried
//        again; the next one the lead verifies is.
//   4. Checks each instance's settings against the list's `expect` (new shared features that need a per-portal switch:
//      deviceApproval, trustProxy, machines.keepAgentsOnRestart) and logs the ones that differ. It never changes a config.
//
// Its state and log are beside the list: update-all.json, update-all.log. No npm package: it runs before npm ci.
//
//   node scripts/instance/update-all.ts --list <instances.json> [--only a,b] [--dry-run] [--no-self]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Instance {
  /** A short name (used in the log and the state). */
  name: string;
  /** The instance's folder (config.json, data, logs). */
  dir: string;
  /** Its checkout of ff-factory, which the portal runs (default <dir>/app). */
  app?: string;
  /** Its config.json (default <dir>/config.json); dataDir and port are read from it. */
  config?: string;
  /** The portal's logon task (Windows) or LaunchAgent label (macOS). */
  portalTask: string;
  /** The daemon's task or label, when the daemon runs from the portal's app folder (`daemonInApp`). */
  daemonTask?: string;
  /** The daemon on this computer runs from `app` (the hand-made layout): stop it around npm ci, start it after. */
  daemonInApp?: boolean;
  /** The daemon's daemon.json, to find its process (default <dir>/daemon.json). */
  daemonConfig?: string;
  /** The machines that run this instance's daemons, for the record (docs/instances.md). */
  machines?: string[];
  /** Settings a shared feature needs set per portal, by dotted path: logged when config.json differs. */
  expect?: Record<string, unknown>;
  /** false: listed, never updated (a demo kept on its commit on purpose). */
  enabled?: boolean;
}

export interface InstanceList {
  version: 1;
  /** The portal whose verified commit the others follow. */
  leader: { url: string; stableMinutes?: number };
  /** The branch a target must be on (default main). */
  branch?: string;
  /** Folder holding node (prepended to PATH for npm and the tasks' children). */
  nodeDir?: string;
  /** The updater's own checkout of ff-factory (default: the one this script runs from). */
  self?: string;
  drainMinutes?: number;
  healthMinutes?: number;
  instances: Instance[];
}

export interface State {
  leader?: { sha: string; since: string };
  /** Commits that failed here, with the instance that failed them: not tried again. */
  failed: Record<string, { instance: string; at: string; error: string }>;
  /** The last roll of each instance. */
  last: Record<string, { at: string; from?: string; to: string; ok: boolean; note: string }>;
  settings: Record<string, string[]>;
}

/** What the updater does to the world: injected, so the tests drive it with fakes. */
export interface Deps {
  now(): number;
  /** /api/health's sha (short), or undefined when it does not answer. */
  health(url: string): Promise<string | undefined>;
  git(cwd: string, args: string[]): { code: number; out: string };
  /** npm ci, the web's npm ci and its build, in `app`. Throws with the step that failed. */
  build(app: string): void;
  /** Stop the portal (its drain is done) and, with daemonInApp, its daemon. */
  stop(i: Resolved): Promise<void>;
  /** Start the portal's task, and the daemon's with daemonInApp. */
  start(i: Resolved): void;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface Resolved extends Instance {
  app: string;
  config: string;
  dataDir: string;
  port: number;
  daemonConfig: string;
}

export const DEFAULTS = { stableMinutes: 5, drainMinutes: 30, healthMinutes: 6, branch: 'main' };
const SHA = /^[0-9a-f]{7,40}$/;

export function readList(file: string): InstanceList {
  const l = JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))) as InstanceList;
  const bad = listProblem(l);
  if (bad) throw new Error(`${file}: ${bad}`);
  return l;
}

export function listProblem(l: InstanceList): string | undefined {
  if (l?.version !== 1) return 'version must be 1';
  if (!/^https?:\/\/[^/]+/.test(l.leader?.url ?? '')) return 'leader.url must be the lead portal\'s base URL';
  if (!Array.isArray(l.instances)) return 'instances must be a list';
  const names = new Set<string>();
  for (const i of l.instances) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(i?.name ?? '')) return `instance name ${JSON.stringify(i?.name)}: lower case letters, digits and -`;
    if (names.has(i.name)) return `instance ${i.name} is listed twice`;
    names.add(i.name);
    if (!i.dir) return `instance ${i.name}: dir is missing`;
    if (!i.portalTask) return `instance ${i.name}: portalTask is missing`;
    if (i.daemonInApp && !i.daemonTask) return `instance ${i.name}: daemonInApp needs daemonTask`;
  }
  return undefined;
}

/** An instance's paths, and the port and dataDir its config.json gives. */
export function resolve(i: Instance): Resolved {
  const config = i.config ?? path.join(i.dir, 'config.json');
  const c = JSON.parse(stripBom(fs.readFileSync(config, 'utf8'))) as { port?: number; dataDir?: string };
  const app = i.app ?? path.join(i.dir, 'app');
  return { ...i, app, config, port: c.port ?? 8787, dataDir: path.resolve(app, c.dataDir ?? 'data'), daemonConfig: i.daemonConfig ?? path.join(i.dir, 'daemon.json') };
}

/** The dotted paths of `expect` that config.json does not have as given: "deviceApproval: off, expected members". */
export function settingsDiff(config: Record<string, unknown>, expect: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const [key, want] of Object.entries(expect ?? {})) {
    let v: unknown = config;
    for (const k of key.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    if (JSON.stringify(v) !== JSON.stringify(want)) out.push(`${key}: ${v === undefined ? 'unset' : JSON.stringify(v)}, expected ${JSON.stringify(want)}`);
  }
  return out;
}

export const sameCommit = (a: string | undefined, b: string | undefined) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * The commit to roll to: the lead's, once it has reported it for stableMinutes. Updates `state.leader`. Undefined while
 * the lead does not answer or its commit is new.
 */
export function stableTarget(sha: string | undefined, state: State, now: number, stableMinutes: number): string | undefined {
  if (!sha || !SHA.test(sha)) return undefined;
  if (!state.leader || !sameCommit(state.leader.sha, sha)) {
    state.leader = { sha, since: new Date(now).toISOString() };
    return stableMinutes <= 0 ? sha : undefined;
  }
  return now - Date.parse(state.leader.since) >= stableMinutes * 60_000 ? state.leader.sha : undefined;
}

export interface TickResult {
  target?: string;
  rolled: string[];
  failed?: string;
  skipped: string[];
}

/** One pass: pick the target, roll each instance that is not on it, one at a time. */
export async function tick(l: InstanceList, state: State, d: Deps, o: { dryRun?: boolean } = {}): Promise<TickResult> {
  const res: TickResult = { rolled: [], skipped: [] };
  const lead = await d.health(l.leader.url);
  const short = stableTarget(lead, state, d.now(), l.leader.stableMinutes ?? DEFAULTS.stableMinutes);
  const instances = l.instances.filter((i) => i.enabled !== false).map(resolve);
  for (const i of instances) {
    try {
      const diff = settingsDiff(JSON.parse(stripBom(fs.readFileSync(i.config, 'utf8'))), i.expect);
      if (diff.join() !== (state.settings[i.name] ?? []).join()) d.log(`${i.name}: settings ${diff.length ? `differ from the list: ${diff.join('; ')}` : 'match the list'}`);
      state.settings[i.name] = diff;
    } catch (e) {
      d.log(`${i.name}: cannot read ${i.config}: ${(e as Error).message}`);
    }
  }
  if (!lead) {
    d.log(`the lead portal ${l.leader.url} does not answer; nothing to follow`);
    return res;
  }
  if (!short) return res;
  const branch = l.branch ?? DEFAULTS.branch;
  for (const i of instances) {
    const cur = await d.health(`http://127.0.0.1:${i.port}`);
    if (sameCommit(cur, short)) continue;
    if (!cur) {
      d.log(`${i.name}: its portal on :${i.port} does not answer; not touched (it may be starting)`);
      res.skipped.push(i.name);
      continue;
    }
    if (d.git(i.app, ['fetch', '--quiet', 'origin']).code !== 0) {
      d.log(`${i.name}: git fetch failed in ${i.app}; not touched`);
      res.skipped.push(i.name);
      continue;
    }
    const full = d.git(i.app, ['rev-parse', '--verify', '--quiet', `${short}^{commit}`]).out.trim();
    if (!/^[0-9a-f]{40}$/.test(full)) {
      d.log(`${i.name}: the lead's commit ${short} is not in ${i.app}'s origin; not touched`);
      res.skipped.push(i.name);
      continue;
    }
    res.target = full;
    if (state.failed[full]) {
      res.skipped.push(i.name);
      continue;
    }
    if (d.git(i.app, ['merge-base', '--is-ancestor', full, `origin/${branch}`]).code !== 0) {
      d.log(`the lead runs ${short}, which is not on origin/${branch}; no instance follows it`);
      return res;
    }
    const prev = d.git(i.app, ['rev-parse', 'HEAD']).out.trim();
    if (d.git(i.app, ['status', '--porcelain', '--untracked-files=no']).out.trim()) {
      d.log(`${i.name}: ${i.app} has modified tracked files; not touched (commit or discard them)`);
      res.skipped.push(i.name);
      continue;
    }
    if (o.dryRun) {
      d.log(`${i.name}: would roll ${prev.slice(0, 9)} -> ${full.slice(0, 9)} (dry run)`);
      continue;
    }
    const r = await roll(i, prev, full, l, d);
    state.last[i.name] = { at: new Date(d.now()).toISOString(), from: prev, to: r.ok ? full : prev, ok: r.ok, note: r.note };
    if (!r.ok) {
      state.failed[full] = { instance: i.name, at: new Date(d.now()).toISOString(), error: r.note };
      res.failed = i.name;
      d.log(`${i.name}: ${full.slice(0, 9)} failed (${r.note}); the batch stops here, the instances after it stay where they are`);
      return res;
    }
    res.rolled.push(i.name);
  }
  return res;
}

/** Drain, stop, update, start, verify; put the old commit back when the new one does not answer. */
export async function roll(i: Resolved, prev: string, target: string, l: InstanceList, d: Deps): Promise<{ ok: boolean; note: string }> {
  const drainMinutes = l.drainMinutes ?? DEFAULTS.drainMinutes;
  const healthMs = (l.healthMinutes ?? DEFAULTS.healthMinutes) * 60_000;
  const at = () => new Date(d.now()).toISOString();
  d.log(`${i.name}: rolling ${prev.slice(0, 9)} -> ${target.slice(0, 9)}; draining (at most ${drainMinutes} min)`);
  await drain(i, drainMinutes, `update to ${target.slice(0, 9)}, the commit the lead portal verified (update-all)`, d);
  try {
    await d.stop(i);
  } catch (e) {
    // Nothing was changed yet: let it run on as it is.
    const note = `could not stop it: ${(e as Error).message}`;
    d.log(`${i.name}: ${note}; left on ${prev.slice(0, 9)}`);
    try {
      d.start(i);
    } catch (e2) {
      d.log(`${i.name}: starting its task again failed too: ${(e2 as Error).message}: a person must look`);
    }
    return { ok: false, note };
  }
  let error = '';
  try {
    if (d.git(i.app, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', target]).code !== 0) throw new Error('git checkout failed');
    d.build(i.app);
  } catch (e) {
    error = (e as Error).message;
  }
  if (!error) {
    writeJson(path.join(i.dataDir, 'update.result.json'), { ok: true, at: at(), headBefore: prev, headAfter: target });
    let started = '';
    try {
      d.start(i);
    } catch (e) {
      started = (e as Error).message;
    }
    if (!started && (await waitHealth(i, target, healthMs, d))) {
      writeJson(path.join(i.dataDir, 'update.verified.json'), { sha: target, previous: prev, at: at() });
      d.log(`${i.name}: on ${target.slice(0, 9)}, verified by its /api/health; its portal now updates its machines' daemons`);
      return { ok: true, note: 'verified' };
    }
    error = started ? `starting it failed: ${started}` : `its /api/health did not report ${target.slice(0, 9)} within ${Math.round(healthMs / 60_000)} min`;
    await d.stop(i).catch((e: Error) => d.log(`${i.name}: stopping it for the rollback: ${e.message}`));
  }
  d.log(`${i.name}: ${error}; putting ${prev.slice(0, 9)} back`);
  let back = '';
  try {
    if (d.git(i.app, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', prev]).code !== 0) throw new Error('git checkout of the previous commit failed');
    d.build(i.app);
  } catch (e) {
    back = (e as Error).message;
  }
  writeJson(path.join(i.dataDir, 'update.result.json'), { ok: false, at: at(), error: `update to ${target.slice(0, 9)} rolled back: ${error}`, headBefore: prev, headAfter: prev });
  try {
    d.start(i);
  } catch (e) {
    back ||= (e as Error).message;
  }
  const up = await waitHealth(i, prev, healthMs, d);
  d.log(`${i.name}: ${up ? `back on ${prev.slice(0, 9)}` : `NOT answering after the rollback${back ? ` (${back})` : ''}: a person must look`}`);
  return { ok: false, note: error + (up ? '; rolled back' : '; rollback did not come up') };
}

async function drain(i: Resolved, minutes: number, reason: string, d: Deps) {
  const done = path.join(i.dataDir, 'drain.done');
  fs.rmSync(done, { force: true });
  fs.writeFileSync(path.join(i.dataDir, 'restart.request'), JSON.stringify({ drain: 'auto', drainMinutes: minutes, reason, update: false, hold: true, auto: true }));
  const until = d.now() + (minutes + 2) * 60_000;
  while (!fs.existsSync(done) && d.now() < until) await d.sleep(3000);
  d.log(`${i.name}: ${fs.existsSync(done) ? 'drain done' : 'no drain confirmation; stopping anyway'}`);
  fs.rmSync(done, { force: true });
  // The plain request: stop now (resume.json records the sessions to resume).
  fs.writeFileSync(path.join(i.dataDir, 'restart.request'), '');
}

async function waitHealth(i: Resolved, sha: string, ms: number, d: Deps): Promise<boolean> {
  const until = d.now() + ms;
  for (;;) {
    if (sameCommit(await d.health(`http://127.0.0.1:${i.port}`), sha)) return true;
    if (d.now() >= until) return false;
    await d.sleep(5000);
  }
}

export function readState(file: string): State {
  try {
    const s = JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))) as Partial<State>;
    return { failed: s.failed ?? {}, last: s.last ?? {}, settings: s.settings ?? {}, ...(s.leader ? { leader: s.leader } : {}) };
  } catch {
    return { failed: {}, last: {}, settings: {} };
  }
}

function writeJson(file: string, v: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function stripBom(s: string) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ---------------------------------------------------------------- the real world

const isWin = process.platform === 'win32';

function sh(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function ps(script: string) {
  return sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

/** The pid listening on the port (the portal), or undefined. */
function portPid(port: number): number | undefined {
  const r = isWin
    ? ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`)
    : sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pid = Number.parseInt(r.out.trim().split(/\s+/)[0] ?? '', 10);
  return pid > 0 ? pid : undefined;
}

/** The node processes whose command line names `needle` (the daemon's daemon.json). */
function pidsByCommandLine(needle: string): number[] {
  if (isWin) {
    const q = needle.replace(/'/g, "''");
    const r = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('\\','/').ToLower().Contains('${q}'.Replace('\\','/').ToLower()) } | ForEach-Object { $_.ProcessId }`);
    return r.out.split(/\s+/).map((x) => Number.parseInt(x, 10)).filter((x) => x > 0);
  }
  return sh('pgrep', ['-f', needle]).out.split(/\s+/).map((x) => Number.parseInt(x, 10)).filter((x) => x > 0 && x !== process.pid);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function kill(pid: number) {
  if (isWin) sh('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
}

// The instances' tasks restart a task that fails within a minute (register-tasks.ps1: RestartCount 999): a portal or
// daemon this script ends would come back in the middle of npm ci. So their tasks are disabled for the roll and enabled
// again to start. Portals are on Windows only so far (docs/instances.md); a Mac instance's LaunchAgent would need its own.
function task(name: string, verb: 'Disable' | 'Enable' | 'Start') {
  if (!isWin) throw new Error(`update-all runs instance portals on Windows only so far (${verb} ${name})`);
  const r = ps(`${verb}-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' | Out-Null`);
  if (r.code !== 0) throw new Error(`${verb}-ScheduledTask ${name}: ${r.out.trim()}`);
}

export function realDeps(l: InstanceList, logFile: string): Deps {
  const env = { ...process.env, ...(l.nodeDir ? { PATH: `${l.nodeDir}${path.delimiter}${process.env.PATH ?? ''}` } : {}) };
  const npm = (cwd: string, args: string[]) => (isWin ? sh('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], cwd, env) : sh('npm', args, cwd, env));
  const log = (line: string) => {
    const s = `${new Date().toISOString()} ${line}`;
    console.log(s);
    fs.appendFileSync(logFile, s + '\n');
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return {
    now: () => Date.now(),
    async health(url) {
      try {
        const r = await fetch(`${url.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(10_000) });
        const j = (await r.json()) as { sha?: string };
        return typeof j.sha === 'string' && SHA.test(j.sha) ? j.sha : undefined;
      } catch {
        return undefined;
      }
    },
    git: (cwd, args) => sh('git', args, cwd, { ...env, GIT_TERMINAL_PROMPT: '0' }),
    build(app) {
      for (const [what, cwd, args] of [
        ['npm ci', app, ['ci', '--no-audit', '--no-fund']],
        ['npm ci (web)', path.join(app, 'web'), ['ci', '--no-audit', '--no-fund']],
        ['web build', path.join(app, 'web'), ['run', 'build']],
      ] as const) {
        const r = npm(cwd, [...args]);
        if (r.code !== 0) throw new Error(`${what} failed: ${r.out.trim().split('\n').slice(-3).join(' | ')}`);
      }
    },
    async stop(i) {
      const tasks = [i.portalTask, ...(i.daemonInApp && i.daemonTask ? [i.daemonTask] : [])];
      for (const t of tasks) task(t, 'Disable');
      // The portal exits by itself (code 0) after the plain restart.request; wait for it, then end what is left.
      const portal = portPid(i.port);
      for (let t = 0; t < 90 && portal && alive(portal); t++) await sleep(1000);
      const left = [...(portal && alive(portal) ? [portal] : []), ...(i.daemonInApp ? pidsByCommandLine(i.daemonConfig) : [])];
      for (const p of left) {
        log(`${i.name}: ending pid ${p}`);
        kill(p);
      }
      for (let t = 0; t < 30 && left.some(alive); t++) await sleep(1000);
      const still = portPid(i.port);
      if (still) throw new Error(`pid ${still} still listens on :${i.port}`);
    },
    start(i) {
      const tasks = [i.portalTask, ...(i.daemonInApp && i.daemonTask ? [i.daemonTask] : [])];
      for (const t of tasks) task(t, 'Enable');
      for (const t of tasks) task(t, 'Start');
    },
    sleep,
    log,
  };
}

/** The updater's own checkout follows the target first, then runs again from it (--no-self). */
// The updater follows the lead forward only: a lead still on a commit older than the updater's own (one from before
// the updater existed, or a roll-back) leaves the updater where it is, since moving back could take away the script the
// next 5-minute pass runs and stop all updates on this computer for good.
export function followSelf(selfDir: string, short: string, d: Deps, branch: string): boolean {
  const head = d.git(selfDir, ['rev-parse', 'HEAD']).out.trim();
  if (sameCommit(head, short)) return false;
  if (d.git(selfDir, ['fetch', '--quiet', 'origin']).code !== 0) return false;
  const full = d.git(selfDir, ['rev-parse', '--verify', '--quiet', `${short}^{commit}`]).out.trim();
  if (!/^[0-9a-f]{40}$/.test(full) || d.git(selfDir, ['merge-base', '--is-ancestor', full, `origin/${branch}`]).code !== 0) return false;
  if (d.git(selfDir, ['merge-base', '--is-ancestor', head, full]).code !== 0) return false;
  if (d.git(selfDir, ['cat-file', '-e', `${full}:scripts/instance/update-all.ts`]).code !== 0) return false;
  if (d.git(selfDir, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', full]).code !== 0) return false;
  d.log(`updater: its own checkout moved ${head.slice(0, 9)} -> ${full.slice(0, 9)}; running again from it`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const listFile = opt('--list');
  if (!listFile) {
    console.error('usage: node scripts/instance/update-all.ts --list <instances.json> [--only a,b] [--dry-run] [--no-self]');
    process.exit(2);
  }
  const l = readList(listFile);
  // --only a,b: roll just these (a first roll by hand, instance by instance, each when its workers are between turns).
  const only = opt('--only')?.split(',').filter(Boolean);
  if (only) {
    const unknown = only.filter((n) => !l.instances.some((i) => i.name === n));
    if (unknown.length) throw new Error(`--only: not in the list: ${unknown.join(', ')}`);
    l.instances = l.instances.filter((i) => only.includes(i.name));
  }
  const dir = path.dirname(path.resolve(listFile));
  const stateFile = path.join(dir, 'update-all.json');
  const lock = path.join(dir, 'update-all.lock');
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    const holder = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10);
    if (holder > 0 && holder !== process.pid && alive(holder)) return; // another run is rolling
    fs.writeFileSync(lock, String(process.pid));
  }
  const d = realDeps(l, path.join(dir, 'update-all.log'));
  try {
    const state = readState(stateFile);
    const selfDir = l.self ?? path.resolve(import.meta.dirname, '..', '..');
    if (!args.includes('--no-self') && !args.includes('--dry-run')) {
      const lead = await d.health(l.leader.url);
      const short = lead && stableTarget(lead, { ...state }, d.now(), l.leader.stableMinutes ?? DEFAULTS.stableMinutes);
      if (short && followSelf(selfDir, short, d, l.branch ?? DEFAULTS.branch)) {
        fs.rmSync(lock, { force: true });
        const r = spawnSync(process.execPath, [...process.execArgv, path.join(selfDir, 'scripts', 'instance', 'update-all.ts'), ...args, '--no-self'], { stdio: 'inherit' });
        process.exitCode = r.status ?? 1;
        return;
      }
    }
    const r = await tick(l, state, d, { dryRun: args.includes('--dry-run') });
    writeJson(stateFile, state);
    if (r.rolled.length || r.failed) d.log(`pass done: rolled ${r.rolled.join(', ') || 'none'}${r.failed ? `; failed ${r.failed}` : ''}`);
  } finally {
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.rmSync(lock, { force: true });
  }
}

if (import.meta.main) await main();
