import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editorHomeEnv } from '../machine/unitySlots.ts';

/**
 * w5961 (found in w5806 on m5): a fenced Mac worker's second editor (a peer run's ParrelSync clone) opened under
 * `unity-slot run` hung on a hidden "Moving file failed" modal with the real home; with HOME and CFFIXED_USER_HOME at
 * `<root>/home` (what the daemon's fenced editors get) it loaded in 10.6 s and its bridge came up.
 */
const UNITY = '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity';

test('w5961: an interactive Unity editor run on a fenced Mac gets the fenced editor home', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5961-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const env = { HOME: '/Users/u', FF_UNITY_EDITOR_HOME: home, KEEP: '1' };
  const got = editorHomeEnv([UNITY, '-projectPath', '/r/sandboxes/slot2_clone_0', '-logFile', '/t/clone.log'], env, 'darwin');
  assert.equal(got.HOME, home);
  assert.equal(got.CFFIXED_USER_HOME, home);
  assert.equal(got.KEEP, '1');
  assert.ok(fs.existsSync(home), 'made, so the editor finds its home');
});

test('w5961: a batch run, a script, another platform or no fence keeps the home it had', () => {
  const env = { HOME: '/Users/u', FF_UNITY_EDITOR_HOME: '/r/home' };
  assert.equal(editorHomeEnv([UNITY, '-batchmode', '-quit', '-projectPath', '/p'], env, 'darwin'), env, 'batchmode: a moved home could start its own licensing client and quit unlicensed');
  assert.equal(editorHomeEnv(['/bin/bash', 'scripts/launch-editor.sh', '/p'], env, 'darwin'), env, 'a script keeps the person home (git, gh)');
  assert.equal(editorHomeEnv(['/r/build/Unity Hub.app/Contents/Resources/x', 'serve'], env, 'darwin'), env, 'the Hub helper');
  assert.equal(editorHomeEnv([UNITY, '-projectPath', '/p'], env, 'win32'), env, 'Mac only');
  const unfenced = { HOME: '/Users/u' };
  assert.equal(editorHomeEnv([UNITY, '-projectPath', '/p'], unfenced, 'darwin'), unfenced, 'no fence (no FF_UNITY_EDITOR_HOME): unchanged');
});
