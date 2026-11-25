// w5550 (rogue-worker audit w5451 item 18): file_ffbox_symbols only for the worker's own builds. lothsahn: "File it:
// file_ffbox_symbols only for the worker's own builds". The store is server/symbolOwners.ts; the wiring through
// switch_branch and file_ffbox_symbols is tested in machineSandboxes.test.ts ("w5550").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SymbolOwners, urgentVersionOf } from './symbolOwners.ts';

test('w5550: urgentVersionOf reads urgent/<v> only', () => {
  assert.equal(urgentVersionOf('urgent/1.0.0.12'), '1.0.0.12');
  assert.equal(urgentVersionOf('urgent/beast'), undefined);
  assert.equal(urgentVersionOf('release/1.0.0.12'), undefined);
  assert.equal(urgentVersionOf('urgent/1.0.0.12/x'), undefined);
  assert.equal(urgentVersionOf('feature/urgent/1.0.0.12'), undefined);
  assert.equal(urgentVersionOf(undefined), undefined);
});

test('w5550: own build allowed; another request, an unknown version, no request and overwriting another request\'s symbols refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-owners-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'symbol-owners.json');
  const o = new SymbolOwners(file);
  // Only a switch onto urgent/<v> by a session with an open request records a build.
  assert.equal(o.recordSwitch('feature/w1', 's1', ['w100'], 'beast', 'slot1'), undefined);
  assert.equal(o.recordSwitch('urgent/1.0.0.12', 's0', [], 'beast', 'slot1'), undefined);
  assert.equal(o.recordSwitch('urgent/1.0.0.12', 's1', ['W100'], 'beast', 'slot1'), '1.0.0.12');

  // Own build: allowed (the request id compared without case).
  assert.equal(o.refusal('1.0.0.12', ['w100']), undefined);
  assert.equal(o.refusal('1.0.0.12', ['w7', 'W100']), undefined);
  // Another request's build: refused, naming whose it is.
  assert.match(o.refusal('1.0.0.12', ['w200'])!, /^Refused \(w5550\): 1\.0\.0\.12 was built for w100, not for your request \(w200\)/);
  // An unknown version: refused.
  assert.match(o.refusal('1.0.0.13', ['w100'])!, /^Refused \(w5550\): no urgent build of 1\.0\.0\.13 is recorded for any request/);
  // A session with no open request: refused.
  assert.match(o.refusal('1.0.0.12', [])!, /serves no open request/);

  // w100 files; it may file again (a retry), and the record survives a restart.
  o.recordFiling('1.0.0.12', 's1', ['w100']);
  assert.equal(o.refusal('1.0.0.12', ['w100']), undefined);
  const again = new SymbolOwners(file);
  assert.deepEqual(again.get('1.0.0.12')?.filed?.workIds, ['w100']);
  assert.equal(again.get('1.0.0.12')?.builds.length, 1);

  // w200 also builds 1.0.0.12 (its own switch): it built it too, but w100's symbols are never overwritten by it.
  assert.equal(again.recordSwitch('urgent/1.0.0.12', 's2', ['w200'], 'lothdesktop', 'slot1'), '1.0.0.12');
  assert.match(again.refusal('1.0.0.12', ['w200'])!, /^Refused \(w5550\): 1\.0\.0\.12's symbols were filed by w100 at .*; only that request may file them again/);
  assert.equal(again.refusal('1.0.0.12', ['w100']), undefined);
  // A second filing never moves the owner.
  again.recordFiling('1.0.0.12', 's2', ['w200']);
  assert.deepEqual(again.get('1.0.0.12')?.filed?.workIds, ['w100']);
  // A repeated switch by the same session in the same sandbox is one build, not two.
  again.recordSwitch('urgent/1.0.0.12', 's2', ['w200'], 'lothdesktop', 'slot1');
  assert.equal(again.get('1.0.0.12')?.builds.length, 2);
});
