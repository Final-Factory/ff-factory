import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lowTargets, MEDIUM_TOOLS, strayShimFiles, toolsShimsDir, WINDOWS_SHIM_FILES, windowsShims, windowsShimsDir } from '../machine/lowIntegrity.ts';
import { enforcedShimDir } from '../machine/pathFence.ts';
import { writeShims } from '../machine/unitySlots.ts';
import { installLeftoversShim } from '../machine/leftovers.ts';
import { installPrShim } from '../machine/prFlow.ts';
import { installPythonShim } from '../machine/evidenceGate.ts';
import { installFfuSlotShim } from '../machine/ffuSlots.ts';

// w6101 (item 3 of w6085): the Windows shims move to <root>/tools-medium/shims, the one name on every OS.

const R = path.resolve('/ffw');
const kids = (...n: string[]) => n.map((name) => ({ name, dir: true }));

test('w6101: the Windows shims folder is the one macOS and Linux use', () => {
  assert.equal(windowsShimsDir(R), enforcedShimDir(R));
  assert.equal(windowsShimsDir(R), path.join(R, 'tools-medium', 'shims'));
  // The old one stays Medium while it is still written.
  assert.equal(toolsShimsDir(R), path.join(R, 'tools', 'shims'));
  assert.ok(MEDIUM_TOOLS.includes('shims'));
});

test('w6101: WINDOWS_SHIM_FILES is what the daemon writes in the shims folder on Windows', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w6101-names-'));
  try {
    const bin = path.join(tmp, 'shims');
    // The daemon's shims() in machine/daemon.ts, in its order, with the Windows python answer.
    writeShims(bin);
    installLeftoversShim(bin, undefined, undefined, undefined, path.join(tmp, 'facts.json'));
    installPrShim(bin);
    assert.equal(installPythonShim(bin, '', 'win32'), 'none');
    installFfuSlotShim(bin, path.join(tmp, 'facts.json'), 4);
    assert.deepEqual(fs.readdirSync(bin).sort(), [...WINDOWS_SHIM_FILES].sort());
    assert.deepEqual(strayShimFiles(bin), { strays: [] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('w6101: strayShimFiles names what the daemon does not write, ignores temp files, and says when it cannot read', () => {
  assert.deepEqual(strayShimFiles(R, () => ['unity-slot', 'FF-PR.CMD', 'git.cmd', 'git', 'unity-slot.123.abc.tmp']), { strays: ['git', 'git.cmd'] });
  assert.deepEqual(strayShimFiles(R, () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }), { strays: [] });
  assert.deepEqual(strayShimFiles(R, () => { throw Object.assign(new Error('EPERM: denied'), { code: 'EPERM' }); }), { strays: [], error: 'EPERM: denied' });
});

test('w6101: tools-medium and its shims are kept Medium when the root has tools-medium', () => {
  const app = path.join(R, 'daemon');
  const t = lowTargets({ root: R, appDir: app, children: kids('tools', 'tools-medium', 'tmp'), toolsChildren: kids('node', 'shims'), exists: () => true });
  assert.ok(t.medium.includes(path.join(R, 'tools-medium')) && t.medium.includes(path.join(R, 'tools-medium', 'shims')));
  assert.ok(!t.dirs.some((d) => d.toLowerCase().startsWith(path.join(R, 'tools-medium').toLowerCase())), 'never labelled Low');
  // The old folder stays Medium too.
  assert.ok(t.medium.includes(toolsShimsDir(R)) && !t.dirs.includes(toolsShimsDir(R)));
  // No tools-medium folder: nothing about it.
  const none = lowTargets({ root: R, appDir: app, children: kids('tools', 'tmp'), toolsChildren: kids('node'), exists: () => true });
  assert.ok(!none.medium.some((m) => m.includes('tools-medium')));
});

test('w6101: windowsShims writes both folders, puts the new one first, and says who still runs the old one', () => {
  const wrote: string[] = [];
  const log: string[] = [];
  const bin = windowsShims(R, { write: (d) => void wrote.push(d), waits: () => ['s1', 's2'], log: (l) => log.push(l), list: () => [...WINDOWS_SHIM_FILES] });
  assert.equal(bin, windowsShimsDir(R));
  assert.deepEqual(wrote, [windowsShimsDir(R), toolsShimsDir(R)]);
  assert.equal(log.length, 1);
  assert.match(log[0], /first on new agents' PATH/);
  assert.match(log[0], /2 agent host\(s\).*\(s1, s2\)/);
  assert.ok(!log.some((l) => /WARNING/.test(l)));
});

test('w6101: windowsShims warns of a planted file and of a folder it cannot read, and removes nothing', () => {
  const log: string[] = [];
  windowsShims(R, { write: () => {}, waits: () => [], log: (l) => log.push(l), list: () => [...WINDOWS_SHIM_FILES, 'git.cmd'] });
  assert.match(log[0], /none has it on its PATH now/);
  assert.ok(log.some((l) => /WARNING: .*git\.cmd is not a shim the daemon writes.*left in place/.test(l)));
  const log2: string[] = [];
  windowsShims(R, { write: () => {}, waits: () => [], log: (l) => log2.push(l), list: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
  assert.ok(log2.some((l) => /WARNING: could not read/.test(l)));
});

test('w6101: a failed write in tools-medium falls back to tools\\shims, which is Medium; both failing gives no folder', () => {
  const log: string[] = [];
  const bin = windowsShims(R, { write: (d) => { if (d === windowsShimsDir(R)) throw new Error('EPERM'); }, waits: () => [], log: (l) => log.push(l) });
  assert.equal(bin, toolsShimsDir(R));
  assert.ok(log.some((l) => /WARNING: could not write the shims in .*tools-medium.*first on their PATH instead/.test(l)));
  const log2: string[] = [];
  assert.equal(windowsShims(R, { write: () => { throw new Error('EPERM'); }, waits: () => [], log: (l) => log2.push(l) }), undefined);
  assert.equal(log2.filter((l) => /WARNING/.test(l)).length, 2);
  // The new folder written and the old one not: still the new one, with a WARNING for the old.
  const log3: string[] = [];
  assert.equal(windowsShims(R, { write: (d) => { if (d === toolsShimsDir(R)) throw new Error('EPERM'); }, waits: () => [], log: (l) => log3.push(l), list: () => [] }), windowsShimsDir(R));
  assert.ok(log3.some((l) => /WARNING: could not write the shims in .*tools.shims/.test(l)));
});
