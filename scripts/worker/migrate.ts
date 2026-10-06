// FF Factory worker migration (w513; docs/worker-install.md, "Migrating"): move a machine's daemon from today's layout
// (its folder ~/.ff-factory or app_dir, sandboxes worktrees of a person's clone, the Library seed, the player slots and
// the nightly lab wherever they are) into one worker root, copy-first and verified, with rollback until cleanup.
//
//   migrate --root R --dry-run    what would move where, by rename (same volume: instant, undone by renaming back) or by
//                                 copy (another volume: the space it needs), and what stays and why. Changes nothing.
//   migrate --root R              install the root beside the old layout (clone, daemon code), copy the small things,
//                                 copy each sandbox's Claude conversations to its new path, then, with the old daemon
//                                 stopped: move each sandbox into the root and point its git at the root's own clone
//                                 (branches, unpushed commits, staged and unstaged work kept, checked file by file),
//                                 move the seed and the nightly lab, and start the daemon from the root. Every step is
//                                 written to <root>/migration.json first.
//   migrate --root R --rollback   undo it: the sandboxes back where they were with their old git links, the old task or
//                                 LaunchAgent back. Works until cleanup.
//   migrate --root R --cleanup    after the new install has run well: delete the old daemon folder, the old slots and
//                                 their firewall rules, the .git.pre-ffw backups, prune the old clone's worktree entries
//                                 for the moved sandboxes. --legacy also archives ~/ff-worker into the root's scratch and
//                                 removes the old ad-hoc tasks (FF-Build-*, FF-LiveMP-*, ff-worker-leg, ff-detach-test).
//
// The machine keeps its credential (the old daemon.json's token moves to <root>/secrets/machine-token, never printed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { armScriptReimport } from '../../machine/scriptReimport.ts';
import * as win from '../../server/machineDeployWin.ts';
import { LABEL } from '../../server/machineDeploy.ts';
import { Progress, exec, install, layoutOf, readManifest, whoami, type InstallOptions, type Layout } from './worker.ts';

const isWin = process.platform === 'win32';
const say = (line: string) => console.log(line);

// ---------------------------------------------------------------- today's layout

/** One sandbox as the old pool keeps it (machine/sandboxes.ts Rec). */
export interface OldSandbox {
  id: string;
  branch: string;
  base: string;
  path: string;
  createdAt: string;
  status: string;
  statusDetail?: string;
  logPath?: string;
}

export interface OldLayout {
  appDir: string;
  /** The old daemon.json as read (its token is never printed). */
  config: Record<string, unknown>;
  token: string;
  repoPath: string;
  sandboxRoot?: string;
  librarySeed?: string;
  sandboxes: OldSandbox[];
  slotRoot?: string;
  nightlyRoots: string[];
}

/**
 * The old layout: the daemon folder (--from, else the default one in the home folder) and what its daemon.json names.
 * The player slots and the nightly lab are only what the runbook names for the machine (--old-slots, --nightly): never
 * guessed, so a run can never take a folder that belongs to something else.
 */
export function discoverOld(fromAppDir?: string, o: { slots?: string; nightly?: string[] } = {}, home = os.homedir()): OldLayout {
  const appDir = path.resolve(fromAppDir ?? path.join(home, '.ff-factory'));
  const file = path.join(appDir, 'daemon.json');
  if (!fs.existsSync(file)) throw new Error(`no daemon.json in ${appDir}: pass --from <the old daemon folder>`);
  const text = fs.readFileSync(file, 'utf8');
  const config = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
  if (config.root) throw new Error(`${appDir} already belongs to the worker root ${config.root}`);
  const pool = (config.sandboxes ?? {}) as { root?: string; librarySeed?: string };
  let sandboxes: OldSandbox[] = [];
  try {
    sandboxes = JSON.parse(fs.readFileSync(path.join(appDir, 'sandboxes.json'), 'utf8')) as OldSandbox[];
  } catch {
    // no pool
  }
  const slotRoot = o.slots && fs.existsSync(o.slots) ? path.resolve(o.slots) : undefined;
  const nightly = (o.nightly ?? []).filter((d) => fs.existsSync(d)).map((d) => path.resolve(d));
  return {
    appDir,
    config,
    token: String(config.token ?? ''),
    repoPath: String(config.repoPath ?? ''),
    sandboxRoot: pool.root,
    librarySeed: pool.librarySeed,
    sandboxes,
    slotRoot,
    nightlyRoots: [...new Set(nightly)],
  };
}

// ---------------------------------------------------------------- the plan

export type Method = 'rename' | 'copy' | 'rehome' | 'claude' | 'leave';

export interface Item {
  what: string;
  from: string;
  to?: string;
  method: Method;
  /** Bytes a copy needs (renames need none); undefined when not measured. */
  bytes?: number;
  note?: string;
}

/** Whether two paths are on the same volume (a rename between them is instant). Exported for tests. */
export function sameVolume(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return path.win32.parse(path.win32.resolve(a)).root.toLowerCase() === path.win32.parse(path.win32.resolve(b)).root.toLowerCase();
  const dev = (p: string) => {
    let d = p;
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    return fs.statSync(d).dev;
  };
  return dev(a) === dev(b);
}

/** Claude Code's project folder name for a working folder: every character but a letter or digit becomes "-". Exported for tests. */
export const claudeSlug = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-');

/** Size of a folder tree (files only, junctions and symlinks not followed). */
export function treeBytes(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) n += fs.statSync(p).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

/** What moves where. Pure but for the volume and size probes. Exported for tests. */
export function plan(old: OldLayout, l: Layout, o: { claudeDir?: string; measure?: boolean } = {}): Item[] {
  const items: Item[] = [];
  const how = (from: string, to: string): Method => (sameVolume(from, to) ? 'rename' : 'copy');
  const sized = (from: string, m: Method) => (m === 'copy' && o.measure !== false ? treeBytes(from) : undefined);
  for (const f of ['sandboxes.json', 'cleanup.json', 'cleanup-state.json', 'cleanup-log.jsonl', 'outside-watch.json']) {
    const from = path.join(old.appDir, f);
    if (fs.existsSync(from)) items.push({ what: `daemon state ${f}`, from, to: path.join(l.daemon, f), method: 'copy', bytes: fs.statSync(from).size, note: f === 'sandboxes.json' ? 'paths rewritten to the root' : undefined });
  }
  for (const d of ['agents', 'logs']) {
    const from = path.join(old.appDir, d);
    if (fs.existsSync(from)) items.push({ what: `daemon ${d}/`, from, to: path.join(l.daemon, d === 'logs' ? path.join('logs', 'before-migration') : d), method: 'copy', bytes: o.measure === false ? undefined : treeBytes(from) });
  }
  items.push({ what: 'the machine credential (old daemon.json token)', from: path.join(old.appDir, 'daemon.json'), to: l.token, method: 'copy', note: 'never printed' });
  const claude = o.claudeDir ?? path.join(os.homedir(), '.claude', 'projects');
  for (const sb of old.sandboxes) {
    const to = path.join(l.sandboxes, sb.id);
    const m = how(sb.path, to);
    items.push({ what: `sandbox ${sb.id} (${sb.branch})`, from: sb.path, to, method: m === 'rename' ? 'rehome' : 'copy', bytes: sized(sb.path, m), note: m === 'rename' ? 'renamed in place; its git re-pointed at the root clone' : 'another volume: copied whole (Library included), then re-pointed' });
    const cFrom = path.join(claude, claudeSlug(sb.path));
    if (fs.existsSync(cFrom)) items.push({ what: `Claude conversations of ${sb.id}`, from: cFrom, to: path.join(claude, claudeSlug(to)), method: 'claude', bytes: o.measure === false ? undefined : treeBytes(cFrom), note: 'copied, so its agents resume at the new path' });
  }
  if (old.librarySeed && fs.existsSync(old.librarySeed)) {
    const to = path.join(l.seed, 'Library');
    const m = how(old.librarySeed, to);
    items.push({ what: 'Library seed', from: old.librarySeed, to, method: m, bytes: sized(old.librarySeed, m) });
  }
  for (const n of old.nightlyRoots) {
    const m = how(n, l.nightly);
    items.push({ what: 'nightly lab', from: n, to: l.nightly, method: m, bytes: sized(n, m), note: 'FF_NIGHTLY_ROOT points here for agents and scripts the daemon starts' });
  }
  if (old.slotRoot) items.push({ what: 'player slots', from: old.slotRoot, method: 'leave', note: `rebuilt empty in ${l.players} (builds are mirrored in on demand); the old ones and their firewall rules go at cleanup` });
  items.push({ what: 'the old clone', from: old.repoPath, method: 'leave', note: 'a person\'s own clone: untouched; its worktree entries for the moved sandboxes are pruned at cleanup' });
  return items;
}

const gb = (b?: number) => (b === undefined ? '?' : `${(b / 1e9).toFixed(1)} GB`);

export function printPlan(items: Item[], l: Layout) {
  say(`Migration plan into ${l.root}:`);
  for (const i of items) say(`- ${i.method.padEnd(6)} ${i.what}: ${i.from}${i.to ? ` -> ${i.to}` : ''}${i.method === 'copy' || i.method === 'claude' ? ` (${gb(i.bytes)})` : ''}${i.note ? `; ${i.note}` : ''}`);
  const need = items.filter((i) => i.method === 'copy' || i.method === 'claude').reduce((s, i) => s + (i.bytes ?? 0), 0);
  say(`Space the copies need: ${gb(need)} (renames need none). The root's own clone needs about 11 GB more.`);
}

// ---------------------------------------------------------------- copying, with live progress and a check

interface Copied {
  files: number;
  bytes: number;
}

/** Copy a tree file by file (junctions and symlinks recreated as links, never followed), with a progress line. */
export async function copyTree(from: string, to: string, label: string, p = new Progress()): Promise<Copied> {
  const done: Copied = { files: 0, bytes: 0 };
  const walk = (s: string, d: string) => {
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink()) {
      fs.rmSync(d, { force: true, recursive: true });
      fs.symlinkSync(fs.readlinkSync(s), d, isWin ? 'junction' : undefined);
      return;
    }
    if (st.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      for (const e of fs.readdirSync(s)) walk(path.join(s, e), path.join(d, e));
      return;
    }
    // A file unchanged since an earlier pass (same size and time) is not copied again.
    const prev = fs.existsSync(d) ? fs.statSync(d) : undefined;
    if (!prev || prev.size !== st.size || Math.abs(prev.mtimeMs - st.mtimeMs) > 2000) {
      fs.copyFileSync(s, d);
      fs.utimesSync(d, st.atime, st.mtime);
    }
    done.files++;
    done.bytes += st.size;
    if (done.files % 200 === 0) p.update(`${label}: ${done.files} files, ${gb(done.bytes)}`);
  };
  walk(from, to);
  p.done();
  return done;
}

/** Compare two trees: file count, sizes, and a SHA-256 of every file under 1 MB ("hashes where cheap"). */
export function verifyTree(from: string, to: string): string[] {
  const bad: string[] = [];
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const walk = (s: string, d: string) => {
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(s)) walk(path.join(s, e), path.join(d, e));
      return;
    }
    if (!fs.existsSync(d)) return void bad.push(`missing ${d}`);
    const ds = fs.statSync(d);
    if (ds.size !== st.size) bad.push(`size differs: ${d}`);
    else if (st.size < 1 << 20 && sha(s) !== sha(d)) bad.push(`content differs: ${d}`);
  };
  walk(from, to);
  return bad;
}

// ---------------------------------------------------------------- the journal (rollback reads it)

export interface Journal {
  from: string;
  /** The old clone (its worktree entries are pruned at cleanup) and the old slot root (deleted then). */
  oldRepo?: string;
  oldSlotRoot?: string;
  startedAt: string;
  state: 'prepared' | 'switched' | 'cleaned' | 'rolled-back';
  /** Sandboxes moved: their old path, the new one, and the old .git file kept beside it. */
  moved: { id: string; from: string; to: string; method: 'rename' | 'copy' }[];
  renamed: { from: string; to: string }[];
  oldService?: { kind: 'task' | 'launchagent'; name: string; saved: string };
}

const journalFile = (l: Layout) => path.join(l.root, 'migration.json');
function writeJournal(l: Layout, j: Journal) {
  fs.writeFileSync(journalFile(l) + '.tmp', JSON.stringify(j, null, 2));
  fs.renameSync(journalFile(l) + '.tmp', journalFile(l));
}
const readJournal = (l: Layout): Journal | undefined => {
  try {
    return JSON.parse(fs.readFileSync(journalFile(l), 'utf8')) as Journal;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- moving one sandbox's git to the root's clone

async function git(dir: string, args: string[], input?: string) {
  const r = await exec('git', ['-C', dir, ...args], { input });
  if (r.code !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} in ${dir} failed: ${(r.stderr || r.stdout).trim().slice(-400)}`);
  return r.stdout;
}

/** What a worktree holds that must survive the move: its HEAD, branch, status and both diffs. */
async function snapshot(dir: string) {
  return {
    head: (await git(dir, ['rev-parse', 'HEAD'])).trim(),
    branch: (await exec('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim(),
    status: (await git(dir, ['status', '--porcelain=v1', '--untracked-files=all'])).split('\n').filter(Boolean).sort(),
    staged: await git(dir, ['diff', '--cached', '--binary']),
    unstaged: await git(dir, ['diff', '--binary']),
  };
}

/**
 * Point a moved worktree at the root's bare clone: bring its branch and commits over (unpushed ones too), make an
 * admin entry for it there, swap its .git file (the old one kept as .git.pre-ffw), rebuild its index from HEAD and
 * put the staged part back. Then compare status and both diffs with `before`; any difference throws.
 */
export async function rehome(dir: string, id: string, l: Layout, before: Awaited<ReturnType<typeof snapshot>>, oldGitFile: string) {
  const ref = before.branch || `refs/ffw/${id}`;
  // An entry an earlier, rolled-back run left in the root's clone would hold the branch, or push this one's name to
  // "<id>1": this sandbox's own entry is made again below, so any old one goes first (only in the root's clone).
  fs.rmSync(path.join(l.repo, 'worktrees', id), { recursive: true, force: true });
  await git(l.repo, ['worktree', 'prune']);
  await git(l.repo, ['fetch', '--no-tags', '--quiet', dir, `+${before.head}:refs/heads/${ref.replace(/^refs\/heads\//, '')}`]);
  const tmp = path.join(l.sandboxes, '.ffw-rehome', id);
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  await git(l.repo, ['worktree', 'add', '--no-checkout', '--force', tmp, before.branch || before.head]);
  const newGit = fs.readFileSync(path.join(tmp, '.git'), 'utf8');
  fs.writeFileSync(oldGitFile.replace(/\.git$/, '.git.pre-ffw'), fs.readFileSync(oldGitFile));
  // Git marks a worktree's .git file hidden, and Windows refuses to open a hidden file for writing: replace it.
  fs.rmSync(oldGitFile, { force: true });
  fs.writeFileSync(oldGitFile, newGit);
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  await git(l.repo, ['worktree', 'repair', dir]);
  // The old .git file kept beside it (for a rollback) is no one's work: never untracked noise in status or a commit.
  const exclude = path.join(l.repo, 'info', 'exclude');
  const ex = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!ex.split(/\r?\n/).includes('/.git.pre-ffw')) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${ex && !ex.endsWith('\n') ? '\n' : ''}# FF Factory: a migrated sandbox's old git link, kept until cleanup (scripts/worker/migrate.ts)\n/.git.pre-ffw\n`);
  }
  await git(dir, ['reset', '--quiet', '--mixed', 'HEAD']);
  if (before.staged) await git(dir, ['apply', '--cached', '--binary', '--whitespace=nowarn'], before.staged);
  const after = await snapshot(dir);
  const same = after.head === before.head && after.branch === before.branch && after.staged === before.staged && after.unstaged === before.unstaged && after.status.join('\n') === before.status.join('\n');
  if (!same) throw new Error(`sandbox ${id}: after the move its git state differs (status ${before.status.length} -> ${after.status.length} lines); rolled back`);
  // The project moved: its Library's script mappings name the old path. The first editor start reimports the scripts.
  armScriptReimport(dir, l.repo);
}

// ---------------------------------------------------------------- the old service

async function saveOldService(l: Layout, task: string): Promise<Journal['oldService']> {
  const dir = path.join(l.root, 'migration');
  fs.mkdirSync(dir, { recursive: true });
  if (isWin) {
    const saved = path.join(dir, `${task}.xml`);
    const r = await win.psScript(win.LOCAL, `$t = Get-ScheduledTask -TaskName ${win.psq(task)} -ErrorAction SilentlyContinue\nif ($t) { Export-ScheduledTask -TaskName ${win.psq(task)} }\n`, { timeoutMs: 60_000 });
    if (!r.stdout.trim()) return undefined;
    fs.writeFileSync(saved, r.stdout, 'utf8');
    return { kind: 'task', name: task, saved };
  }
  const plistFile = path.join(os.homedir(), 'Library', 'LaunchAgents', `${task}.plist`);
  if (!fs.existsSync(plistFile)) return undefined;
  const saved = path.join(dir, `${task}.plist`);
  fs.copyFileSync(plistFile, saved);
  return { kind: 'launchagent', name: task, saved };
}

async function restoreOldService(s: NonNullable<Journal['oldService']>) {
  if (s.kind === 'task') {
    const r = await win.psScript(win.LOCAL, `$x = Get-Content -Raw -LiteralPath ${win.psq(s.saved)}\nRegister-ScheduledTask -TaskName ${win.psq(s.name)} -Xml $x -Force | Out-Null\nStart-ScheduledTask -TaskName ${win.psq(s.name)}\n'ok'\n`, { timeoutMs: 60_000 });
    if (!/ok/.test(r.stdout)) throw new Error(`restoring the ${s.name} task failed: ${win.failureDetail(r)}; register it from ${s.saved} by hand`);
    return;
  }
  const plistFile = path.join(os.homedir(), 'Library', 'LaunchAgents', `${s.name}.plist`);
  fs.copyFileSync(s.saved, plistFile);
  await exec('bash', ['-c', `launchctl bootout gui/$(id -u)/${s.name} 2>/dev/null; launchctl bootstrap gui/$(id -u) "${plistFile}"`]);
}

/** Stop the old daemon (its task or LaunchAgent, and only what runs from its own folder). */
async function stopOld(old: OldLayout, service: string) {
  if (isWin) await win.psScript(win.LOCAL, win.controlScript('stop', old.appDir, { task: service, only: true }), { timeoutMs: 3 * 60_000 });
  else await exec('bash', ['-c', `launchctl bootout gui/$(id -u)/${service} 2>/dev/null || true`]);
}

// ---------------------------------------------------------------- the commands

export interface MigrateOptions {
  from?: string;
  /** The old daemon's task (Windows) or LaunchAgent label (Mac); default the standard one. */
  fromService?: string;
  oldSlots?: string;
  nightly?: string[];
  dryRun: boolean;
  /** The installer's options for the new root (worker.ts install); the credential and the old settings come from the old daemon.json. */
  install: Omit<InstallOptions, 'token' | 'carry' | 'replacesService' | 'portalUrl'> & { portalUrl?: string };
}

export async function migrate(o: MigrateOptions) {
  const l = layoutOf(path.resolve(o.install.root));
  const old = discoverOld(o.from, { slots: o.oldSlots, nightly: o.nightly });
  const fromService = o.fromService ?? (isWin ? win.TASK_NAME : LABEL);
  if (!old.token) throw new Error(`the old daemon.json in ${old.appDir} has no token: this tool moves a working daemon`);
  const portalUrl = (o.install.portalUrl ?? String(old.config.portalUrl ?? '')).replace(/\/+$/, '');
  const io: InstallOptions = { ...o.install, portalUrl, token: old.token, carry: old.config, replacesService: true };
  const items = plan(old, l);
  printPlan(items, l);
  if (o.dryRun) return say('\nDry run: nothing changed.');

  // 1. Before anything stops: the root installed beside the old layout (it refuses here if a prerequisite is missing).
  if (readJournal(l)?.state === 'switched') throw new Error(`${l.root} was migrated already (migration.json); --rollback or --cleanup`);
  const j: Journal = { from: old.appDir, oldRepo: old.repoPath, oldSlotRoot: old.slotRoot, startedAt: new Date().toISOString(), state: 'prepared', moved: [], renamed: [] };
  const busy = old.sandboxes.filter((sb) => fs.existsSync(path.join(sb.path, 'Temp', 'UnityLockfile')));
  if (busy.length) throw new Error(`stop these sandboxes' Unity editors first (unity stop): ${busy.map((b) => b.id).join(', ')}`);
  j.oldService = await saveOldService(l, fromService).catch(() => undefined);
  fs.mkdirSync(l.root, { recursive: true });
  writeJournal(l, j);
  // The root's clone and the installer's checkout while the old daemon still runs (every prerequisite checked first).
  if (!(await install(io, undefined, 'prepare'))) {
    fs.rmSync(journalFile(l), { force: true });
    throw new Error('the install into the root could not start (see above); nothing of the old layout was touched');
  }

  // 2. Copy pass one while the old daemon still runs: daemon state and Claude conversations.
  const p = new Progress();
  for (const i of items.filter((x) => (x.method === 'copy' || x.method === 'claude') && !x.what.startsWith('sandbox ') && x.to && !x.what.startsWith('the machine credential'))) {
    if (fs.statSync(i.from).isDirectory()) await copyTree(i.from, i.to!, i.what, p);
    else {
      fs.mkdirSync(path.dirname(i.to!), { recursive: true });
      fs.copyFileSync(i.from, i.to!);
    }
  }

  // 3. The old daemon stops, once no agent there is mid-turn (the portal says), then the moves.
  const w = await whoami(portalUrl, old.token);
  if (!w.ok) throw new Error(`asking the portal which agents run there failed: ${w.error}`);
  const busy2 = w.me.agents.filter((a) => a.midTurn);
  if (busy2.length) throw new Error(`agents are mid-turn there: ${busy2.map((a) => `${a.title} (${a.id})`).join(', ')}; run again once they are idle (the root is ready; nothing moved yet)`);
  say('Stopping the old daemon...');
  await stopOld(old, fromService);
  try {
    for (const sb of old.sandboxes) {
      if (!fs.existsSync(sb.path)) continue;
      const to = path.join(l.sandboxes, sb.id);
      const before = await snapshot(sb.path);
      fs.mkdirSync(l.sandboxes, { recursive: true });
      const item = items.find((i) => i.from === sb.path)!;
      if (item.method === 'rehome') fs.renameSync(sb.path, to);
      else await copyTree(sb.path, to, `sandbox ${sb.id}`, p);
      j.moved.push({ id: sb.id, from: sb.path, to, method: item.method === 'rehome' ? 'rename' : 'copy' });
      writeJournal(l, j);
      await rehome(to, sb.id, l, before, path.join(to, '.git'));
      say(`Sandbox ${sb.id}: moved, git now in the root's clone (${before.status.length} changed file(s) kept).`);
    }
    for (const i of items.filter((x) => (x.what === 'Library seed' || x.what === 'nightly lab') && x.to)) {
      if (fs.existsSync(i.to!) && fs.readdirSync(i.to!).length) throw new Error(`${i.to} is not empty`);
      fs.rmSync(i.to!, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(i.to!), { recursive: true });
      if (i.method === 'rename') {
        fs.renameSync(i.from, i.to!);
        j.renamed.push({ from: i.from, to: i.to! });
      } else await copyTree(i.from, i.to!, i.what, p);
      writeJournal(l, j);
    }
    // Copy pass two: what changed in the daemon's state while it ran, then the check.
    for (const i of items.filter((x) => x.method === 'copy' && x.what.startsWith('daemon '))) {
      if (fs.statSync(i.from).isDirectory()) {
        await copyTree(i.from, i.to!, i.what, p);
        const bad = verifyTree(i.from, i.to!);
        if (bad.length) throw new Error(`${i.what} did not copy right: ${bad.slice(0, 5).join('; ')}`);
      } else fs.copyFileSync(i.from, i.to!);
    }
    // The pool's own record, with the new paths.
    const recs = old.sandboxes.map((sb) => ({ ...sb, path: path.join(l.sandboxes, sb.id), ...(sb.logPath ? { logPath: path.join(l.sandboxes, sb.id, path.relative(sb.path, sb.logPath)) } : {}) }));
    fs.writeFileSync(path.join(l.daemon, 'sandboxes.json'), JSON.stringify(recs, null, 2));
    // 4. The daemon from the root, with the machine's own credential and its old settings (worker.ts install).
    if (!(await install(io, undefined, 'finish'))) throw new Error('the daemon from the root did not come up');
    j.state = 'switched';
    writeJournal(l, j);
    say(`\nMigrated. The old layout stays until: migrate --root "${l.root}" --cleanup (after the new install has run well). Undo: --rollback.`);
  } catch (e) {
    say(`\nThe migration stopped: ${(e as Error).message}\nRolling back...`);
    await rollback(l.root);
    throw e;
  }
}

export async function rollback(root: string) {
  const l = layoutOf(path.resolve(root));
  const j = readJournal(l);
  if (!j) throw new Error(`no migration.json in ${l.root}: nothing to roll back`);
  if (j.state === 'cleaned') throw new Error('the old layout was cleaned up already: a rollback is no longer possible');
  const m = readManifest(l.root);
  if (m && isWin) await win.psScript(win.LOCAL, win.uninstallScript(l.daemon, { task: m.service, only: true }), { timeoutMs: 3 * 60_000 });
  for (const mv of [...j.moved].reverse()) {
    const pre = path.join(mv.to, '.git.pre-ffw');
    if (fs.existsSync(pre)) {
      fs.rmSync(path.join(mv.to, '.git'), { force: true });
      fs.renameSync(pre, path.join(mv.to, '.git'));
    }
    if (mv.method === 'rename' && fs.existsSync(mv.to) && !fs.existsSync(mv.from)) fs.renameSync(mv.to, mv.from);
    say(`Sandbox ${mv.id}: back at ${mv.from}.`);
  }
  for (const r of [...j.renamed].reverse()) if (fs.existsSync(r.to) && !fs.existsSync(r.from)) fs.renameSync(r.to, r.from);
  // The root's clone forgets the worktrees that went back.
  if (fs.existsSync(path.join(l.repo, 'HEAD'))) await exec('git', ['-C', l.repo, 'worktree', 'prune']);
  if (j.oldService) await restoreOldService(j.oldService);
  j.state = 'rolled-back';
  writeJournal(l, j);
  say(`Rolled back: the old daemon runs from ${j.from} again. The root ${l.root} can be uninstalled (--keep-registration: the machine's record is the old daemon's).`);
}

export interface CleanupOptions {
  root: string;
  legacy: boolean;
}

/** The ad-hoc tasks of earlier lab runs (BEAST, docs/worker-root.md 1.8). */
export const LEGACY_TASKS = /^(FF-Build-.*|FF-LiveMP-.*|ff-worker-leg|ff-detach-test)$/;

export async function cleanup(o: CleanupOptions) {
  const l = layoutOf(path.resolve(o.root));
  const j = readJournal(l);
  if (!j || j.state !== 'switched') throw new Error(`${l.root} has no finished migration to clean up after (migration.json state: ${j?.state ?? 'none'})`);
  const old = { repoPath: j.oldRepo, slotRoot: j.oldSlotRoot };
  // The new install must be up: its daemon connected with its root.
  const token = fs.readFileSync(l.token, 'utf8').trim();
  const w = await whoami(readManifest(l.root)!.portalUrl, token);
  if (!w.ok || !w.me.online || w.me.root?.toLowerCase() !== l.root.toLowerCase()) throw new Error(`the new install is not confirmed working (${w.ok ? `online ${w.me.online}, root ${w.me.root}` : w.error}); not cleaning up`);
  for (const mv of j.moved) {
    fs.rmSync(path.join(mv.to, '.git.pre-ffw'), { force: true });
    if (mv.method === 'copy') fs.rmSync(mv.from, { recursive: true, force: true });
  }
  if (old.repoPath && fs.existsSync(old.repoPath)) {
    await exec('git', ['-C', old.repoPath, 'worktree', 'prune']);
    say(`Pruned the worktree entries of moved sandboxes in ${old.repoPath}.`);
  }
  fs.rmSync(j.from, { recursive: true, force: true });
  say(`Deleted the old daemon folder ${j.from}.`);
  if (old.slotRoot && path.resolve(old.slotRoot).toLowerCase() !== l.players.toLowerCase() && fs.existsSync(old.slotRoot)) {
    fs.rmSync(old.slotRoot, { recursive: true, force: true });
    say(`Deleted the old player slots ${old.slotRoot} (the install's firewall step replaced their rules).`);
  }
  if (o.legacy) await legacy(l);
  j.state = 'cleaned';
  writeJournal(l, j);
  say('Cleanup done.');
}

/** ~/ff-worker archived into the root's scratch (a rename on the same volume, else a copy), the old ad-hoc tasks removed. */
async function legacy(l: Layout) {
  const ffw = path.join(os.homedir(), 'ff-worker');
  if (fs.existsSync(ffw)) {
    const to = path.join(l.scratch, 'legacy', 'ff-worker');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (sameVolume(ffw, to)) fs.renameSync(ffw, to);
    else {
      await copyTree(ffw, to, 'archiving ~/ff-worker');
      const bad = verifyTree(ffw, to);
      if (bad.length) throw new Error(`archiving ~/ff-worker failed: ${bad.slice(0, 5).join('; ')}`);
      fs.rmSync(ffw, { recursive: true, force: true });
    }
    say(`Archived ~/ff-worker into ${to}.`);
  }
  if (!isWin) return;
  const list = await win.psScript(win.LOCAL, `Get-ScheduledTask | Where-Object { $_.TaskPath -eq '\\' } | ForEach-Object { $_.TaskName }\n`, { timeoutMs: 60_000 });
  for (const name of list.stdout.split('\n').map((s) => s.trim()).filter((s) => LEGACY_TASKS.test(s))) {
    const dir = path.join(l.scratch, 'legacy', 'tasks');
    fs.mkdirSync(dir, { recursive: true });
    const r = await win.psScript(win.LOCAL, `Export-ScheduledTask -TaskName ${win.psq(name)} | Set-Content -Encoding Unicode -LiteralPath ${win.psq(path.join(dir, `${name}.xml`))}\nUnregister-ScheduledTask -TaskName ${win.psq(name)} -Confirm:$false\n'ok'\n`, { timeoutMs: 60_000 });
    say(/ok/.test(r.stdout) ? `Removed the old task ${name} (saved in ${dir}).` : `Could not remove the old task ${name} (it may need an administrator): Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error('Run the migration through worker.ts: node scripts/worker/worker.ts migrate --root <root> [--dry-run|--rollback|--cleanup]');
  process.exitCode = 2;
}
