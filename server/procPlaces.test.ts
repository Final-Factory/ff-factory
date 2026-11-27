import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseLsof, procPlaces } from './procPlaces.ts';

// w6240: where a process runs from, for the ffu slot rule (server/installLeftovers.ts runsFromDir).

test("w6240: lsof's -F output gives each process its working folder and its first txt as the executable", () => {
  const out = ['p93416', 'fcwd', 'n/w/ffu-sandboxes/slot4/ffu', 'ftxt', 'n/usr/bin/python3', 'ftxt', 'n/usr/lib/libz.dylib', 'p93417', 'ftxt', 'n/w/ffu-sandboxes/slot4/target/debug/deps/alarms-bdd02d47710ae4cf', ''].join('\n');
  assert.deepEqual(parseLsof(out), [
    { pid: 93416, cwd: '/w/ffu-sandboxes/slot4/ffu', exe: '/usr/bin/python3' },
    { pid: 93417, exe: '/w/ffu-sandboxes/slot4/target/debug/deps/alarms-bdd02d47710ae4cf' },
  ]);
  assert.deepEqual(parseLsof(''), []);
});

test('w6240: procPlaces reads this process on the machine the tests run on', async () => {
  const places = await procPlaces();
  if (process.platform !== 'linux' && process.platform !== 'darwin' && process.platform !== 'win32') return assert.equal(places, undefined);
  assert.ok(places?.length, 'the listing answers');
  const me = places.find((p) => p.pid === process.pid);
  assert.ok(me, 'this test process is in it');
  assert.equal(fs.realpathSync(me.exe!), fs.realpathSync(process.execPath), 'its executable is node');
  if (process.platform !== 'win32') assert.equal(fs.realpathSync(me.cwd!), fs.realpathSync(process.cwd()), 'its working folder');
  assert.equal(await procPlaces('aix'), undefined, 'a platform with no reader: undefined, so the caller keeps the files');
});
