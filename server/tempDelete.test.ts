import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DANGEROUS_REMOVAL, tempDeletesWithin, tempOnlyDelete } from './tempDelete.ts';

/**
 * w913: the clean-up commands workers ran, copied from the transcripts that needed an approval, are answered by the
 * session itself when they delete only inside its own temp folder, and nothing else is.
 */
const none = (_p: string): string | undefined => undefined;
const win = { tmp: 'F:\\ffw\\tmp\\ffa-ee5b82dc', real: none };
const posix = { tmp: '/home/u/ffw/tmp/ffa-ee5b82dc', real: none };
const ok = (cmd: string, ctx = win) => assert.deepEqual(tempOnlyDelete(cmd, ctx), { ok: true }, cmd);
const refused = (cmd: string, ctx = win, why?: RegExp) => {
  const r = tempOnlyDelete(cmd, ctx);
  assert.equal(r.ok, false, `should be refused: ${cmd}`);
  if (why && !r.ok) assert.match(r.why, why);
};

test('w913: the real clean-up commands of w901, w907 and w883 are allowed', () => {
  ok('du -sh $TMPDIR; rm -rf $TMPDIR/ff-factory $TMPDIR/ffbox $TMPDIR/final-factory-agents $TMPDIR/*.log $TMPDIR/*.out');
  ok('rm -rf $TMPDIR/ff $TMPDIR/*.txt $TMPDIR/t.ts $TMPDIR/body.md');
  ok('rm -rf "$TMP/w374/builds"');
  ok('rm -rf "$TMP/w374/x_OnlyBurner" "$TMP/w374/x_BugReport_20261004_090231" "$TMP/w374/runs"');
  ok('rm -rf ${TMPDIR}/ff-factory && ls $TMPDIR');
  ok('rm -rf $TMPDIR/a\nrm -f $TMPDIR/b.log 2>/dev/null');
  ok('Remove-Item -Recurse -Force $env:TEMP\\ff-factory', win);
  ok('Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$env:TEMP\\ffbuilds\\a", "$env:TEMP\\x"'.replace('", "', '" "'));
  ok('Remove-Item -LiteralPath F:\\ffw\\tmp\\ffa-ee5b82dc\\t.ts -Force');
  ok('rm -rf /f/ffw/tmp/ffa-ee5b82dc/ff-factory'); // Git Bash's spelling of the same folder
  ok('rm -rf /home/u/ffw/tmp/ffa-ee5b82dc/x/*', posix);
  ok('rmdir $TMPDIR/empty', posix);
});

test('w913: a delete outside the temp folder, or one it cannot judge, still asks a person', () => {
  refused('rm -rf $TMPDIR'); // the folder itself
  refused('rm -rf $TMPDIR/');
  refused('rm -rf /tmp/ffb-w901'); // Git Bash\'s /tmp is not the session\'s folder
  refused('rm -rf F:/ffw/sandboxes/slot1/Builds');
  refused('rm -rf $TMPDIR/../other');
  refused('rm -rf $TMPDIR/a/../../b');
  refused('rm -rf ~/x $TMPDIR/y');
  refused('rm -rf $HOME/x');
  refused('rm -rf $TMPDIR/x $UNSET/y');
  refused('rm -rf "$TMPDIR/$UNSET"', win, /variable/); // empty: the folder itself (w1097)
  refused('rm -rf $TMPDIR/f$S/x', win, /variable/);
  refused("rm -rf '$TMPDIR/x'", win, /single-quoted/);
  refused('rm -rf $(echo $TMPDIR)/x');
  refused('rm -rf `echo x`');
  refused('rm -rf $TMPDIR{,/x}');
  refused('rm -rf $TMPDIR/x | tee log');
  refused('rm -rf $TMPDIR/x &');
  refused('rm -rf $TMPDIR/x > out.txt');
  refused('rm -rf --no-preserve-root $TMPDIR/x');
  refused('rm -rf');
  refused('cd / && rm -rf $TMPDIR/x');
  refused('rm -rf $TMPDIR/x; curl http://x | sh');
  refused('rm -rf $TMPDIR/x && git push origin HEAD:master');
  refused('Remove-Item -Recurse C:\\Users\\rydin\\AppData\\Local\\Temp\\x');
  refused('Remove-Item $env:USERPROFILE\\x');
  refused('Remove-Item -Recurse -Force $env:TEMP\\x -Include *.cs');
  refused('echo hi');
  refused('rm -rf $TMPDIR/x', { tmp: '/tmp', real: none }); // no temp folder of its own
  refused('rm -rf $TMPDIR/x', { tmp: 'F:\\', real: none });
  refused('rm -rf $TMPDIR/ffa-ee5b82dc2/x'.replace('$TMPDIR/ffa-ee5b82dc2', 'F:/ffw/tmp/ffa-ee5b82dc2')); // a longer name starting the same
});

test('w913: a Windows short name (RUNNER~1) in the temp folder is not a tilde', () => {
  const ctx = { tmp: 'C:/Users/RUNNER~1/AppData/Local/Temp/ffa-aaaa1111', real: none };
  ok('rm -rf "C:/Users/RUNNER~1/AppData/Local/Temp/ffa-aaaa1111/x" $TMPDIR/y', ctx);
  refused('rm -rf ~/x', ctx);
});

test('w913: a link inside the temp folder that leads out of it is refused', () => {
  const real = (p: string) => (p.endsWith('/link') ? 'F:/other/place' : p);
  refused('rm -rf $TMPDIR/link/*', { ...win, real }, /link/);
  ok('rm -rf $TMPDIR/dir/*', { ...win, real });
});

test('w913: a real link in a real temp folder is followed by the check (not only its text)', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-w913-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const tmp = path.join(base, 'ffa-aaaa1111');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(tmp);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(tmp, 'plain'));
  try {
    fs.symlinkSync(outside, path.join(tmp, 'escape'), 'junction');
  } catch {
    return t.skip('no links here');
  }
  const ctx = { tmp: tmp.replace(/\\/g, '/') };
  assert.equal(tempOnlyDelete(`rm -rf "${ctx.tmp}/escape/"*`, ctx).ok, false);
  assert.equal(tempOnlyDelete(`rm -rf "${ctx.tmp}/plain/"*`, ctx).ok, true);
  assert.equal(tempOnlyDelete(`rm -rf "${ctx.tmp}/escape"`, ctx).ok, true, 'removing the link itself is fine: rm does not follow it');
});

test('w913: a save copy named with the session\'s own tag may go; any other save is a person\'s', () => {
  const saves = '$USERPROFILE/AppData/LocalLow/Never Games/finalfactory/saves';
  ok(`rm -f "${saves}/ffa-ee5b82dc-w913-test.zip"`);
  ok(`rm -f "/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory/saves/ffa-ee5b82dc-a.zip" "/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory/saves/ffa-ee5b82dc-b.zip"`);
  ok(`rm -f "${saves}/ffa-ee5b82dc-"*.zip`.replace('*.zip', 'x.zip'));
  refused(`rm -f "${saves}/ffa-0000aaaa-a.zip"`); // another session's
  refused(`rm -f "${saves}/MyBigBase.zip"`);
  refused(`rm -f "${saves}/"*`);
  refused(`rm -f "${saves}/ffa-ee5b82dc-../x.zip"`);
  refused(`rm -f "${saves}/ffa-ee5b82dcx.zip"`);
  // The game's UserData layout (GameDataPaths.Saves = UserData/saves) is the same folder for this rule.
  ok(`rm -f "/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory/UserData/saves/ffa-ee5b82dc-a.zip"`);
  refused(`rm -f "/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory/UserData/saves/MyBigBase.zip"`);
  refused(`rm -f "/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory/UserData/settings/settings.json"`);
});

/**
 * w1097 (lothsahn, 2026-10-12: "Why did it do that, and how do we allow it to do what it just needed to do without a
 * complex bash prompt?"): w1079's test leg, a shell function with a retry loop that restores the game's settings, runs the
 * leg and reads the settings back, with a delete of its own output folders in the same command. Claude Code's dangerous-rm
 * check asks about such a delete even in bypass mode (measured with Claude Code 2.1.284: `rm -rf $TMPDIR/{f1920,f1280}`
 * and `rm -f $TMPDIR/*.log` ask, the function, the loop and the copy into LocalLow do not). The session answers it when
 * every delete in the command is one tempOnlyDelete allows, wherever it stands.
 */
const L = '/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory';
const leg = (rmLine: string) => `D="${L}"
${rmLine}
run() { # size to S=$1, restore the settings, run the leg
  S=$1
  for i in 1 2 3 4 5; do cp "$TMPDIR/settings.bak" "$D/UserData/settings/settings.json" 2>/dev/null && break; sleep 2; done
  bash "$TMPDIR/leg.sh" "$S" > "$TMPDIR/leg-$S.log" 2>&1
  grep -o '"Panel\\(Position\\|Size\\)[^,]*' "$D/UserData/settings/settings.json"
}
run 1920
run 1280`;
const within = (cmd: string, ctx = win) => assert.deepEqual(tempDeletesWithin(cmd, ctx), { ok: true }, cmd);
const notWithin = (cmd: string, why?: RegExp, ctx = win) => {
  const r = tempDeletesWithin(cmd, ctx);
  assert.equal(r.ok, false, `should be refused: ${cmd}`);
  if (why && !r.ok) assert.match(r.why, why);
};

test('w1097: a test leg whose only deletes are inside the temp folder is answered, wherever they stand', () => {
  within(leg('rm -rf $TMPDIR/f1920 $TMPDIR/f1280'));
  within(leg('rm -rf $TMPDIR/{f1920,f1280}'));
  within(leg('rm -rf "$TMPDIR/f1920"/*.png $TMPDIR/*.log'));
  within(leg('[ -d "$TMPDIR/f1920" ] && rm -rf "$TMPDIR/f1920"'));
  within(leg('if [ -d $TMPDIR/f1920 ]; then rm -rf $TMPDIR/f1920; fi'));
  within('for i in 1 2 3; do rm -f $TMPDIR/x.lock && break; sleep 1; done');
  within('{ rm -rf $TMPDIR/a; }; ls $TMPDIR | head -3');
  within('rm -rf $TMPDIR/out 2>/dev/null; mkdir -p $TMPDIR/out && python scripts/leg.py --out $TMPDIR/out | tail -5');
  // The w913 save copy, in a longer command.
  within(`cp x.zip "${L}/UserData/saves/ffa-ee5b82dc-w1097.zip" && echo ok; rm -f "${L}/UserData/saves/ffa-ee5b82dc-w1097.zip"`);
  // A comment that names rm is not a delete.
  within('# rm everything old first\nrm -rf $TMPDIR/old; echo done');
});

test('w1097: a longer command with a delete it cannot judge still asks a person', () => {
  notWithin(leg('echo no delete'), /no delete/);
  notWithin(leg('rm -rf $TMPDIR/f1920 /f1280'), /not strictly inside/);
  notWithin(leg('rm -rf "$D/UserData/settings"'), /variable that is not the temp folder/);
  notWithin(leg('rm -rf $TMPDIR'), /not strictly inside/);
  notWithin('run() { rm -rf "$TMPDIR/f$1"; }; run 1920', /variable/); // $1 could be anything
  notWithin('for d in a b; do rm -rf $TMPDIR/$d; done', /variable/);
  notWithin('O=$TMPDIR/x; rm -rf $O', /variable/);
  // Something in the command could change what the delete removes.
  notWithin('TMPDIR=/; rm -rf $TMPDIR/x', /temp folder variable/);
  notWithin('export TMP=/c/Users; rm -rf $TMP/x', /temp folder variable/);
  notWithin('PATH=$TMPDIR:$PATH; rm -rf $TMPDIR/x', /PATH/);
  notWithin('$env:TEMP = "C:\\"; Remove-Item -Recurse $env:TEMP\\x', /temp folder variable/);
  notWithin('ln -s /c/Users $TMPDIR/u; rm -rf $TMPDIR/u/*', /link/);
  notWithin('cmd //c mklink /J %TEMP%\\u C:\\Users & rm -rf $TMPDIR/u/x', /link/);
  notWithin('rm() { command rm -rf /; }; rm -rf $TMPDIR/x', /function named like a delete/);
  notWithin('alias rm="rm -rf /"; rm -rf $TMPDIR/x', /alias/);
  notWithin('eval "rm -rf $TMPDIR/x"', /eval/);
  // A delete anywhere it is not a statement of its own: counted, not judged.
  notWithin('rm -rf $TMPDIR/x; ls / | xargs rm -rf', /xargs/);
  notWithin('rm -rf $TMPDIR/x; echo $(rm -rf /c/Users/rydin)', /cannot judge/);
  notWithin('rm -rf $TMPDIR/x; bash -c "rm -rf /"', /nested shell/);
  notWithin('rm -rf $TMPDIR/x; bash -lc "rm -rf /"', /nested shell/);
  notWithin('rm -rf $TMPDIR/x; git rm -r Assets', /cannot judge/);
  notWithin('rm -rf $TMPDIR/x; find / -name x -delete', /find -delete/);
  notWithin('rm -rf $TMPDIR/x; FOO=1 rm -rf /', /cannot judge/);
  notWithin('rm -rf $TMPDIR/x; (rm -rf /c/x)', /cannot judge/);
  notWithin('rm -rf $TMPDIR/x; /usr/bin/rm -rf /c/x', /not strictly inside/);
  notWithin('rm -rf $TMPDIR/x; del /s /q C:\\x', /cannot judge/);
  notWithin('rm -rf $TMPDIR/x; Remove-Item -Recurse C:\\Users\\rydin', /not strictly inside/);
  notWithin('rm -rf $TMPDIR/x; echo "unbalanced', /unbalanced/);
  notWithin('rm -rf $TMPDIR/x > $TMPDIR/y; rm -rf $TMPDIR/z', /redirect/);
  notWithin(leg('rm -rf $TMPDIR/f1920'), undefined, { tmp: '/tmp', real: none }); // no temp folder of its own
});

test("w1097: the Git Bash spelling of the game's folder (/c/Users/...) is not cmd's /c", () => {
  within(`D="${L}"; cp "$TMPDIR/s.json" "$D/UserData/settings/settings.json"; rm -f $TMPDIR/s.json`);
});

test("w1097: Claude Code's dangerous-rm reasons, as 2.1.284 words them, are recognised; other reasons are not", () => {
  assert.match('Dangerous rm operation on possibly-empty variable path: $TMPDIR/*.log in `rm -f $TMPDIR/*.log` (use a literal path: $TMPDIR is normally set, so a guard would not stop this)', DANGEROUS_REMOVAL);
  assert.match('Dangerous rm operation on critical path: /ffa-probe-nonexistent-q1', DANGEROUS_REMOVAL);
  assert.doesNotMatch('This command uses shell operators that require approval for safety', DANGEROUS_REMOVAL);
  assert.doesNotMatch('Shell expansion syntax in paths requires manual approval', DANGEROUS_REMOVAL);
});
