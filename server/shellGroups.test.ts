import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_LIFE_MS,
  SLACK_MS,
  groupOwners,
  installShellGroups,
  parseShellGroups,
  readShellGroups,
  shellGroupEnv,
  shellGroupsDir,
  shellZdotdir,
  withShellGroups,
  type ShellGroup,
} from '../machine/shellGroups.ts';
import { leftoversMain, type ProcEnv, type ProcReaders } from '../machine/leftovers.ts';
import { macProcs, type Proc } from '../machine/unity.ts';

/**
 * w5401: macOS hides the environment of Apple's own programs, so a worker's `nohup sleep 600 &` (m5, 2026-11-24, pid 40085,
 * reparented to pid 1) showed no FF_SESSION_ID and ff-leftovers never listed it. Each worker shell now writes a start and
 * an end line (machine/shellGroups.ts); a process whose environment reads empty is tied to the session whose shell leads
 * its process group. These fixtures are such orphans: an empty environment, ppid 1, the shell's pid as pgid.
 */

const T0 = 1_800_000_000_000;
const s1: ProcEnv = { session: 's1', machine: 'm5' };
const shell = (leader: number, start: number, end?: number, env: ProcEnv = s1): ShellGroup => ({ leader, start, end, env });

test('parseShellGroups pairs start and end lines and skips bad ones', () => {
  const g = parseShellGroups(
    [
      's\t500\t1800000000.250\ts1\tslot3\tm5\t/Users/x/ffw',
      'e\t500\t1800000004.5',
      's\t600\t1800000010.0\ts1\t\tm5\t',
      'e\t999\t1800000011.0', // no start line
      's\t1\t1800000000\ts1', // pid 1
      's\t700\tnope\ts1', // bad time
      's\t701\t1800000000\tbad session!', // bad session
      'garbage',
      '',
    ].join('\n'),
  );
  assert.deepEqual(g, [
    { leader: 500, start: T0 + 250, end: T0 + 4500, env: { session: 's1', sandbox: 'slot3', machine: 'm5', root: '/Users/x/ffw' } },
    { leader: 600, start: T0 + 10_000, env: { session: 's1', machine: 'm5' } },
  ]);
});

test('groupOwners: an orphan whose environment reads empty, its shell gone, started while the shell ran, is the session\'s', () => {
  const procs: Proc[] = [{ pid: 501, ppid: 1, pgid: 500, cmd: 'sleep 600' }];
  const born = new Map([[501, T0 + 1000]]);
  const owners = groupOwners(procs, new Map([[501, {}]]), (p) => born.get(p), [shell(500, T0, T0 + 2000)]);
  assert.deepEqual(owners.get(501), s1);
});

test('groupOwners: a process born after the shell ended (a reused group id) is not', () => {
  const procs: Proc[] = [{ pid: 501, ppid: 1, pgid: 500, cmd: 'sleep 600' }];
  const born = new Map([[501, T0 + 2000 + SLACK_MS + 1000]]);
  assert.equal(groupOwners(procs, new Map(), (p) => born.get(p), [shell(500, T0, T0 + 2000)]).size, 0);
  // Born before the shell started: not either.
  born.set(501, T0 - SLACK_MS - 1000);
  assert.equal(groupOwners(procs, new Map(), (p) => born.get(p), [shell(500, T0, T0 + 2000)]).size, 0);
});

test('groupOwners: no end line counts for MAX_LIFE_MS, not beyond', () => {
  const procs: Proc[] = [{ pid: 501, ppid: 1, pgid: 500, cmd: 'tail -f x' }];
  const born = new Map([[501, T0 + MAX_LIFE_MS - 60_000]]);
  assert.equal(groupOwners(procs, new Map(), (p) => born.get(p), [shell(500, T0)]).size, 1);
  born.set(501, T0 + MAX_LIFE_MS + SLACK_MS + 60_000);
  assert.equal(groupOwners(procs, new Map(), (p) => born.get(p), [shell(500, T0)]).size, 0);
});

test('groupOwners: with the leader alive, its start time must match the line', () => {
  const procs: Proc[] = [
    { pid: 500, ppid: 400, pgid: 500, cmd: '/bin/zsh -c x' },
    { pid: 501, ppid: 500, pgid: 500, cmd: 'sleep 600' },
  ];
  const born = new Map([
    [500, T0 + 400],
    [501, T0 + 900],
  ]);
  const owned = groupOwners(procs, new Map(), (p) => born.get(p), [shell(500, T0)]);
  assert.deepEqual([...owned.keys()].sort(), [500, 501]);
  // The pid 500 now is another shell, started an hour later: neither is matched.
  born.set(500, T0 + 3_600_000);
  assert.equal(groupOwners(procs, new Map(), (p) => born.get(p), [shell(500, T0)]).size, 0);
});

test('groupOwners: another session\'s visible environment and a person\'s program are kept as they are', () => {
  const procs: Proc[] = [
    { pid: 501, ppid: 1, pgid: 500, cmd: 'node other.js' },
    { pid: 502, ppid: 1, pgid: 500, cmd: 'open -a Steam' },
  ];
  const env = new Map<number, ProcEnv>([
    [501, { session: 's2', machine: 'm5' }],
    [502, { person: 'ben', machine: 'm5' }],
  ]);
  const owned = groupOwners(procs, env, () => T0 + 1000, [shell(500, T0, T0 + 2000)]);
  assert.equal(owned.size, 0);
});

test('groupOwners: what a matched orphan started later, in its group, is the session\'s too', () => {
  // `nohup sh -c 'while :; do sleep 5; done' &`: the loop matches by its birth, its next sleep (born after the shell
  // ended) by its parent.
  const procs: Proc[] = [
    { pid: 501, ppid: 1, pgid: 500, cmd: 'sh -c while' },
    { pid: 777, ppid: 501, pgid: 500, cmd: 'sleep 5' },
    { pid: 778, ppid: 1, pgid: 500, cmd: 'sleep 5' }, // same group, parent not matched, born late: no
  ];
  const born = new Map([
    [501, T0 + 1000],
    [777, T0 + 60_000],
    [778, T0 + 60_000],
  ]);
  const owned = groupOwners(procs, new Map(), (p) => born.get(p), [shell(500, T0, T0 + 2000)]);
  assert.deepEqual([...owned.keys()].sort(), [501, 777]);
});

test('withShellGroups keeps the given map and returns it unchanged with no records', async () => {
  const procs: Proc[] = [{ pid: 501, ppid: 1, pgid: 500, cmd: 'sleep 600' }];
  const env = new Map<number, ProcEnv>([[501, {}]]);
  assert.equal(await withShellGroups(procs, env, [], async () => []), env);
  const merged = await withShellGroups(procs, env, [shell(500, T0, T0 + 2000)], async (pids) => pids.map((pid) => ({ pid, startedAt: T0 + 1000 })));
  assert.deepEqual(merged.get(501), s1);
  assert.deepEqual(env.get(501), {}, 'the given map is not changed');
});

test('macProcs reads pid, ppid, pgid and the command', () => {
  assert.deepEqual(macProcs('  501     1   500 sleep 600\n   12  1    12 /usr/sbin/a -b c\nbad line\n'), [
    { pid: 501, ppid: 1, pgid: 500, cmd: 'sleep 600' },
    { pid: 12, ppid: 1, pgid: 12, cmd: '/usr/sbin/a -b c' },
  ]);
});

test('shellGroupEnv sets ZDOTDIR and keeps the one it replaces', () => {
  assert.deepEqual(shellGroupEnv('/s', {}), { ZDOTDIR: '/s/zsh' });
  assert.deepEqual(shellGroupEnv('/s', { ZDOTDIR: '/Users/x/.config/zsh' }), { ZDOTDIR: '/s/zsh', FF_ZDOTDIR_WAS: '/Users/x/.config/zsh' });
  assert.deepEqual(shellGroupEnv('/s', { ZDOTDIR: '/s/zsh' }), { ZDOTDIR: '/s/zsh' });
});

test('readShellGroups reads one session\'s file, ignores lines naming another, and prunes old files', () => {
  const slots = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shell-groups-'));
  try {
    const dir = shellGroupsDir(slots);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's1.tsv'), 's\t500\t1800000000\ts1\t\tm5\t\ns\t510\t1800000000\ts2\t\tm5\t\n');
    fs.writeFileSync(path.join(dir, 'old.tsv'), 's\t520\t1800000000\told\t\tm5\t\n');
    const long = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    fs.utimesSync(path.join(dir, 'old.tsv'), long, long);
    assert.deepEqual(readShellGroups(dir, { session: 's1' }).map((g) => g.leader), [500]);
    assert.deepEqual(readShellGroups(dir, { session: '../x' }), []);
    assert.deepEqual(readShellGroups(dir, { prune: true }).map((g) => g.leader), [500]);
    assert.equal(fs.existsSync(path.join(dir, 'old.tsv')), false);
  } finally {
    fs.rmSync(slots, { recursive: true, force: true });
  }
});

test('ff-leftovers on a Mac lists and ends an orphan whose environment reads empty, from its shell\'s line', async () => {
  const slots = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shell-groups-'));
  const now = Date.now();
  const dir = shellGroupsDir(slots);
  fs.mkdirSync(dir, { recursive: true });
  // Shell 500 of s1 ran 10 s and left `nohup sleep 600 &` (501). Shell 600 is another session's, its orphan 601.
  fs.writeFileSync(path.join(dir, 's1.tsv'), `s\t500\t${(now - 60_000) / 1000}\ts1\tslot3\tm5\t\ne\t500\t${(now - 50_000) / 1000}\n`);
  fs.writeFileSync(path.join(dir, 's2.tsv'), `s\t600\t${(now - 60_000) / 1000}\ts2\tslot4\tm5\t\n`);
  let machine: Proc[] = [
    { pid: 50, ppid: 1, pgid: 50, cmd: 'node agentHost.ts' },
    { pid: 100, ppid: 50, pgid: 100, cmd: 'claude --print' },
    { pid: 501, ppid: 1, pgid: 500, cmd: 'sleep 600' },
    { pid: 601, ppid: 1, pgid: 600, cmd: 'sleep 600' },
    { pid: 700, ppid: 1, pgid: 700, cmd: 'sleep 600' }, // a person's, no record
  ];
  const envs = new Map<number, ProcEnv>([[100, s1]]);
  const read: ProcReaders = {
    procs: async () => machine,
    envs: async (pids) => new Map(pids.map((p) => [p, envs.get(p) ?? {}])),
    inspect: async (pids) => pids.map((pid) => ({ pid, startedAt: now - 55_000, cpuMs: 1 })),
  };
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
  const sent: [number, string][] = [];
  try {
    const e = { FF_SESSION_ID: 's1', FF_MACHINE_ID: 'm5', FF_UNITY_SLOTS: slots };
    const t = {
      platform: 'darwin' as const,
      read,
      signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => {
        sent.push([pid, sig]);
        machine = machine.filter((p) => p.pid !== pid);
      },
      wait: async () => undefined,
    };
    assert.equal(await leftoversMain(['list'], e, t), 0);
    assert.match(out.join(''), /Still running from your session \(s1\): 1\n\s+pid 501 .*sleep 600/);
    out.length = 0;
    assert.equal(await leftoversMain(['end'], e, t), 0);
    assert.deepEqual(sent, [[501, 'SIGTERM']], 'only the session\'s orphan, not s2\'s nor the person\'s');
    out.length = 0;
    assert.equal(await leftoversMain(['list'], e, t), 0);
    assert.match(out.join(''), /Nothing your session \(s1\) started is still running/);
  } finally {
    process.stdout.write = write;
    fs.rmSync(slots, { recursive: true, force: true });
  }
});

const zsh = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '';

test('a zsh started with the ZDOTDIR writes its start and end lines and hands back ZDOTDIR', { skip: !zsh && 'no /bin/zsh' }, () => {
  const slots = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shell-groups-'));
  try {
    installShellGroups(slots);
    installShellGroups(slots); // again: unchanged files are left alone
    const home = path.join(slots, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.zshenv'), 'export FF_PERSON_ZSHENV=read\n');
    const before = Date.now();
    const got = execFileSync(zsh, ['-c', 'print -r -- "$$|${ZDOTDIR-unset}|${FF_PERSON_ZSHENV-}"'], {
      env: { PATH: process.env.PATH, HOME: home, FF_SESSION_ID: 's1', FF_MACHINE_ID: 'm5', ...shellGroupEnv(slots, {}) },
      encoding: 'utf8',
    }).trim();
    const [pid, zd, person] = got.split('|');
    assert.equal(zd, 'unset', 'ZDOTDIR is handed back (unset) before the person\'s files');
    assert.equal(person, 'read', 'the person\'s own .zshenv still loads');
    const g = readShellGroups(shellGroupsDir(slots), { session: 's1' });
    assert.equal(g.length, 1);
    assert.equal(g[0].leader, Number(pid));
    assert.deepEqual(g[0].env, { session: 's1', machine: 'm5' });
    assert.ok(g[0].start >= before - 1000 && g[0].end !== undefined && g[0].end >= g[0].start);
    assert.ok(fs.existsSync(path.join(shellZdotdir(slots), '.zshrc')));
    // No FF_SESSION_ID (a person's shell): no line, nothing printed.
    const quiet = execFileSync(zsh, ['-c', 'true'], { env: { PATH: process.env.PATH, HOME: home, ...shellGroupEnv(slots, {}) }, encoding: 'utf8' });
    assert.equal(quiet, '');
    assert.deepEqual(fs.readdirSync(shellGroupsDir(slots)), ['s1.tsv']);
  } finally {
    fs.rmSync(slots, { recursive: true, force: true });
  }
});
