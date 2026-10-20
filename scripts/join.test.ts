// The join bootstraps end to end against a test enrolment (w1592, docs/worker-install.md "Adding a machine with a join
// code"): scripts/worker/join.ps1 under PowerShell and scripts/worker/join.sh under bash, each against a local portal
// running the real join routes (server/machineJoinHttp.ts) with a fake `tailscale whois`, a fake tailscale CLI and a fake
// installer that records what it was given. Proves: a dry run changes nothing and leaves the code unused; a join writes
// the credential into a private file for the installer, never onto the screen, and deletes it; the code then works no
// more; a second run on an installed PC updates it with no code. The machine setup (winget, OpenSSH Server) is Windows
// and is left out here (-SkipMachineSetup). On Windows, the downloaded installer (join.cmd) runs under cmd.exe as a
// double-click runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { JoinCodes } from '../server/machineJoin.ts';
import { machineJoinHttp, windowsInstaller } from '../server/machineJoinHttp.ts';
import { powershell } from '../server/testPowershell.ts';

const ROOT = path.join(import.meta.dirname, '..');
const isWin = process.platform === 'win32';

/** A throwaway portal: the join routes for real, /api/health, and whoami and the ssh check for the credential it issued. */
async function testPortal(o: { sshReachable?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffjoin-e2e-'));
  const codes = new JoinCodes(path.join(dir, 'machine-joins.json'));
  const issued: string[] = [];
  const records = new Map<string, { root?: string; awaitingInstall?: string }>();
  let base = '';
  const handle = machineJoinHttp({
    codes,
    records: { get: (id) => records.get(id) },
    whois: async () => ({ name: 'testpc', tags: [] }),
    enrol: (e) => {
      records.set(e.machineId, { awaitingInstall: 'now' });
      // A fake credential of the real shape, made at run time (CONTRIBUTING.md: the tests never see a real one).
      const cred = `ffm_${e.machineId}_${'FAKE'.repeat(10)}${String(Date.now()).slice(-6)}`;
      issued.push(cred);
      return cred;
    },
    portalUrl: () => base,
    script: (kind) => fs.readFileSync(path.join(ROOT, 'scripts', 'worker', kind === 'windows' ? 'join.ps1' : 'join.sh'), 'utf8'),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/api/health') return json(200, { ok: true });
    if (url.pathname === '/machine/whoami' || url.pathname === '/machine/ssh') {
      const ok = issued.some((c) => req.headers.authorization === `Bearer ${c}`);
      if (!ok) return json(401, { error: 'a valid machine token is required' });
      if (url.pathname === '/machine/whoami') return json(200, { id: 'testpc', online: true, daemon: 'abc1234', root: 'X:\\ffw', agents: [], sandboxes: [] });
      return json(200, { host: 'tester@testpc', reachable: o.sshReachable ?? true, detail: o.sshReachable === false ? 'ssh: connect to host testpc port 22: Operation timed out' : 'ok' });
    }
    void handle(req, res, url.pathname);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, codes, issued, dir, close: () => server.close() };
}

/** A fake tailscale CLI (connected, device testpc, no tags) and a fake installer that records its arguments and the credential it read. */
function fakes(dir: string, shell: 'ps' | 'sh') {
  const record = path.join(dir, 'installer-record.json');
  const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'testpc.tail0000.ts.net.', Tags: null } });
  let tailscale: string;
  if (isWin) {
    tailscale = path.join(dir, 'tailscale.cmd');
    fs.writeFileSync(tailscale, `@echo ${status}\r\n`);
  } else {
    tailscale = path.join(dir, 'tailscale');
    fs.writeFileSync(tailscale, `#!/bin/sh\necho '${status}'\n`, { mode: 0o755 });
  }
  let installer: string;
  if (shell === 'ps') {
    installer = path.join(dir, 'fake-install.ps1');
    fs.writeFileSync(
      installer,
      `param([string]$Root, [string]$PortalUrl, [int]$MaxSandboxes, [int]$MaxAgentsPerSandbox, [int]$MaxUnity, [string]$CredentialFile, [switch]$Update, [switch]$NoSsh)
$cred = $(if ($CredentialFile) { (Get-Content -Raw -LiteralPath $CredentialFile).Trim() } else { '' })
@{ args = @($args); root = $Root; portal = $PortalUrl; limits = @($MaxSandboxes, $MaxAgentsPerSandbox, $MaxUnity); credentialFile = $CredentialFile; credential = $cred; update = [bool]$Update; noSsh = [bool]$NoSsh } | ConvertTo-Json | Set-Content -LiteralPath '${record.replace(/'/g, "''")}'
Write-Host 'fake installer: done'
exit 0
`,
    );
  } else {
    installer = path.join(dir, 'fake-install.sh');
    fs.writeFileSync(
      installer,
      `#!/usr/bin/env bash
cred_file='' ; update=false ; root=''
args=("$@")
while [ $# -gt 0 ]; do case "$1" in --credential-file) cred_file=$2; shift 2 ;; --root) root=$2; shift 2 ;; --update) update=true; shift ;; *) shift ;; esac; done
cred='' ; mode=''
if [ -n "$cred_file" ]; then cred=$(tr -d '\\n' < "$cred_file"); mode=$(ls -l "$cred_file" | cut -c1-10); fi
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({args: process.argv.slice(6), credentialFile: process.argv[2], credential: process.argv[3], mode: process.argv[4], update: process.argv[5] === "true"}))' '${record}' "$cred_file" "$cred" "$mode" "$update" "\${args[@]}"
echo 'fake installer: done'
`,
      { mode: 0o755 },
    );
  }
  return { tailscale, installer, record };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env, NODE_V8_COVERAGE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const psArgs = (file: string, ...rest: string[]) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...rest];

test('join.ps1: a dry run changes nothing; the join hands the installer a private credential file, never shows it, deletes it; then the code is spent', { skip: !powershell && 'no PowerShell here (pwsh not on PATH)' }, async (t) => {
  const portal = await testPortal();
  t.after(portal.close);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffjoin-ps-'));
  const f = fakes(tmp, 'ps');
  const { code } = portal.codes.create({ machineId: 'testpc', tailnetName: 'testpc', limits: { maxUnity: 1 }, by: 'Lothsahn' });
  const script = path.join(tmp, 'join.ps1');
  fs.writeFileSync(script, await (await fetch(`${portal.base}/join/windows.ps1`)).text());
  const root = path.join(tmp, 'root');
  const log = path.join(tmp, 'logs', 'join.log');
  const env = { FF_JOIN_CODE: code, FF_JOIN_LOG: log, FF_JOIN_STARTED: path.join(tmp, 'started.txt'), TMPDIR: tmp, TEMP: tmp, PATH: `${path.dirname(powershell!)}${path.delimiter}${process.env.PATH}` };
  const common = ['-Root', root, '-Tailscale', f.tailscale, '-Installer', f.installer, '-SkipMachineSetup', '-Yes'];

  const dry = await run(powershell!, psArgs(script, ...common, '-DryRun'), env);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /This PC is 'testpc' on the tailnet/);
  assert.match(dry.out, /joins as 'testpc'/);
  assert.match(dry.out, /Limits: \d+ sandboxes, 2 agents per sandbox, 1 Unity editors at once \(the owner's, with the code\)/);
  assert.match(dry.out, /Dry run: nothing was changed, and the code is still unused/);
  assert.ok(!fs.existsSync(f.record), 'no installer ran');
  assert.ok(portal.codes.find(code), 'the code is unused');
  assert.equal(portal.issued.length, 0);

  const r = await run(powershell!, psArgs(script, ...common), env);
  assert.equal(r.code, 0, r.out);
  assert.equal(portal.issued.length, 1);
  const cred = portal.issued[0];
  const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
  assert.equal(rec.credential, cred, 'the installer read the credential from its file');
  assert.equal(rec.root, root);
  assert.equal(rec.portal, portal.base);
  assert.equal(rec.limits[2], 1);
  assert.ok(!fs.existsSync(rec.credentialFile), 'the credential file is deleted');
  assert.equal(fs.readdirSync(tmp).filter((n) => n.startsWith('ff-join-')).length, 0, "the run's private folder is gone");
  assert.ok(!r.out.includes(cred) && !r.out.includes(cred.slice(4, -4)), 'the credential never reaches the screen');
  assert.ok(!r.out.includes(code), 'nor does the code');
  assert.match(r.out, new RegExp(`credential \\(\\.\\.\\.${cred.slice(-4)}\\)`));
  assert.match(r.out, /The portal sees it: online, daemon abc1234/);
  assert.equal(rec.noSsh, true, 'w1596: a new join installs with -NoSsh: the portal updates it over its daemon link');
  assert.match(r.out, /no ssh, firewall rule or tailnet tag is needed/);
  assert.doesNotMatch(r.out, /OpenSSH|tag:fff-worker|port 22/);
  assert.equal(portal.codes.find(code), undefined, 'the code is spent');
  // w1603: the run's log, named on screen, holds what the screen showed and the installer's own lines, never a secret.
  const text = fs.readFileSync(log, 'utf8');
  assert.match(r.out, new RegExp(`This run's log \\(no secrets in it\\): ${log.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  assert.match(text, /join\.ps1 started/);
  assert.equal(fs.readFileSync(path.join(tmp, 'started.txt'), 'utf8').trim(), 'started', 'it tells ff-factory-join.cmd it ran');
  assert.match(text, /== Enrolling/);
  assert.match(text, /fake installer: done/, "the installer's output is logged too");
  assert.ok(!text.includes(cred) && !text.includes(cred.slice(4, -4)) && !text.includes(code), 'no credential or code in the log');

  const again = await run(powershell!, psArgs(script, '-Root', path.join(tmp, 'root2'), '-Tailscale', f.tailscale, '-Installer', f.installer, '-SkipMachineSetup', '-Yes'), env);
  assert.equal(again.code, 2);
  assert.match(again.out, /The portal refused the code: that join code is wrong, used or expired/);
  assert.match(again.out, /It stopped \(exit 2\) at 'Tailscale and the portal': the reason is the line above\. Everything this run printed is in /);
});

test('join.ps1: a portal it cannot reach exits 3 (the one failure the Tailscale hint is for), names the step, and logs it (w1603)', { skip: !powershell && 'no PowerShell here (pwsh not on PATH)' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffjoin-ps3-'));
  const f = fakes(tmp, 'ps');
  const log = path.join(tmp, 'join.log');
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const dead = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise<void>((r) => closed.close(() => r()));
  const env = { FF_JOIN_LOG: log, TMPDIR: tmp, TEMP: tmp, PATH: `${path.dirname(powershell!)}${path.delimiter}${process.env.PATH}` };
  const r = await run(powershell!, psArgs(path.join(ROOT, 'scripts', 'worker', 'join.ps1'), '-PortalUrl', dead, '-Root', path.join(tmp, 'root'), '-Tailscale', f.tailscale, '-Installer', f.installer, '-SkipMachineSetup', '-Yes'), env);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, new RegExp(`The portal at ${dead.replace(/[.]/g, '\\.')} does not answer: \\S`));
  assert.match(r.out, /It stopped \(exit 3\) at 'Tailscale and the portal'/);
  assert.match(fs.readFileSync(log, 'utf8'), /does not answer/);
});

test('join.ps1: an elevated window of the signed-in person installs for that person (-Owner), not refused (w1603)', { skip: !isWin && 'Windows elevation' }, async () => {
  const probe = `$env:FF_JOIN_NO_MAIN = '1'; $env:FF_JOIN_LOG = Join-Path ([IO.Path]::GetTempPath()) 'ffjoin-owner.log'; . '${path.join(ROOT, 'scripts', 'worker', 'join.ps1').replace(/'/g, "''")}'
$elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$o = Get-ElevatedOwner
"elevated=$elevated owner=[$o] me=[$([Security.Principal.WindowsIdentity]::GetCurrent().Name)]"`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', probe], {});
  const m = /elevated=(\w+) owner=\[(.*?)\] me=\[(.*?)\]/.exec(r.out);
  assert.ok(m, r.out);
  // CI's runner is elevated as the account that runs it: the owner is that account. A normal window has none ('').
  assert.equal(m[2], m[1] === 'True' ? m[3] : '', r.out);
});

test('no installer starts PowerShell with a command line that downloads and runs a script: Defender blocks it as "Access is denied." (w1603)', () => {
  // desktop-coosego: ff-factory-join.cmd's `powershell.exe -Command "irm <url> | iex"` printed only "Access is denied."
  // (Defender's Trojan:Win32/Commando.A!ml on that command line, https://github.com/Thurbeen/fleet/pull/139). A line a person
  // types into their own PowerShell is not that, so the hints may still show one.
  const bad = /(-Command|-c)\s+["'][^"'\r\n]*\b(irm|iwr|Invoke-RestMethod|Invoke-WebRequest|DownloadString)\b[^\r\n]*\|\s*(iex|Invoke-Expression)\b/i;
  for (const name of ['join.cmd', 'join.ps1', 'install.ps1']) {
    const lines = fs.readFileSync(path.join(ROOT, 'scripts', 'worker', name), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(rem |#)/i.test(l));
    assert.deepEqual(lines.filter((l) => bad.test(l)), [], `${name} starts PowerShell with a download-and-run command line`);
  }
  assert.ok(bad.test(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://p/join/windows.ps1' | iex"`), 'the check sees the shape that failed');
});

test('join.ps1: run again on an installed PC, it updates the install with no code, keeping its ssh; a new join asks for no ssh or tailnet tag (w1596)', { skip: !powershell && 'no PowerShell here (pwsh not on PATH)' }, async (t) => {
  const portal = await testPortal({ sshReachable: false });
  t.after(portal.close);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffjoin-ps2-'));
  const f = fakes(tmp, 'ps');
  const script = path.join(ROOT, 'scripts', 'worker', 'join.ps1');
  const env = { TMPDIR: tmp, TEMP: tmp, PATH: `${path.dirname(powershell!)}${path.delimiter}${process.env.PATH}` };
  const installed = path.join(tmp, 'installed');
  fs.mkdirSync(installed);
  fs.writeFileSync(path.join(installed, 'root.json'), JSON.stringify({ machine: 'testpc' }));
  const up = await run(powershell!, psArgs(script, '-PortalUrl', portal.base, '-Root', installed, '-Tailscale', f.tailscale, '-Installer', f.installer, '-SkipMachineSetup', '-Yes', '-MaxUnity', '3'), env);
  assert.equal(up.code, 0, up.out);
  assert.match(up.out, /Already installed as testpc at .*: updating it \(no join code needed\)/);
  const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
  assert.equal(rec.update, true);
  assert.equal(rec.root, installed);
  assert.equal(rec.limits[2], 3, 'a limit given here goes to the update');
  assert.equal(rec.credential, '');
  assert.equal(rec.noSsh, false, 'an update carries the ssh a PC joined with (install.ps1 -Update reads root.json)');
  assert.equal(portal.issued.length, 0, 'no credential is issued for an update');

  fs.rmSync(f.record);
  const { code } = portal.codes.create({ machineId: 'testpc', tailnetName: 'testpc', limits: {}, by: 'Lothsahn' });
  const r = await run(powershell!, psArgs(script, '-PortalUrl', portal.base, '-Root', path.join(tmp, 'fresh'), '-Tailscale', f.tailscale, '-Installer', f.installer, '-SkipMachineSetup', '-Yes'), { ...env, FF_JOIN_CODE: code });
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(fs.readFileSync(f.record, 'utf8')).noSsh, true);
  assert.doesNotMatch(r.out, /tag:fff-worker|Edit ACL tags|port 22|OpenSSH/, 'no tailnet step: the portal does not need ssh to this PC');
});

test('join.sh: a dry run changes nothing; the join hands install.sh a 0600 credential file, never shows it, deletes it; an installed computer is updated', { skip: isWin && 'bash bootstrap: Mac and Linux' }, async (t) => {
  const portal = await testPortal();
  t.after(portal.close);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffjoin-sh-'));
  const f = fakes(tmp, 'sh');
  const { code } = portal.codes.create({ machineId: 'testpc', tailnetName: 'testpc', limits: {}, by: 'Ben' });
  const script = path.join(tmp, 'join.sh');
  fs.writeFileSync(script, await (await fetch(`${portal.base}/join/unix.sh`)).text());
  const root = path.join(tmp, 'root');
  const env = { FF_JOIN_CODE: code, TMPDIR: tmp };
  const common = ['--root', root, '--tailscale', f.tailscale, '--installer', f.installer, '--skip-machine-setup', '--yes'];

  const dry = await run('bash', [script, ...common, '--dry-run'], env);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /joins as 'testpc'/);
  assert.match(dry.out, /Dry run: nothing was changed, and the code is still unused/);
  assert.ok(portal.codes.find(code));
  assert.ok(!fs.existsSync(f.record));

  const r = await run('bash', [script, ...common], env);
  assert.equal(r.code, 0, r.out);
  const cred = portal.issued[0];
  const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'));
  assert.equal(rec.credential, cred);
  assert.equal(rec.mode, '-rw-------', 'owner-only');
  assert.ok(rec.args.includes('--max-sandboxes') && rec.args.includes(root));
  assert.ok(rec.args.includes('--no-ssh'), 'w1596: a new join installs with --no-ssh');
  assert.doesNotMatch(r.out, /Remote Login is off|sshd: |No sshd|tag:fff-worker/);
  assert.ok(!fs.existsSync(rec.credentialFile), 'deleted');
  assert.equal(fs.readdirSync(tmp).filter((n) => n.startsWith('ff-join.')).length, 0, "the run's private folder is gone");
  assert.ok(!r.out.includes(cred) && !r.out.includes(code), 'neither the credential nor the code reaches the screen');
  assert.match(r.out, new RegExp(`credential \\(\\.\\.\\.${cred.slice(-4)}\\)`));
  assert.equal(portal.codes.find(code), undefined, 'spent');

  fs.rmSync(f.record);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'root.json'), '{}');
  const up = await run('bash', [script, '--root', root, '--tailscale', f.tailscale, '--installer', f.installer, '--skip-machine-setup', '--yes'], { TMPDIR: tmp });
  assert.equal(up.code, 0, up.out);
  assert.match(up.out, /Already installed at .*: updating it \(no join code needed\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.record, 'utf8')).args, ['--update', '--root', root]);
});

test('join.cmd: double-clicked (cmd.exe), the download runs the portal\'s bootstrap in Windows PowerShell with its code; an unreachable portal says what to check', { skip: !isWin && 'cmd.exe: Windows' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffjoin-cmd-'));
  const seen = path.join(dir, 'seen.txt');
  // A portal whose bootstrap only records what it was given, marks its start as join.ps1 does, and exits `exit`: the
  // wrapper is what is tested here. 'blocked' never starts (as when Windows refuses to start PowerShell).
  let exit: number | 'blocked' = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== '/join/windows.ps1') return void res.writeHead(404).end();
    const started = exit === 'blocked' ? '' : `Set-Content -LiteralPath $env:FF_JOIN_STARTED -Value 'started'\n`;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`${started}Add-Content -LiteralPath '${seen}' -Value ("code=$env:FF_JOIN_CODE edition=$($PSVersionTable.PSEdition)")\nexit ${exit === 'blocked' ? 1 : exit}\n`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const template = fs.readFileSync(path.join(ROOT, 'scripts', 'worker', 'join.cmd'), 'utf8');
  const code = 'ABCDE-FGHJK-MNPQR-STVWX';
  const withCode = path.join(dir, 'ff-factory-join.cmd');
  fs.writeFileSync(withCode, windowsInstaller(template, base, code));
  // Its log goes to %LOCALAPPDATA%\FFFactory\join\join.log, named on screen (w1603).
  const local = path.join(dir, 'local');
  fs.mkdirSync(local);
  const log = path.join(local, 'FFFactory', 'join', 'join.log');
  const a = await run('cmd.exe', ['/d', '/c', withCode], { FF_JOIN_CODE: '', LOCALAPPDATA: local });
  assert.equal(a.code, 0, a.out);
  assert.ok(a.out.includes(`This run's log (no secrets in it): ${log}`), a.out);
  assert.doesNotMatch(a.out, /FAILED|Tailscale/, a.out);
  const generic = path.join(dir, 'generic', 'ff-factory-join.cmd');
  fs.mkdirSync(path.dirname(generic));
  fs.writeFileSync(generic, windowsInstaller(template, base));
  const b = await run('cmd.exe', ['/d', '/c', generic], { FF_JOIN_CODE: 'left-over', LOCALAPPDATA: local });
  assert.equal(b.code, 0, b.out);
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split(/\r?\n/), [`code=${code} edition=Desktop`, 'code= edition=Desktop'], 'Windows PowerShell 5.1, with the code written in, or none (the bootstrap asks)');
  assert.ok(!fs.readFileSync(log, 'utf8').includes(code), 'the code is not in the log');

  // A step of the bootstrap that stops it: named above by the bootstrap; the Tailscale hint is not shown.
  exit = 2;
  const stopped = await run('cmd.exe', ['/d', '/c', withCode], { LOCALAPPDATA: local });
  assert.match(stopped.out, /It stopped at the step named above \(exit 2\)/, stopped.out);
  assert.doesNotMatch(stopped.out, /Tailscale/, stopped.out);
  // The bootstrap could not reach the portal (exit 3): the hint.
  exit = 3;
  const unreachable = await run('cmd.exe', ['/d', '/c', withCode], { LOCALAPPDATA: local });
  assert.match(unreachable.out, /It could not reach the portal: is this PC connected to Tailscale/, unreachable.out);
  // Windows did not let PowerShell start the bootstrap (desktop-coosego's "Access is denied."): said so, and where to look.
  exit = 'blocked';
  const blocked = await run('cmd.exe', ['/d', '/c', withCode], { LOCALAPPDATA: local });
  assert.match(blocked.out, /FAILED at step 2 of 2: Windows did not let PowerShell run the join script/, blocked.out);
  assert.match(blocked.out, /Protection history/);
  assert.doesNotMatch(blocked.out, /Tailscale/, blocked.out);

  server.close();
  const off = await run('cmd.exe', ['/d', '/c', withCode], { LOCALAPPDATA: local });
  assert.match(off.out, /FAILED at step 1 of 2: this PC could not reach the portal \(curl exit \d+/, off.out);
  assert.match(off.out, /Is this PC connected to Tailscale/, off.out);
  assert.match(fs.readFileSync(log, 'utf8'), /step 1 FAILED: curl exit \d+/);
});
