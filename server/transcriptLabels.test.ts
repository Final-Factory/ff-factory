import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, type spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { deniesDeleteChild, explicitMedium, isLink, labelTree, labelTreeSync, liveSessionIds, lockTranscripts, lowTranscriptSpawner, ownFiles, probeTranscriptLock, setLabelSync, unlockTranscripts, type IcaclsSync } from './transcriptLabels.ts';
import { projectSlug } from './claudeHome.ts';
import type { Exec } from '../machine/lowIntegrity.ts';

/**
 * w5703: the Windows half of "transcripts are read-only to workers". Everywhere: which files a claude argv owns, the label
 * calls, the new conversation's gate (its file made only once the CLI answered `initialize`), the daemon's lock and its way
 * back. On Windows: the real labels refuse a Low process every write to another conversation's transcript and let its own
 * through, and the spawner runs a stand-in CLI that refuses a pre-made file the way Claude Code does.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w5703-'));
const tick = () => new Promise((r) => setImmediate(r));
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

/** A fake icacls that records each call and answers what `answer` says. */
const recorder = (answer: (args: string[]) => { code: number; out: string } = () => ({ code: 0, out: 'ok' })) => {
  const calls: string[][] = [];
  const icacls: IcaclsSync = (args) => (calls.push(args), answer(args));
  return { calls, icacls };
};

/** A child the spawner can drive: what it is sent, its stdout, its exit. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, killed: false, exitCode: null as number | null, signalCode: null, kill: () => true });
  let got = '';
  child.stdin.on('data', (c: Buffer) => (got += c.toString()));
  return { child, got: () => got, run: (() => child) as unknown as typeof spawn };
}

const line = (o: object) => JSON.stringify(o) + '\n';
const INIT = line({ type: 'control_request', request_id: 'r1', request: { subtype: 'initialize' } });
const USER = line({ type: 'user', message: { role: 'user', content: 'hi' } });

test('ownFiles: a new conversation goes in the cwd folder, a resume is found in any project folder', () => {
  const home = tmp();
  const cwd = path.join(home, 'work');
  const env = { CLAUDE_CONFIG_DIR: home };
  const fresh = ownFiles({ args: ['--session-id', SID], cwd, env });
  assert.deepEqual(fresh, { sid: SID, file: path.join(home, 'projects', projectSlug(cwd), `${SID}.jsonl`), dir: path.join(home, 'projects', projectSlug(cwd), SID), exists: false });
  const elsewhere = path.join(home, 'projects', 'old-slug');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, `${SID}.jsonl`), '{}\n');
  assert.deepEqual(ownFiles({ args: ['--resume', SID], cwd, env }), { sid: SID, file: path.join(elsewhere, `${SID}.jsonl`), dir: path.join(elsewhere, SID), exists: true });
  assert.equal(ownFiles({ args: ['--resume', '../x'], cwd, env }), undefined);
  assert.equal(ownFiles({ args: ['--session-id', SID], cwd, env: {} }), undefined);
});

test('setLabelSync grants the account Full and retries when icacls is denied, and throws when it still fails', () => {
  let denied = true;
  const r = recorder((a) => (a[1] === '/grant' ? ((denied = false), { code: 0, out: '' }) : denied ? { code: 5, out: 'Access is denied.' } : { code: 0, out: '' }));
  setLabelSync('X:\\p', '(OI)(CI)low', r.icacls, 'HOST\\me');
  assert.deepEqual(r.calls, [['X:\\p', '/setintegritylevel', '(OI)(CI)low'], ['X:\\p', '/grant', 'HOST\\me:(OI)(CI)F'], ['X:\\p', '/setintegritylevel', '(OI)(CI)low']]);
  const f = recorder(() => ({ code: 1, out: 'The system cannot find the file specified.' }));
  assert.throws(() => setLabelSync('X:\\f', 'low', f.icacls, 'HOST\\me'), /cannot find/);
  assert.equal(f.calls.length, 1);
});

test('a new conversation: control lines pass, the first message waits for the CLI, its file is made Low, then Medium at exit', async () => {
  const home = tmp();
  const cwd = path.join(home, 'work');
  const r = recorder();
  const f = fakeChild();
  const own = ownFiles({ args: ['--session-id', SID], cwd, env: { CLAUDE_CONFIG_DIR: home } })!;
  const p = lowTranscriptSpawner({ run: f.run, icacls: r.icacls, log: () => {} })({ command: 'claude', args: ['--session-id', SID], cwd, env: { CLAUDE_CONFIG_DIR: home }, signal: new AbortController().signal });
  assert.equal((p as { pid?: number }).pid, 4242);
  assert.ok(fs.statSync(own.dir).isDirectory(), 'its folder is made before the CLI starts');
  const labels = () => r.calls.filter((c) => c[1] === '/setintegritylevel');
  assert.deepEqual(labels(), [[own.dir, '/setintegritylevel', '(OI)(CI)low']], 'its folder walked, never with /T');
  assert.deepEqual(r.calls.filter((c) => c[1] === '/deny').map((c) => c[0]), process.env.USERNAME ? [path.dirname(own.file)] : [], 'a project folder it makes gets delete-child taken back');
  p.stdin.write(INIT + USER.slice(0, 10));
  p.stdin.write(USER.slice(10));
  await tick();
  assert.equal(f.got(), INIT, 'only initialize reaches the CLI');
  assert.equal(fs.existsSync(own.file), false, 'no file while the CLI runs its start-up check');
  f.child.stdout.write(line({ type: 'control_response', response: { subtype: 'success', request_id: 'r1' } }));
  await tick();
  assert.equal(fs.readFileSync(own.file, 'utf8'), '', 'made empty once initialize is answered');
  assert.deepEqual(r.calls.at(-1), [own.file, '/setintegritylevel', 'low']);
  await tick();
  assert.equal(f.got(), INIT + USER, 'the held message goes through, whole and in order');
  p.stdin.write(USER);
  await tick();
  assert.equal(f.got(), INIT + USER + USER);
  f.child.emit('exit', 0, null);
  assert.deepEqual(labels().slice(-2), [[own.file, '/setintegritylevel', 'medium'], [own.dir, '/setintegritylevel', '(OI)(CI)medium']]);
});

test('a resume labels its file Low at once and passes stdin straight through; two processes of one conversation share the label', async () => {
  const home = tmp();
  const cwd = path.join(home, 'work');
  const file = path.join(home, 'projects', projectSlug(cwd), `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  const r = recorder();
  const a = fakeChild();
  const b = fakeChild();
  const o = { args: ['--resume', SID], cwd, env: { CLAUDE_CONFIG_DIR: home }, signal: new AbortController().signal };
  const p = lowTranscriptSpawner({ run: a.run, icacls: r.icacls, log: () => {} })({ command: 'claude', ...o });
  lowTranscriptSpawner({ run: b.run, icacls: r.icacls, log: () => {} })({ command: 'claude', ...o });
  assert.ok(r.calls.some((c) => c[0] === file && c[2] === 'low'));
  p.stdin.write(USER);
  await tick();
  assert.equal(a.got(), USER);
  a.child.emit('exit', 0, null);
  assert.ok(!r.calls.some((c) => c[2] === 'medium'), 'the other process still runs');
  b.child.emit('exit', 0, null);
  assert.ok(r.calls.some((c) => c[0] === file && c[2] === 'medium'));
});

test('the gate opens after gateMs when the CLI never answers, and an end sent while held reaches the CLI after the message', async () => {
  const home = tmp();
  const cwd = path.join(home, 'work');
  const logs: string[] = [];
  const f = fakeChild();
  let ended = false;
  f.child.stdin.on('finish', () => (ended = true));
  const p = lowTranscriptSpawner({ run: f.run, icacls: recorder().icacls, log: (l) => logs.push(l), gateMs: 30 })({ command: 'claude', args: ['--session-id', SID], cwd, env: { CLAUDE_CONFIG_DIR: home }, signal: new AbortController().signal });
  p.stdin.write(USER);
  p.stdin.end();
  await tick();
  assert.equal(f.got(), '');
  assert.equal(ended, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(f.got(), USER);
  assert.equal(ended, true);
  assert.match(logs.join('\n'), /no initialize answer/);
});

test('explicitMedium reads only an own Medium label, not an inherited one or Low', () => {
  assert.equal(explicitMedium('X:\\p HOST\\me:(OI)(CI)(F)\r\n    Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)\r\n'), true);
  assert.equal(explicitMedium('X:\\p Mandatory Label\\Medium Mandatory Level:(I)(OI)(CI)(NW)'), false);
  assert.equal(explicitMedium('X:\\p Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)'), false);
  assert.equal(explicitMedium('X:\\p HOST\\me:(F)'), false);
});

test('lockTranscripts keeps recent conversations Low, labels projects Medium last, and is done once', async () => {
  const projects = path.join(tmp(), 'projects');
  const slug = path.join(projects, 'F--work');
  fs.mkdirSync(path.join(slug, 'old'), { recursive: true });
  fs.mkdirSync(path.join(slug, 'new'));
  fs.mkdirSync(path.join(slug, 'memory'));
  for (const n of ['old.jsonl', 'new.jsonl', 'notes.txt']) fs.writeFileSync(path.join(slug, n), '');
  const week = (Date.now() - 7 * 24 * 3600_000) / 1000;
  fs.utimesSync(path.join(slug, 'old.jsonl'), week, week);
  fs.utimesSync(path.join(slug, 'old'), week, week);
  let label = '';
  const exec: Exec = async () => ({ code: 0, stdout: label, stderr: '' });
  const r = recorder();
  const said: string[] = [];
  assert.equal(await lockTranscripts(projects, exec, (l) => said.push(l), { icacls: r.icacls, account: 'HOST\\me' }), true);
  const w = (n: string) => path.join('F--work', n);
  const byName = (a: string[], b: string[]) => a[0].localeCompare(b[0]);
  assert.deepEqual(r.calls.map((c) => [path.relative(projects, c[0]), ...c.slice(1)]), [
    // delete-child taken back first: a DACL change pushes the folder's inheritable label down again
    ['..', '/deny', 'HOST\\me:(DC)'],
    ['', '/deny', 'HOST\\me:(DC)'],
    ['F--work', '/deny', 'HOST\\me:(DC)'],
    // the folders Medium before anything in them is read: no Low process can put a junction in them after (w5774)
    ['', '/setintegritylevel', '(OI)(CI)medium'],
    ['F--work', '/setintegritylevel', '(OI)(CI)medium'],
    // then each entry on its own, never /T: the recent conversations (no live list: written in 3 days) pinned Low, the rest
    // Medium explicitly (an old explicit Low is not overridden by what it inherits)
    ...[
      [w('memory'), '/setintegritylevel', '(OI)(CI)medium'],
      [w('new'), '/setintegritylevel', '(OI)(CI)low'],
      [w('new.jsonl'), '/setintegritylevel', 'low'],
      [w('notes.txt'), '/setintegritylevel', 'medium'],
      [w('old'), '/setintegritylevel', '(OI)(CI)medium'],
      [w('old.jsonl'), '/setintegritylevel', 'medium'],
    ].sort(byName),
  ]);
  assert.match(said[0], /1 project folder and 4 transcripts and folders in them; 2 running or written in the last 3 days/);
  label = `${projects} Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)`;
  // Later starts: a project folder without the deny (made since by a Medium process) gets it; one with it is only read.
  const again = recorder();
  assert.equal(await lockTranscripts(projects, exec, () => {}, { icacls: again.icacls, account: 'HOST\\me' }), true);
  assert.deepEqual(again.calls.map((c) => [path.relative(projects, c[0]), ...c.slice(1)]), [['F--work'], ['F--work', '/deny', 'HOST\\me:(DC)']]);
  const denied = recorder(() => ({ code: 0, out: 'F--work HOST\\me:(DENY)(DC)\r\n' }));
  assert.equal(await lockTranscripts(projects, exec, () => {}, { icacls: denied.icacls, account: 'HOST\\me' }), true);
  assert.deepEqual(denied.calls.length, 1);
});

test('lockTranscripts and unlockTranscripts leave the event loop free between icacls calls, and run icacls through exec by default', async () => {
  // On BEAST the first lock ran ~400 synchronous icacls calls on the daemon's loop and held its heartbeats 5.5 minutes
  // (w5703, 2026-11-25). Each call here holds the thread 5 ms, as a synchronous icacls does: a 1 ms timer must still tick.
  const projects = path.join(tmp(), 'projects');
  const slug = path.join(projects, 'F--work');
  fs.mkdirSync(path.join(slug, 'old'), { recursive: true });
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(slug, `old-${i}.jsonl`), '');
  const week = (Date.now() - 7 * 24 * 3600_000) / 1000;
  for (const n of fs.readdirSync(slug)) fs.utimesSync(path.join(slug, n), week, week);
  let label = '';
  const exec: Exec = async () => ({ code: 0, stdout: label, stderr: '' });
  const slow = recorder(() => {
    const until = Date.now() + 5;
    while (Date.now() < until) {
      /* a synchronous icacls */
    }
    return { code: 0, out: 'ok' };
  });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    assert.equal(await lockTranscripts(projects, exec, () => {}, { icacls: slow.icacls, account: 'HOST\\me' }), true);
    assert.ok(slow.calls.length >= 10, `${slow.calls.length} calls`);
    assert.ok(ticks >= slow.calls.length / 2, `the loop ticked ${ticks} times in ${slow.calls.length} icacls calls`);
    label = `${projects} Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)`;
    ticks = 0;
    slow.calls.length = 0;
    await unlockTranscripts(projects, exec, () => {}, slow.icacls, 'HOST\\me');
    assert.ok(slow.calls.length > 0, 'unlock ran icacls (a label it misread would return at once and prove nothing)');
    assert.ok(ticks >= slow.calls.length / 2, `unlock: the loop ticked ${ticks} times in ${slow.calls.length} icacls calls`);
  } finally {
    clearInterval(timer);
  }
  // With no icacls given, every call goes through the daemon's (asynchronous) exec.
  const viaExec: string[][] = [];
  label = '';
  const projects2 = path.join(tmp(), 'projects');
  fs.mkdirSync(path.join(projects2, 'F--work'), { recursive: true });
  const exec2: Exec = async (cmd, args) => (assert.equal(cmd, 'icacls'), viaExec.push(args), { code: 0, stdout: args.length === 1 ? label : 'ok', stderr: '' });
  assert.equal(await lockTranscripts(projects2, exec2, () => {}, { account: 'HOST\\me' }), true);
  assert.deepEqual(viaExec.slice(1).map((a) => a.slice(1)), [['/deny', 'HOST\\me:(DC)'], ['/deny', 'HOST\\me:(DC)'], ['/deny', 'HOST\\me:(DC)'], ['/setintegritylevel', '(OI)(CI)medium'], ['/setintegritylevel', '(OI)(CI)medium']]);
});

test('lockTranscripts pins running and recent conversations, and a later start takes back to Medium the pins no longer running', async () => {
  const root = tmp();
  const projects = path.join(root, 'projects');
  const slug = path.join(projects, 'F--work');
  fs.mkdirSync(slug, { recursive: true });
  const pins = path.join(root, 'transcript-pins.json');
  const at = (n: string) => path.join(slug, n);
  for (const n of [`${SID}.jsonl`, 'cccccccc-old.jsonl', 'dddddddd-recent.jsonl']) fs.writeFileSync(at(n), '');
  const week = (Date.now() - 7 * 24 * 3600_000) / 1000;
  for (const n of [`${SID}.jsonl`, 'cccccccc-old.jsonl']) fs.utimesSync(at(n), week, week);
  let label = '';
  const exec: Exec = async () => ({ code: 0, stdout: label, stderr: '' });
  const r = recorder();
  assert.equal(await lockTranscripts(projects, exec, () => {}, { icacls: r.icacls, account: 'HOST\\me', live: new Set([SID]), pins }), true);
  const lows = r.calls.filter((c) => c[2] === 'low').map((c) => c[0]);
  assert.deepEqual(lows.sort(), [at(`${SID}.jsonl`), at('dddddddd-recent.jsonl')], 'running (old but live) and written in the hour');
  assert.ok(r.calls.some((c) => c[0] === at('cccccccc-old.jsonl') && c[2] === 'medium'));
  assert.deepEqual(JSON.parse(fs.readFileSync(pins, 'utf8')).sort(), lows);

  label = `${projects} Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)`;
  const deny = () => ({ code: 0, out: '(DENY)(DC)' });
  // What runs unknown: every pin kept.
  const unknown = recorder(deny);
  await lockTranscripts(projects, exec, () => {}, { icacls: unknown.icacls, account: 'HOST\\me', pins });
  assert.ok(!unknown.calls.some((c) => c[1] === '/setintegritylevel'));
  // Two hours on, only SID still runs: the other pin goes back to Medium and leaves the list.
  const later = recorder(deny);
  const said: string[] = [];
  await lockTranscripts(projects, exec, (l) => said.push(l), { icacls: later.icacls, account: 'HOST\\me', live: new Set([SID]), pins, now: Date.now() + 2 * 3600_000 });
  assert.deepEqual(later.calls.filter((c) => c[1] === '/setintegritylevel'), [[at('dddddddd-recent.jsonl'), '/setintegritylevel', 'medium']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(pins, 'utf8')), [at(`${SID}.jsonl`)]);
  assert.match(said.join('\n'), /1 pinned conversation entry no longer running labelled Medium/);
});

test('labelTree to Low leaves a sub-folder that already answers Low unread, and walks one that answers Medium', async () => {
  const tree = path.join(tmp(), 'tree');
  for (const d of ['low', 'med']) {
    fs.mkdirSync(path.join(tree, d, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tree, d, 'x.jsonl'), '');
  }
  const lowOut = (p: string) => `${p} Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)\r\n`;
  const answer = (args: string[]) => ({ code: 0, out: args.length === 1 && args[0].startsWith(path.join(tree, 'low')) ? lowOut(args[0]) : 'ok' });
  for (const run of ['sync', 'async'] as const) {
    const r = recorder(answer);
    if (run === 'sync') labelTreeSync(tree, 'low', r.icacls, 'HOST\\me');
    else await labelTree(tree, 'low', r.icacls, 'HOST\\me');
    const inLow = r.calls.filter((c) => c[0].startsWith(path.join(tree, 'low') + path.sep));
    assert.deepEqual(inLow, [], `${run}: nothing inside the Low sub-folder is read or labelled: ${JSON.stringify(inLow)}`);
    assert.ok(r.calls.some((c) => c[0].startsWith(path.join(tree, 'med') + path.sep) && c[1] === '/setintegritylevel'), `${run}: the Medium sub-folder is walked`);
  }
});

test('labelTreeSync never follows a junction: it labels each real entry and skips the link, both ways', { skip: process.platform !== 'win32' ? 'junctions are a Windows thing' : false }, () => {
  const root = tmp();
  const tree = path.join(root, 'tree');
  const target = path.join(root, 'target');
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(tree, 'a.jsonl'), '');
  fs.writeFileSync(path.join(tree, 'sub', 'b.txt'), '');
  fs.symlinkSync(target, path.join(tree, 'link'), 'junction');
  for (const level of ['medium', 'low'] as const) {
    const r = recorder();
    assert.equal(labelTreeSync(tree, level, r.icacls, 'HOST\\me'), 1, level);
    const labelled = r.calls.filter((c) => c[1] === '/setintegritylevel');
    assert.ok(!r.calls.some((c) => c[0].startsWith(target) || c[0] === path.join(tree, 'link') || c[0] === path.join(tree, '*')), `${level}: nothing names the link or a wildcard beside it: ${JSON.stringify(r.calls)}`);
    assert.ok(!r.calls.some((c) => c.includes('/T')));
    assert.deepEqual(labelled.map((c) => c[0]).sort(), [tree, path.join(tree, 'a.jsonl'), path.join(tree, 'sub'), path.join(tree, 'sub', '*')].sort(), level);
    if (level === 'medium') assert.deepEqual(labelled[0], [tree, '/setintegritylevel', '(OI)(CI)medium'], 'the folder first, before it is read');
    else assert.deepEqual(labelled.at(-1), [tree, '/setintegritylevel', '(OI)(CI)low'], 'the folder last, after what is in it');
  }
  assert.throws(() => labelTreeSync(path.join(tree, 'link'), 'medium', recorder().icacls, 'HOST\\me'), /junction or link/);
  assert.throws(() => setLabelSync(path.join(tree, 'link'), 'low', recorder().icacls, 'HOST\\me'), /junction or link/);
});

test('liveSessionIds reads --resume and --session-id off the command lines, and is unknown when the call fails', async () => {
  const out = `node cli.js --resume ${SID} --output-format stream-json\r\n"C:\\x\\claude.exe" --session-id="bbbbbbbb-2222" -p\r\nnode other.js --resume ..\\x\r\n`;
  assert.deepEqual([...((await liveSessionIds(async () => ({ code: 0, stdout: out, stderr: '' }))) ?? [])], [SID, 'bbbbbbbb-2222']);
  assert.equal(await liveSessionIds(async () => ({ code: 1, stdout: '', stderr: 'no' })), undefined);
  assert.equal(deniesDeleteChild('X:\\p HOST\\me:(DENY)(DC)\r\n'), true);
  assert.equal(deniesDeleteChild('X:\\p HOST\\me:(OI)(CI)(F)\r\n'), false);
});

test('lockTranscripts says so and answers false when the label cannot be set', async () => {
  const projects = path.join(tmp(), 'projects');
  const said: string[] = [];
  const r = recorder(() => ({ code: 1, out: 'Access is denied.' }));
  assert.equal(await lockTranscripts(projects, async () => ({ code: 0, stdout: '', stderr: '' }), (l) => said.push(l), { icacls: r.icacls }), false);
  assert.match(said.join('\n'), /could not label .* Medium/);
});

test('unlockTranscripts labels everything Low again only where a lock was set', async () => {
  const projects = path.join(tmp(), 'projects');
  fs.mkdirSync(path.join(projects, 'F--work', SID), { recursive: true });
  fs.writeFileSync(path.join(projects, 'F--work', `${SID}.jsonl`), '');
  const none = recorder();
  await unlockTranscripts(projects, async () => ({ code: 0, stdout: 'Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)', stderr: '' }), () => {}, none.icacls);
  assert.deepEqual(none.calls, []);
  const r = recorder();
  await unlockTranscripts(projects, async () => ({ code: 0, stdout: 'Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)', stderr: '' }), () => {}, r.icacls, 'HOST\\me');
  // Walked, not /T: each folder's contents before the folder, `projects` itself last, so a way back cut off half way is
  // tried again at the next start (it still carries its Medium label).
  assert.deepEqual(r.calls.map((c) => [path.relative(projects, c[0]), ...c.slice(1)]), [
    ['..', '/remove:d', 'HOST\\me'],
    ['', '/remove:d', 'HOST\\me'],
    ['F--work', '/remove:d', 'HOST\\me'],
    [''],
    ['F--work'],
    [path.join('F--work', SID)],
    [path.join('F--work', '*'), '/setintegritylevel', 'low'],
    [path.join('F--work', SID), '/setintegritylevel', '(OI)(CI)low'],
    ['*', '/setintegritylevel', 'low'],
    ['F--work', '/setintegritylevel', '(OI)(CI)low'],
    ['', '/setintegritylevel', '(OI)(CI)low'],
  ]);
});

/**
 * A stand-in for Claude Code's start-up and appends, run at Low: refuses a pre-made `<id>.jsonl` for `--session-id` the way
 * the CLI does ("already in use"), answers initialize, appends each user message, and tries the other conversation's file.
 */
const FAKE_CLI = `
const fs=require('fs'),path=require('path');const a=process.argv;const sid=a[a.indexOf('--session-id')+1];
const file=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.env.SLUG,sid+'.jsonl');
if(fs.existsSync(file)){console.error('Session ID '+sid+' is already in use');process.exit(3)}
let buf='';process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
if(l.type==='control_request')process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:l.request_id}})+'\\n');
else{fs.appendFileSync(file,JSON.stringify(l)+'\\n');fs.writeFileSync(path.join(path.dirname(file),sid,'tool.txt'),'x');
let other='refused';try{fs.appendFileSync(process.env.OTHER,'x')}catch{other='refused ok'}
let junction='none';if(process.env.JUNCTION)try{fs.symlinkSync(process.env.JUNCTION,path.join(path.dirname(file),sid,'link'),'junction');junction='made'}catch(e){junction=e.code}
process.stdout.write(JSON.stringify({type:'result',other,junction})+'\\n')}}});
process.stdin.on('end',()=>process.exit(0));`;

/** A Low process cannot label anything Medium (a worker on a fenced machine): the Windows leg needs Medium or above (CI, the daemon). */
const atLowItself = () => process.platform === 'win32' && /Low Mandatory Level/i.test(execFileSync(path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'whoami.exe'), ['/groups'], { encoding: 'utf8' }));

/**
 * Removes privileges from a running process's token (PowerShell P/Invoke of AdjustTokenPrivileges, SE_PRIVILEGE_REMOVED);
 * answers one line per name: `removed`, or `not held`. A privilege not in the token is not an error.
 */
const PRIV_PS = `param([int]$procId, [string]$names)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class FfPriv {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct TP { public int Count; public long Luid; public int Attr; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string sys, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool all, ref TP state, int len, IntPtr prev, IntPtr ret);
  public static string Remove(int pid, string name) {
    IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "OpenProcess " + Marshal.GetLastWin32Error();
    IntPtr t; if (!OpenProcessToken(h, 0x28, out t)) return "OpenProcessToken " + Marshal.GetLastWin32Error();
    long luid; if (!LookupPrivilegeValue(null, name, out luid)) return "LookupPrivilegeValue " + Marshal.GetLastWin32Error();
    TP tp = new TP(); tp.Count = 1; tp.Luid = luid; tp.Attr = 4;
    if (!AdjustTokenPrivileges(t, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return "AdjustTokenPrivileges " + Marshal.GetLastWin32Error();
    return Marshal.GetLastWin32Error() == 1300 ? "not held" : "removed";
  }
}
"@
foreach ($n in $names.Split(',')) { "$n " + [FfPriv]::Remove($procId, $n) }
`;
function removePrivileges(pid: number, names: string[], dir: string): string {
  const ps1 = path.join(dir, 'remove-privileges.ps1');
  fs.writeFileSync(ps1, PRIV_PS);
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, String(pid), names.join(',')], { encoding: 'utf8' }).trim();
}

test('Windows: a Low process cannot touch another transcript under the lock, its own stays writable, and the spawner runs a new conversation', { skip: process.platform !== 'win32' ? 'Windows only' : atLowItself() ? 'this process runs at Low and cannot set a Medium label' : false }, async (t) => {
  const root = tmp();
  const home = path.join(root, 'claude');
  // A GitHub runner's account holds SeBackupPrivilege and SeRestorePrivilege enabled, and a Low child keeps them: Node opens
  // files with FILE_FLAG_BACKUP_SEMANTICS, so they pass both the label and the ACL (measured, w5703: every write WRITTEN,
  // while cmd's >> at Low was refused). A worker's token holds neither (a filtered user token). Remove them from this
  // process so every child here, the spawner's included, has a worker's token.
  const removed = removePrivileges(process.pid, ['SeBackupPrivilege', 'SeRestorePrivilege'], root);
  t.diagnostic(`privileges: ${removed.split(/\s*\r?\n\s*/).join('; ')}`);
  assert.match(removed, /^SeBackupPrivilege (removed|not held)\s+SeRestorePrivilege (removed|not held)$/, removed);
  const projects = path.join(home, 'projects');
  const slug = path.join(projects, 'F--work');
  fs.mkdirSync(slug, { recursive: true });
  const other = path.join(slug, 'bbbbbbbb-other.jsonl');
  fs.writeFileSync(other, '{"type":"user"}\n');
  fs.mkdirSync(path.join(slug, 'bbbbbbbb-other'));
  // A subagent's transcript inside the other conversation's folder, with an explicit Low as an earlier label left it: an
  // (OI)(CI) label on its folder alone would not reach it (w5703, measured on the Windows CI runner).
  const sub = path.join(slug, 'bbbbbbbb-other', 'subagent.jsonl');
  fs.writeFileSync(sub, '{}\n');
  setLabelSync(sub, 'low');
  for (const n of ['bbbbbbbb-rename.jsonl', 'bbbbbbbb-delete.jsonl']) fs.writeFileSync(path.join(slug, n), '{}\n');
  setLabelSync(root, '(OI)(CI)low');
  setLabelSync(home, '(OI)(CI)low');
  const lowNode = path.join(root, 'node-low.exe');
  fs.copyFileSync(process.execPath, lowNode);
  setLabelSync(lowNode, 'low');
  const exec: Exec = async (cmd, args) => {
    try {
      return { code: 0, stdout: execFileSync(cmd, args, { encoding: 'utf8' }), stderr: '' };
    } catch (e) {
      return { code: 1, stdout: String((e as { stdout?: string }).stdout ?? ''), stderr: (e as Error).message };
    }
  };
  const atLow = (js: string, ...args: string[]) => execFileSync(lowNode, ['-e', js, ...args], { encoding: 'utf8' }).trim();
  const TRY = `const fs=require('fs');const out=[];const t=(w,f)=>{try{f();out.push(w+' WRITTEN')}catch(e){out.push(w+' '+e.code)}};`;
  // Before the lock every transcript is open to a Low worker: what the lock is for.
  assert.match(atLow(`${TRY}t('append',()=>fs.appendFileSync(process.argv[1],''));console.log(out.join())`, other), /append WRITTEN/);

  // Not written lately, so the lock labels them Medium rather than keeping them Low for a running conversation.
  const week = (Date.now() - 7 * 24 * 3600_000) / 1000;
  for (const n of ['bbbbbbbb-other.jsonl', 'bbbbbbbb-other', 'bbbbbbbb-rename.jsonl', 'bbbbbbbb-delete.jsonl']) fs.utimesSync(path.join(slug, n), week, week);
  assert.equal(await lockTranscripts(projects, exec, (l) => t.diagnostic(l)), true);
  for (const p of [home, projects, slug, other]) t.diagnostic(execFileSync('icacls', [p], { encoding: 'utf8' }).replace(/\s+/g, ' '));
  const own = path.join(slug, `${SID}.jsonl`);
  fs.writeFileSync(own, '');
  fs.mkdirSync(path.join(slug, SID));
  setLabelSync(own, 'low');
  setLabelSync(path.join(slug, SID), '(OI)(CI)low');
  const res = atLow(
    `${TRY}const [o,own,slug,projects,home]=process.argv.slice(1);const path=require('path');
t('append other',()=>fs.appendFileSync(o,'x'));t('truncate other',()=>fs.writeFileSync(o,''));
t('plant',()=>fs.writeFileSync(path.join(slug,'cccccccc.jsonl'),''));t('mkdir',()=>fs.mkdirSync(path.join(slug,'cccccccc')));
t('plant in other folder',()=>fs.writeFileSync(path.join(o.slice(0,-6),'x.txt'),''));t('append in other folder',()=>fs.appendFileSync(path.join(o.slice(0,-6),'subagent.jsonl'),'x'));
t('rename other',()=>fs.renameSync(path.join(slug,'bbbbbbbb-rename.jsonl'),path.join(slug,'bbbbbbbb-renamed.jsonl')));
t('rename other to its folder',()=>fs.renameSync(o,path.join(o.slice(0,-6),'moved.jsonl')));t('delete other',()=>fs.unlinkSync(path.join(slug,'bbbbbbbb-delete.jsonl')));
t('delete other folder',()=>fs.rmSync(o.slice(0,-6),{recursive:true}));
t('new project folder',()=>fs.mkdirSync(path.join(projects,'F--evil')));
t('append own',()=>fs.appendFileSync(own,'{}\\n'));t('own folder',()=>fs.writeFileSync(path.join(own.slice(0,-6),'t.txt'),'x'));
t('rename projects',()=>{fs.renameSync(projects,projects+'-moved');fs.renameSync(projects+'-moved',projects)});
const cp=require('child_process');const ic=(w,a)=>{try{cp.execFileSync('icacls',a,{stdio:'pipe'});out.push(w+' WRITTEN')}catch(e){out.push(w+' EPERM')}};
const me=process.env.USERDOMAIN+String.fromCharCode(92)+process.env.USERNAME;
ic('undo deny on projects',[projects,'/remove:d',me]);ic('label projects low',[projects,'/setintegritylevel','(OI)(CI)low']);ic('undo deny on claude',[home,'/remove:d',me]);
console.log(out.join('; '))`,
    other,
    own,
    slug,
    projects,
    home,
  );
  t.diagnostic(`at Low under the lock: ${res}`);
  for (const w of ['append other', 'truncate other', 'plant', 'mkdir', 'plant in other folder', 'append in other folder', 'rename other', 'rename other to its folder', 'delete other', 'delete other folder', 'new project folder', 'undo deny on projects', 'label projects low']) assert.match(res, new RegExp(`${w} E(ACCES|PERM)`), w);
  assert.match(res, /append own WRITTEN/);
  assert.match(res, /own folder WRITTEN/);
  assert.match(res, /rename projects E(ACCES|PERM)/, 'a Low worker cannot move the locked folder aside, though its parent is Low');
  assert.equal(fs.readFileSync(other, 'utf8'), '{"type":"user"}\n');
  assert.ok(fs.existsSync(path.join(slug, 'bbbbbbbb-rename.jsonl')) && fs.existsSync(path.join(slug, 'bbbbbbbb-delete.jsonl')));
  assert.doesNotMatch(probeTranscriptLock(lowNode, projects), /WRITTEN|failed/);

  // The spawner end to end, the stand-in CLI at Low: a pre-made file would stop it, the gate makes the file in time.
  const sid2 = 'dddddddd-2222';
  const cwd = path.join(root, 'work');
  // A Medium folder outside the transcripts that the stand-in CLI, at Low, points a junction at from its own Low folder: the
  // relabels at its exit and at the way back must leave it Medium (w5774: icacls /T followed such a junction and relabelled
  // the target Low, measured on BEAST).
  const target = path.join(root, 'medium-target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'medium\n');
  setLabelSync(target, '(OI)(CI)medium');
  setLabelSync(path.join(target, 'keep.txt'), 'medium');
  const targetStaysMedium = (when: string) => {
    const shown = execFileSync('icacls', [target], { encoding: 'utf8' });
    t.diagnostic(`junction target ${when}: ${shown.replace(/\s+/g, ' ')}`);
    assert.doesNotMatch(shown, /Low Mandatory Level/, `the junction's target is not labelled Low ${when}`);
    assert.match(atLow(`${TRY}t('append',()=>fs.appendFileSync(process.argv[1],'x'));t('plant',()=>fs.writeFileSync(process.argv[2],''));console.log(out.join())`, path.join(target, 'keep.txt'), path.join(target, 'planted.txt')), /append E(ACCES|PERM),plant E(ACCES|PERM)/, when);
  };
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, SLUG: projectSlug(cwd), OTHER: other, JUNCTION: target } as Record<string, string>;
  fs.mkdirSync(cwd);
  const p = lowTranscriptSpawner({ log: (l) => t.diagnostic(l) })({ command: lowNode, args: ['-e', FAKE_CLI, '--', '--session-id', sid2], cwd, env, signal: new AbortController().signal });
  let out = '';
  p.stdout.on('data', (c: Buffer) => (out += c.toString()));
  const exited = new Promise<number | null>((r) => p.once('exit', (code: number | null) => r(code)));
  p.stdin.write(INIT + USER);
  const done = Date.now() + 30_000;
  while (!out.includes('"result"') && Date.now() < done) await new Promise((r) => setTimeout(r, 50));
  // The Low CLI's own try: the Windows runner refused it (EPERM, measured: a Low process may point a junction only at a
  // folder it can write). The labels must not lean on that, so where it was refused a link is put there anyway, as any other
  // route would (a symlink, a junction made while its target was Low), before the exit relabel walks the folder.
  const link = path.join(projects, projectSlug(cwd), sid2, 'link');
  const planted = /"junction":"(\w+)"/.exec(out)?.[1];
  t.diagnostic(`a junction from the Low CLI to a Medium folder: ${planted}`);
  assert.match(planted ?? '', /^(made|EPERM|EACCES)$/, out);
  if (planted !== 'made') fs.symlinkSync(target, link, 'junction');
  p.stdin.end();
  assert.equal(await exited, 0, out);
  assert.match(out, /"other":"refused ok"/);
  assert.ok(isLink(link), 'the junction is still there at the relabels');
  targetStaysMedium('after the spawner labelled the conversation Medium at its exit');
  const file2 = path.join(projects, projectSlug(cwd), `${sid2}.jsonl`);
  assert.equal(fs.readFileSync(file2, 'utf8'), USER);
  assert.equal(fs.readFileSync(path.join(projects, projectSlug(cwd), sid2, 'tool.txt'), 'utf8'), 'x');
  assert.match(atLow(`${TRY}t('append after exit',()=>fs.appendFileSync(process.argv[1],'x'));console.log(out.join())`, file2), /append after exit E(ACCES|PERM)/);

  // The way back: everything Low again.
  await unlockTranscripts(projects, exec, (l) => t.diagnostic(l));
  for (const p of [projects, other]) t.diagnostic(`after unlock: ${execFileSync('icacls', [p], { encoding: 'utf8' }).replace(/\s+/g, ' ')}`);
  targetStaysMedium('after the way back labelled everything Low');
  // A transcript the lock labelled Medium is Low again: an (OI)(CI) label on `projects` alone left it Medium (measured).
  assert.match(
    atLow(`${TRY}t('append',()=>fs.appendFileSync(process.argv[1],''));t('plant',()=>fs.writeFileSync(process.argv[2],''));t('append sub',()=>fs.appendFileSync(process.argv[3],''));console.log(out.join())`, other, path.join(slug, 'eeeeeeee.jsonl'), sub),
    /append WRITTEN,plant WRITTEN,append sub WRITTEN/,
  );
});
