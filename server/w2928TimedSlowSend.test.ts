import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore, machineUploadHttp } from './attachments.ts';
import { TimedRuns } from './timedRuns.ts';
import { timedRunFromMachine } from '../machine/timedRunPack.ts';
import type { Machine } from '../shared/types.ts';

/**
 * w2928: a timed_run whose pieces take longer to send than the agent host waits for its daemon's answer (20 min,
 * agentHost.ts RPC_ANSWER_MS). On 2026-11-03 m3's four builds for LothDesktop took 40 min 47 s (tr_affa494c34: planned
 * 03:17:03Z, its ticket taken there 03:57:50Z): the worker's call failed at 20 min with no answer while the sending went
 * on, it called again (tr_2b5e6e6230, planned 03:37:08Z, all 40 pieces again beside the first), and the first run then
 * played on LothDesktop for a worker that had given it up. Now the call answers in time with the run id, a second call
 * is refused while the first sends, and the handover or a failure reaches the worker as a message.
 */

test('w2928: a slow send answers in time, refuses a second call, and tells the worker when it is handed over or fails', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w2928-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const store = new AttachmentStore(path.join(d, 'portal'));
  // The portal's upload route, with a gate: the link is slow until `open`, and `refuse` answers 404 (a lost upload).
  let gate: { open: () => void; refuse: () => void } | undefined;
  let held = new Promise<'go' | 'refuse'>((resolve) => (gate = { open: () => resolve('go'), refuse: () => resolve('refuse') }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const up = /^\/machine\/attachments\/uploads\/([0-9a-f]+)$/.exec(url.pathname);
    if (!up) return void res.writeHead(404).end();
    void held.then((how) => {
      if (how === 'refuse') {
        req.resume();
        return void res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no such upload' }));
      }
      machineUploadHttp(store, 'm3', req, res, up[1], Number(url.searchParams.get('offset') ?? 0));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const portalUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const told: string[] = [];
  const posted: string[] = [];
  const tr = new TimedRuns({
    dataDir: path.join(d, 'portal'),
    store,
    machines: () => [{ id: 'desk', playOnly: 'test', platform: 'win32' } as unknown as Machine, { id: 'm3', platform: 'win32' } as unknown as Machine],
    isOnline: () => true,
    offers: (id) => id === 'desk',
    post: (_id, msg) => {
      posted.push((msg as { type: string }).type);
      return true;
    },
    deliver: async (_session, text) => void told.push(text),
  });
  const sandbox = path.join(d, 'm3', 'slot1');
  for (const name of ['base', 'fix']) {
    const p = path.join(sandbox, 'builds', name);
    fs.mkdirSync(path.join(p, 'finalfactory_Data'), { recursive: true });
    fs.writeFileSync(path.join(p, 'finalfactory.exe'), `player ${name}`);
  }
  fs.writeFileSync(path.join(sandbox, 'bench.zip'), 'PK save one');
  const worker = { session: 'sess-1', requests: ['w2917'], what: 'w2917 map pan (worker sess-1)' };
  const phases: string[] = [];
  const rpc = async (a: Record<string, unknown>) => {
    phases.push(String(a.phase));
    if (a.phase === 'plan') return tr.plan('m3', worker, a);
    if (a.phase === 'go') return tr.go('sess-1', a);
    if (a.phase === 'abort') return tr.abort('sess-1', a);
    throw new Error(`no phase ${String(a.phase)}`);
  };
  const call = () =>
    timedRunFromMachine({ portalUrl, token: 't', roots: [sandbox], cwd: sandbox, tempDir: path.join(d, 'm3', 'tmp'), key: 'sess-1', answerWithinMs: 300, args: { builds: [{ name: 'base', path: 'builds/base' }, { name: 'fix', path: 'builds/fix' }], save: 'bench.zip', rounds: 2 }, rpc });
  const until = async (what: string, ok: () => boolean) => {
    const end = Date.now() + 10_000;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  // RED before w2928: this call held until every piece was sent, so on the slow link it never answered (the host's 20 min).
  const started = Date.now();
  const answer = await call();
  assert.ok(Date.now() - started < 5_000, 'the call answered while the pieces were still being sent');
  const id = /tr_[0-9a-f]{10}/.exec(answer)?.[0];
  assert.ok(id, answer);
  assert.match(answer, /still sending its pieces .*0 of 3 pieces/);
  assert.match(answer, /FF Factory messages you when it is handed to desk/);
  assert.equal(tr.get(id)?.state, 'uploading');

  // A second call from the same worker while the first still sends is refused, and plans (and sends) nothing.
  await assert.rejects(call(), new RegExp(`timed run ${id} of yours is still sending its pieces .*rather than call timed_run again`));
  assert.deepEqual(phases, ['plan']);

  // The link catches up: the run is handed over, and the worker hears it by message (its call answered long ago).
  gate!.open();
  await until('the handover', () => tr.get(id)?.state === 'sent');
  assert.deepEqual(phases, ['plan', 'go']);
  assert.deepEqual(posted, ['timed_run']);
  await until('the message', () => told.length === 1);
  assert.match(told[0], new RegExp(`\\[timed run ${id}\\] its pieces have all arrived now .*handed to desk`));
  assert.doesNotMatch(told[0], /End your turn now/);

  // A send that fails after the call answered fails the run at once, and the worker is told why (no 60 min wait in uploading).
  fs.writeFileSync(path.join(sandbox, 'bench.zip'), 'PK save two');
  held = new Promise((resolve) => (gate = { open: () => resolve('go'), refuse: () => resolve('refuse') }));
  const second = await call();
  const id2 = /tr_[0-9a-f]{10}/.exec(second)![0];
  assert.match(second, /still sending its pieces .*0 of 1 pieces/);
  gate!.refuse();
  await until('the failure', () => tr.get(id2)?.state === 'failed');
  await until('its message', () => told.length === 2);
  assert.match(told[1], new RegExp(`\\[timed run ${id2} on desk\\] FAILED: .*its pieces could not be sent from m3: .*no such upload; call timed_run again`));
  // and the worker may call again now: nothing of its is still sending
  assert.equal(tr.get(id2)?.state, 'failed');

  // A send that fails while the call still waits gives the agent the error and leaves no run in uploading.
  held = Promise.resolve('refuse');
  fs.writeFileSync(path.join(sandbox, 'bench.zip'), 'PK save three');
  const quick = timedRunFromMachine({ portalUrl, token: 't', roots: [sandbox], cwd: sandbox, tempDir: path.join(d, 'm3', 'tmp'), key: 'sess-1', answerWithinMs: 60_000, args: { builds: [{ name: 'base', path: 'builds/base' }], save: 'bench.zip' }, rpc });
  await assert.rejects(quick, /no such upload/);
  assert.equal(told.length, 2, 'the agent got the error itself: no message besides');
  assert.ok(tr.list().every((r) => r.state !== 'uploading'));
});
