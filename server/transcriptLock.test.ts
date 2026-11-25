import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FF_LANDLOCK, writeLockArgs, writeLockSpawner } from '../machine/writeLock.ts';
import { NEW_TRANSCRIPT, TRANSCRIPTS, finishNewTranscripts, linkTranscripts, ownTranscriptArgs } from '../machine/transcriptLock.ts';
import { projectSlug } from './claudeHome.ts';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

// w5702: the Linux half of w5563 (machine/transcriptLock.ts, docs/transcript-seal.md): under the write lock a claude writes
// only its own conversation's transcript.

const SID = '0f6c1a52-3b1e-4c11-9d1e-5b1f0d2a7c01';
const OTHER = '7d2e44f0-91aa-4b6f-8a3c-2c5e1f9b0e77';

function home(t: { after: (f: () => void) => void }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w5702-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const claude = path.join(root, 'claude');
  fs.mkdirSync(path.join(claude, 'projects', 'p1'), { recursive: true });
  return { base, root, claude, tr: path.join(root, TRANSCRIPTS) };
}

test('linkTranscripts moves projects out of the Claude home once, then keeps the link and sets aside what replaced it', (t) => {
  const { root, claude, tr } = home(t);
  fs.writeFileSync(path.join(claude, 'projects', 'p1', `${OTHER}.jsonl`), 'x\n');
  assert.match(linkTranscripts(root, claude) ?? '', /moved/);
  assert.equal(fs.readlinkSync(path.join(claude, 'projects')), `../${TRANSCRIPTS}`);
  assert.equal(fs.readFileSync(path.join(claude, 'projects', 'p1', `${OTHER}.jsonl`), 'utf8'), 'x\n', 'the transcripts are where they were, by the link');
  assert.equal(linkTranscripts(root, claude), undefined, 'nothing to do the second time');
  // A worker removes the link and makes a folder (it writes the Claude home): set aside, link made again.
  fs.unlinkSync(path.join(claude, 'projects'));
  fs.mkdirSync(path.join(claude, 'projects', 'planted'), { recursive: true });
  assert.match(linkTranscripts(root, claude, 42) ?? '', /was not the link .*a folder.*\.replaced-42/);
  assert.ok(fs.existsSync(path.join(tr, '.replaced-42', 'planted')));
  assert.equal(fs.readlinkSync(path.join(claude, 'projects')), `../${TRANSCRIPTS}`);
  // ... or a link to somewhere else.
  fs.unlinkSync(path.join(claude, 'projects'));
  fs.symlinkSync('/tmp', path.join(claude, 'projects'));
  assert.match(linkTranscripts(root, claude, 43) ?? '', /a link to \/tmp/);
  assert.equal(fs.readlinkSync(path.join(claude, 'projects')), `../${TRANSCRIPTS}`);
});

test("a new conversation gets its own folder and a link its claude's first write follows; the file is moved in after it exits", (t) => {
  const { root, claude, tr, base } = home(t);
  linkTranscripts(root, claude);
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd);
  const p = path.join(tr, projectSlug(cwd));
  const args = ownTranscriptArgs(tr, SID, cwd);
  assert.deepEqual(args, ['--rw', path.join(p, SID)], 'only its own folder: the link is not a file yet');
  assert.equal(fs.readlinkSync(path.join(p, `${SID}.jsonl`)), path.join(SID, NEW_TRANSCRIPT));
  // Claude Code's "Session ID ... is already in use" check is a stat, which follows the link: still free.
  assert.equal(fs.existsSync(path.join(p, `${SID}.jsonl`)), false);
  fs.appendFileSync(path.join(p, `${SID}.jsonl`), '{"a":1}\n');
  assert.deepEqual(finishNewTranscripts(tr, SID), [path.join(p, `${SID}.jsonl`)]);
  assert.ok(fs.lstatSync(path.join(p, `${SID}.jsonl`)).isFile());
  assert.equal(fs.readFileSync(path.join(p, `${SID}.jsonl`), 'utf8'), '{"a":1}\n');
  assert.deepEqual(finishNewTranscripts(tr, SID), [], 'once');
  // Its resume: the file and the folder, in whichever project folder they are; never another conversation's.
  fs.writeFileSync(path.join(tr, 'p1', `${OTHER}.jsonl`), '');
  fs.mkdirSync(path.join(tr, 'p1', SID));
  assert.deepEqual(ownTranscriptArgs(tr, SID, path.join(base, 'elsewhere')).sort(), ['--rw', '--rw', '--rw', path.join(tr, 'p1', SID), path.join(p, `${SID}.jsonl`), path.join(p, SID)].sort());
  // A claude that never wrote leaves a dangling link: removed, not moved.
  const fresh = '11111111-2222-4333-8444-555555555555';
  ownTranscriptArgs(tr, fresh, cwd);
  assert.deepEqual(finishNewTranscripts(tr, fresh), [path.join(p, `${fresh}.jsonl`)]);
  assert.equal(fs.existsSync(path.join(p, `${fresh}.jsonl`)) || !!fs.lstatSync(path.join(p, `${fresh}.jsonl`), { throwIfNoEntry: false }), false);
});

test('writeLockArgs opens a transcripts folder whole while transcriptLock is off, and never while it is on', (t) => {
  const { root, tr } = home(t);
  assert.ok(!writeLockArgs({ root }).includes(tr), 'no folder, no rule (makeOpenRootChildren must not make it)');
  fs.mkdirSync(tr);
  assert.ok(writeLockArgs({ root }).includes(tr));
  assert.ok(!writeLockArgs({ root, transcriptLock: true }).includes(tr));
});

const landlock = process.platform === 'linux' && spawnSync('python3', [FF_LANDLOCK, '--', 'true']).status === 0;

/** Runs `script` as a locked claude of conversation `sid` would run (the spawner's rules), and answers its output. */
async function locked(root: string, claude: string, cwd: string, sid: string, script: string) {
  const spawn = writeLockSpawner(writeLockArgs({ root, transcriptLock: true }), { transcripts: path.join(root, TRANSCRIPTS), log: () => {} });
  const opts = { command: 'bash', args: ['-c', script, '_', '--session-id', sid], cwd, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: claude }, signal: new AbortController().signal } as unknown as SpawnOptions;
  const child = spawn(opts) as unknown as ChildProcess;
  let out = '';
  child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
  child.stdin!.end();
  await once(child, 'exit');
  await new Promise((r) => setImmediate(r));
  return out.trim().split('\n');
}

test('live w5702: a locked claude writes its own transcript and folder, and is refused every write to another conversation\'s', { skip: !landlock && 'needs Linux with Landlock' }, async (t) => {
  const { root, claude, tr, base } = home(t);
  for (const c of ['tmp', 'sandboxes']) fs.mkdirSync(path.join(root, c));
  const cwd = path.join(root, 'sandboxes', 'slot1');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(claude, 'projects', 'p1', `${OTHER}.jsonl`), 'other\n');
  fs.mkdirSync(path.join(claude, 'projects', 'p1', OTHER));
  linkTranscripts(root, claude);
  const p = path.join(claude, 'projects', projectSlug(cwd));
  const o = path.join(claude, 'projects', 'p1', OTHER);
  const tryAll = (own: string[]) =>
    [
      'try() { if eval "$2" 2>/dev/null; then echo "$1 ok"; else echo "$1 refused"; fi; }',
      ...own,
      `try append-other "echo x >> ${o}.jsonl"`,
      `try truncate-other ": > ${o}.jsonl"`,
      `try plant "echo x > ${p}/${'9'.repeat(8)}-0000-4000-8000-000000000000.jsonl"`,
      `try plant-elsewhere "echo x > ${path.dirname(o)}/planted.jsonl"`,
      `try rename-other "mv ${o}.jsonl ${o}.old"`,
      `try delete-other "rm ${o}.jsonl"`,
      `try other-folder "touch ${o}/x"`,
      `try link-other-in "ln ${o}.jsonl ${p}/${SID}/stolen"`,
      `try move-other-in "mv ${o}.jsonl ${p}/${SID}/stolen"`,
      `try new-project "mkdir ${claude}/projects/evil"`,
      `try memory "mkdir ${p}/memory"`,
      `try claude-home "touch ${claude}/settings.json"`,
    ].join('\n');
  const refused = ['append-other', 'truncate-other', 'plant', 'plant-elsewhere', 'rename-other', 'delete-other', 'other-folder', 'link-other-in', 'move-other-in', 'new-project', 'memory'].map((n) => `${n} refused`);
  // A new conversation: its first write follows the link into its own folder.
  assert.deepEqual(await locked(root, claude, cwd, SID, tryAll([`try new "echo '{\\"n\\":1}' >> ${p}/${SID}.jsonl"`, `try own-folder "mkdir -p ${p}/${SID}/subagents && touch ${p}/${SID}/subagents/a.jsonl"`])), [
    'new ok', 'own-folder ok', ...refused, 'claude-home ok',
  ]);
  assert.ok(fs.lstatSync(path.join(p, `${SID}.jsonl`)).isFile(), 'moved in when it exited');
  // Its resume appends to the file in place.
  assert.deepEqual(await locked(root, claude, cwd, SID, tryAll([`try resume "echo '{\\"n\\":2}' >> ${p}/${SID}.jsonl"`, `try own-rename "mv ${p}/${SID}.jsonl ${p}/${SID}.x"`])), [
    'resume ok', 'own-rename refused', ...refused, 'claude-home ok',
  ]);
  assert.equal(fs.readFileSync(path.join(p, `${SID}.jsonl`), 'utf8'), '{"n":1}\n{"n":2}\n');
  assert.equal(fs.readFileSync(`${o}.jsonl`, 'utf8'), 'other\n', 'the other conversation is untouched');
  // A worker that swaps the projects link for its own folder: set aside at the next start, the link made again.
  const swap = await locked(root, claude, cwd, OTHER, `rm ${claude}/projects && mkdir -p ${claude}/projects/p1 && echo swapped`);
  assert.deepEqual(swap, ['swapped']);
  await locked(root, claude, cwd, SID, 'true');
  assert.equal(fs.readlinkSync(path.join(claude, 'projects')), `../${TRANSCRIPTS}`);
  assert.ok(fs.readdirSync(tr).some((n) => n.startsWith('.replaced-')));
  assert.ok(base);
});

test("the secret scrubbers walk a linked projects folder, and the read guard holds its real folder as the Claude home's", async (t) => {
  const { root, claude, tr } = home(t);
  fs.writeFileSync(path.join(claude, 'projects', 'p1', `${OTHER}.jsonl`), 'x\n');
  linkTranscripts(root, claude);
  const { scrubFiles } = await import('./scrubSecrets.ts');
  assert.deepEqual(scrubFiles([path.join(claude, 'projects')]), [path.join(claude, 'projects', 'p1', `${OTHER}.jsonl`)]);
  const { homeSecrets } = await import('./secretGuard.ts');
  assert.ok(homeSecrets({ CLAUDE_CONFIG_DIR: claude }, 'linux').includes(tr));
  assert.ok(!homeSecrets({ CLAUDE_CONFIG_DIR: path.join(root, 'nothing') }, 'linux').includes(tr));
});
