// w6237: the guard runs inside the portal on every shell command of every agent, and none of its own git, gh or python
// starts on the portal's event loop: a spawn there holds every page and API call while it starts, 20-50 s on a fully loaded
// BEAST (w6234). They run on the probe thread (server/hostProbe.ts), and checkShellAsync waits for their answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { checkShellAsync, sandboxGuard } from './guard.ts';
import { checkFlakyRerun } from './rerunGuard.ts';

const decide = async (g: ReturnType<typeof sandboxGuard>, command: string, cwd: string) => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd };
  const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return r.hookSpecificOutput ?? { permissionDecision: 'allow' };
};

/**
 * Records every child_process call made on this thread (the portal's loop) while `fn` runs. A worker thread loads its own
 * child_process, so the probe thread's spawns are not seen: what is recorded is exactly what would hold the loop.
 */
async function loopSpawns<T>(fn: () => Promise<T>): Promise<{ value: T; spawns: string[] }> {
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const;
  const mod = cp as unknown as Record<string, (...a: unknown[]) => unknown>;
  const real = new Map(names.map((n) => [n, mod[n]]));
  const spawns: string[] = [];
  for (const n of names) mod[n] = (...a: unknown[]) => (spawns.push(`${n} ${String(a[0])} ${JSON.stringify(a[1] ?? '').slice(0, 80)}`), real.get(n)!(...a));
  syncBuiltinESMExports();
  try {
    return { value: await fn(), spawns };
  } finally {
    for (const n of names) mod[n] = real.get(n)!;
    syncBuiltinESMExports();
  }
}

test('w6237: the recorder sees a spawn made through a named import, as the guard made them before', async () => {
  const { spawns } = await loopSpawns(async () => execFileSync(process.execPath, ['-e', '0']));
  assert.equal(spawns.length, 1, spawns.join('\n'));
  assert.match(spawns[0], /^execFileSync /);
});

test('w6237: a push to a public repo is judged with the real git lookups, and none of them spawns on the loop', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w6237-push-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/Final-Factory/ff-factory.git');
  git('-c', 'user.name=p', '-c', 'user.email=person@gmail.example', 'commit', '-q', '--allow-empty', '-m', 'private email');
  // No remotes, pushedEmails or isPublic given: the guard's own (gitRemotes, gitPushedEmails), as in the portal.
  const g = sandboxGuard({
    sandboxId: 'sb1',
    sandboxPath: dir,
    protectedPaths: [],
    gameRepos: [],
    prBase: () => undefined,
    evidence: () => undefined,
    publicIdentity: { repos: ['https://github.com/Final-Factory/ff-factory'], name: 'Public Name', email: 'bot@users.noreply.github.com' },
  });
  const { value, spawns } = await loopSpawns(() => decide(g, 'git push origin HEAD:feature', dir));
  assert.equal(value.permissionDecision, 'deny', JSON.stringify(value));
  assert.match(value.permissionDecisionReason ?? '', /person@gmail\.example to github\.com\/final-factory\/ff-factory/);
  assert.deepEqual(spawns, [], 'git ran on the probe thread, never on the loop');
});

test('w6237: a rerun is read with the real gh reader, and it spawns nothing on the loop', async () => {
  const { value, spawns } = await loopSpawns(() => checkFlakyRerun('gh run rerun 1 --failed -R Final-Factory/no-such-repo-w6237', { env: { GH_TOKEN: 'not-a-token', GH_HOST: 'github.invalid' } }));
  // gh fails (no such host, or no gh at all): the rerun cannot be checked, and is refused.
  assert.match(value ?? '', /run 1 in Final-Factory\/no-such-repo-w6237 could not be read/);
  assert.deepEqual(spawns, []);
});

test('w6237: checkShellAsync waits for a slow lookup while the loop keeps turning, and asks each lookup once', async () => {
  let worst = 0;
  let last = performance.now();
  const beat = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last - 20);
    last = t;
  }, 20);
  const asked: string[] = [];
  const slow = <T,>(what: string, v: T) => () => (asked.push(what), new Promise<T>((r) => setTimeout(() => r(v), 1500)));
  try {
    const ctx = {
      cwd: 'C:/ffsb/sb1',
      gameRepos: ['https://github.com/example-org/example-game.git'],
      remotes: slow('remotes', new Map([['origin', 'https://github.com/example-org/example-game.git']])),
      prBase: slow('prBase', 'develop'),
      evidence: slow('evidence', undefined),
    };
    const why = await checkShellAsync('gh pr merge 12 --squash', ctx);
    assert.match(why ?? '', /develop/, 'the base read late still refuses a merge into the retired develop');
    assert.ok(asked.filter((a) => a === 'remotes').length === 1, asked.join(' '));
    assert.equal(await checkShellAsync('git push origin HEAD:feature', ctx), undefined);
  } finally {
    clearInterval(beat);
  }
  assert.ok(worst < 100, `the loop was held ${Math.round(worst)} ms`);
});

test('w6237: guard.ts, publicGit.ts and rerunGuard.ts start no synchronous child process', () => {
  for (const f of ['guard.ts', 'publicGit.ts', 'rerunGuard.ts']) {
    const text = fs.readFileSync(path.join(import.meta.dirname, f), 'utf8');
    assert.doesNotMatch(text, /\b(execFileSync|spawnSync|execSync)\b|gitFenceSync|gitExecFileSync|gitSpawnSync/, f);
  }
  const gate = fs.readFileSync(path.join(import.meta.dirname, '..', 'machine', 'evidenceGate.ts'), 'utf8');
  const refresh = gate.slice(gate.indexOf('export async function refreshTrustedCheckout'), gate.indexOf('\n}\n', gate.indexOf('export async function refreshTrustedCheckout')));
  assert.ok(refresh.length > 100, 'found refreshTrustedCheckout');
  assert.doesNotMatch(refresh, /(spawn|exec\w*)Sync\(/, 'the trusted checkout is cloned and fetched off the loop');
});
