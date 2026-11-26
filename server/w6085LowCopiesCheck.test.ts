import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Daemon, type Probes } from '../machine/daemon.ts';
import type { LowEditorFence } from '../machine/unity.ts';

/**
 * w6085 (item 6 of the w5838 reviews): every start of a Low claude or a Low editor runs `LowCopies.check` first and starts
 * what it answers, never the path it was handed. Every agent's spawn takes its spec from runSpec (daemon.ts: the hosted
 * spec and buildOptions), and every sandbox editor's start asks the pool's fence getter, `() => this.editorFence()`
 * (unity.ts `this.fence?.()` in start), so these two are the points before each spawn.
 */

const PROBES: Probes = {
  stats: async () => ({}) as Awaited<ReturnType<Probes['stats']>>,
  usage: async () => ({ account: { email: 'someone@example.com', plan: 'Claude Max' }, reply: { subscription_type: 'max', rate_limits_available: false } }) as Awaited<ReturnType<Probes['usage']>>,
};

type Inside = {
  low?: { claude: string; editor?: LowEditorFence };
  lowCopies?: { check(copy: string): string | undefined };
  fence: { allowsSandboxRun(): boolean };
  runSpec(info: { id: string }, spec: Record<string, unknown>): { claudeExecutable?: string };
  editorFence(): LowEditorFence | undefined;
  shutdown(): void;
};

function daemon(t: { after: (f: () => void) => void }, answer: (copy: string) => string | undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w6085-'));
  const d = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'mx', token: 't', repoPath: root, appDir: root, tempDir: path.join(root, 'tmp'), maxEventsFile: null }, () => {
    throw new Error('no sessions here');
  }, PROBES) as unknown as Inside;
  t.after(() => {
    d.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const checked: string[] = [];
  d.lowCopies = { check: (copy) => (checked.push(copy), answer(copy)) };
  d.fence.allowsSandboxRun = () => true;
  return { d, checked };
}

test('w6085: runSpec checks the Low claude before every sandbox run and runs what the check answers', (t) => {
  const { d, checked } = daemon(t, (c) => c.replace('claude-1-2.exe', 'claude-1-2-1.exe'));
  d.low = { claude: 'X:/ffw/tools/low/claude-1-2.exe' };
  const spec = d.runSpec({ id: 's1' }, { sandbox: 'slot1', env: {}, prompt: 'p' });
  assert.deepEqual(checked, ['X:/ffw/tools/low/claude-1-2.exe']);
  assert.equal(spec.claudeExecutable, 'X:/ffw/tools/low/claude-1-2-1.exe', 'the copy made again, not the one handed in');
  d.runSpec({ id: 's2' }, { sandbox: 'slot1', env: {}, prompt: 'p' });
  assert.equal(checked.length, 2, 'checked again before the next run');
  assert.equal(checked[1], 'X:/ffw/tools/low/claude-1-2-1.exe');
  // A run that is not a sandbox agent's starts no Low copy, so nothing is checked.
  d.runSpec({ id: 's3' }, { env: {}, prompt: 'p' });
  assert.equal(checked.length, 2);
});

test('w6085: a Low claude that cannot be checked or made again holds the run, never starts it', (t) => {
  const { d } = daemon(t, () => undefined);
  d.low = { claude: 'X:/ffw/tools/low/claude-1-2.exe' };
  assert.throws(() => d.runSpec({ id: 's1' }, { sandbox: 'slot1', env: {}, prompt: 'p' }), /could not be checked or made again; sandbox runs are held/);
});

test('w6085: editorFence checks the Low node launcher before each editor start; one that fails leaves that editor unfenced, never the replaced program', (t) => {
  let ok = true;
  const { d, checked } = daemon(t, (c) => (ok ? `${c}-again` : undefined));
  const editor: LowEditorFence = { launcher: 'X:/ffw/tools/low/node-1-2.exe', unityDir: 'X:/ffw/tools/unity-low', licensingIpc: 'ipc', env: {} };
  d.low = { claude: 'X:/ffw/tools/low/claude-1-2.exe', editor };
  assert.equal(d.editorFence()?.launcher, 'X:/ffw/tools/low/node-1-2.exe-again');
  assert.deepEqual(checked, ['X:/ffw/tools/low/node-1-2.exe']);
  ok = false;
  assert.equal(d.editorFence(), undefined);
  assert.equal(checked.length, 2, 'checked at every start, not once');
  // The pool asks the getter at each start, never a value taken once (daemon.ts realPoolDeps; unity.ts start).
  const daemonSrc = fs.readFileSync(new URL('../machine/daemon.ts', import.meta.url), 'utf8');
  assert.match(daemonSrc, /realPoolDeps\([^;]*\(\) => this\.editorFence\(\)/);
  const unitySrc = fs.readFileSync(new URL('../machine/unity.ts', import.meta.url), 'utf8');
  const start = unitySrc.indexOf('const wanted = this.fence?.();');
  assert.ok(start > 0 && start < unitySrc.indexOf('fencedEditorBin(bin, fence.unityDir', start), 'the start asks the fence just before it starts the editor');
});
