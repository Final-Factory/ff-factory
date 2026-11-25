import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonVoice, voiceToolsProblem } from '../machine/voice.ts';
import { voicePaths } from './voiceSetup.ts';

/**
 * w5574 (from w5542's audit): the daemon ran the voice venv's python from <root>/voice, a folder workers can write. The
 * tools now live in the daemon's folder (<appDir>/voice), and a toolsDir or uvPath elsewhere in the worker root is refused.
 */

const deps = (root: string | undefined, extra: Partial<ConstructorParameters<typeof DaemonVoice>[2]> = {}) => ({
  log: () => {},
  stats: () => undefined,
  changed: () => {},
  needed: () => null,
  ...(root ? { root } : {}),
  ...extra,
});

test('w5574: a python planted in <root>/voice is never run by the daemon; the tools default to its own folder', { skip: process.platform === 'win32' && 'the planted python is a shell script' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5574-voice-'));
  const appDir = path.join(root, 'daemon');
  const marks = path.join(root, 'marks');
  fs.mkdirSync(marks);
  const planted = voicePaths({ toolsDir: path.join(root, 'voice') }).python;
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, `#!/bin/sh\necho ran > ${JSON.stringify(path.join(marks, 'planted'))}\nexit 1\n`, { mode: 0o755 });
  const settings = { enabled: true, device: 'cpu' as const, toolsDir: path.join(root, 'voice') };

  // RED: without the worker root to check against (as before w5574), the load runs the planted python.
  const before = new DaemonVoice(settings, appDir, deps(undefined));
  await assert.rejects(before.load());
  before['engine'].unload();
  assert.deepEqual(fs.readdirSync(marks), ['planted']);
  fs.rmSync(path.join(marks, 'planted'));

  // Now: the same settings are refused, nothing runs, and the status says why.
  let setups = 0;
  const v = new DaemonVoice(settings, appDir, deps(root, { setup: async () => void setups++ }));
  assert.equal(v.status().state, 'unavailable');
  assert.match(v.status().detail ?? '', /workers can write \(w5574\)/);
  await assert.rejects(v.load(), /workers can write/);
  v.start();
  await v.install();
  assert.equal(setups, 0, 'no install into a folder workers can write');
  assert.deepEqual(fs.readdirSync(marks), []);
  assert.match(voiceToolsProblem({ toolsDir: path.join(appDir, 'voice'), uvPath: path.join(root, 'tools', 'uv') }, root, appDir) ?? '', /uvPath/);

  // The default is the daemon's folder; once the tools are installed there, the old <root>/voice goes.
  const d = new DaemonVoice({ enabled: true }, appDir, deps(root, { setup: async () => void setups++ }));
  assert.equal(d.v.toolsDir, path.join(appDir, 'voice'));
  assert.notEqual(d.status().state, 'unavailable');
  await d.install();
  assert.equal(setups, 1);
  assert.equal(fs.existsSync(path.join(root, 'voice')), false);
  assert.deepEqual(fs.readdirSync(marks), []);
  fs.rmSync(root, { recursive: true, force: true });
});
