import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from './attachments.ts';
import { LabFixtures } from './labFixtures.ts';
import { CATALOG } from './launch.ts';
import type { ToDaemon } from './machineProtocol.ts';
import { findFixtures, fixturesDir, listFixtures, offeredDir, onDriveC, sendFixture } from '../machine/labFixtures.ts';

/**
 * w3939: the nightly lab's fixtures (players' saves in <root>/nightly-history/fixtures of lothdesktop) for a worker on any
 * computer. beast's nightly worker waited 3 h for w1440-lifesave-0.50.0.105.zip, which only lothdesktop had.
 */

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const SAVE = Buffer.from(Array.from({ length: 40_000 }, (_, i) => (i * 31) % 251));
const OTHER = Buffer.from('another save');
const NAME = 'w1440-lifesave-0.50.0.105.zip';

const tmp = (t: { after(fn: () => void): void }, tag = 'w3939-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** A holder's `<root>/nightly-history/fixtures` with these files. */
function holderRoot(t: { after(fn: () => void): void }, files: Record<string, Buffer>) {
  const root = tmp(t, 'w3939-root-');
  const dir = fixturesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return { root, dir };
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), what);
};

/**
 * The portal with a real attachment store and daemons simulated by the real machine/labFixtures.ts: a holder answers
 * lab_fixture from its folder and fills lab_fixture_upload's upload through the store's append (what the HTTP route does).
 */
function setup(t: { after(fn: () => void): void }, holders: Record<string, string>, over: { maxMB?: number } = {}) {
  const store = new AttachmentStore(tmp(t, 'w3939-data-'), () => over);
  const online = new Set(Object.keys(holders));
  const posted: { to: string; msg: ToDaemon }[] = [];
  const logs: string[] = [];
  // eslint-disable-next-line prefer-const
  let lf: LabFixtures;
  const post = (to: string, msg: ToDaemon) => {
    if (!online.has(to)) return false;
    posted.push({ to, msg });
    const dir = fixturesDir(holders[to]);
    setImmediate(async () => {
      if (msg.type === 'lab_fixture') {
        const files = msg.op === 'find' ? await findFixtures(dir, msg.sha256 ?? '') : await listFixtures(dir);
        lf.onReport(to, { type: 'lab_fixture_result', id: msg.id, ok: true, files });
      } else if (msg.type === 'lab_fixture_upload') {
        const [f] = await findFixtures(dir, msg.sha256);
        const r = await store.append(msg.uploadId, 0, fs.createReadStream(path.join(dir, f.name)), f.size);
        lf.onReport(to, { type: 'lab_fixture_sent', id: msg.id, attachmentId: r.attachment!.id });
      }
    });
    return true;
  };
  lf = new LabFixtures({ store, post, holders: () => [...online], log: (l) => logs.push(l), warmDelayMs: 0, findMs: 2000, uploadMs: 5000, listMs: 2000 });
  return { store, lf, online, posted, logs };
}

test('w3939: a worker on beast asks for the sha256 and gets the save lothdesktop holds, checked and granted', async (t) => {
  const { dir, root } = holderRoot(t, { [NAME]: SAVE, 'other.zip': OTHER });
  const before = fs.readdirSync(dir).map((n) => [n, fs.statSync(path.join(dir, n)).mtimeMs]);
  const { store, lf, posted } = setup(t, { lothdesktop: root });
  const r = await lf.fetch('beast', sha(SAVE).toUpperCase(), NAME);
  assert.equal(r.refs.length, 1);
  assert.equal(r.refs[0].sha256, sha(SAVE));
  assert.equal(r.refs[0].name, NAME);
  assert.deepEqual(fs.readFileSync(store.pathOf(r.refs[0])), SAVE, 'the bytes in the store are the holder\'s');
  assert.ok(store.granted('beast', r.refs[0].id), 'beast may fetch it');
  assert.ok(!store.granted('lothdesktop', r.refs[0].id));
  assert.deepEqual(posted.map((p) => p.msg.type), ['lab_fixture', 'lab_fixture_upload'], 'a find, then the upload');
  assert.match(r.text, /Fetched lab fixture w1440-lifesave-0\.50\.0\.105\.zip .* from lothdesktop's fixtures folder \(read-only there\)/);
  assert.match(r.text, /\$FF_WORKER_ROOT\/nightly-history\/fixtures\/w1440-lifesave-0\.50\.0\.105\.zip/);
  assert.equal(store.bySha(sha(SAVE))?.source, `lab fixture ${NAME} from lothdesktop`);
  assert.deepEqual(fs.readdirSync(dir).map((n) => [n, fs.statSync(path.join(dir, n)).mtimeMs]), before, "the holder's folder is as it was");
});

test('w3939: a name other than the fixture\'s is said, the file still delivered under what the scenario asks', async (t) => {
  const { root } = holderRoot(t, { [NAME]: SAVE });
  const { lf } = setup(t, { lothdesktop: root });
  const r = await lf.fetch('beast', sha(SAVE), 'life.zip');
  assert.equal(r.refs.length, 1);
  assert.match(r.text, /Its name there is w1440-lifesave-0\.50\.0\.105\.zip, not life\.zip/);
  assert.match(r.text, /fixtures\/life\.zip/);
});

test('w3939: the portal holds it already and lothdesktop is off: beast gets it and no computer is asked', async (t) => {
  const { root } = holderRoot(t, { [NAME]: SAVE });
  const { store, lf, online, posted } = setup(t, { lothdesktop: root });
  await lf.fetch('beast', sha(SAVE));
  online.delete('lothdesktop');
  posted.length = 0;
  const r = await lf.fetch('lothlaptop', sha(SAVE));
  assert.equal(r.refs[0].sha256, sha(SAVE));
  assert.ok(store.granted('lothlaptop', r.refs[0].id));
  assert.deepEqual(posted, [], 'nothing was posted');
  assert.match(r.text, /from the portal's copy \(no computer was asked\)/);
});

test('w3939: two workers asking for one sha256 at once share one copy from the holder', async (t) => {
  const { root } = holderRoot(t, { [NAME]: SAVE });
  const { store, lf, posted } = setup(t, { lothdesktop: root });
  const [a, b] = await Promise.all([lf.fetch('beast', sha(SAVE)), lf.fetch('lothlaptop', sha(SAVE))]);
  assert.equal(a.refs[0].id, b.refs[0].id);
  assert.equal(posted.filter((p) => p.msg.type === 'lab_fixture_upload').length, 1);
  assert.equal(store.usage().files, 1);
  assert.ok(store.granted('beast', a.refs[0].id) && store.granted('lothlaptop', a.refs[0].id));
});

test('w3939: a holder says hello: what the store lacks is copied, what it has is touched, a file over the limit is logged and skipped', async (t) => {
  const big = Buffer.alloc(300, 7);
  const { root } = holderRoot(t, { [NAME]: SAVE, 'other.zip': OTHER, 'big.zip': big });
  // 0.05 MB is 52428 bytes: all three files fit
  const { store, lf, posted, logs } = setup(t, { lothdesktop: root }, { maxMB: 0.05 });
  const present = await store.addFile(path.join(fixturesDir(root), 'other.zip'));
  const stale = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const rec = store.get(present.id)!;
  rec.lastUsedAt = stale;
  lf.onHolder('lothdesktop');
  await until(() => !!store.bySha(sha(SAVE)) && !!store.bySha(sha(big)) && store.get(present.id)!.lastUsedAt !== stale, 'copied and touched');
  assert.ok(store.bySha(sha(SAVE)), 'the missing save was pulled');
  assert.notEqual(store.get(present.id)!.lastUsedAt, stale, 'the one it had was touched');
  assert.equal(posted.filter((p) => p.msg.type === 'lab_fixture_upload').length, 2, 'only the two missing ones were pulled (the save and big.zip)');
  assert.equal(posted[0].msg.type, 'lab_fixture');
  assert.equal((posted[0].msg as { op: string }).op, 'list');

  // over the limit: not copied, said in the log
  const tight = setup(t, { lothdesktop: holderRoot(t, { [NAME]: SAVE }).root }, { maxMB: 0.0001 });
  tight.lf.onHolder('lothdesktop');
  await until(() => tight.logs.some((l) => /over the attachment limit/.test(l)), 'a log line per file over the limit');
  assert.equal(tight.store.usage().files, 0);
  assert.equal(tight.posted.filter((p) => p.msg.type === 'lab_fixture_upload').length, 0);
  assert.ok(logs.every((l) => !/not copied/.test(l)));
});

test('w3939: refusals are plain text: a bad sha256, a path for a name, no holder online and nothing cached, a sha256 no holder has', async (t) => {
  const { root } = holderRoot(t, { [NAME]: SAVE });
  const { store, lf, online, posted } = setup(t, { lothdesktop: root });
  for (const bad of ['', 'abc', 'g'.repeat(64), sha(SAVE) + '0']) {
    const r = await lf.fetch('beast', bad);
    assert.deepEqual(r.refs, []);
    assert.match(r.text, /sha256: 64 hex digits/);
  }
  for (const name of ['../x.zip', 'a/b.zip', 'a\\b.zip', 'x'.repeat(129)]) {
    const r = await lf.fetch('beast', sha(SAVE), name);
    assert.deepEqual(r.refs, []);
    assert.match(r.text, /name: a plain file name/);
  }
  assert.deepEqual(posted, [], 'a bad argument asks nobody');

  const none = sha(Buffer.from('nobody has this'));
  const missing = await lf.fetch('beast', none);
  assert.deepEqual(missing.refs, []);
  assert.match(missing.text, /No lab fixture with sha256 [a-f0-9]{64} on lothdesktop/);
  assert.match(missing.text, /the SHA-256 the scenario's `source` text gives/);
  assert.equal(store.usage().files, 0);

  online.clear();
  const off = await lf.fetch('beast', none);
  assert.deepEqual(off.refs, []);
  assert.match(off.text, /No online computer holds a lab fixture cache now/);
  assert.match(off.text, /lothdesktop \(last online \d{4}-/, 'the holder seen before is named');
  assert.match(off.text, /`wake_me 30`/);
  assert.match(off.text, /Do not ask a person to bring a computer online/);
  assert.doesNotMatch(off.text, /ask (?:Ben|Lothsahn|the orchestrator) to/i);
});

test('w3939: a fixture over attachments.maxMB is refused with the limit; a holder that never answers ends the call', async (t) => {
  const { root } = holderRoot(t, { [NAME]: SAVE });
  const small = setup(t, { lothdesktop: root }, { maxMB: 0.0001 });
  const r = await small.lf.fetch('beast', sha(SAVE));
  assert.deepEqual(r.refs, []);
  assert.match(r.text, /was not taken: the file is 39 KB; the limit is .* \(config attachments\.maxMB\)/);

  const store = new AttachmentStore(tmp(t, 'w3939-data-'));
  const silent = new LabFixtures({ store, post: () => true, holders: () => ['lothdesktop'], log: () => {}, findMs: 20, uploadMs: 20 });
  const s = await silent.fetch('beast', sha(SAVE));
  assert.deepEqual(s.refs, []);
  assert.match(s.text, /lothdesktop: no answer in 0 s/);
});

test('w3939: a text fixture the portal would mask is not handed out under a hash it does not have', async (t) => {
  const secret = Buffer.from('{"token":"ghp_' + 'a'.repeat(36) + '"}\n');
  const { root } = holderRoot(t, { 'cfg.json': secret });
  const { store, lf } = setup(t, { lothdesktop: root });
  const r = await lf.fetch('beast', sha(secret));
  const stored = store.bySha(sha(secret));
  // either the text had nothing to mask (kept as is) or the copy under another hash was refused and dropped
  if (!stored) {
    assert.deepEqual(r.refs, []);
    assert.match(r.text, /stored under another SHA-256/);
  } else assert.equal(r.refs[0].sha256, sha(secret));
});

test('machine/labFixtures: only regular files directly in the folder are listed, hashed, and nothing there is changed', async (t) => {
  const { dir } = holderRoot(t, { [NAME]: SAVE, 'other.zip': OTHER, '.hidden.zip': OTHER, 'empty.zip': Buffer.alloc(0) });
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'deep.zip'), SAVE);
  let linked = false;
  try {
    fs.symlinkSync(path.join(dir, 'other.zip'), path.join(dir, 'link.zip'));
    linked = true;
  } catch {
    // no right to make links here: the other skips still hold
  }
  const state = () => fs.readdirSync(dir, { recursive: true }).map(String).sort().map((n) => [n, fs.lstatSync(path.join(dir, n)).mtimeMs, fs.lstatSync(path.join(dir, n)).size]);
  const before = state();
  const list = await listFixtures(dir);
  assert.deepEqual(list, [
    { name: 'other.zip', size: OTHER.length, sha256: sha(OTHER) },
    { name: NAME, size: SAVE.length, sha256: sha(SAVE) },
  ]);
  assert.ok(!list.some((f) => f.name === 'link.zip') || !linked);
  assert.deepEqual(await findFixtures(dir, sha(SAVE).toUpperCase()), [list[1]]);
  assert.deepEqual(await findFixtures(dir, sha(Buffer.from('x'))), []);
  assert.deepEqual(state(), before, 'no file or folder was written, renamed or deleted');

  // a sha256 the folder lacks is refused before any byte goes
  await assert.rejects(sendFixture(dir, sha(Buffer.from('x')), { portalUrl: 'http://127.0.0.1:1', token: 't', uploadId: 'u' }), /no lab fixture with sha256/);
  // a changed file is not sent under the old hash: it is listed again under its new one
  fs.writeFileSync(path.join(dir, 'other.zip'), Buffer.from('changed bytes!'));
  assert.deepEqual(await findFixtures(dir, sha(OTHER)), []);
});

test('machine/labFixtures: drive C: is never read, and a root with no fixtures folder offers nothing', async (t) => {
  assert.equal(onDriveC('C:\\x\\nightly-history\\fixtures', 'win32'), true);
  assert.equal(onDriveC('c:/ffw/nightly-history/fixtures', 'win32'), true);
  assert.equal(onDriveC('V:\\ffw\\nightly-history\\fixtures', 'win32'), false);
  assert.equal(onDriveC('C:\\x', 'linux'), false, 'a drive letter means nothing off Windows');
  if (process.platform === 'win32') {
    assert.equal(offeredDir('C:\\ff-worker-that-does-not-exist'), undefined);
  }
  const bare = tmp(t, 'w3939-bare-');
  assert.equal(offeredDir(bare), undefined);
  assert.equal(offeredDir(undefined), undefined);
  fs.mkdirSync(fixturesDir(bare), { recursive: true });
  if (!onDriveC(bare)) assert.equal(offeredDir(bare), fixturesDir(bare));
});

test('fetch_lab_fixture: the worker tool takes a sha256 and a name, never a path', () => {
  assert.deepEqual(Object.keys(CATALOG.fetch_lab_fixture).sort(), ['name', 'sha256']);
});
