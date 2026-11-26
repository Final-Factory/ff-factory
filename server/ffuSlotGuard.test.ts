import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFU_SLOT_HOOKS, readHolderFile, realFfuSlotDeps, releaseSlot, slotCheckout, slotHolderFile, slotWriteRefusal, takeSlot, type FfuSlotDeps } from '../machine/ffuSlots.ts';

/**
 * w6038: a worker's git write in an ffu slot its session does not hold, or on a branch other than the one ffu-slot recorded,
 * is refused by the slot hooks (machine/ffuSlotHooks) that `take` points the shared clone at. w5681's slip: a worker resumed,
 * cd'd into a slot path a saved script named, and made a merge commit on another worker's branch. Real git, a local origin.
 */

const NOW = Date.now();

/** A worker's own git in a slot: no fence, the session in FF_SESSION_ID (undefined: none, as in a person's shell). */
function wgit(cwd: string, session: string | undefined, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.FF_SESSION_ID;
  if (session) env.FF_SESSION_ID = session;
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function must(r: { code: number; err: string }, what: string) {
  assert.equal(r.code, 0, `${what}: ${r.err}`);
}

function world(t: { after: (fn: () => void) => void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6038-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const work = path.join(base, 'src');
  fs.mkdirSync(work);
  const g = (...a: string[]) => must(wgit(work, undefined, ...a), `git ${a.join(' ')}`);
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'Cargo.toml'), '[workspace]\n');
  g('add', '.');
  g('commit', '-qm', 'one');
  g('checkout', '-qb', 'feat');
  fs.writeFileSync(path.join(work, 'feat.rs'), '// feat\n');
  g('add', '.');
  g('commit', '-qm', 'feat');
  g('checkout', '-qb', 'other', 'main');
  fs.writeFileSync(path.join(work, 'other.rs'), '// another worker\n');
  g('add', '.');
  g('commit', '-qm', 'other');
  g('checkout', '-q', 'main');
  const remote = path.join(base, 'origin.git');
  must(wgit(base, undefined, 'clone', '-q', '--bare', work, remote), 'clone');
  const root = path.join(base, 'install');
  fs.mkdirSync(root);
  return { root, remote };
}

function deps(root: string, session: string): FfuSlotDeps {
  const real = realFfuSlotDeps({ FF_WORKER_ROOT: root, FF_SESSION_ID: session });
  return {
    ...real,
    max: 2,
    facts: { at: new Date(NOW).toISOString(), connected: true, root, tempRoot: path.join(root, 'tmp'), sandboxes: [], live: ['aaaa1111', 'bbbb2222'], resumable: [], open: [], closed: [] } as FfuSlotDeps['facts'],
    freeGB: () => 500,
    write: () => {},
    say: () => {},
  };
}

const head = (wt: string) => wgit(wt, undefined, 'rev-parse', 'HEAD').out.trim();

test('w6038: take points the slot at FF Factory hooks and writes the holder file the hooks read', (t) => {
  const { root, remote } = world(t);
  takeSlot(deps(root, 'aaaa1111'), { branch: 'feat', remote });
  const wt = slotCheckout(root, 'slot1');
  assert.equal(wgit(wt, undefined, 'config', '--get', 'core.hooksPath').out.trim(), FFU_SLOT_HOOKS.split(path.sep).join('/'));
  assert.deepEqual(readHolderFile(slotHolderFile(root, 'slot1')), { holder: 'aaaa1111', branch: 'feat' });
  for (const h of ['reference-transaction', 'pre-push', 'pre-rebase']) if (process.platform !== 'win32') assert.ok((fs.statSync(path.join(FFU_SLOT_HOOKS, h)).mode & 0o111) !== 0, `${h} is executable`);
  assert.deepEqual(releaseSlot(deps(root, 'aaaa1111')), ['slot1']);
  assert.deepEqual(readHolderFile(slotHolderFile(root, 'slot1')), { holder: '', branch: 'feat' }, 'a release clears the holder');
});

test("w6038 (w5681's case): session B in the slot session A holds cannot merge, commit, rebase, reset, stash or push; the refusal names the slot, holder and branch", (t) => {
  const { root, remote } = world(t);
  takeSlot(deps(root, 'aaaa1111'), { branch: 'feat', remote });
  const wt = slotCheckout(root, 'slot1');
  const before = head(wt);
  const said = /ffu-slot: refused: .* in ffu slot slot1 \(.*slot1\/ffu\), which session aaaa1111 holds on branch feat; you are session bbbb2222\./;

  const merge = wgit(wt, 'bbbb2222', 'merge', '--no-edit', 'origin/other');
  assert.notEqual(merge.code, 0, 'the merge commit is refused');
  assert.match(merge.err, said);
  assert.equal(head(wt), before, 'feat did not move');
  assert.ok(fs.existsSync(path.join(wt, 'other.rs')), 'the stopped merge left its files, which the message says how to undo');
  must(wgit(wt, 'bbbb2222', 'merge', '--abort'), 'merge --abort'); // abort moves no ref the hook refuses
  assert.ok(!fs.existsSync(path.join(wt, 'other.rs')));

  fs.writeFileSync(path.join(wt, 'b.rs'), '// B\n');
  must(wgit(wt, 'bbbb2222', 'add', 'b.rs'), 'add');
  const commit = wgit(wt, 'bbbb2222', 'commit', '-qm', 'B on A');
  assert.notEqual(commit.code, 0, 'the commit is refused');
  assert.match(commit.err, said);
  assert.notEqual(wgit(wt, 'bbbb2222', 'commit', '--no-verify', '-qm', 'B on A').code, 0, '--no-verify does not skip it');
  assert.equal(head(wt), before);

  assert.equal(wgit(wt, undefined, 'diff', '--cached', '--name-only').out.trim(), 'b.rs', "B's staged file stays for B to take away");
  must(wgit(wt, undefined, 'reset', '-q'), 'unstage');
  fs.rmSync(path.join(wt, 'b.rs'));

  for (const args of [['rebase', 'origin/other'], ['reset', '--soft', 'HEAD~1'], ['reset', '--hard', 'origin/other'], ['push', 'origin', 'HEAD:feat']]) {
    const r = wgit(wt, 'bbbb2222', ...args);
    assert.notEqual(r.code, 0, `git ${args.join(' ')} is refused`);
    assert.match(r.err, said, args.join(' '));
    assert.equal(head(wt), before, `feat did not move on ${args.join(' ')}`);
  }
  // git reset --hard rewrites the files before its ref update, which is all a hook sees: the ref stays, the files are put back.
  assert.ok(fs.existsSync(path.join(wt, 'other.rs')), 'reset --hard: the files moved, the ref did not (no git hook runs before it)');
  must(wgit(wt, 'bbbb2222', 'reset', '-q', '--hard', 'HEAD'), 'reset --hard HEAD (the same commit: let through)');
  fs.writeFileSync(path.join(wt, 'feat.rs'), '// A, not committed\n');
  const stash = wgit(wt, 'bbbb2222', 'stash');
  assert.notEqual(stash.code, 0, 'git stash is refused');
  assert.match(stash.err, said);
  assert.equal(fs.readFileSync(path.join(wt, 'feat.rs'), 'utf8'), '// A, not committed\n', "A's uncommitted edit stays");
  must(wgit(wt, undefined, 'checkout', '-q', '--', 'feat.rs'), 'restore');
  assert.equal(wgit(remote, undefined, 'rev-parse', 'refs/heads/feat').out.trim(), before, 'nothing reached origin');

  // Read-only git and a fetch (remote-tracking refs only) still work for anyone.
  must(wgit(wt, 'bbbb2222', 'status', '--porcelain'), 'status');
  must(wgit(wt, 'bbbb2222', 'fetch', '-q', 'origin'), 'fetch');

  // A released slot is no one's to write in either.
  releaseSlot(deps(root, 'aaaa1111'));
  const released = wgit(wt, 'aaaa1111', 'commit', '-q', '--allow-empty', '-m', 'after release');
  assert.notEqual(released.code, 0);
  assert.match(released.err, /in ffu slot slot1 .*which no session holds \(released; last on branch feat\); you are session aaaa1111/);
});

test('w6038: the holder on a branch ffu-slot did not record for the slot is refused; back on its branch it commits', (t) => {
  const { root, remote } = world(t);
  takeSlot(deps(root, 'aaaa1111'), { branch: 'feat', remote });
  const wt = slotCheckout(root, 'slot1');
  must(wgit(wt, 'aaaa1111', 'switch', '-q', 'other'), 'switch (a symref change, let through)');
  const r = wgit(wt, 'aaaa1111', 'commit', '-q', '--allow-empty', '-m', 'on the wrong branch');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /ffu-slot: refused: .* on branch other in ffu slot slot1 .*: your session aaaa1111 holds this slot for branch feat/);
  assert.match(wgit(wt, 'aaaa1111', 'push', 'origin', 'other').err, /on branch other in ffu slot slot1/);
  must(wgit(wt, 'aaaa1111', 'switch', '-q', 'feat'), 'switch back');
  must(wgit(wt, 'aaaa1111', 'commit', '-q', '--allow-empty', '-m', 'on feat'), 'commit on feat');
});

test('w6038: the normal path is unchanged: take, work, commit, merge, push; a session with no FF_SESSION_ID sees no check; take moves the slot on', (t) => {
  const { root, remote } = world(t);
  takeSlot(deps(root, 'aaaa1111'), { branch: 'feat', remote });
  const wt = slotCheckout(root, 'slot1');
  fs.writeFileSync(path.join(wt, 'a.rs'), '// A\n');
  must(wgit(wt, 'aaaa1111', 'add', 'a.rs'), 'add');
  must(wgit(wt, 'aaaa1111', 'commit', '-qm', 'A on feat'), 'commit');
  must(wgit(wt, 'aaaa1111', 'merge', '-q', '--no-edit', 'origin/other'), 'merge (ff-pr push merges the base in)');
  must(wgit(wt, 'aaaa1111', 'push', '-q', 'origin', 'HEAD:refs/heads/feat'), 'push');
  assert.equal(wgit(remote, undefined, 'rev-parse', 'refs/heads/feat').out.trim(), head(wt));
  // Detached at a branch's tip (another slot has the branch checked out) is the holder's own work: it commits.
  must(wgit(wt, 'aaaa1111', 'checkout', '-q', '--detach'), 'detach');
  must(wgit(wt, 'aaaa1111', 'commit', '-q', '--allow-empty', '-m', 'detached'), 'commit detached');
  must(wgit(wt, 'aaaa1111', 'checkout', '-q', 'feat'), 'back');
  // No session (a person's shell, the daemon): nothing is checked.
  must(wgit(wt, undefined, 'commit', '-q', '--allow-empty', '-m', 'a person'), 'commit with no session');
  must(wgit(wt, undefined, 'push', '-q', 'origin', 'HEAD:refs/heads/feat'), 'push with no session');
  // B takes the slot once A releases it: take's own git (fenced, FF Factory's hooks) switches it, and then B commits there.
  assert.deepEqual(releaseSlot(deps(root, 'aaaa1111')), ['slot1']);
  assert.equal(takeSlot(deps(root, 'bbbb2222'), { branch: 'other', remote }), 'slot1');
  must(wgit(wt, 'bbbb2222', 'commit', '-q', '--allow-empty', '-m', 'B on other'), "B's commit in its own slot");
  assert.match(wgit(wt, 'aaaa1111', 'commit', '-q', '--allow-empty', '-m', 'A came back').err, /which session bbbb2222 holds on branch other; you are session aaaa1111/);
});

test('w6038: slotWriteRefusal (what ff-pr checks) says what the hooks say, and nothing outside a slot', (t) => {
  const { root, remote } = world(t);
  takeSlot(deps(root, 'aaaa1111'), { branch: 'feat', remote });
  const wt = slotCheckout(root, 'slot1');
  assert.equal(slotWriteRefusal(wt, 'aaaa1111', 'ff-pr push'), undefined);
  assert.equal(slotWriteRefusal(path.join(wt, 'crates'), 'aaaa1111', 'ff-pr push'), undefined, 'a folder inside the checkout');
  assert.match(slotWriteRefusal(path.join(wt, 'crates'), 'bbbb2222', 'ff-pr push') ?? '', /^ffu-slot: refused: ff-pr push in ffu slot slot1 .*which session aaaa1111 holds on branch feat; you are session bbbb2222\./);
  assert.equal(slotWriteRefusal(wt, undefined, 'ff-pr push'), undefined, 'no session');
  assert.equal(slotWriteRefusal(root, 'bbbb2222', 'ff-pr push'), undefined, 'not a slot checkout');
  must(wgit(wt, 'aaaa1111', 'switch', '-q', 'other'), 'switch');
  assert.match(slotWriteRefusal(wt, 'aaaa1111', 'ff-pr push') ?? '', /ff-pr push on branch other in ffu slot slot1 .*holds this slot for branch feat/);
});
