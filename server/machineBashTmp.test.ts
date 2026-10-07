import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Daemon, type Probes } from '../machine/daemon.ts';
import type { CleanupGuard } from './cleanup.ts';

const PROBES: Probes = {
  stats: async () => ({}) as Awaited<ReturnType<Probes['stats']>>,
  usage: async () => ({ account: { email: 'someone@example.com', plan: 'Claude Max' }, reply: { subscription_type: 'max', rate_limits_available: false } }) as Awaited<ReturnType<Probes['usage']>>,
};

type Inside = { ensureBashTmp(): Promise<void>; cleanupGuard(): CleanupGuard; onMessage(m: unknown): void };

function daemon(t: { after: (f: () => void) => void }, bashTmp?: Probes['bashTmp']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-bashtmp-'));
  const tempDir = path.join(root, 'tmp');
  const d = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'mx', token: 't', repoPath: root, appDir: root, tempDir, maxEventsFile: null }, () => {
    throw new Error('no sessions here');
  }, { ...PROBES, bashTmp });
  t.after(() => {
    d.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { d: d as unknown as Inside, tempDir };
}

test("w603: the session folder that became Git Bash's /tmp is kept by clean-up and by the session's removal", async (t) => {
  let pinned = '';
  let asked = 0;
  const { d, tempDir } = daemon(t, async () => (asked++, { dir: pinned, made: false }));
  pinned = path.join(tempDir, 'ffa-pinned');
  const other = path.join(tempDir, 'ffa-other');
  for (const f of [pinned, other]) fs.mkdirSync(f, { recursive: true });
  await d.ensureBashTmp();
  assert.equal(asked, 1);
  assert.ok(d.cleanupGuard().inUse.includes(pinned), JSON.stringify(d.cleanupGuard().inUse));
  d.onMessage({ type: 'remove', sessionId: 'pinned' });
  d.onMessage({ type: 'remove', sessionId: 'other' });
  for (let i = 0; i < 100 && fs.existsSync(other); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!fs.existsSync(other), "another session's folder goes with it");
  assert.ok(fs.existsSync(pinned), "Git Bash's /tmp stays");
});

test('w603: a temp root that is /tmp is not kept whole; without the probe (tests) nothing is looked up', async (t) => {
  const { d, tempDir } = daemon(t, async () => ({ dir: tempDir, made: false }));
  await d.ensureBashTmp();
  assert.ok(!d.cleanupGuard().inUse.includes(tempDir));
  const plain = daemon(t).d;
  await plain.ensureBashTmp();
  assert.equal(plain.cleanupGuard().inUse.length, 0);
});
