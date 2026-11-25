import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SEAL_DAYS, TranscriptHasher, checkSeal, pidGone, sealStore } from './transcriptSeal.ts';
import { AgentSession, setQueryForTesting } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import { projectSlug } from './claudeHome.ts';
import type { SessionInfo, TranscriptEvent } from '../shared/types.ts';

/**
 * w5563 (lothsahn: "transcripts are read-only to workers"): a transcript changed outside its own process since it was sealed
 * is not resumed. Claude Code only appends to it (measured on m5, 2026-11-25: its first 152,106 bytes kept their hash
 * through a resume and a /compact).
 */

const tmp = (t: { after: (f: () => void) => void }, name: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ffsb-seal-${name}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const line = (n: number) => `${JSON.stringify({ type: 'user', uuid: `u${n}`, message: { role: 'user', content: `message ${n}` } })}\n`;

test('w5563: sealStore keeps one seal per conversation, refuses ids that are no file name, junk and old seals', (t) => {
  const dir = tmp(t, 'store');
  let now = Date.parse('2026-11-25T00:00:00Z');
  const store = sealStore(dir, () => now);
  const seal = { v: 1 as const, size: 10, sha256: 'a'.repeat(64), at: '2026-11-25T00:00:00Z', final: true };
  store.save('conv-1', seal);
  assert.deepEqual(store.load('conv-1'), seal);
  store.save('../escape', seal);
  assert.equal(fs.existsSync(path.join(dir, '..', 'escape.json')), false);
  assert.equal(store.load('../escape'), undefined);
  fs.writeFileSync(path.join(dir, 'junk.json'), JSON.stringify({ ...seal, sha256: 'nothex' }));
  assert.equal(store.load('junk'), undefined, 'not a seal');
  fs.writeFileSync(path.join(dir, 'half.json'), '{"v":1,');
  assert.equal(store.load('half'), undefined);
  // a seal untouched for SEAL_DAYS goes at the next save of a new store
  const old = new Date(now - (SEAL_DAYS + 1) * 86_400_000);
  fs.utimesSync(path.join(dir, 'conv-1.json'), old, old);
  now += 1;
  sealStore(dir, () => now).save('conv-2', seal);
  assert.equal(fs.existsSync(path.join(dir, 'conv-1.json')), false);
});

test('w5563: an appended transcript passes its seal; an edited, cut, deleted or (after a final seal) grown one does not', async (t) => {
  const dir = tmp(t, 'check');
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line(1) + line(2));
  const h = new TranscriptHasher(file);
  const s1 = (await h.seal(false))!;
  assert.equal(s1.size, fs.statSync(file).size);
  assert.deepEqual((await checkSeal(file, s1)).ok, true, 'as sealed');

  fs.appendFileSync(file, line(3));
  const grown = await checkSeal(file, s1);
  assert.ok(grown.ok && grown.tail === line(3).length && grown.sealed, 'appended after a seal that was not final: resumes with its tail');
  const s2 = (await h.seal(true))!;
  assert.equal(s2.size, fs.statSync(file).size, 'the running hash took the new line');
  assert.equal((await checkSeal(file, s2)).ok, true);

  fs.appendFileSync(file, line(4));
  const planted = await checkSeal(file, s2);
  assert.ok(!planted.ok && /added to it after its process had ended/.test(planted.why), 'a line planted after the process ended');

  const text = fs.readFileSync(file, 'utf8').slice(0, s2.size);
  fs.writeFileSync(file, text.replace('message 2', 'message X'));
  const edited = await checkSeal(file, s2);
  assert.ok(!edited.ok && /changed since they were sealed/.test(edited.why), 'an earlier line edited, same length');

  fs.writeFileSync(file, line(1));
  const cut = await checkSeal(file, s2);
  assert.ok(!cut.ok && /shorter than/.test(cut.why));

  fs.rmSync(file);
  const gone = await checkSeal(file, s2);
  assert.ok(!gone.ok && /gone/.test(gone.why));
  assert.equal((await checkSeal(file, undefined)).ok, true, 'no seal and no file: nothing to refuse (the CLI says it has no conversation)');
});

test('w5563: an edit to the part already hashed while the process runs shows at the next resume, though the host seals after it', async (t) => {
  const dir = tmp(t, 'mid');
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line(1) + line(2));
  const h = new TranscriptHasher(file);
  await h.seal(false);
  // another worker edits line 1 at the same length mid-conversation; the process appends line 3; the turn ends
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('message 1', 'message Y'));
  fs.appendFileSync(file, line(3));
  const s = (await h.seal(false))!;
  assert.equal(s.size, fs.statSync(file).size);
  const c = await checkSeal(file, s);
  assert.ok(!c.ok && /changed/.test(c.why), 'the seal holds what the process wrote, not the edit');
});

test('w5563: a transcript with no seal (from before w5563) resumes, and is hashed from then on', async (t) => {
  const dir = tmp(t, 'legacy');
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line(1));
  const c = await checkSeal(file, undefined);
  assert.ok(c.ok && !c.sealed);
  fs.appendFileSync(file, line(2));
  const s = (await c.hasher.seal(false))!;
  assert.equal((await checkSeal(file, s)).ok, true);
});

test('w5563: pidGone waits for the process to end, up to its limit', async () => {
  let left = 3;
  assert.equal(await pidGone(1, 1_000, 1, () => left-- > 0), true);
  assert.equal(await pidGone(1, 5, 1, () => true), false);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.equal(await pidGone(dead, 1_000, 5), true);
});

test("w5563: the Agent SDK still calls onProcessSpawned with its claude's pid (the final seal rests on it)", () => {
  const sdk = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
  assert.match(fs.readFileSync(sdk, 'utf8'), /this\.options\.onProcessSpawned\([a-z]\.pid/, 'the SDK no longer calls onProcessSpawned: AgentSession needs another way to see its process exit (server/sessions.ts watchPid)');
});

test('w5563: AgentSession seals a new conversation, resumes it while sealed, and starts afresh, saying why, once its transcript was edited', async (t) => {
  const dir = tmp(t, 'session');
  const home = path.join(dir, 'claude');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const runs: { sessionId?: string; resume?: string; first?: unknown }[] = [];
  setQueryForTesting((({ prompt, options }: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: Record<string, unknown> }) => {
    const run: (typeof runs)[number] = { sessionId: options.sessionId as string | undefined, resume: options.resume as string | undefined };
    runs.push(run);
    const sid = run.resume ?? run.sessionId!;
    const file = path.join(home, 'projects', projectSlug(cwd), `${sid}.jsonl`);
    (options.onProcessSpawned as ((pid: number) => void) | undefined)?.(dead);
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: sid, model: 'm', uuid: 'init' };
      for await (const m of prompt) {
        run.first ??= m.message.content;
        // what Claude Code does: append the message and its answer
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line(runs.length));
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, duration_ms: 1, session_id: sid, uuid: `r-${Math.random()}` };
        return;
      }
    })();
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  const store = new Store(path.join(dir, 'data'));
  t.after(() => store.flush());
  const until = async (f: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(f(), what);
  };
  const info: SessionInfo = { id: 'sess-5563', kind: 'worker', title: 't', status: 'idle', permissionMode: 'bypassPermissions', createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0, pendingPermissions: [] };
  store.putSession(info);
  const opts = () => ({ cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: home } });

  // a new conversation: its id is ours, passed to the CLI; sealed final once its process has gone
  const one = new AgentSession({ ...info }, store, opts, new EventEmitter());
  one.send('first');
  await until(() => !one.live, 'the first process ended');
  const sid = runs[0].sessionId!;
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.equal(runs[0].resume, undefined);
  const file = path.join(home, 'projects', projectSlug(cwd), `${sid}.jsonl`);
  await until(() => store.seals.load(sid)?.final === true, 'sealed final');
  assert.equal(store.seals.load(sid)!.size, fs.statSync(file).size);

  // untouched: it resumes
  const two = new AgentSession({ ...info, sdkSessionId: sid }, store, opts, new EventEmitter());
  two.send('second');
  await until(() => !two.live && runs.length === 2, 'the second process ended');
  assert.equal(runs[1].resume, sid, 'resumed');
  await until(() => store.seals.load(sid)?.size === fs.statSync(file).size, 'sealed again with its new line');

  // a worker edits an earlier line: not resumed; a fresh conversation, told why, and the ledger's transcript says so
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('message 1', 'message Z'));
  const three = new AgentSession({ ...info, sdkSessionId: sid }, store, opts, new EventEmitter());
  three.send('third');
  await until(() => !three.live && runs.length === 3, 'the third process ended');
  assert.equal(runs[2].resume, undefined, 'not resumed');
  assert.ok(runs[2].sessionId && runs[2].sessionId !== sid, 'a fresh conversation of its own id');
  assert.match(String(runs[2].first), /^\[FF Factory\] This conversation's transcript was changed outside its own process[\s\S]*\n\n[\s\S]*third$/);
  const err = store.readTranscript('sess-5563').find((e: TranscriptEvent) => e.kind === 'error' && /was not resumed/.test(e.text));
  assert.ok(err, 'the refusal is in the transcript');
  assert.equal(three.info.sdkSessionId, runs[2].sessionId, 'the session follows the fresh conversation');
  assert.match(fs.readFileSync(file, 'utf8'), /message Z/, 'the edited file is kept for a look');
});
