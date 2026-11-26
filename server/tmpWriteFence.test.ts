import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSystemTempWrite, isSystemTemp, systemTempWrites, tmpWriteHook, tmpWriteMessage, type TmpWriteContext } from './tmpWriteFence.ts';

// The three OSes' worker folders, as their daemons set them (FF_WORKER_ROOT, TMPDIR, the sandbox).
const LINUX: TmpWriteContext = {
  root: '/home/biscuit/ffw',
  temp: '/home/biscuit/ffw/tmp/ffa-1',
  sandbox: '/home/biscuit/ffw/sandboxes/slot3',
  cwd: '/home/biscuit/ffw/sandboxes/slot3',
  home: '/home/biscuit',
  env: { TMPDIR: '/home/biscuit/ffw/tmp/ffa-1', HOME: '/home/biscuit' },
};
const MAC: TmpWriteContext = {
  root: '/Users/ben/ffw',
  temp: '/Users/ben/ffw/tmp/ffa-2',
  sandbox: '/Users/ben/ffw/sandboxes/slot1',
  cwd: '/Users/ben/ffw/sandboxes/slot1',
  home: '/Users/ben',
  env: { TMPDIR: '/Users/ben/ffw/tmp/ffa-2', HOME: '/Users/ben' },
};
const WIN: TmpWriteContext = {
  root: 'V:\\ffw',
  temp: 'V:\\ffw\\tmp\\ffa-3',
  sandbox: 'V:\\ffw\\sandboxes\\slot5',
  cwd: 'V:\\ffw\\sandboxes\\slot5',
  home: 'C:\\Users\\loth',
  env: { TMPDIR: 'V:\\ffw\\tmp\\ffa-3', TEMP: 'V:\\ffw\\tmp\\ffa-3', TMP: 'V:\\ffw\\tmp\\ffa-3', USERPROFILE: 'C:\\Users\\loth' },
};
const paths = (cmd: string, ctx: TmpWriteContext) => systemTempWrites(cmd, ctx).map((w) => w.path);
const hows = (cmd: string, ctx: TmpWriteContext) => systemTempWrites(cmd, ctx).map((w) => w.how);

test('w6008: the system temp folders of the three OSes, and nothing else', () => {
  for (const p of ['/tmp', '/tmp/x', '/var/tmp/x', '/private/tmp/x', '/var/folders/zz/abc/t/x', '/private/var/folders/zz/t', 'c:/windows/temp/x', 'c:/users/loth/appdata/local/temp/x'])
    assert.equal(isSystemTemp(p), true, p);
  for (const p of ['/tmpfoo', '/home/biscuit/ffw/tmp/ffa-1/x', '/var/log/x', 'v:/ffw/tmp/ffa-3/x', 'c:/users/loth/appdata/local/templates', 'c:/temp2', '/dev/null'])
    assert.equal(isSystemTemp(p), false, p);
});

test('w6008: the w5973 write that left /tmp/bq_head.ts on biscuit is seen', () => {
  const w = systemTempWrites('git show HEAD:machine/benchQueue.ts > /tmp/bq_head.ts', LINUX);
  assert.deepEqual(w, [{ raw: '/tmp/bq_head.ts', path: '/tmp/bq_head.ts', how: 'redirect' }]);
  assert.match(checkSystemTempWrite('git show HEAD:machine/benchQueue.ts > /tmp/bq_head.ts', LINUX)!, /^Refused: .*\/tmp\/bq_head\.ts \(redirect\).*\/home\/biscuit\/ffw\/tmp\/ffa-1/);
});

test('w6008: redirections in every spelling, on Linux, macOS and Windows', () => {
  for (const [ctx, t] of [[LINUX, '/tmp/a'], [LINUX, '/var/tmp/a'], [MAC, '/private/tmp/a'], [MAC, '/var/folders/zz/x/T/a'], [WIN, '/tmp/a'], [WIN, 'C:\\Users\\loth\\AppData\\Local\\Temp\\a'], [WIN, 'C:/Windows/Temp/a']] as const) {
    for (const cmd of [`echo hi > ${t}`, `echo hi >> ${t}`, `echo hi >${t}`, `echo hi>${t}`, `make 2> ${t}`, `make 2>${t}`, `make &> ${t}`, `make &>${t}`, `Get-Date *> "${t}"`, `cat <<EOF > ${t}\nx\nEOF`])
      assert.equal(paths(cmd, ctx).length, 1, `${cmd}`);
  }
  assert.deepEqual(paths('make > out.log 2>&1', LINUX), []);
  assert.deepEqual(paths('ls 2>/dev/null', LINUX), []);
  assert.deepEqual(paths('echo "a > /tmp/b is text"', LINUX), [], 'a > in quotes');
  assert.deepEqual(paths("grep -E 'x->/tmp' f", LINUX), []);
});

test('w6008: tee, write verbs, copies, moves and deletes into a temp folder', () => {
  assert.deepEqual(hows('ls | tee /tmp/l.txt', LINUX), ['tee']);
  assert.deepEqual(hows('ls | tee -a /var/tmp/l.txt other.txt', LINUX), ['tee']);
  assert.deepEqual(hows('cp machine/x.ts /tmp/', LINUX), ['cp']);
  assert.deepEqual(hows('cp /tmp/x.ts ./here', LINUX), [], 'cp from /tmp only reads it');
  assert.deepEqual(hows('cp -t /private/tmp a b', MAC), ['cp']);
  assert.deepEqual(hows('mv /tmp/a ./b', LINUX), ['mv'], 'a move takes the source away');
  assert.deepEqual(hows('rm -f /tmp/bq_head.ts', LINUX), ['rm'], 'delete nothing in /tmp');
  assert.deepEqual(hows('touch /tmp/probe && mkdir -p /var/tmp/d', LINUX), ['touch', 'mkdir']);
  assert.deepEqual(hows('rsync -a src/ /var/folders/zz/T/dst/', MAC), ['rsync']);
  assert.deepEqual(hows('Copy-Item a.txt -Destination $env:LOCALAPPDATA\\Temp\\a.txt', WIN), ['copy-item']);
  assert.deepEqual(hows('Set-Content -Path C:\\Windows\\Temp\\x.txt -Value hi', WIN), ['set-content']);
  assert.deepEqual(hows('Get-Process | Out-File -FilePath C:\\Users\\loth\\AppData\\Local\\Temp\\p.txt', WIN), ['out-file']);
  assert.deepEqual(hows('"x" | Tee-Object -FilePath /tmp/t.txt', WIN), ['tee-object']);
  assert.deepEqual(hows('New-Item -ItemType Directory -Path C:/Windows/Temp/d', WIN), ['new-item']);
  assert.deepEqual(hows('robocopy src C:\\Windows\\Temp\\dst /E', WIN), ['robocopy']);
  assert.deepEqual(hows('Remove-Item C:\\Users\\loth\\AppData\\Local\\Temp\\old -Recurse', WIN), ['remove-item']);
});

test('w6008: mktemp with a folder or template in a temp folder; bare mktemp uses $TMPDIR and passes', () => {
  assert.deepEqual(hows('f=$(mktemp)', LINUX), []);
  assert.deepEqual(hows('mktemp -d', LINUX), []);
  assert.deepEqual(hows('mktemp --tmpdir x.XXXX', LINUX), [], '--tmpdir alone is $TMPDIR');
  assert.deepEqual(hows('mktemp /tmp/x.XXXXXX', LINUX), ['mktemp']);
  assert.deepEqual(hows('mktemp -p /var/tmp', LINUX), ['mktemp']);
  assert.deepEqual(hows('mktemp --tmpdir=/private/tmp x.XXXX', MAC), ['mktemp']);
  assert.deepEqual(hows('mktemp -d /var/folders/zz/T/run.XXXX', MAC), ['mktemp']);
  assert.deepEqual(hows('mktemp -p /tmp', WIN), ['mktemp'], "Git Bash's /tmp");
});

test("w6008: a tool's output path", () => {
  assert.deepEqual(hows('curl -sL https://x -o /tmp/f.zip', LINUX), ['curl -o']);
  assert.deepEqual(hows('git log --output=/tmp/log.txt', LINUX), ['git --output']);
  assert.deepEqual(hows('Invoke-WebRequest https://x -OutFile C:\\Windows\\Temp\\f.zip', WIN), ['invoke-webrequest -outfile']);
  assert.deepEqual(hows('Unity.exe -batchmode -logFile C:/Users/loth/AppData/Local/Temp/u.log', WIN), ['unity -logfile']);
  assert.deepEqual(hows('dd if=/dev/zero of=/var/tmp/z bs=1M count=1', LINUX), ['dd of=']);
  assert.deepEqual(hows('unzip -q a.zip -d /tmp/a', MAC), ['unzip -d']);
  assert.deepEqual(hows('tar -xzf a.tgz -C /tmp', LINUX), ['tar -C'.toLowerCase()]);
  assert.deepEqual(hows('tar -czf /tmp/a.tgz dir', LINUX), ['tar -f']);
  assert.deepEqual(hows('tar -tzf a.tgz -C /tmp', LINUX), [], 'a listing writes nothing');
  assert.deepEqual(hows('ffmpeg -y -i in.mp4 -t 5 /tmp/out.mp4', MAC), ['ffmpeg']);
  assert.deepEqual(hows('git clone -q https://github.com/x/y.git /tmp/y', LINUX), ['git clone']);
  assert.deepEqual(hows('git worktree add /tmp/wt feature', LINUX), ['git worktree add']);
  assert.deepEqual(hows('sort -o /tmp/s.txt in.txt', LINUX), ['sort -o']);
  assert.deepEqual(hows('grep -o foo /tmp/x', LINUX), [], "grep's -o is a switch, and reading /tmp is not a write");
  assert.deepEqual(hows('git ls-files -o /tmp', LINUX), []);
});

test('w6008: cd into a temp folder makes relative writes count; bash -c and powershell -Command strings are read', () => {
  assert.deepEqual(paths('cd /tmp && echo x > a.txt', LINUX), ['/tmp/a.txt']);
  assert.deepEqual(paths('cd /tmp; cd ~/ffw/tmp/ffa-1; echo x > a.txt', LINUX), [], 'back in ffw');
  assert.deepEqual(paths('Set-Location C:\\Windows\\Temp; "x" | Out-File a.txt', WIN), ['c:/windows/temp/a.txt']);
  assert.deepEqual(paths('bash -c "git show HEAD:x > /tmp/y"', LINUX), ['/tmp/y']);
  assert.deepEqual(paths('powershell -NoProfile -Command "Get-Date | Out-File C:\\Windows\\Temp\\d.txt"', WIN), ['c:/windows/temp/d.txt']);
  assert.deepEqual(paths('timeout -s TERM 60 cp a /tmp/b', LINUX), ['/tmp/b']);
});

test("w6008: the worker's own folders pass, whatever variable spells them", () => {
  for (const cmd of ['git show HEAD:x > "$TMPDIR/bq_head.ts"', 'echo > ${TMPDIR}/a', 'mktemp -p "$TMPDIR"', 'cp a ~/ffw/tmp/ffa-1/b', 'cd "$TMPDIR" && echo > a'])
    assert.deepEqual(paths(cmd, LINUX), [], cmd);
  for (const cmd of ['echo > $TMPDIR/a', 'cp a "$TMPDIR/b"'])
    assert.deepEqual(paths(cmd, MAC), [], cmd);
  // On a Windows worker TEMP and TMP point into ffw, so %TEMP% and $env:TEMP are its own folder.
  for (const cmd of ['echo x > $env:TEMP\\a.txt', 'echo x > %TEMP%\\a.txt', 'Out-File -FilePath "$env:TMP\\a.txt"', 'echo > $TEMP/a', 'cp a /v/ffw/tmp/ffa-3/b', 'echo > V:/ffw/sandboxes/slot5/x'])
    assert.deepEqual(paths(cmd, WIN), [], cmd);
  // ...but a TEMP still on C: (a worker started without the ffw env) is a system temp folder.
  const plain = { ...WIN, env: { ...WIN.env, TEMP: 'C:\\Users\\loth\\AppData\\Local\\Temp' } };
  assert.deepEqual(paths('echo x > $env:TEMP\\a.txt', plain), ['c:/users/loth/appdata/local/temp/a.txt']);
  assert.deepEqual(paths('echo x > /c/Users/loth/AppData/Local/Temp/a.txt', WIN), ['c:/users/loth/appdata/local/temp/a.txt'], 'an MSYS drive path');
  assert.deepEqual(paths('echo > $UNKNOWN/a', LINUX), [], 'an unknown variable is not judged');
  assert.deepEqual(paths('cat /tmp/x | wc -l; ls /var/folders', MAC), [], 'reads');
});

test('w6008: the warn-only hook notes and logs a temp write after it ran, and says nothing otherwise', async () => {
  const lines: string[] = [];
  const h = tmpWriteHook({ root: LINUX.root, temp: LINUX.temp, sandbox: LINUX.sandbox, env: LINUX.env, session: 'ae3c6686', log: (l) => lines.push(l) });
  const call = (tool: string, command: string) =>
    ({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { command }, cwd: LINUX.cwd, session_id: 's', transcript_path: '', tool_response: {}, tool_use_id: 'u' }) as never;
  const signal = { signal: new AbortController().signal };
  const note = (out: unknown) => (out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;
  const n = note(await h(call('Bash', 'git show HEAD:machine/benchQueue.ts > /tmp/bq_head.ts'), undefined, signal));
  assert.match(n!, /^w6008: that command wrote into a system temp folder outside ffw: \/tmp\/bq_head\.ts \(redirect\)/);
  assert.match(n!, /\/home\/biscuit\/ffw\/tmp\/ffa-1/);
  assert.match(n!, /Warn-only for now: nothing was refused/);
  assert.match(n!, /Do not delete what you left there/);
  assert.deepEqual(lines, ['tmp write fence (w6008, warn): ae3c6686 Bash: /tmp/bq_head.ts (redirect)']);
  assert.deepEqual(await h(call('Bash', 'git show HEAD:x > "$TMPDIR/x"'), undefined, signal), {});
  assert.deepEqual(await h(call('Read', 'x'), undefined, signal), {});
  assert.deepEqual(lines.length, 1);
  assert.doesNotMatch(tmpWriteMessage([{ raw: '/tmp/a', path: '/tmp/a', how: 'redirect' }], LINUX.temp, 'refuse'), /Warn-only/);
});

test('w6022 review: heredoc text, rsync -t and a tar file named x... are not writes; the misses it found are seen', () => {
  // A heredoc body is the command's input text (here a PR body quoting w5973's command), not a command line.
  assert.deepEqual(paths(`cat > "$TMPDIR/body.md" <<'EOF'\nthe bug: git show HEAD:x > /tmp/bq_head.ts\nEOF\nff-pr push --body-file "$TMPDIR/body.md"`, LINUX), []);
  assert.deepEqual(paths(`git commit -F - <<EOF\ncp a /tmp/b\nEOF`, LINUX), []);
  // ...but the heredoc's own command line is still read, and a body fed to a shell is commands.
  assert.deepEqual(paths(`cat <<'EOF' > /tmp/x\nhi\nEOF`, LINUX), ['/tmp/x']);
  assert.deepEqual(paths(`bash <<'EOF'\necho hi > /tmp/y\nEOF`, LINUX), ['/tmp/y']);
  // rsync's -t keeps times; cp's and mv's -t is the target folder.
  assert.deepEqual(paths('rsync -t /tmp/src/ "$TMPDIR/dst/"', LINUX), []);
  assert.deepEqual(paths('rsync -avt src/ /tmp/dst/', LINUX), ['/tmp/dst']);
  assert.deepEqual(paths('cp -t "/tmp/d" a b', LINUX), ['/tmp/d']);
  assert.deepEqual(paths('mv -t /var/tmp/d a', LINUX), ['/var/tmp/d']);
  // tar's mode is its first word or an option bundle, never a file name that starts with x.
  assert.deepEqual(paths('tar -czf "$TMPDIR/a.tgz" -C /tmp xfile', LINUX), []);
  assert.deepEqual(paths('tar -xzf a.tgz -C /tmp', LINUX), ['/tmp']);
  assert.deepEqual(paths('tar xzf a.tgz -C /tmp', LINUX), ['/tmp']);
  assert.deepEqual(paths('tar --extract -f a.tar -C /tmp', LINUX), ['/tmp']);
  // A redirection glued after a quote, and >| (clobber), are redirections.
  assert.deepEqual(paths("echo 'hi'>/tmp/x", LINUX), ['/tmp/x']);
  assert.deepEqual(paths('echo hi >| /tmp/x', LINUX), ['/tmp/x']);
  assert.deepEqual(paths('echo "a > /tmp/q" > "$TMPDIR/o"', LINUX), []);
  // git clone's flag values do not shift its destination; --separate-git-dir writes too.
  assert.deepEqual(paths('git clone --depth 1 https://g/x.git /tmp/x', LINUX), ['/tmp/x']);
  assert.deepEqual(paths('git clone -b main https://g/x.git /tmp/x', LINUX), ['/tmp/x']);
  assert.deepEqual(paths('git clone -b main https://g/x.git "$TMPDIR/x"', LINUX), []);
  assert.deepEqual(paths('git clone --separate-git-dir=/tmp/g https://g/x.git "$TMPDIR/x"', LINUX), ['/tmp/g']);
});

test('w6022 review: a parse that throws notes nothing and logs nothing (the hook never breaks a tool call)', async () => {
  const lines: string[] = [];
  const env = new Proxy({} as Record<string, string | undefined>, {
    get() {
      throw new Error('boom');
    },
  });
  const hook = tmpWriteHook({ root: LINUX.root, temp: LINUX.temp, sandbox: LINUX.sandbox, env, session: 's', log: (l) => lines.push(l) });
  assert.throws(() => systemTempWrites('echo hi > /tmp/x', { ...LINUX, env }));
  const out = await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi > /tmp/x' }, cwd: LINUX.cwd } as never, undefined, { signal: new AbortController().signal });
  assert.deepEqual(out, {});
  assert.deepEqual(lines, []);
});
