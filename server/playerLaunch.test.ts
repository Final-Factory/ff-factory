// w513: built players start only from a player slot (server/guard.ts checkPlayerLaunch).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPlayerLaunch } from './guard.ts';

test('a player started from a build, sandbox or temp folder is refused, with the slot launcher named', () => {
  for (const cmd of [
    'F:/ffsb/x/builds/a/finalfactory.exe -batchmode',
    '"F:\\ffsb\\x\\Builds\\a b\\finalfactory.exe" -x',
    '& "C:\\Users\\u\\AppData\\Local\\Temp\\ffa-1234\\lab\\builds\\abc-win\\player\\finalfactory.exe"',
    'Start-Process -FilePath C:\\b\\finalfactory.exe -ArgumentList x',
    'cd builds && ./finalfactory.exe &',
    'FOO=1 nohup ./Builds/mac/finalfactory.app/Contents/MacOS/finalfactory &',
    'open -n builds/finalfactory.app --args -x',
    'cmd /c start "" D:\\work\\ffsb\\sb1\\Builds\\w\\finalfactory.exe',
  ]) {
    const why = checkPlayerLaunch(cmd);
    assert.ok(why, cmd);
    assert.match(why, /player_slots\.py launch/);
  }
});

test('a player in a slot, the slot launcher and commands that only touch a build are allowed', () => {
  for (const cmd of [
    'F:/ffw/players/slot3/player/finalfactory.exe -batchmode',
    'C:\\ffw\\players\\slot0\\player\\finalfactory.exe -logFile x',
    'open -n ~/ffw/players/slot0/player/finalfactory.app --args -x',
    '/Users/b/ffw/players/slot1/player/finalfactory.app/Contents/MacOS/finalfactory -batchmode',
    'python scripts/nightly/player_slots.py launch F:/ffsb/x/builds/a/finalfactory.exe -- -batchmode',
    'ls builds/finalfactory.exe',
    'cp -r builds/finalfactory.app /tmp/x',
    'sha256sum F:/b/finalfactory.exe',
    '"${FF_LAUNCH[@]}" "$PLAYER" -- -x &',
    'git log -- finalfactory.exe',
  ]) {
    assert.equal(checkPlayerLaunch(cmd), undefined, cmd);
  }
});

test("w576: a sandbox's players run from its own pair, slotK-0 and slotK-1, never another sandbox's", () => {
  // Sandbox slot3 on a worker root install owns players/slot3-0 (the host) and slot3-1 (the client).
  for (const cmd of ['D:/work/ffw/players/slot3-0/player/finalfactory.exe -batchmode', '& "D:/work/ffw/players/slot3-1/player/finalfactory.exe" -x']) {
    assert.equal(checkPlayerLaunch(cmd, 'slot3'), undefined, cmd);
  }
  const why = checkPlayerLaunch('D:/work/ffw/players/slot2-1/player/finalfactory.exe -x', 'slot3');
  assert.match(why ?? '', /sandbox slot2's player folder; this is sandbox slot3, whose players run only from slot3-0 and slot3-1/);
  assert.match(why ?? '', /--peer 1/);
  // A pair path outside a slotK sandbox (a host sandbox, a main clone) and a lab pool's slotK stay as before.
  assert.equal(checkPlayerLaunch('D:/work/ffw/players/slot2-1/player/finalfactory.exe', 'agent-mcp'), undefined);
  assert.equal(checkPlayerLaunch('F:/ffw/players/slot7/player/finalfactory.exe', 'slot3'), undefined);
  assert.match(checkPlayerLaunch('D:/work/ffw/sandboxes/slot3/Builds/w/finalfactory.exe', 'slot3') ?? '', /outside a player slot/);
});

test("w576: the nightly lab's pair, slotnightly-0 and -1, is a slot; a sandbox may not start from it", () => {
  assert.equal(checkPlayerLaunch('D:/work/ffw/players/slotnightly-1/player/finalfactory.exe -x'), undefined, 'the nightly lab, outside any sandbox');
  assert.match(checkPlayerLaunch('D:/work/ffw/players/slotnightly-0/player/finalfactory.exe', 'slot2') ?? '', /the nightly lab's player folder; this is sandbox slot2/);
});
