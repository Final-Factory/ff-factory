import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MAX_EVENTS_PROBE, maxProbeArgv, probeMaxEvents } from '../machine/maxEventsFence.ts';
import { daemonMaxEventsFile, withRootDefaults, withoutMaxEvents } from '../machine/daemon.ts';
import { lowTargets } from '../machine/lowIntegrity.ts';
import { READ_ONLY_IN_ROOT, seatbeltProfile } from './workerFence.ts';
import { LOCKED_CHILDREN, writeLockArgs } from '../machine/writeLock.ts';

// w5552 (lothsahn: "Max events go in a folder workers can't write"): the Max events file is the daemon's, no fence lets a
// worker write it, sandbox agents are not told where it is, and the daemon checks each fence once and logs the answer.

const file = '/r/daemon/max/max-events.jsonl';

test('the daemon\'s check reads REFUSED, WROTE or neither from the fenced shell', () => {
  const seen: string[][] = [];
  const run = (out: string, status = 0) => (cmd: string, args: string[]) => {
    seen.push([cmd, ...args]);
    return { status, stdout: out };
  };
  const refused = probeMaxEvents('landlock', ['python3', 'll.py', '--', ...maxProbeArgv('/bin/sh', file)], file, { run: run('REFUSED\n') });
  assert.equal(refused.refused, true);
  assert.match(refused.line, /landlock refuses a fenced worker's write/);
  assert.deepEqual(seen[0], ['python3', 'll.py', '--', '/bin/sh', '-c', MAX_EVENTS_PROBE, 'max-events-probe', file]);
  const wrote = probeMaxEvents('Low integrity', maxProbeArgv('bash.exe', file), file, { run: run('WROTE\r\n') });
  assert.equal(wrote.refused, false);
  assert.match(wrote.line, /WARNING: a worker inside Low integrity could write/);
  const broken = probeMaxEvents('seatbelt', ['sandbox-exec'], file, { run: () => ({ status: 65, stdout: '', stderr: 'sandbox-exec: invalid profile' }) });
  assert.equal(broken.refused, undefined);
  assert.match(broken.line, /could not check .*exited 65; stderr: sandbox-exec: invalid profile/);
  assert.equal(probeMaxEvents('x', ['nope'], file, { run: () => ({ status: null, error: new Error('ENOENT') }) }).refused, undefined);
});

test('with a worker root the events file is in the daemon\'s folder, whatever daemon.json names', () => {
  assert.equal(withRootDefaults({ portalUrl: 'p', id: 'x', token: 't', repoPath: 'r', root: '/r' }).maxEventsFile, path.join('/r', 'daemon', 'max', 'max-events.jsonl'));
  assert.equal(withRootDefaults({ portalUrl: 'p', id: 'x', token: 't', repoPath: 'r', root: '/r', maxEventsFile: '/r/max/max-events.jsonl' }).maxEventsFile, daemonMaxEventsFile(path.join('/r', 'daemon')), 'the old worker-writable path is not kept');
  assert.equal(withRootDefaults({ portalUrl: 'p', id: 'x', token: 't', repoPath: 'r', root: '/r', maxEventsFile: null }).maxEventsFile, null);
});

test('every fence keeps the daemon\'s folder, and so the events file, out of a worker\'s writes', () => {
  // Linux: Landlock grants only the root folders workers write (w5569), never the daemon's, and no rule names the events file.
  const ll = writeLockArgs({ root: '/r', appDir: '/r/daemon' });
  assert.ok(LOCKED_CHILDREN.includes('daemon'));
  assert.ok(!ll.includes(path.join('/r', 'daemon')) && !ll.includes('--rw-children'));
  assert.ok(!ll.some((a) => a.includes('max-events')));
  // macOS: Seatbelt denies writes under <root>/daemon after allowing the root's open folders.
  assert.ok(READ_ONLY_IN_ROOT.subpaths.includes('daemon'));
  const profile = seatbeltProfile({ root: '/r', home: '/Users/u', darwinTemp: '/private/var/folders/x/T', darwinCache: '/private/var/folders/x/C', extraWritable: [] } as never);
  const daemonRule = `(subpath ${JSON.stringify(path.join('/r', 'daemon'))})`;
  assert.ok(profile.indexOf(daemonRule) > profile.lastIndexOf('(allow file-write* (subpath') && profile.indexOf(daemonRule) > profile.indexOf(`(subpath ${JSON.stringify(path.join('/r', 'tmp'))})`), "the daemon's folder is denied after the root's folders are allowed");
  assert.ok(!profile.includes('max-events'));
  // Windows: the daemon's folder is never labelled Low, nor anything in it but what workerIntegrityAllow names.
  const t = lowTargets({ root: path.resolve('/r'), appDir: path.resolve('/r/daemon'), children: [{ name: 'daemon', dir: true }, { name: 'sandboxes', dir: true }], exists: () => false });
  assert.ok(![...t.dirs, ...t.files].some((p) => p.toLowerCase().includes(`${path.sep}daemon`)));
});

test('a sandbox agent gets no FF_MAX_EVENTS, whatever its spec carried; other agents keep theirs', () => {
  assert.deepEqual(withoutMaxEvents({ FF_MAX_EVENTS: '/host/max-events.jsonl', FF_SESSION_ID: 's' }, true), { FF_SESSION_ID: 's' });
  assert.deepEqual(withoutMaxEvents({ FF_MAX_EVENTS: '/f', A: 'b' }, false), { FF_MAX_EVENTS: '/f', A: 'b' });
  assert.equal(withoutMaxEvents(undefined, true), undefined);
});
