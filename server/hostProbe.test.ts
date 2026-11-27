// w6234: a host-stats probe never holds the portal's event loop. On a fully loaded BEAST (2026-11-26) Lens Scout's portal
// stalled 20-50 s at a time in the GPU probe's spawn (server/system.ts gpu, every 5 s refresh); its /api/health took 18-48 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CachedProbe, runOffThread, type ProbeResult } from './hostProbe.ts';

function tmp(t: { after: (fn: () => void) => void }, prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('a cached probe answers at once with its last value and runs one probe at a time', async () => {
  let release: (r: ProbeResult<number>) => void = () => undefined;
  let n = 0;
  const p = new CachedProbe<number>(
    'test',
    () => {
      n++;
      return new Promise((r) => (release = r));
    },
    { everyMs: 0, maxBackoffMs: 0 },
  );
  assert.equal(p.get(), undefined, 'no value before the first probe answers');
  assert.equal(p.get(), undefined);
  assert.equal(n, 1, 'a second read while the probe runs starts no other');
  release({ value: 42 });
  await p.inFlight;
  assert.equal(p.get(), 42, 'the answer, then a new probe');
  assert.equal(n, 2);
  release({ value: undefined, timedOut: true });
  await p.inFlight;
  assert.equal(p.get(), 42, 'a timeout keeps the last value');
});

test('a probe that keeps timing out backs off, doubling up to its cap, and comes back on its first answer', async () => {
  let now = 0;
  let answer: ProbeResult<string> = { value: undefined, timedOut: true };
  const logs: string[] = [];
  const p = new CachedProbe<string>('GPU', async () => answer, { everyMs: 5000, maxBackoffMs: 60_000, now: () => now, log: (l) => logs.push(l) });
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    p.get();
    await p.inFlight;
    delays.push(p.delayMs);
    const before = p.probes;
    now += p.delayMs - 1;
    p.get();
    assert.equal(p.probes, before, 'nothing before the wait is up');
    now += 1;
  }
  assert.deepEqual(delays, [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.equal(logs.length, 1, logs.join('\n'));
  assert.match(logs[0], /the GPU probe timed out 3 times in a row; probing it at most every 1 min/);
  answer = { value: 'RTX' };
  p.get();
  await p.inFlight;
  assert.equal(p.get(), 'RTX');
  assert.equal(p.delayMs, 5000);
});

test('a probe whose child hangs answers timed out, and the loop keeps turning meanwhile', async () => {
  let worst = 0;
  let last = performance.now();
  const beat = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last - 20);
    last = t;
  }, 20);
  try {
    const t0 = performance.now();
    const r = await runOffThread(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], 1000);
    const took = performance.now() - t0;
    assert.equal(r.timedOut, true, JSON.stringify(r));
    assert.ok(took < 8000, `answered in ${Math.round(took)} ms`);
    const ok = await runOffThread(process.execPath, ['-e', 'console.log("probe answer")'], 10_000);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /probe answer/);
    const missing = await runOffThread('ff-no-such-probe-tool', [], 1000);
    assert.equal(missing.code, -1);
    assert.match(missing.stderr, /ENOENT/);
  } finally {
    clearInterval(beat);
  }
  assert.ok(worst < 100, `the loop was held ${Math.round(worst)} ms`);
});

test('the portal answers /api/health in under 100 ms while its GPU probe hangs for 30 s', { timeout: 180_000 }, async (t) => {
  const base = tmp(t, 'ffsb-gpu-hang-');
  const data = path.join(base, 'data');
  const repo = path.join(base, 'base');
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(base, 'sandboxes'));
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(
    path.join(base, 'config.json'),
    JSON.stringify({
      port: 0,
      host: '127.0.0.1',
      trustProxy: false,
      dataDir: data,
      sandboxRoot: path.join(base, 'sandboxes'),
      repo: { url: repo, basePath: repo },
      defaultBase: 'develop',
      unity: { editorPath: path.join(base, 'no-unity', 'Unity.exe'), watchdog: { stallMinutes: 0, runningPollSeconds: 0, autoDismiss: false } },
      voice: { enabled: false, autoInstall: false, tts: false },
      hostGuard: { pollSeconds: 0 },
      orchestrator: { notifyOnWorkerEvents: false },
    }),
  );
  // The fake GPU tool: it takes 30 s to answer, as nvidia-smi or the GPU counters can on a loaded host.
  const fake = path.join(base, 'fake-nvidia-smi.js');
  fs.writeFileSync(fake, "setTimeout(() => console.log('Fake GPU, 8192, 1024, 50'), 30000);\n");
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FFSB_CONFIG: path.join(base, 'config.json'),
    FFSB_GPU_PROBE_CMD: JSON.stringify([process.execPath, fake]),
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  };
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'DISCORD_TOKEN']) delete env[k];
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'index.ts')], { cwd: path.join(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 60_000;
  while (!/on http:\/\/127\.0\.0\.1:\d+ /.test(log)) {
    if (child.exitCode !== null) assert.fail(`the server exited (${child.exitCode}):\n${log}`);
    if (Date.now() > end) assert.fail(`the server did not come up:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const port = Number(/on http:\/\/127\.0\.0\.1:(\d+) /.exec(log)![1]);
  // Let start-up settle (the first refreshes, the first probe started), then probe health across three 5 s refreshes.
  await new Promise((r) => setTimeout(r, 5000));
  await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); // the first connection's own set-up is not the loop
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    await res.json();
    times.push(Math.round(performance.now() - t0));
    await new Promise((r) => setTimeout(r, 500));
  }
  t.diagnostic(`/api/health ms: ${times.join(' ')}`);
  // Stop it the way the scripts do, so nothing it started outlives the test.
  fs.writeFileSync(path.join(data, 'restart.request'), '');
  assert.equal(await exited, 0, log);
  assert.ok(Math.max(...times) < 100, `/api/health took ${Math.max(...times)} ms at worst: ${times.join(' ')}`);
});
