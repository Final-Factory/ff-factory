// w513: built players start only from a player slot (server/guard.ts checkPlayerLaunch).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPlayerLaunch, checkScriptPlayerLaunch } from './guard.ts';

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

test("w1099: the nightly lab's old pair, slotnightly-0 and -1, is no slot any more", () => {
  // The nightly run plays from its sandbox's own pair since w1099; the installer removes the old folders.
  assert.match(checkPlayerLaunch('V:/ffw/players/slotnightly-1/player/finalfactory.exe -x') ?? '', /outside a player slot/);
  assert.match(checkPlayerLaunch('V:/ffw/players/slotnightly-0/player/finalfactory.exe', 'slot2') ?? '', /outside a player slot/);
  assert.equal(checkPlayerLaunch('V:/ffw/players/slot2-1/player/finalfactory.exe', 'slot2'), undefined);
});

test('w4167: a script handed a player outside a slot is refused unless it starts players through the slot pool', () => {
  const files: Record<string, string> = {
    'V:/ffw/tmp/ffa-1/run_legs.sh': '#!/bin/bash\n"$1" -ffSoloNewGame w1 -screen-width 1920 &\n',
    'V:/ffw/sandboxes/slot2/specs/w4155-x/run_legs.sh': 'python scripts/nightly/player_slots.py launch --detach "$APP" -- -x\n',
    'V:/ffw/sandboxes/slot2/specs/w1/leg.sh': 'source scripts/nightly/player_launch.sh\n"${FF_LAUNCH[@]}" "$1" -- -x\n',
    'V:/ffw/tmp/ffa-1/tour.py': 'import subprocess, sys\nsubprocess.Popen([sys.argv[1], "-x"])\n',
    'V:/ffw/tmp/ffa-1/tour.ps1': '& $args[0] -x\n',
    // run_w2183_suture_clips.py starts players through a helper it imports, which goes through the slots.
    'V:/ffw/sandboxes/slot2/scripts/feel/clips.py': 'import os\nfrom ship_clips import start\nstart(a.player)\n',
    'V:/ffw/sandboxes/slot2/scripts/feel/ship_clips.py': 'import player_slots\n',
  };
  const read = (p: string) => files[p.replace(/\\/g, '/')];
  const env = { TMPDIR: 'V:/ffw/tmp/ffa-1' };
  const cwd = 'V:/ffw/sandboxes/slot2';
  const exe = 'V:/ffw/tmp/ffa-1/builds/abc-win/player/finalfactory.exe';
  for (const cmd of [
    `bash "$TMPDIR/run_legs.sh" ${exe}`,
    `bash $TMPDIR/run_legs.sh "$TMPDIR/builds/abc-win/player/finalfactory.exe" 1920`,
    `cd x && sh V:/ffw/tmp/ffa-1/run_legs.sh V:\\ffw\\tmp\\ffa-1\\builds\\abc-win\\player\\finalfactory.exe`,
    `python3 $TMPDIR/tour.py --player=${exe}`,
    `timeout 600 python $TMPDIR/tour.py V:/ffw/tmp/ffa-1/builds/abc-win/player`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File $TMPDIR/tour.ps1 ${exe}`,
    `FOO=1 bash "$TMPDIR/run_legs.sh" V:/ffw/tmp/ffa-1/builds/abc-win`,
  ]) {
    const why = checkScriptPlayerLaunch(cmd, cwd, env, read);
    assert.match(why ?? '', /outside a player slot.*player_slots\.py launch/s, cmd);
  }
  for (const cmd of [
    // Scripts that start players through the slot pool: handing them a build is the normal path.
    `bash specs/w4155-x/run_legs.sh ${exe} V:/ffw/tmp/ffa-1/builds/def-win/player/finalfactory.exe`,
    `bash specs/w1/leg.sh ${exe}`,
    `python scripts/feel/clips.py --player ${exe}`,
    // A slot's own player, no player at all, a script that cannot be read, or no script file.
    `bash $TMPDIR/run_legs.sh V:/ffw/players/slot2-0/player/finalfactory.exe`,
    'bash $TMPDIR/run_legs.sh 1920',
    `bash $TMPDIR/missing.sh ${exe}`,
    `bash $(make_path) ${exe}`,
    `python -c "print(1)" ${exe}`,
    `cp -r V:/ffw/tmp/ffa-1/builds/abc-win/player V:/ffw/tmp/ffa-1/keep`,
    `ls ${exe}`,
  ]) {
    assert.equal(checkScriptPlayerLaunch(cmd, cwd, env, read), undefined, cmd);
  }
});

test('w4169: timeout, a subshell, cmd //c, a variable and inline code do not hide a player outside a slot', () => {
  // The paths LothDesktop's firewall log named on 2026-11-13 (two prompts, both answered Block).
  const exe = 'V:/ffw/tmp/ffa-b770969a/builds/07b0492f06-win/player/finalfactory.exe';
  const dir = 'V:/ffw/tmp/ffa-b770969a/builds/07b0492f06-win/player';
  for (const cmd of [
    `timeout -s TERM 600 "${exe}" -ffDeckTour t.json`,
    `timeout --kill-after=10 300 ${exe} -x`,
    `timeout 600 ${exe}`,
    `(cd ${dir} && ./finalfactory -x)`,
    `cd "${dir}" && ./finalfactory -screen-width 1280 &`,
    `cmd //c start "" "${exe}" -x`,
    `P="${exe}"; "$P" -x`,
    `export EXE=${exe} && timeout -s TERM 60 $EXE -x`,
    `$p = "${exe}"; & $p -x`,
    `python -c "import subprocess; subprocess.Popen(['${exe}'])"`,
    `python - <<'PY'\nimport subprocess\nsubprocess.Popen([r"${exe.replace(/\//g, '\\')}", "-x"])\nPY`,
    `powershell -NoProfile -Command "Start-Process '${exe}'"`,
  ]) {
    assert.match(checkPlayerLaunch(cmd) ?? '', /outside a player slot.*player_slots\.py launch/s, cmd);
  }
  for (const cmd of [
    `timeout -s TERM 600 V:/ffw/players/slot2-0/player/finalfactory.exe -x`,
    `(cd V:/ffw/players/slot2-1/player && ./finalfactory -x)`,
    `timeout 900 python scripts/nightly/player_slots.py launch ${exe} -- -x`,
    `P=${exe}; cp "$P" ${'$'}TMPDIR/keep/`,
    `python -c "print('${exe}')"`,
    `python - <<'PY'\nimport subprocess\nsubprocess.run(['python', 'scripts/nightly/player_slots.py', 'launch', '${exe}'])\nPY`,
    `git commit -m "$(cat <<'EOF'\nsubprocess.Popen used to start ${exe}\nEOF\n)"`,
    `grep -n subprocess scripts/x.py && ls ${dir}/finalfactory.exe`,
    `timeout 5 ls ${dir}`,
  ]) {
    assert.equal(checkPlayerLaunch(cmd, 'slot2'), undefined, cmd);
  }
});
