import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityLine, fleetOf } from '../shared/fleet.ts';
import type { Machine, MachineSandbox, Sandbox, SessionInfo, SessionStatus, SystemStats } from '../shared/types.ts';

const T = '2026-09-29T10:00:00.000Z';

const session = (id: string, status: SessionStatus, where: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: id,
  status,
  permissionMode: 'bypassPermissions',
  createdAt: T,
  lastActivityAt: T,
  turns: 0,
  costUsd: 0,
  pendingPermissions: [],
  ...where,
});

const hostSandbox = (id: string, purpose: string, sessionIds: string[] = [], unity: Sandbox['unity']['state'] = 'stopped'): Sandbox => ({
  id,
  name: id,
  branch: `sandbox/${id}`,
  base: 'develop',
  path: `D:/ffsb/${id}`,
  purpose,
  status: 'ready',
  createdAt: T,
  unity: { state: unity },
  sessionIds,
});

const machineSandbox = (id: string, purpose: string, sessionIds: string[] = [], unity: MachineSandbox['unity']['state'] = 'stopped'): MachineSandbox => ({
  id,
  branch: `sandbox/${id}`,
  base: 'origin/develop',
  path: `D:/work/ffsb/${id}`,
  purpose,
  status: 'ready',
  createdAt: T,
  unity: { state: unity },
  sessionIds,
  git: { branch: `feature/${id}`, dirty: 0, untracked: 0, at: T },
});

const machine = (id: string, extra: Partial<Machine> = {}): Machine => ({
  id,
  host: id,
  purpose: 'unused',
  status: 'ready',
  online: true,
  repoPath: 'D:/work/FFFRepo',
  home: 'C:/Users/dev',
  portalUrl: 'https://portal.example',
  maxSessions: 3,
  sessionIds: [],
  createdAt: T,
  ...extra,
});

const system = { hostname: 'BEAST', platform: 'win32 10.0.26100', limits: { maxUnity: 4, maxSessions: 8, maxSandboxes: 10 } } as SystemStats;

test('fleet: the host first, then each machine, with sandboxes, live agents and the main clone', () => {
  const sessions = [
    session('busy', 'running', { sandboxId: 'alpha' }),
    session('old', 'stopped', { sandboxId: 'alpha' }),
    session('ask', 'waiting_permission', { machineId: 'lothdesktop', machineSandbox: 'sb1', pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {}, createdAt: T }] }),
    session('main', 'idle', { machineId: 'lothdesktop' }),
    session('duty', 'running', { machineId: 'lothdesktop', kind: 'standing', standingId: 'st' }),
    session('failed', 'error', { machineId: 'lothdesktop' }),
  ];
  const fleet = fleetOf({
    system,
    sessions,
    sandboxes: [hostSandbox('free1', 'unused'), hostSandbox('alpha', 'Belt splitter', ['busy', 'old'], 'running')],
    machines: [
      machine('lothdesktop', {
        name: 'LothDesktop',
        platform: 'win32',
        sandboxRoot: 'D:/work/ffsb',
        maxSandboxes: 3,
        sessionIds: ['ask', 'main', 'duty', 'failed'],
        sandboxes: [machineSandbox('sb2', 'unused'), machineSandbox('sb1', 'Nightly e2e', ['ask'], 'running')],
      }),
      machine('m3', { online: false }),
    ],
  });

  assert.deepEqual(
    fleet.map((c) => [c.key, c.name, c.host]),
    [
      ['host', 'BEAST', true],
      ['lothdesktop', 'LothDesktop', false],
      ['m3', 'm3', false],
    ],
  );

  const [host, loth, m3] = fleet;
  // In-use sandboxes first; a stopped agent is only counted.
  assert.deepEqual(host.sandboxes.map((s) => [s.key, s.free]), [['alpha', false], ['free1', true]]);
  assert.deepEqual(host.sandboxes[0].agents.live.map((s) => s.id), ['busy']);
  assert.equal(host.sandboxes[0].agents.stopped, 1);
  assert.equal(host.editors, 1);
  assert.equal(capacityLine(host), '2/10 sandboxes · 1/4 editors');
  assert.deepEqual([host.live, host.busy, host.attention], [1, 1, 0]);

  // A machine sandbox is keyed "<machine>/<id>" and shows the branch git reports.
  assert.deepEqual(loth.sandboxes.map((s) => [s.key, s.branch, s.free]), [['lothdesktop/sb1', 'feature/sb1', false], ['lothdesktop/sb2', 'feature/sb2', true]]);
  assert.equal(loth.sandboxes[0].attention, 1);
  // The main clone: its own workers, not the sandbox's agents nor the standing agent; the failed one is counted.
  assert.deepEqual(loth.main!.live.map((s) => s.id), ['main']);
  assert.equal(loth.main!.stopped, 1);
  assert.equal(capacityLine(loth), '2/3 sandboxes · 1/2 editors');
  assert.deepEqual([loth.live, loth.busy, loth.attention], [2, 1, 1]);

  // No sandbox_root: the main clone only.
  assert.equal(m3.online, false);
  assert.equal(capacityLine(m3), 'main clone only');
});

test('fleet: a labelled sandbox, or one with a live agent, is never free', () => {
  const fleet = fleetOf({
    system,
    sessions: [session('idle', 'idle', { sandboxId: 'spare' })],
    sandboxes: [hostSandbox('spare', 'unused', ['idle']), hostSandbox('named', 'Shader work'), hostSandbox('empty', '')],
    machines: [],
  });
  assert.deepEqual(fleet[0].sandboxes.map((s) => [s.key, s.free]), [['spare', false], ['named', false], ['empty', true]]);
});

test('fleet: counts without a known limit read naturally (a server from before maxSandboxes)', () => {
  const old = { ...system, limits: { maxUnity: 2, maxSessions: 4 } } as SystemStats;
  const fleet = fleetOf({ system: old, sessions: [], sandboxes: [hostSandbox('a', 'x')], machines: [] });
  assert.equal(capacityLine(fleet[0]), '1 sandbox · 0/2 editors');
  assert.equal(fleetOf({ sessions: [], sandboxes: [], machines: [] })[0].name, 'This host');
});
