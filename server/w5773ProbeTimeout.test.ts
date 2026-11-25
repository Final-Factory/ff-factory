import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { OWNER_SOCKET_PROBE_TIMEOUT_MS, ownerSocketsAfterProbe, readFenceMode } from '../machine/readFence.ts';

const PROBES: Probes = {
  stats: async () => ({ hostname: 'x', platform: process.platform, cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: 1, memFreeBytes: 1 }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

/** The portal's wait for a daemon_control answer (w5773: a read-fence switch must answer inside it). */
const PORTAL_WAIT_MS = 60_000;

test('w5773: a hung probe child cannot hold a read fence switch past the portal\'s 60 s wait; the mode is written first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w5773-'));
  const appDir = path.join(dir, 'daemon');
  const d = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'linuxbox', token: 't', repoPath: path.join(dir, 'FinalFactory'), appDir, root: dir, maxEventsFile: null }, () => {
    throw new Error('no agents in this test');
  }, PROBES);
  // The probe's child never exits: as a fenced child stuck on a socket or a file would.
  const hung = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  let probes = 0;
  (d as unknown as { probeReadFence(): Promise<void> }).probeReadFence = () => {
    probes++;
    return new Promise<void>((resolve) => hung.once('exit', () => resolve()));
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const held = new Promise<'held'>((resolve) => {
      timer = setTimeout(() => resolve('held'), PORTAL_WAIT_MS);
    });
    const answered = await Promise.race([d.setReadFence('warn').then(() => 'answered' as const), held]);
    assert.equal(answered, 'answered', 'setReadFence waited on the probe child');
    assert.equal(probes, 1, 'the probe still runs, after the answer');
    assert.equal(readFenceMode(appDir), 'warn');
    assert.equal((d as unknown as { readProbeBlocks: boolean }).readProbeBlocks, true, 'runs start without read rules until the probe passes');
  } finally {
    clearTimeout(timer);
    hung.kill();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('w5773: the owner-socket probe is cut at 15 s, and one that hung or failed counts the sockets as reachable', () => {
  assert.equal(OWNER_SOCKET_PROBE_TIMEOUT_MS, 15_000);
  // The file probe's 60 s plus this one stays under the old 120 s; the switch no longer waits on either.
  assert.ok(OWNER_SOCKET_PROBE_TIMEOUT_MS < 60_000);
  assert.deepEqual(ownerSocketsAfterProbe({ code: 0 }, []), []);
  assert.deepEqual(ownerSocketsAfterProbe({ code: 0 }, ['/r/bus']), ['/r/bus']);
  assert.deepEqual(ownerSocketsAfterProbe({ code: -1, timedOut: true }, []), ['(the probe hung and was ended after 15 s)']);
  assert.deepEqual(ownerSocketsAfterProbe({ code: 1 }, []), ['(the probe exited 1)']);
});
