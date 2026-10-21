// The portal and its machine daemons are versioned by the protocol, not by the commit (w605): a daemon from another
// commit keeps working as long as its protocol is in range. That holds only if every change to what the two send
// each other is looked at, so this test fails on any change to the messages or the launch spec until someone decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OLDEST_DAEMON_PROTOCOL, OLDEST_PORTAL_PROTOCOL, PROTOCOL_VERSION } from './machineProtocol.ts';

/**
 * The protocol as last decided. When the test fails, decide which it is:
 * - both sides ignore the change safely (a new optional field, a message the other side may drop): record the new
 *   fingerprint below, protocol unchanged;
 * - an older daemon or portal would misread it: bump PROTOCOL_VERSION in machineProtocol.ts, gate the new thing on the
 *   daemon's protocol in the portal (as SANDBOX_PROTOCOL and the others are), and record both here. Raise
 *   OLDEST_DAEMON_PROTOCOL or OLDEST_PORTAL_PROTOCOL only when the other side can no longer be served at all.
 */
// w615 (no bump): the GPU Whisper's `voice` in the hello and its `voice`/`transcribe_result` messages, which an older
// portal's onMessage drops (no default case), and `transcribe`/`voice_warm`, sent only to a daemon that offered it.
// w656 (no bump): `saveWork` in the hello, an optional field an older portal ignores, and `save_work`, sent only to a
// daemon that offered it, answered by `save_result`, which an older portal never asks for and drops.
// Linux workers (no bump): `info.platform` may be 'linux'; it is typed in shared/types.ts, outside this surface. An
// older portal takes a Linux daemon for a Mac (its words say "Mac", and its ssh start/stop would try launchctl); nothing
// on the wire is misread, and a portal from this change on keeps only the platforms it knows.
// w691 (no bump): `reason: 'host_start'` on `failed`, an optional field an older portal ignores; the portal reads the
// words of an older daemon's `failed` the same way. The `waiting_on_person` tool is in the catalog a daemon offers in its
// hello, which filters what the portal gives its workers (a daemon without it is not offered the tool).
// w791 (bump to 9): `clear_batch` as a `unity` action. A protocol-8 daemon would start the sandbox's editor on an action it
// does not know, so the portal sends it only to a daemon of protocol 9 or later (BATCH_CLEAR_PROTOCOL) and refuses otherwise.
// w799 (no bump): `lingering` on a sandbox (MachineSandbox in shared/types.ts, so DaemonSandbox), an optional field an older
// portal ignores (it then may count that sandbox free, as before); an older daemon never sends it.
// w868 (no bump): `githubToken` on `switch` and `save_work`, optional: an older daemon ignores it and pushes on its own
// login, as before; an older portal never sends it, and the daemon then uses its own login.
// w896 (no bump): `workerRoot` on the launch spec's guard, optional: an older daemon ignores it and its guard does not check deletes until
// it is updated (a verified deploy updates the machines, w887); an older portal never sends it, and the guard then checks nothing.
// w936 (no bump): `mainClone` on the launch spec's guard, optional: an older daemon ignores it and its guard keeps refusing every
// command that names the main clone, as before (the worker then reports the refusal); an older portal never sends it.
// w1097 (no bump): `resumable` on `welcome` and a `resumable` message, the sessions whose temp folders survive a stop. An older
// daemon ignores both (its onMessage has no default) and sweeps as before; an older portal never sends them, and the daemon
// then sweeps as before.
// w1163 (no bump): `alwaysLoad` and `searchHint` on the launch spec's MCP tools, optional: an older daemon builds its tools
// from name and description only (no hint, every tool deferred, as before); an older portal never sends them.
// w1196 (no bump): `wakes` on `welcome` and `resumable`, the pending wake_me check-ins (ISO), optional: an older daemon ignores
// it; an older portal never sends it, and the daemon then keeps a stopped worker's leftovers only for the grace after its stop.
// w1379 (no bump): `owners` on `welcome` and `resumable`, each session of the machine with a request not closed and its requests,
// optional: an older daemon ignores it; an older portal never sends it, and the daemon's `ff-leftovers folders` then says it has no
// owners and nothing is deletable.
// w1398 (no bump): `liveView` in the hello (optional: an older portal ignores it), `live`, sent only to a daemon that offered it,
// answered by `live_result`, and `live_state`, which an older portal's onMessage drops (no default case).
// w1463 (no bump): `gh_login`, the machine's gh account and its token's scope names, which an older portal's onMessage drops
// (no default case); an older daemon never sends it, and list_machines, the brief and placement then say "not reported yet".
// w1469 (no bump): `compact` in the hello (optional: an older portal ignores it), `compact`, sent only to a daemon that offered
// it (an older daemon's onMessage has no default and drops it, so its workers are simply not compacted), and `meta` on `signal`,
// optional: an older portal emits the turn end without it, as before; an older daemon never sends it.
// w1480 (no bump): `settings` on the launch spec (the session's Claude Code settings, here a plugin turned off), optional: an
// older daemon ignores it and its workers start with the machine's plugins as before.
// w1509 (no bump): `liveViews` in the hello, the views a daemon runs (optional: an older portal ignores it; from an older
// daemon the portal gets none and asks each of its views to start again, which that daemon answers "already running" for a
// view it still has), and `materials` on a `live` start, optional: an older daemon ignores it and reports none.
// w1519 (no bump): `ghApp` in the hello (optional: an older portal ignores it) and `gh_app_tokens`, GitHub App installation
// tokens, sent only to a daemon that offered it (an older daemon never gets one; its runs keep the person's token everywhere).
// w1532 (no bump): the machine's `pause` in the hello and its `pause` message, which an older portal's onMessage drops (no
// default case); a daemon before it sends neither, and its machine is never paused.
// w1574 (no bump): `activity_config` (the machine's machines.activityPause), which an older daemon's onMessage drops (it keeps
// its pause.json's own setting; the portal then ignores its activity pauses while the setting is off), and `activity_set`
// from the tray, which an older portal drops (the tray's choice stays on that machine).
// w1600 (no bump): `benchLock` on `stats`, the machine's bench lock while a timed run holds it (machine/benchLock.ts). An older
// portal drops it (its stats handler copies `stats` and `unity` only); an older daemon sends none, so nothing waits for its lock.
// w1596 (no bump): `selfUpdate` in the hello (optional: an older portal ignores it and updates the machine over ssh), and
// `self_update` and `daemon_control`, sent only to a daemon that offered it (an older daemon never gets one), answered by
// `self_update_ack`, `self_update_report` and `daemon_control_result`, which an older portal never asks for and drops.
// w1628 (no bump): `benchQueue` on `stats`, the timed legs in the machine's bench queue (machine/benchLock.ts readBenchQueue),
// which an older portal drops (its stats handler copies the fields it knows); and `bench_priorities`, each worker's request
// priority for the queue, which an older daemon's onMessage drops (no default case): its queue then counts every ticket normal.
// w1688 (no bump): `secretEnv` on LaunchSpec, the variables whose values the vault gave the run, which an older daemon
// ignores (it masks by SECRET_ENV names, as before); a newer daemon with an older portal has none and does the same.
const DECIDED = { protocol: 9, fingerprint: '6ae65fa2acc7f91e' };

/** The messages (machineProtocol.ts from DaemonSandbox on) and the launch spec (launch.ts LaunchSpec), without comments or spaces. */
function protocolSurface(root = path.join(import.meta.dirname, '..')): string {
  const proto = fs.readFileSync(path.join(root, 'server/machineProtocol.ts'), 'utf8');
  const launch = fs.readFileSync(path.join(root, 'server/launch.ts'), 'utf8');
  const from = proto.indexOf('export type DaemonSandbox');
  const spec = /export interface LaunchSpec \{[\s\S]*?\n\}/.exec(launch)?.[0];
  assert.ok(from >= 0 && spec, 'the protocol types moved: point protocolSurface at them again');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
  return strip(proto.slice(from)) + '\n' + strip(spec);
}

test('w605: the portal-daemon protocol changed only with a decision (a bump, or a recorded fingerprint)', () => {
  const fingerprint = createHash('sha256').update(protocolSurface()).digest('hex').slice(0, 16);
  assert.equal(
    `${PROTOCOL_VERSION} ${fingerprint}`,
    `${DECIDED.protocol} ${DECIDED.fingerprint}`,
    'What the portal and its daemons send each other changed (server/machineProtocol.ts, LaunchSpec in server/launch.ts). ' +
      'If an older daemon and portal still work with it, record the new fingerprint in machineProtocol.test.ts; if not, bump PROTOCOL_VERSION and gate it (see DECIDED).',
  );
});

test('w605: the protocol range keeps the previous protocol working on both sides', () => {
  assert.ok(OLDEST_DAEMON_PROTOCOL <= PROTOCOL_VERSION - 1, 'the portal still drives a daemon one protocol behind');
  assert.ok(OLDEST_PORTAL_PROTOCOL <= PROTOCOL_VERSION - 1, 'a daemon still serves a portal one protocol behind');
});

test('w605: comments and layout are not the protocol', () => {
  const dir = fs.mkdtempSync(path.join(import.meta.dirname, '..', '.tmp-protocol-'));
  try {
    fs.mkdirSync(path.join(dir, 'server'));
    const real = path.join(import.meta.dirname, '..');
    const proto = fs.readFileSync(path.join(real, 'server/machineProtocol.ts'), 'utf8');
    const launch = fs.readFileSync(path.join(real, 'server/launch.ts'), 'utf8');
    fs.writeFileSync(path.join(dir, 'server/launch.ts'), launch);
    fs.writeFileSync(path.join(dir, 'server/machineProtocol.ts'), proto.replace("| { type: 'status_now' }", "/** reworded */\n  |   { type: 'status_now' }  // and a note"));
    assert.equal(protocolSurface(dir), protocolSurface(real));
    fs.writeFileSync(path.join(dir, 'server/machineProtocol.ts'), proto.replace("| { type: 'status_now' }", "| { type: 'status_now'; now?: boolean }"));
    assert.notEqual(protocolSurface(dir), protocolSurface(real));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
