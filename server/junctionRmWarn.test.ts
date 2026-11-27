// w6266: the warn-only check for a Git Bash `rm -r` over a folder holding a junction (server/junctionRmWarn.ts). The parse
// runs everywhere; the walk and the guard run on Windows with a junction made by `cmd /c mklink /J` inside the test's own
// temp folder, its target there too. Nothing here runs rm: the guard only reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstLink, junctionRmLogLine, junctionRmMessage, junctionRmScan, rmRecursiveTargets } from './junctionRmWarn.ts';
import { sandboxGuard } from './guard.ts';

const win = process.platform === 'win32';
const env = { TMPDIR: '/v/ffw/tmp/ffa-1', HOME: '/c/Users/dev' };
const ctx = { cwd: 'V:/ffw/sandboxes/sb1', env };

test('w6266: the folders an rm -r names, in Windows form', () => {
  assert.deepEqual(rmRecursiveTargets('rm -rf "$TMPDIR/clone"', ctx), ['V:\\ffw\\tmp\\ffa-1\\clone']);
  assert.deepEqual(rmRecursiveTargets('rm -fr ${TMPDIR}/a b', ctx), ['V:\\ffw\\tmp\\ffa-1\\a', 'V:\\ffw\\sandboxes\\sb1\\b']);
  assert.deepEqual(rmRecursiveTargets('rm -R -- -odd', ctx), ['V:\\ffw\\sandboxes\\sb1\\-odd']);
  assert.deepEqual(rmRecursiveTargets('rm --recursive --force /v/ffw/tmp/x', ctx), ['V:\\ffw\\tmp\\x']);
  assert.deepEqual(rmRecursiveTargets('cd "$TMPDIR" && rm -rf leg-1; ls', ctx), ['V:\\ffw\\tmp\\ffa-1\\leg-1']);
  assert.deepEqual(rmRecursiveTargets('echo hi | /usr/bin/rm.exe -rf V:\\ffw\\tmp\\y', ctx), ['V:\\ffw\\tmp\\y']);
  // Not a recursive rm, or a path the text does not give: nothing to walk.
  assert.deepEqual(rmRecursiveTargets('rm -f "$TMPDIR/a.log"', ctx), []);
  assert.deepEqual(rmRecursiveTargets('rm -rf "$TMPDIR"/leg-*', ctx), []);
  assert.deepEqual(rmRecursiveTargets('rm -rf "$(cat $TMPDIR/p)" $OTHER/x /tmp/z', ctx), []);
  assert.deepEqual(rmRecursiveTargets('cmd //c "rd /s /q V:\\ffw\\tmp\\x"; git rm -r docs; echo rm -rf x', ctx), []);
});

test('w6266: the scan never throws and finds nothing where nothing is', () => {
  assert.deepEqual(junctionRmScan('rm -rf "$TMPDIR/does-not-exist-w6266"', ctx), { found: [], unfinished: [] });
  assert.deepEqual(junctionRmScan('git status', ctx), { found: [], unfinished: [] });
  assert.equal(junctionRmLogLine('s1', { found: [], unfinished: [] }), undefined);
  const line = junctionRmLogLine('s1', { found: [{ target: 'V:\\t', link: 'V:\\t\\j', lstatLink: false }], unfinished: ['V:\\u'] });
  assert.match(line!, /^junction rm warn \(w6266, warn\): s1 hit target="V:\\\\t" link="V:\\\\t\\\\j" lstatLink=false unfinished target="V:\\\\u"$/);
  assert.match(junctionRmMessage([{ target: 'V:\\t', link: 'V:\\t\\j', lstatLink: false }]), /the command still runs\).*cmd \/\/c "rd \/s \/q V:\\t"/);
});

/** `root/target/keep.txt`, and `root/tree/` with `sub/x.txt` and a junction `tree/sub/j` -> `target`. */
function junctionTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w6266-'));
  const target = path.join(root, 'target');
  const tree = path.join(root, 'tree');
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(tree, 'sub', 'x.txt'), 'x');
  const junction = path.join(tree, 'sub', 'j');
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, target], { stdio: 'ignore' });
  return { root, target, tree, junction, done: () => execFileSync('cmd.exe', ['/c', 'rd', '/s', '/q', root], { stdio: 'ignore' }) };
}

test('w6266: the walk finds a mklink /J junction by its folder entry, and stops at its budget', { skip: !win && 'mklink /J is Windows only' }, () => {
  const t = junctionTree();
  try {
    assert.deepEqual(firstLink(t.tree), { link: t.junction, done: true });
    assert.deepEqual(firstLink(t.junction), { link: t.junction, done: true }, 'the target itself a junction');
    assert.deepEqual(firstLink(t.target), { done: true }, 'no link: done, none found');
    assert.deepEqual(firstLink(t.tree, { maxEntries: 0 }), { done: false }, 'the entry budget');
    let clock = 0;
    assert.deepEqual(firstLink(t.tree, { now: () => (clock += 1000) }), { done: false }, 'the time budget');
    const scan = junctionRmScan(`rm -rf "${t.tree}"`, {});
    assert.equal(scan.found.length, 1);
    assert.equal(scan.found[0].link, t.junction);
    assert.ok(fs.existsSync(path.join(t.target, 'keep.txt')), 'the scan deleted nothing');
  } finally {
    t.done();
  }
});

const pre = (command: string, cwd: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd });
type Out = { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string } };

test('w6266: the guard lets an rm -r over a junction run, warns the agent and logs one line', { skip: !win && 'mklink /J is Windows only' }, async () => {
  const t = junctionTree();
  const lines: string[] = [];
  try {
    const g = sandboxGuard({ sandboxId: 'sb1', sandboxPath: t.root, protectedPaths: [], prBase: () => undefined, evidence: () => undefined, session: 'sess-1', junctionRmWarn: true, log: (l) => lines.push(l) });
    const run = async (c: string) => (await g(pre(c, t.root) as never, 'x', { signal: new AbortController().signal })) as Out;
    const r = await run('rm -rf tree');
    assert.equal(r.hookSpecificOutput?.permissionDecision, undefined, 'warn-only: no decision, the command runs');
    assert.match(r.hookSpecificOutput?.additionalContext ?? '', /holds a link.*rd \/s \/q/);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^junction rm warn \(w6266, warn\): sess-1 hit target=.*lstatLink=(true|false)$/);
    // rd, rm of files and an rm -r of a folder with no link: no warning, no line.
    for (const c of [`cmd //c "rd /s /q ${t.tree}"`, 'rm -f tree/sub/x.txt', 'rm -rf target']) assert.deepEqual(await run(c), {}, c);
    assert.equal(lines.length, 1);
    assert.ok(fs.existsSync(path.join(t.target, 'keep.txt')));
  } finally {
    t.done();
  }
});

test('w6266: a refusal wins over the warning, and the warning is off where it is not asked for', async () => {
  const lines: string[] = [];
  const g = sandboxGuard({ sandboxId: 'sb1', sandboxPath: 'C:/ffsb/sb1', protectedPaths: ['C:/Users/dev/games/MyGame'], prBase: () => undefined, evidence: () => undefined, junctionRmWarn: true, log: (l) => lines.push(l) });
  const r = (await g(pre('rm -rf /c/Users/dev/games/MyGame', 'C:/ffsb/sb1') as never, 'x', { signal: new AbortController().signal })) as Out;
  assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(r.hookSpecificOutput?.additionalContext, undefined);
  assert.equal(lines.length, 0);
  const off = sandboxGuard({ sandboxId: 'sb1', sandboxPath: 'C:/ffsb/sb1', protectedPaths: [], prBase: () => undefined, evidence: () => undefined, platform: 'linux', log: (l) => lines.push(l) });
  assert.deepEqual(await off(pre('rm -rf x', 'C:/ffsb/sb1') as never, 'x', { signal: new AbortController().signal }), {});
});
