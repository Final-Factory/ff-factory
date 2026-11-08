import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCleanup, unpushedWorkWhy, type CleanupGuard } from './cleanup.ts';
import { installLeftoverSettings, planInstallLeftovers, type ProcLite } from './installLeftovers.ts';

/**
 * w3656: LothDesktop's V:\ffw\tmp reached 166 GB. A worker whose requests had all closed kept its folder for 7 days (the
 * w1575 reopen hold), its clones for a day after that, and a clone with one uncommitted change or an unreadable git
 * forever; and an ordinary hourly pass looked at none of it. Now the folder of a stopped worker whose requests all closed
 * goes whole on any pass once untouched for closedSessionMinutes, unless a live session or a process uses it; only a clone
 * with commits on no remote or a stash stays.
 */

const MIN = 60_000;
const settings = installLeftoverSettings({});

function world(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-closed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const temp = path.join(root, 'tmp');
  fs.mkdirSync(temp, { recursive: true });
  const guard: CleanupGuard = { keep: [path.join(root, 'repo')], inUse: [], home: path.join(root, 'home'), resumable: [] };
  /** A worker folder holding a clone (a .git folder) and scratch, last written `ageMin` minutes ago. */
  const session = (id: string, ageMin: number) => {
    const dir = path.join(temp, `ffa-${id}`);
    const clone = path.join(dir, 'clone-w3554');
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    fs.mkdirSync(path.join(clone, 'Library', 'Artifacts'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'Library', 'Artifacts', 'big'), 'x');
    fs.writeFileSync(path.join(dir, 'leg.sh'), 'x');
    age(dir, ageMin);
    return { dir, clone };
  };
  const age = (p: string, ageMin: number) => {
    const at = (Date.now() - ageMin * MIN) / 1000;
    const walk = (q: string) => {
      if (fs.statSync(q).isDirectory()) for (const n of fs.readdirSync(q)) walk(path.join(q, n));
      fs.utimesSync(q, at, at);
    };
    walk(p);
  };
  const plan = (o: { closed: string[]; procs?: ProcLite[]; inUse?: string[]; unpushedWork?: (d: string) => Promise<boolean>; scope?: 'cargo-cap' }) =>
    planInstallLeftovers({
      root,
      sandboxes: [],
      tempRoots: [temp],
      guard: { ...guard, inUse: o.inUse ?? [] },
      procs: 'procs' in o ? o.procs : [],
      settings,
      self: [1],
      // An uncommitted change, as clone-3286 held: it must not keep a closed worker's folder.
      localWork: async () => true,
      unpushedWork: o.unpushedWork ?? (async () => false),
      closed: o.closed,
      scope: o.scope,
    });
  return { root, temp, guard, session, plan };
}

test('w3656: a closed worker\'s whole folder goes on the hourly pass, clone and Library included, though its clone has an uncommitted change', async (t) => {
  const { guard, session, plan } = world(t);
  const { dir } = session('4820f4e1', 45);
  for (const scope of ['cargo-cap', undefined] as const) {
    const p = await plan({ closed: [dir], scope });
    assert.deepEqual(p.items.map((i) => [i.path, i.rule]), [[dir, 'closed-session-temp']], `scope ${scope ?? 'all'}`);
  }
  const p = await plan({ closed: [dir], scope: 'cargo-cap' });
  await runCleanup(p.items, guard);
  assert.ok(!fs.existsSync(dir), 'the folder is gone');
});

test('w3656: a clone with commits on no remote or a stash stays, listed; the rest of the closed worker\'s folder goes', async (t) => {
  const { session, plan } = world(t);
  const { dir, clone } = session('6b25d859', 45);
  const p = await plan({ closed: [dir], scope: 'cargo-cap', unpushedWork: async (d) => d === clone });
  assert.ok(!p.items.some((i) => i.path === dir || i.path.startsWith(clone)), 'neither the folder nor the clone goes');
  assert.deepEqual(p.items.map((i) => i.path), [path.join(dir, 'leg.sh')]);
  assert.ok(p.listed.some((l) => l.path === clone && /commits on no remote or a stash/.test(l.why)), 'the clone is listed for a person');
});

test('w3656: a closed worker\'s folder stays while it was written lately, a process names it, its session runs, the process list is unknown, or it is not closed', async (t) => {
  const { session, plan } = world(t);
  const fresh = session('aaaa0001', 5);
  assert.equal((await plan({ closed: [fresh.dir], scope: 'cargo-cap' })).items.length, 0, 'written 5 min ago');
  const { dir } = session('bbbb0002', 45);
  const holder: ProcLite = { pid: 42, ppid: 1, cmd: `cargo build --target-dir ${path.join(dir, 'target')}` } as ProcLite;
  assert.equal((await plan({ closed: [dir], procs: [holder], scope: 'cargo-cap' })).items.length, 0, 'a process names it');
  assert.equal((await plan({ closed: [dir], inUse: [dir], scope: 'cargo-cap' })).items.length, 0, 'its session runs');
  assert.equal((await plan({ closed: [dir], procs: undefined, scope: 'cargo-cap' })).items.length, 0, 'the process list could not be read');
  assert.equal((await plan({ closed: [], scope: 'cargo-cap' })).items.length, 0, 'not judged closed: the hourly pass leaves it');
});

function git(cwd: string, ...a: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('w3656: unpushedWorkWhy counts commits on no remote and stashes, not uncommitted changes or an unreadable git', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-unpushed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const bare = path.join(root, 'r.git');
  git(root, 'init', '-q', '--bare', bare);
  const dir = path.join(root, 'clone');
  git(root, 'clone', '-q', bare, dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  git(dir, 'push', '-q', 'origin', 'HEAD');
  assert.equal(await unpushedWorkWhy(dir), undefined, 'pushed and clean');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  assert.equal(await unpushedWorkWhy(dir), undefined, 'uncommitted changes do not count');
  git(dir, 'stash', 'push', '-q');
  assert.match((await unpushedWorkWhy(dir))!, /1 stash/);
  git(dir, 'stash', 'drop', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'two');
  assert.match((await unpushedWorkWhy(dir))!, /1 commit on no remote/);
  const broken = path.join(root, 'broken');
  fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
  assert.equal(await unpushedWorkWhy(broken), undefined, 'a git that cannot read it shows no work');
});
