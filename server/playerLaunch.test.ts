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
    'F:/ff-players/slot3/player/finalfactory.exe -batchmode',
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
