import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { checkShell, runtimeDirInTemp } from './guard.ts';
import { mountOps, mountsIn, parseMountinfo, unmountOwnFuse } from './deadMounts.ts';
import { mountsText, sessionTempDir, unmountText } from '../machine/leftovers.ts';

// w5285: biscuit, 2026-10-11. Worker bd1baf7b (w994) ran a private GNOME Shell with XDG_RUNTIME_DIR at <its temp>/w994/gs;
// its gvfsd-fuse and document portal mounted there. These are the two lines w5276 read from /proc/self/mountinfo.
const DIR = '/home/u/ffw/tmp/ffa-bd1baf7b';
const BISCUIT = [
  `5182 44 0:80 / ${DIR}/w994/gs/gvfs rw,nosuid,nodev,relatime shared:1132 - fuse.gvfsd-fuse gvfsd-fuse rw,user_id=1000,group_id=1000`,
  `5225 44 0:81 / ${DIR}/w994/gs/doc rw,nosuid,nodev,relatime shared:1229 - fuse.portal portal rw,user_id=1000,group_id=1000`,
];
const ROOT = '29 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw';
// The person's own desktop session: its runtime folder's mounts are never ours to touch.
const PERSON = [
  '901 44 0:60 / /run/user/1000/gvfs rw,nosuid,nodev,relatime shared:500 - fuse.gvfsd-fuse gvfsd-fuse rw,user_id=1000,group_id=1000',
  '902 44 0:61 / /run/user/1000/doc rw,nosuid,nodev,relatime shared:501 - fuse.portal portal rw,user_id=1000,group_id=1000',
];

function table(t: { after: (fn: () => void) => void }, lines: string[], unmountFails = false) {
  let rows = [ROOT, ...PERSON, ...lines];
  const unmounted: string[] = [];
  const mi = mock.method(mountOps, 'mountinfo', async () => rows.join('\n'));
  const um = mock.method(mountOps, 'unmount', async (p: string) => {
    if (unmountFails) throw new Error('fusermount: not permitted');
    unmounted.push(p);
    rows = rows.filter((r) => parseMountinfo(r)[0]?.point !== p);
  });
  t.after(() => {
    mi.mock.restore();
    um.mock.restore();
  });
  return { unmounted };
}

test('guard: XDG_RUNTIME_DIR in a temp folder is refused, in each spelling', () => {
  for (const cmd of [
    'XDG_RUNTIME_DIR=$TMPDIR/w994/gs dbus-run-session -- gnome-shell --headless',
    'export XDG_RUNTIME_DIR="$TMPDIR/gs"; dbus-run-session -- gnome-shell --headless --wayland',
    'mkdir -p $TMPDIR/gs && XDG_RUNTIME_DIR=${TMPDIR}/gs gnome-shell --nested',
    'env XDG_RUNTIME_DIR=/home/ben-ryding/ffw/tmp/ffa-bd1baf7b/w994/gs dbus-launch openbox',
    "XDG_RUNTIME_DIR='/tmp/xdg-run' gnome-shell --headless",
    'XDG_RUNTIME_DIR=$(mktemp -d) dbus-run-session -- bash',
  ]) {
    assert.ok(runtimeDirInTemp(cmd), cmd);
    assert.match(checkShell(cmd) ?? '', /XDG_RUNTIME_DIR.*blocked \(w5285\)/, cmd);
  }
});

test('guard: the real runtime folder, a container\'s, reading it, and words in a commit message pass', () => {
  for (const cmd of [
    'export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
    'export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}',
    'docker run -e XDG_RUNTIME_DIR=/run/host-xdg -v "$XDG_RUNTIME_DIR:/run/host-xdg" img',
    'echo DISPLAY=$DISPLAY XDG=$XDG_RUNTIME_DIR; tail -3 $TMPDIR/build.log',
    'git commit -m "w5285: never XDG_RUNTIME_DIR=$TMPDIR/gs"',
    'gh pr create --title "w5285" --body "keep XDG_RUNTIME_DIR=/tmp/x out"',
  ]) assert.equal(checkShell(cmd), undefined, cmd);
});

test('ff-leftovers: the session temp folder comes from TMPDIR, TEMP or TMP named ffa-<session>, never another', () => {
  assert.equal(sessionTempDir('bd1baf7b', { TMPDIR: `${DIR}/` }), DIR);
  assert.equal(sessionTempDir('bd1baf7b', { TEMP: 'V:\\ffw\\tmp\\ffa-bd1baf7b' }), 'V:\\ffw\\tmp\\ffa-bd1baf7b');
  assert.equal(sessionTempDir('bd1baf7b', { TMPDIR: '/tmp', TMP: '/home/u/ffw/tmp/ffa-other' }), undefined);
});

test('ff-leftovers end: both biscuit mounts in the own temp folder come off; the person\'s session mounts stay', async (t) => {
  const sys = table(t, BISCUIT);
  assert.deepEqual((await mountsIn(DIR)).map((m) => m.fstype).sort(), ['fuse.gvfsd-fuse', 'fuse.portal']);
  const r = await unmountOwnFuse(DIR);
  assert.deepEqual(r.cleared.sort(), [`${DIR}/w994/gs/doc`, `${DIR}/w994/gs/gvfs`]);
  assert.deepEqual(r.left, []);
  assert.ok(sys.unmounted.every((p) => p.startsWith(`${DIR}/`)), 'nothing outside the temp folder');
  assert.deepEqual(await mountsIn(DIR), [], 'mountinfo shows no FUSE mount under the temp folder afterwards');
  const said: string[] = [];
  assert.equal(unmountText(r, (s) => void said.push(s)), 0);
  assert.match(said.join(''), /Unmounted 2 FUSE mount\(s\)/);
});

test('ff-leftovers end: an unmount that fails is reported and exits 1; a non-FUSE mount is never touched', async (t) => {
  table(t, BISCUIT, true);
  const r = await unmountOwnFuse(DIR);
  assert.equal(r.cleared.length, 0);
  assert.equal(r.left.length, 2);
  assert.equal(unmountText(r, () => undefined), 1);
});

test('ff-leftovers end: a bind or tmpfs mount in the temp folder is reported, not unmounted', async (t) => {
  const sys = table(t, [`77 44 0:9 / ${DIR}/scratch rw - tmpfs tmpfs rw`]);
  const r = await unmountOwnFuse(DIR);
  assert.deepEqual(sys.unmounted, []);
  assert.deepEqual(r.left.map((m) => m.fstype), ['tmpfs']);
});

test('ff-leftovers: no temp folder, no mounts, nothing said', async (t) => {
  table(t, BISCUIT);
  assert.deepEqual(await unmountOwnFuse(undefined), { cleared: [], left: [] });
  assert.equal(mountsText([]), '');
  assert.match(mountsText(parseMountinfo(BISCUIT.join('\n'))), /Mounted in your temp folder \(2\).*ff-leftovers end/);
});
