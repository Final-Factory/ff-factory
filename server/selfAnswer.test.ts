import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selfAnswer, type SelfAnswerInput } from './selfAnswer.ts';
import { readOnlyShell } from './readOnlyShell.ts';

/**
 * w5148's replay (lothsahn, 2026-11-22: "I just got a bash request. Figure out why I get those and how to cut them down
 * 90%"): the 21 Bash commands that reached a person from 2026-10-23 to 2026-11-22, copied from the portal's relay of each
 * question (home folders renamed), each judged again by the session's own answer. Before w5148 every one was asked
 * (measured: each one waited on a person or an orchestrator). The reason Claude Code gave is not in the relay, so the replay
 * gives each the reason its shape draws: the dangerous-rm reason when it deletes, the unfinished-check reason otherwise.
 */
interface Prompt {
  n: number;
  request: string;
  machine: string;
  askedAt: string;
  waitMin: number;
  tmp: string;
  cwd: string;
  expect: string;
  command: string;
}
const prompts: Prompt[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'w5148-prompts.json'), 'utf8'));
const RM_WHY = 'Dangerous rm operation detected: the target is the output of a command substitution';
const UNFINISHED = 'The permission check for this command did not finish, so its safety checks did not run.';
const slash = (p: string) => p.replace(/\\/g, '/');

/** Every folder exists and none is a link: the replay's view of the disk. Path files hold a folder in the temp folder. */
const ask = (p: Prompt, why?: string): ReturnType<typeof selfAnswer> =>
  selfAnswer({
    toolName: 'Bash',
    input: { command: p.command },
    why: why ?? (/\brm\b/.test(p.command) ? RM_WHY : UNFINISHED),
    permissionMode: 'bypassPermissions',
    tempDir: p.tmp,
    cwd: p.cwd,
    real: (x) => x,
    read: (f) => (/\.path$/.test(f) ? `${slash(p.tmp)}/${path.posix.basename(slash(f), '.path')}-out\n` : undefined),
  });

test('w5148: of the 21 counted questions the replay asks a person 5, and 1 of the 10 in the last 14 days', () => {
  const answered = prompts.filter((p) => ask(p).ok);
  for (const p of prompts) {
    const r = ask(p);
    if (p.expect.startsWith('asks')) assert.equal(r.ok, false, `#${p.n} ${p.request} should still ask: ${p.command.slice(0, 120)}`);
    else assert.equal(r.ok ? r.route : r.why, p.expect, `#${p.n} ${p.request}`);
  }
  assert.equal(prompts.length, 21);
  assert.equal(answered.length, 16);
  const recent = prompts.filter((p) => p.askedAt >= '2026-11-08');
  assert.equal(recent.length, 10);
  assert.equal(recent.filter((p) => ask(p).ok).length, 9);
  // The minutes workers waited on those answered: what the change saves (measured from the relay and the answers).
  const saved = answered.reduce((s, p) => s + p.waitMin, 0);
  assert.ok(saved > 2500, `saved ${saved} min`);
});

test('w5148: what decides an answer is the session, not the text: outside bypass mode, or with another reason, it asks', () => {
  const p = prompts.find((x) => x.n === 6)!;
  assert.equal(selfAnswer({ toolName: 'Bash', input: { command: p.command }, why: RM_WHY, permissionMode: 'default', tempDir: p.tmp, cwd: p.cwd, real: (x) => x }).ok, false);
  assert.equal(ask(p, 'Claude Code requires approval to read outside the allowed folders').ok, false);
  const r = prompts.find((x) => x.n === 0)!;
  assert.equal(ask(r, 'This command reads ~/.claude/settings.json').ok, false);
  assert.equal(selfAnswer({ toolName: 'Bash', input: { command: 'ls' }, why: UNFINISHED, permissionMode: 'bypassPermissions', tempDir: '/home/u/.tmp' }).ok, false);
});

/** A command the session must never answer, under either reason. */
const never = (command: string, o: Partial<SelfAnswerInput> = {}) => {
  for (const why of [RM_WHY, UNFINISHED]) {
    const r = selfAnswer({
      toolName: 'Bash',
      input: { command },
      why,
      permissionMode: 'bypassPermissions',
      tempDir: 'V:\\ffw\\tmp\\ffa-c7247682',
      cwd: 'V:\\ffw\\sandboxes\\slot3',
      real: (x) => x,
      read: () => 'V:/ffw/repo\n',
      ...o,
    });
    assert.equal(r.ok, false, `should still ask (${why.slice(0, 20)}): ${command}`);
  }
};

test('w5148: the guards stay as strict: main clones and C:', () => {
  never('rm -rf V:/ffw/repo/Library');
  never('rm -rf /v/ffw/repo/Assets/x.cs');
  never('cd /v/ffw/repo && rm -rf Library');
  never('cd V:/ffw/repo; rm -f x.txt');
  never('grep -rn secret /v/ffw/repo/Assets | head');
  never('cat /f/ffw/repo/ProjectSettings/ProjectVersion.txt', { tempDir: 'F:\\ffw\\tmp\\ffa-1', cwd: 'F:\\ffw\\sandboxes\\slot1' });
  never('du -sh C:/Users/u/AppData/Local');
  never('ls /c/Windows/System32 | head');
  never('rm -rf /c/Users/u/AppData/LocalLow/x');
  never('find /c/ -name "*.log" | head');
});

test('w5148: the guards stay as strict: deletes outside the sandbox or the temp folder', () => {
  never('cd /v/ffw/timing; rm -rf cache/* builds/b0 builds/b1'); // w3482, by design
  never('rm -rf /v/ffw/sandboxes/slot4/Library'); // another sandbox
  never('cd V:/ffw/sandboxes/slot3 && rm -rf .git/index.lock');
  never('cd V:/ffw/sandboxes/slot3 && rm -rf *'); // the whole worktree
  never('cd V:/ffw/sandboxes/slot3 && rm -rf ../slot4/x');
  never('rm -rf V:/ffw/sandboxes/slot3');
  never('rm -rf $TMPDIR');
  never('cd $TMPDIR; cd /; rm -rf etc');
  never('cd $TMPDIR && cd .. && rm -rf x');
  never('eval "$(ffu-slot where)"; rm -rf target'); // a relative path after a folder change it cannot read
  never('rm -rf "$(cat $TMPDIR/p.path)"'); // the file names the main clone (read above)
  never('rm -rf "$(cat $TMPDIR/p.path)"', { read: () => '/v/ffw/sandboxes/slot4\n' });
  never('echo /etc > $TMPDIR/p.path; rm -rf "$(cat $TMPDIR/p.path)"', { read: () => 'V:/ffw/tmp/ffa-c7247682/x\n' });
  never('for d in ../x; do rm -rf "$TMPDIR/$d"; done');
  never('for d in .*; do rm -rf "$TMPDIR/$d"; done');
  never('for d in a b; do rm -rf $TMPDIR/$d; done'); // unquoted: split and globbed
  never('rm -rf "$TMPDIR/$d"; for d in a; do true; done');
  never('ln -s / $TMPDIR/l; bash -c \'echo hi\'; rm -rf $TMPDIR/l/x');
  never("bash -c 'rm -rf /'");
  never('bash -c "echo $TMPDIR"; rm -rf /etc');
  never('while read f; do rm -f "$B/$f"; done < list.txt'); // w2682
  never('for d in ops/*/; do rm -rf "$N/$(basename $d)"; done'); // w2186
  never('rm -rf ~/ffw/tmp/x');
  never('find . -delete');
  never('ls | xargs rm -f');
});

test('w5148: the guards stay as strict: pushes to master or main, force pushes', () => {
  never('git push origin master');
  never('git push origin HEAD:main');
  never('git push --force origin w1');
  never('git push -f');
  never('cd $TMPDIR/ff && git push origin +w1:w1');
  never('git log -1 && git push origin master');
  never('git -c core.pager=sh log -1');
  never('git diff --output=/v/ffw/repo/x.patch');
  never('git commit -m x');
});

test('w5148: the guards stay as strict: secrets, credentials and the vault', () => {
  never('cat cicd/credentials.txt');
  never('grep -n token ~/.config/gh/hosts.yml');
  never('head -3 D:/work/ffw/daemon/secrets/vault.json');
  never('cat ~/.ssh/id_ed25519');
  never('jq . D:/work/ffw/daemon/daemon.json');
  never('cat $TMPDIR/.env');
  never('cat ~/.netrc');
});

test('w5148: the guards stay as strict: firewall, network and system settings', () => {
  never('netsh advfirewall set allprofiles state off');
  never('powershell -c "Set-NetFirewallProfile -Enabled False"');
  never('reg add HKLM\\Software\\x /v y /d 1');
  never('sc stop WinDefend');
  never('sudo pfctl -d');
  never('defaults write com.apple.x y 1');
  never('networksetup -setdnsservers Wi-Fi 1.1.1.1');
  never('Set-ItemProperty HKLM:\\x -Name y -Value 1', {});
});

const reads = (cmd: string, tmp = 'V:\\ffw\\tmp\\ffa-c7247682') => assert.deepEqual(readOnlyShell(cmd, { tmp }), { ok: true }, cmd);
const writes = (cmd: string, why?: RegExp) => {
  const r = readOnlyShell(cmd, { tmp: 'V:\\ffw\\tmp\\ffa-c7247682' });
  assert.equal(r.ok, false, `should not be read-only: ${cmd}`);
  if (why && !r.ok) assert.match(r.why, why);
};

test('w5148: a command bash cannot parse is refused with a reason, never allowed; one that parses but writes still asks', () => {
  const p = prompts.find((x) => x.n === 2)!;
  const r = ask(p);
  assert.ok(r.ok && r.route === 'refuse-unparsed' && /Grep tool/.test(r.deny), JSON.stringify(r));
  // Only when Claude Code's own check did not finish: under the dangerous-rm reason it asks.
  assert.equal(ask(p, RM_WHY).ok, false);
  // A heredoc with no end runs in bash (a warning), so it is not refused that way.
  assert.equal(ask({ ...p, command: "cat <<'EOF'\nx" }).ok, false);
  // Under the dangerous-rm reason an unclosed quote around a delete is a person's.
  assert.equal(ask({ ...p, command: 'rm -rf "/x' }).ok, false);
});

test('w5148: read-only commands read as read-only', () => {
  reads("grep -n 'x' a.ts | cut -c1-120 | head -3");
  reads('sed -n 366,470p server/opsWorker.ts | grep -n x');
  reads('git log -1 --format=%ad --date=short abc 2>/dev/null');
  reads('a=$(git merge-base --is-ancestor a b 2>/dev/null && echo after || (git merge-base --is-ancestor b a && echo before || echo other)); echo $a');
  reads('for f in ${(f)P}; do echo "$f: $(grep -c x "$f")"; done');
  reads('[ -f $I ] || I=$(grep -rl --include=\'*.cs\' x Assets | head -1); echo $I');
  reads('git diff --stat > $TMPDIR/d.txt; wc -l < $TMPDIR/d.txt');
  reads('cat > $TMPDIR/x.txt <<\'EOF\'\nhello $(rm -rf /)\nEOF\nwc -l $TMPDIR/x.txt');
  reads('grep -c x /v/ffw/tmp/ffa-c7247682/a.log 2>&1 | tee /v/ffw/tmp/ffa-c7247682/b.log');
  reads('ls "$TMPDIR" | sort | uniq -c | sort -rn | head');
  reads('echo $((3+4)); date +%H%M%S');
  reads('find . -name "*.meta" -newer x | head');
  reads('if [ -d x ]; then ls x; else echo none; fi');
  reads('while read -r l; do echo "$l"; done < $TMPDIR/list.txt');
  reads("sed -n 's/a/b/gp' f.txt");
  reads('{ echo a; echo b; } | sort');
});

test('w5148: anything that writes, runs code or cannot be read is not read-only', () => {
  writes('rm -f x');
  writes('echo x > /v/ffw/repo/x.txt', /write/);
  writes('echo x > out.txt', /write/); // relative: not known to be inside the temp folder
  writes('echo x >> ~/.bashrc');
  writes('sed -i s/a/b/ f.txt');
  writes("sed -n '1w out.txt' f");
  writes("sed 'e rm -rf /' f");
  writes('sort -o f.txt f.txt');
  writes('find . -delete');
  writes('find . -exec rm {} +');
  writes('git push origin master');
  writes('git diff --output=x.patch');
  writes('git -c core.pager=x log');
  writes('git checkout -- .');
  writes('cat <<EOF\n$(rm -rf /)\nEOF', /heredoc/);
  writes('eval "$X"');
  writes('awk \'{system("rm -rf /")}\' f');
  writes('PATH=/x:$PATH ls');
  writes('GIT_PAGER=sh git log');
  writes('$CMD x', /variable/);
  writes('ls & rm -rf x');
  writes('echo $(rm -rf /)');
  writes('echo `touch x`');
  writes('cat <(rm -rf x)');
  writes('tee >(sh) < f');
  writes('echo ${x[$(rm -rf /)]}');
  writes('echo ${(e)x}');
  writes('echo $((x[$(id)]))');
  writes('ls *(e:rm -rf /:)');
  writes('f() { rm -rf x; }; f');
  writes('python -c "print(1)"');
  writes('bash -c "ls"');
  writes('xargs -0 cat');
  writes('rg --pre sh x');
  writes('date -s 2020-01-01');
  writes('uniq a b');
  writes('echo "unbalanced');
  writes('command rm -rf x');
  writes('env rm x');
  writes('source x.sh');
  writes('. x.sh');
  writes('cd x && make');
});
