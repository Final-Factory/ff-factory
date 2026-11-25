import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, type spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { explicitMedium, lockTranscripts, lowTranscriptSpawner, ownFiles, probeTranscriptLock, setLabelSync, unlockTranscripts, type IcaclsSync } from './transcriptLabels.ts';
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
  assert.deepEqual(labels(), [[own.dir, '/setintegritylevel', '(OI)(CI)low', '/T']]);
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
  assert.deepEqual(labels().slice(-2), [[own.file, '/setintegritylevel', 'medium'], [own.dir, '/setintegritylevel', '(OI)(CI)medium', '/T']]);
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
    // the recent conversations first, a folder with all inside it
    // delete-child taken back first: a DACL change pushes the folder's inheritable label down again
    ['..', '/deny', 'HOST\\me:(DC)'],
    ['', '/deny', 'HOST\\me:(DC)'],
    ['F--work', '/deny', 'HOST\\me:(DC)'],
    ...[[w('new'), '/setintegritylevel', '(OI)(CI)low', '/T'], [w('new.jsonl'), '/setintegritylevel', 'low']].sort(byName),
    ['', '/setintegritylevel', '(OI)(CI)medium'],
    ['F--work', '/setintegritylevel', '(OI)(CI)medium'],
    // then everything else, explicitly: an old explicit Low is not overridden by what it inherits
    ...[
      [w('memory'), '/setintegritylevel', '(OI)(CI)medium', '/T'],
      [w('notes.txt'), '/setintegritylevel', 'medium'],
      [w('old'), '/setintegritylevel', '(OI)(CI)medium', '/T'],
      [w('old.jsonl'), '/setintegritylevel', 'medium'],
    ].sort(byName),
  ]);
  assert.match(said[0], /1 project folder and 4 transcripts and folders in them; 2 written/);
  label = `${projects} Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)`;
  const again = recorder();
  assert.equal(await lockTranscripts(projects, exec, () => {}, { icacls: again.icacls }), true);
  assert.deepEqual(again.calls, []);
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
  assert.deepEqual(r.calls.map((c) => [path.relative(projects, c[0]), ...c.slice(1)]), [['..', '/remove:d', 'HOST\\me'], ['', '/remove:d', 'HOST\\me'], ['F--work', '/remove:d', 'HOST\\me'], ['', '/setintegritylevel', '(OI)(CI)low', '/T']]);
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
process.stdout.write(JSON.stringify({type:'result',other})+'\\n')}}});
process.stdin.on('end',()=>process.exit(0));`;

/** A Low process cannot label anything Medium (a worker on a fenced machine): the Windows leg needs Medium or above (CI, the daemon). */
const atLowItself = () => process.platform === 'win32' && /Low Mandatory Level/i.test(execFileSync(path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'whoami.exe'), ['/groups'], { encoding: 'utf8' }));

test('Windows: a Low process cannot touch another transcript under the lock, its own stays writable, and the spawner runs a new conversation', { skip: process.platform !== 'win32' ? 'Windows only' : atLowItself() ? 'this process runs at Low and cannot set a Medium label' : false }, async (t) => {
  const root = tmp();
  const home = path.join(root, 'claude');
  const projects = path.join(home, 'projects');
  const slug = path.join(projects, 'F--work');
  fs.mkdirSync(slug, { recursive: true });
  const other = path.join(slug, 'bbbbbbbb-other.jsonl');
  fs.writeFileSync(other, '{"type":"user"}\n');
  fs.mkdirSync(path.join(slug, 'bbbbbbbb-other'));
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
t('plant in other folder',()=>fs.writeFileSync(path.join(o.slice(0,-6),'x.txt'),''));
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
  for (const w of ['append other', 'truncate other', 'plant', 'mkdir', 'plant in other folder', 'rename other', 'rename other to its folder', 'delete other', 'delete other folder', 'new project folder', 'undo deny on projects', 'label projects low']) assert.match(res, new RegExp(`${w} E(ACCES|PERM)`), w);
  assert.match(res, /append own WRITTEN/);
  assert.match(res, /own folder WRITTEN/);
  assert.match(res, /rename projects E(ACCES|PERM)/, 'a Low worker cannot move the locked folder aside, though its parent is Low');
  assert.equal(fs.readFileSync(other, 'utf8'), '{"type":"user"}\n');
  assert.ok(fs.existsSync(path.join(slug, 'bbbbbbbb-rename.jsonl')) && fs.existsSync(path.join(slug, 'bbbbbbbb-delete.jsonl')));
  assert.doesNotMatch(probeTranscriptLock(lowNode, projects), /WRITTEN|failed/);

  // The spawner end to end, the stand-in CLI at Low: a pre-made file would stop it, the gate makes the file in time.
  const sid2 = 'dddddddd-2222';
  const cwd = path.join(root, 'work');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, SLUG: projectSlug(cwd), OTHER: other } as Record<string, string>;
  fs.mkdirSync(cwd);
  const p = lowTranscriptSpawner({ log: (l) => t.diagnostic(l) })({ command: lowNode, args: ['-e', FAKE_CLI, '--', '--session-id', sid2], cwd, env, signal: new AbortController().signal });
  let out = '';
  p.stdout.on('data', (c: Buffer) => (out += c.toString()));
  const exited = new Promise<number | null>((r) => p.once('exit', (code: number | null) => r(code)));
  p.stdin.write(INIT + USER);
  const done = Date.now() + 30_000;
  while (!out.includes('"result"') && Date.now() < done) await new Promise((r) => setTimeout(r, 50));
  p.stdin.end();
  assert.equal(await exited, 0, out);
  assert.match(out, /"other":"refused ok"/);
  const file2 = path.join(projects, projectSlug(cwd), `${sid2}.jsonl`);
  assert.equal(fs.readFileSync(file2, 'utf8'), USER);
  assert.equal(fs.readFileSync(path.join(projects, projectSlug(cwd), sid2, 'tool.txt'), 'utf8'), 'x');
  assert.match(atLow(`${TRY}t('append after exit',()=>fs.appendFileSync(process.argv[1],'x'));console.log(out.join())`, file2), /append after exit E(ACCES|PERM)/);

  // The way back: everything Low again.
  await unlockTranscripts(projects, exec, (l) => t.diagnostic(l));
  assert.match(atLow(`${TRY}t('append',()=>fs.appendFileSync(process.argv[1],''));t('plant',()=>fs.writeFileSync(process.argv[2],''));console.log(out.join())`, other, path.join(slug, 'eeeeeeee.jsonl')), /append WRITTEN,plant WRITTEN/);
});
