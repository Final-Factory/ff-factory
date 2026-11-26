import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropOldToolsShims, lowDiskImages, lowTargets, MEDIUM_TOOLS, OLD_TOOLS_SHIMS, quarantineStrayShims, strayShimFiles, toolsShimsDir, WINDOWS_SHIM_FILES, windowsShims, windowsShimsDir } from '../machine/lowIntegrity.ts';
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
  // The old one is out of MEDIUM_TOOLS (enforce), and kept Medium only while it is there.
  assert.equal(toolsShimsDir(R), path.join(R, 'tools', OLD_TOOLS_SHIMS));
  assert.ok(!MEDIUM_TOOLS.includes('shims'));
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
  // The old folder, while it is there, stays Medium too, and is never labelled Low.
  assert.ok(t.medium.includes(toolsShimsDir(R)) && !t.dirs.includes(toolsShimsDir(R)));
  assert.deepEqual(lowDiskImages(R, kids('shims'), () => ['x.vhdx']), [], 'the old shims folder is not a Low child');
  // Gone: not named at all.
  const gone = lowTargets({ root: R, appDir: app, children: kids('tools', 'tmp'), toolsChildren: kids('node', 'cargo'), exists: () => true });
  assert.ok(!gone.medium.includes(toolsShimsDir(R)) && !gone.dirs.includes(toolsShimsDir(R)));
  assert.ok(gone.dirs.includes(path.join(R, 'tools', 'cargo')));
  // No tools-medium folder: nothing about it.
  const none = lowTargets({ root: R, appDir: app, children: kids('tools', 'tmp'), toolsChildren: kids('node'), exists: () => true });
  assert.ok(!none.medium.some((m) => m.includes('tools-medium')));
});

test('w6101: windowsShims writes the old folder only while a host started before the move has it on its PATH', () => {
  const wrote: string[] = [];
  const log: string[] = [];
  const r = windowsShims(R, { write: (d) => void wrote.push(d), waits: () => ['s1', 's2'], log: (l) => log.push(l) });
  assert.deepEqual(r, { bin: windowsShimsDir(R), oldNeeded: true });
  assert.deepEqual(wrote, [windowsShimsDir(R), toolsShimsDir(R)]);
  assert.equal(log.length, 1);
  assert.match(log[0], /first on new agents' PATH/);
  assert.match(log[0], /2 agent host\(s\).*\(s1, s2\)/);
  const wrote2: string[] = [];
  const log2: string[] = [];
  assert.deepEqual(windowsShims(R, { write: (d) => void wrote2.push(d), waits: () => [], log: (l) => log2.push(l) }), { bin: windowsShimsDir(R), oldNeeded: false });
  assert.deepEqual(wrote2, [windowsShimsDir(R)], 'nobody runs the old folder: not written');
  assert.match(log2[0], /not written and goes/);
});

test('w6101: a failed write in tools-medium falls back to tools\\shims, which is Medium; both failing gives no folder', () => {
  const log: string[] = [];
  const r = windowsShims(R, { write: (d) => { if (d === windowsShimsDir(R)) throw new Error('EPERM'); }, waits: () => [], log: (l) => log.push(l) });
  assert.deepEqual(r, { bin: toolsShimsDir(R), oldNeeded: true }, 'written even with no host waiting: it is the fallback');
  assert.ok(log.some((l) => /WARNING: could not write the shims in .*tools-medium.*first on their PATH instead/.test(l)));
  const log2: string[] = [];
  assert.deepEqual(windowsShims(R, { write: () => { throw new Error('EPERM'); }, waits: () => [], log: (l) => log2.push(l) }), { bin: undefined, oldNeeded: false });
  assert.equal(log2.filter((l) => /WARNING/.test(l)).length, 2);
  const log3: string[] = [];
  assert.deepEqual(windowsShims(R, { write: (d) => { if (d === toolsShimsDir(R)) throw new Error('EPERM'); }, waits: () => ['s1'], log: (l) => log3.push(l) }), { bin: windowsShimsDir(R), oldNeeded: true });
  assert.ok(log3.some((l) => /WARNING: could not write the shims in .*tools.shims/.test(l)));
});

test('w6101: dropOldToolsShims removes tools\\shims once no host has it on its PATH, and not before', async () => {
  const removed: string[] = [];
  const log: string[] = [];
  assert.equal(dropOldToolsShims(R, { waits: () => [], log: (l) => log.push(l), remove: (p) => void removed.push(p), exists: () => true }), undefined);
  assert.deepEqual(removed, [toolsShimsDir(R)]);
  assert.match(log[0], /removed the old shims folder/);
  // Not there: nothing said.
  const log0: string[] = [];
  assert.equal(dropOldToolsShims(R, { waits: () => [], log: (l) => log0.push(l), remove: () => assert.fail('nothing to remove'), exists: () => false }), undefined);
  assert.deepEqual(log0, []);
  // Waits, then goes once the last host ends; a failed remove is tried again.
  let hosts = ['s1'];
  let fail = 1;
  const removed2: string[] = [];
  const log2: string[] = [];
  const t = dropOldToolsShims(R, { waits: () => hosts, log: (l) => log2.push(l), everyMs: 5, exists: () => true, remove: (p) => { if (fail-- > 0) throw new Error('EBUSY'); removed2.push(p); } });
  assert.ok(t);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(removed2, [], 'a host still runs it');
  hosts = [];
  await new Promise((r) => setTimeout(r, 60));
  clearInterval(t);
  assert.deepEqual(removed2, [toolsShimsDir(R)]);
  assert.ok(log2.some((l) => /WARNING: could not remove .*EBUSY/.test(l)));
});

test('w6101: quarantineStrayShims moves what the daemon does not write out of the shims folder, deleting nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w6101-q-'));
  try {
    const bin = windowsShimsDir(tmp);
    fs.mkdirSync(bin, { recursive: true });
    for (const n of [...WINDOWS_SHIM_FILES, 'git.cmd', 'ff-pr.1.tmp']) fs.writeFileSync(path.join(bin, n), n);
    const log: string[] = [];
    assert.deepEqual(quarantineStrayShims(tmp, { log: (l) => log.push(l), now: () => 7 }), ['git.cmd']);
    assert.deepEqual(fs.readdirSync(bin).sort(), [...WINDOWS_SHIM_FILES, 'ff-pr.1.tmp'].sort());
    const q = path.join(tmp, 'tools-medium', 'quarantine', `shims-7-${process.pid}`);
    assert.equal(fs.readFileSync(path.join(q, 'git.cmd'), 'utf8'), 'git.cmd', 'kept for a person to look at');
    assert.ok(log.some((l) => /WARNING: .*git\.cmd is not a shim the daemon writes.*moved to/.test(l)));
    // Nothing more: nothing said, no folder made.
    const log2: string[] = [];
    assert.deepEqual(quarantineStrayShims(tmp, { log: (l) => log2.push(l), mkdir: () => assert.fail('no folder') }), []);
    assert.deepEqual(log2, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // A move that fails leaves the file and says so; a folder it cannot read says so.
  const log: string[] = [];
  assert.deepEqual(quarantineStrayShims(R, { log: (l) => log.push(l), list: () => ['git.cmd'], mkdir: () => {}, rename: () => { throw new Error('EPERM'); } }), []);
  assert.ok(log.some((l) => /could not be moved out: EPERM; left in place/.test(l)));
  const log2: string[] = [];
  quarantineStrayShims(R, { log: (l) => log2.push(l), list: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
  assert.ok(log2.some((l) => /WARNING: could not read/.test(l)));
});
