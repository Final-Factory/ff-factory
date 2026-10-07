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
const DECIDED = { protocol: 8, fingerprint: '27b3c7565dd89b12' };

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
