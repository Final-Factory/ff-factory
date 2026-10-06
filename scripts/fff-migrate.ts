// fff-migrate (w499): move the FF Factory portal from BEAST into its VM with one command, run inside the VM as root
// (`sudo fffctl migrate ...`, deploy/vm/guest/fff-migrate). It pulls everything from BEAST itself, over ssh with the
// portal's own key: config.json, data/ and the Claude conversations the VM's portal resumes. Modes
// (docs/portal-on-ffbox-host.md 7.2, 7.3; deploy/vm/RUNBOOK.md "Dry run", "Cut-over"):
//
//   --key                 print the line that authorizes this VM's key on BEAST, and test the connection
//   --dry-run-copy        snapshot the VM's own portal, pull a copy (read-only on BEAST), rewrite it for Linux, start it
//                         with FFSB_DRY_RUN=1 and no Funnel, check it, report. Run again: copies only what changed
//   --rollback-dry-run    back to the snapshot; the copy and its secrets are wiped
//   --cut-over            pull a first copy while BEAST runs; then, after a typed confirmation: BEAST's portal drains,
//                         sends its daemons here and holds; it is stopped and its task disabled; the rest is copied,
//                         rewritten and started for real; the daemons are checked. If the portal here is not healthy,
//                         everything goes back: this portal's data, and BEAST's task started again
//
// Secrets travel only over ssh, are stored 0600 (root's stage, fff's data), and are never printed or put on a command
// line: config.json is read and written as files, and the Claude token reaches the resume check through its
// environment only.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { failureDetail, psCommand, psq, stdinOf } from '../server/machineDeployWin.ts';
import {
  SECRET_FILES,
  cleanOutsideWatch,
  countDiffs,
  countsOf,
  historyPlan,
  manifestDiff,
  parseManifest,
  rewriteConfig,
  rewriteState,
  skipOnCopy,
  type Counts,
  type HistoryMove,
  type ManifestEntry,
} from '../server/vmMigration.ts';

type Json = Record<string, unknown>;
export type Mode = 'key' | 'dry-run-copy' | 'rollback-dry-run' | 'cut-over';

export interface Options {
  mode: Mode;
  /** BEAST over ssh: user@host on the tailnet. */
  ssh: string;
  /** The machine id BEAST has in the portal's state, and the ssh host the VM's portal deploys to it by. */
  beastId: string;
  beastSshHost: string;
  /** BEAST's app folder (config.json, data\, scripts\) and its user's Claude config folder. */
  beastRoot: string;
  beastClaudeDir: string;
  /** BEAST's scheduled task that runs its portal. */
  beastTask: string;
  /** The VM's portal: its root (/srv/fff), port, service account (undefined: the current user, in tests). */
  root: string;
  port: number;
  user?: string;
  /** The URL the daemons and people reach the VM's portal at; default its config.json publicUrl. */
  publicUrl?: string;
  drainMinutes: number;
  healthSeconds: number;
  daemonSeconds: number;
  resumeCheck: boolean;
  /** --rollback-dry-run: keep the pulled copy, so the cut-over's first copy is a delta. */
  keepStage: boolean;
  claude: string;
  tailscale: boolean;
}

export const DEFAULTS: Omit<Options, 'mode'> = {
  ssh: 'rydin@beast',
  beastId: 'beast',
  beastSshHost: 'rydin@beast',
  beastRoot: 'C:/ff-sandboxes',
  beastClaudeDir: 'C:/Users/rydin/.claude',
  beastTask: 'ffsb-server',
  root: '/srv/fff',
  port: 8790,
  user: 'fff',
  drainMinutes: 5,
  healthSeconds: 180,
  daemonSeconds: 180,
  resumeCheck: true,
  keepStage: false,
  claude: '/srv/fff/home/.local/bin/claude',
  tailscale: true,
};

/** What differs between the VM and a test: the portal's service, its log, the Funnel, the backups, a typed answer. */
export interface System {
  stopPortal(): Promise<void>;
  startPortal(): Promise<void>;
  /** FFSB_DRY_RUN=1 for the portal from its next start on (a systemd drop-in). */
  setDryRun(on: boolean): Promise<void>;
  /** The portal's log since `sinceMs`. */
  logsSince(sinceMs: number): Promise<string>;
  /** Funnel on, serve only (tailnet), or nothing; undefined: no Tailscale here. */
  funnelState(): Promise<'funnel' | 'serve' | 'off' | undefined>;
  setFunnel(s: 'funnel' | 'serve' | 'off'): Promise<void>;
  backupsActive(): Promise<boolean>;
  setBackups(on: boolean): Promise<void>;
  /** The VM's tailnet IPv4, for the key's from= option. */
  tailnetIp(): Promise<string | undefined>;
  /** One line typed by a person. */
  ask(prompt: string): Promise<string>;
  out(line: string): void;
}

// ---------------------------------------------------------------- running things

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a program; `asUser` runs it as the portal's account (runuser -m, so the given environment reaches it). */
export function run(cmd: string, args: string[], o: { input?: string | Buffer; env?: NodeJS.ProcessEnv; cwd?: string; asUser?: string; timeoutMs?: number; stdout?: NodeJS.WritableStream } = {}): Promise<Result> {
  const [c, a] = o.asUser ? ['runuser', ['-m', '-u', o.asUser, '--', cmd, ...args]] : [cmd, args];
  return new Promise((resolve) => {
    const child = spawn(c, a, { env: o.env ?? process.env, cwd: o.cwd ?? '/', windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 120_000);
    if (o.stdout) child.stdout.pipe(o.stdout);
    else child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.replace(/\r\n/g, '\n'), stderr: stderr.replace(/\r\n/g, '\n') });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(o.input ?? '');
  });
}

/** BEAST, over ssh as the portal's account with the portal's key. */
export class Beast {
  private readonly o: Options;

  constructor(o: Options) {
    this.o = o;
  }

  private sshArgs(remote: string[]): string[] {
    const home = path.join(this.o.root, 'home');
    return [
      '-i', path.join(home, '.ssh', 'id_ed25519'),
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${path.join(home, '.ssh', 'known_hosts')}`,
      '-o', 'ConnectTimeout=20',
      '-o', 'ServerAliveInterval=15',
      this.o.ssh,
      ...remote,
    ];
  }

  private env(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: path.join(this.o.root, 'home'), LANG: 'C.UTF-8' };
  }

  /** A PowerShell script on BEAST (the bootstrap of server/machineDeployWin.ts, fed on stdin), with $FFData. */
  ps(script: string, data?: string, timeoutMs = 120_000): Promise<Result> {
    return run('ssh', this.sshArgs(psCommand()), { input: stdinOf(script, data), env: this.env(), asUser: this.o.user, timeoutMs });
  }

  /**
   * Files from under `root` on BEAST into `dest`, by its own tar: the list goes on stdin (-T -), the archive comes back
   * on stdout. BEAST's sshd runs commands under cmd.exe (no DefaultShell set; checked 2026-10-05), which passes tar's
   * bytes through untouched. Returns the bytes received and the files that vanished meanwhile.
   */
  async tar(root: string, files: string[], dest: string): Promise<{ bytes: number; vanished: string[] }> {
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    if (!files.length) return { bytes: 0, vanished: [] };
    const ssh = spawn(this.o.user ? 'runuser' : 'ssh', this.o.user ? ['-m', '-u', this.o.user, '--', 'ssh', ...this.sshArgs(['tar', '-C', root, '-cf', '-', '-T', '-'])] : this.sshArgs(['tar', '-C', root, '-cf', '-', '-T', '-']), { env: this.env(), cwd: '/' });
    const untar = spawn('tar', ['-C', dest, '-xf', '-', '--no-same-owner', '--no-same-permissions'], { cwd: '/' });
    let bytes = 0;
    let sshErr = '';
    let tarErr = '';
    ssh.stdout.on('data', (d: Buffer) => (bytes += d.length));
    ssh.stdout.pipe(untar.stdin);
    ssh.stderr.on('data', (d) => (sshErr += d));
    untar.stderr.on('data', (d) => (tarErr += d));
    ssh.stdin.on('error', () => undefined);
    // "./" first: GNU tar reads a listed name that starts with "-" as an option (a Linux cwd's project folder does).
    ssh.stdin.end(files.map((f) => `./${f}`).join('\n') + '\n');
    const done = (c: ReturnType<typeof spawn>) => new Promise<number>((r) => c.on('close', (code) => r(code ?? -1)));
    const [sc, tc] = await Promise.all([done(ssh), done(untar)]);
    if (tc !== 0) throw new Error(`unpacking the copy failed (tar exit ${tc}): ${tarErr.trim().split('\n').slice(-3).join(' | ')}`);
    // A file removed on BEAST between its listing and the copy (an expired attachment, a rotated log) is no error.
    const lines = sshErr.replace(/\r/g, '').split('\n').filter((l) => l.trim() && !/^Warning: Permanently added/.test(l));
    const vanished = lines.filter((l) => /No such file|Couldn't (find|stat)|Cannot stat|cannot stat/i.test(l));
    if (sc !== 0 && (lines.length > vanished.length || !vanished.length)) throw new Error(`the copy from BEAST failed (ssh/tar exit ${sc}): ${lines.slice(-4).join(' | ') || 'no message'}`);
    return { bytes, vanished };
  }
}

// ---------------------------------------------------------------- BEAST-side scripts (PowerShell 5.1, and pwsh in CI)

/** Lists files: $FFData is {root, include: [relative paths], skip: [relative paths]}; prints "<size>\t<mtime ms>\t<path>". */
export const MANIFEST_PS = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }
$req = $FFData | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $req.root)) { [Console]::Out.Write(''); exit 0 }
$root = (Resolve-Path -LiteralPath $req.root).ProviderPath.TrimEnd([char]92, [char]47)
$skip = @($req.skip)
$epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)
$sb = New-Object Text.StringBuilder
function Add-One($f) {
  $rel = $f.FullName.Substring($root.Length + 1).Replace([char]92, [char]47)
  if ($skip -contains $rel) { return }
  if ($f.PSIsContainer) { foreach ($c in @(Get-ChildItem -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue)) { Add-One $c }; return }
  $ms = [long][Math]::Floor(($f.LastWriteTimeUtc - $epoch).TotalMilliseconds)
  [void]$sb.Append([string]$f.Length).Append([char]9).Append([string]$ms).Append([char]9).Append($rel).Append([char]10)
}
foreach ($inc in @($req.include)) {
  $p = Join-Path $root $inc
  if (Test-Path -LiteralPath $p) { Add-One (Get-Item -LiteralPath $p -Force) }
}
[Console]::Out.Write($sb.ToString())
`;

/** Who and when on BEAST: proves the key works. */
export const HELLO_PS = `"$([Environment]::MachineName)|$([DateTime]::UtcNow.ToString('o'))"`;

/** Writes restart.request whole (a temp file renamed over it), after clearing an old drain.done and relocate result. */
export function requestPs(beastRoot: string): string {
  return `
$ErrorActionPreference = 'Stop'
$data = Join-Path ${psq(beastRoot)} 'data'
foreach ($n in @('drain.done', 'relocate.result.json')) { Remove-Item -LiteralPath (Join-Path $data $n) -Force -ErrorAction SilentlyContinue }
$tmp = Join-Path $data ('.restart.request.' + [Guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($tmp, $FFData)
Move-Item -LiteralPath $tmp -Destination (Join-Path $data 'restart.request') -Force
'requested'
`;
}

/** Waits for drain.done (prints "done") or a refused relocate ("refused"), then the relocate result after a line "--". */
export function waitPs(beastRoot: string, seconds: number): string {
  return `
$data = Join-Path ${psq(beastRoot)} 'data'
$done = Join-Path $data 'drain.done'
$res = Join-Path $data 'relocate.result.json'
$until = [DateTime]::UtcNow.AddSeconds(${Math.round(seconds)})
$state = 'timeout'
while ([DateTime]::UtcNow -lt $until) {
  if (Test-Path -LiteralPath $done) { $state = 'done'; break }
  if ((Test-Path -LiteralPath $res) -and -not (Test-Path -LiteralPath (Join-Path $data 'restart.request'))) {
    $r = Get-Content -LiteralPath $res -Raw | ConvertFrom-Json
    # A refused request writes its reason and never drain.done; a relocate that failed is followed by drain.done.
    if ($r.error -and -not @($r.machines).Count) { Start-Sleep -Seconds 4; if (-not (Test-Path -LiteralPath $done)) { $state = 'refused'; break } }
  }
  Start-Sleep -Seconds 2
}
$state
'--'
if (Test-Path -LiteralPath $res) { Get-Content -LiteralPath $res -Raw }
`;
}

/** Stops BEAST's portal (its own stop-server.ps1: the supervisor, then a clean stop) and disables its task. */
export function stopPs(beastRoot: string, task: string, port: number): string {
  return `
$ErrorActionPreference = 'Continue'
$out = & (Join-Path ${psq(beastRoot)} 'scripts/stop-server.ps1') 2>&1 | ForEach-Object { "$_" }
"stop-server: $($out -join ' | ')"
$t = & schtasks.exe /Change /TN ${psq(task)} /DISABLE 2>&1 | ForEach-Object { "$_" }
"task: exit $LASTEXITCODE $($t -join ' | ')"
$up = $true
for ($i = 0; $i -lt 30; $i++) {
  try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://127.0.0.1:${port}/api/health'; Start-Sleep -Seconds 2 } catch { $up = $false; break }
}
"portal: $(if ($up) { 'STILL ANSWERING' } else { 'stopped' })"
`;
}

/** Puts BEAST's portal back: enables its task and runs it. */
export function restartPs(task: string): string {
  return `
$ErrorActionPreference = 'Continue'
$a = & schtasks.exe /Change /TN ${psq(task)} /ENABLE 2>&1 | ForEach-Object { "$_" }
"enable: exit $LASTEXITCODE $($a -join ' | ')"
$b = & schtasks.exe /Run /TN ${psq(task)} 2>&1 | ForEach-Object { "$_" }
"run: exit $LASTEXITCODE $($b -join ' | ')"
`;
}

// ---------------------------------------------------------------- the migration

const readJson = (f: string): Json => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) as Json;
const writeJson = (f: string, v: unknown, mode = 0o600) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', { mode });
  fs.renameSync(tmp, f);
};
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Migration {
  readonly o: Options;
  readonly sys: System;
  readonly beast: Beast;
  readonly dir: string;
  readonly stage: string;
  readonly report: string[] = [];

  constructor(o: Options, sys: System) {
    this.o = o;
    this.sys = sys;
    this.beast = new Beast(o);
    this.dir = path.join(o.root, 'migrate');
    this.stage = path.join(this.dir, 'stage');
  }

  private say(line: string) {
    this.sys.out(line);
    this.report.push(line);
  }

  private get marker() {
    return path.join(this.dir, 'dry-run.json');
  }

  private vmConfigFile() {
    return path.join(this.o.root, 'config', 'config.json');
  }

  // ---- connecting

  /** The line that lets this VM's portal key in on BEAST (design 4.3), with the VM's tailnet address in from=. */
  async keyLine(): Promise<string> {
    const pub = fs.readFileSync(path.join(this.o.root, 'home', '.ssh', 'id_ed25519.pub'), 'utf8').trim();
    const ip = await this.sys.tailnetIp();
    return `from="${ip ?? '<this VM\'s tailnet IP>'}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${pub}`;
  }

  /** ssh to BEAST works; otherwise the key line and where it goes, and a refusal. */
  async connect(): Promise<string> {
    const r = await this.beast.ps(HELLO_PS, undefined, 60_000);
    const hello = r.stdout.trim().split('\n').pop() ?? '';
    if (r.code === 0 && hello.includes('|')) return hello;
    const line = await this.keyLine().catch((e) => `(no key: ${(e as Error).message})`);
    throw new Error(
      `cannot reach BEAST as ${this.o.ssh} (${failureDetail(r)}).\n` +
        `If the key is not authorized there yet, add this line to C:\\ProgramData\\ssh\\administrators_authorized_keys on BEAST ` +
        `(${this.o.ssh.split('@')[0]} is an administrator there; for another account, its ~/.ssh/authorized_keys), then run this again:\n\n${line}\n`,
    );
  }

  // ---- copying

  private manifestFile(name: string) {
    return path.join(this.stage, `${name}.manifest.json`);
  }

  private loadManifest(name: string): ManifestEntry[] {
    try {
      return JSON.parse(fs.readFileSync(this.manifestFile(name), 'utf8')) as ManifestEntry[];
    } catch {
      return [];
    }
  }

  /** Brings stage/<name> up to BEAST's files under `root`: what is new or changed is copied, what went is removed. */
  async pull(name: string, root: string, include: string[], skip: string[] = []): Promise<{ files: number; bytes: number; fetched: number; removed: number; ms: number; total: number }> {
    const t0 = Date.now();
    const r = await this.beast.ps(MANIFEST_PS, JSON.stringify({ root, include, skip }), 10 * 60_000);
    if (r.code !== 0) throw new Error(`listing ${root} on BEAST failed: ${failureDetail(r)}`);
    const remote = parseManifest(r.stdout).filter((e) => name !== 'beast' || !skipOnCopy(e.path));
    const have = this.loadManifest(name);
    const { fetch, remove } = manifestDiff(remote, have);
    const dest = path.join(this.stage, name);
    const got = await this.beast.tar(root, fetch.map((e) => e.path), dest);
    for (const p of remove) fs.rmSync(path.join(dest, p), { force: true });
    const gone = new Set(remote.filter((e) => got.vanished.some((l) => l.includes(e.path))).map((e) => e.path));
    writeJson(this.manifestFile(name), remote.filter((e) => !gone.has(e.path)));
    const total = remote.reduce((n, e) => n + e.size, 0);
    if (got.vanished.length) this.say(`  ${got.vanished.length} file(s) went on BEAST during the copy (fetched again next time if they come back)`);
    await this.ownerOnly(dest);
    return { files: remote.length, bytes: got.bytes, fetched: fetch.length, removed: remove.length, ms: Date.now() - t0, total };
  }

  /** BEAST's config.json and data\ (without its Windows-only tools and supervisor files), then the conversations. */
  async pullAll(): Promise<{ moves: HistoryMove[]; ms: number }> {
    fs.mkdirSync(this.stage, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stage, 0o700);
    const t0 = Date.now();
    const d = await this.pull('beast', this.o.beastRoot, ['config.json', 'data'], ['data/tools']);
    this.say(`copied BEAST's config.json and data: ${d.files} files, ${mb(d.total)} in all; this time ${d.fetched} file(s), ${mb(d.bytes)} over the wire, ${d.removed} removed, in ${secs(d.ms)}`);
    const beastCfg = readJson(path.join(this.stage, 'beast', 'config.json'));
    const state = readJson(path.join(this.stage, 'beast', 'data', 'state.json'));
    const vm = this.vmTemplate();
    const moves = historyPlan(state, { beastBase: String((beastCfg.repo as Json | undefined)?.basePath ?? ''), vmBase: String((vm.repo as Json | undefined)?.basePath ?? path.join(this.o.root, 'base')), vmStandingRoot: String(vm.standingRoot ?? path.join(this.o.root, 'agents')) });
    const include = moves.flatMap((m) => [`${m.fromFolder}/${m.sdkSessionId}.jsonl`, `${m.fromFolder}/${m.sdkSessionId}`]);
    const h = await this.pull('claude', `${this.o.beastClaudeDir.replace(/[\\/]+$/, '')}/projects`, include);
    this.say(`copied ${moves.length} conversation(s) to resume (the orchestrators', the dispatcher's, this host's standing agents'): ${h.files} files, ${mb(h.total)}; this time ${h.fetched} file(s) in ${secs(h.ms)}`);
    const have = new Set(this.loadManifest('claude').map((e) => e.path));
    for (const m of moves) if (!have.has(`${m.fromFolder}/${m.sdkSessionId}.jsonl`)) this.say(`  no history on BEAST for ${m.kind} "${m.title}" (${m.sdkSessionId}): it starts a fresh conversation`);
    return { moves, ms: Date.now() - t0 };
  }

  // ---- rewriting and installing

  /**
   * This VM's own config.json, the template for the rewrite: while a dry run is in place the live one is the copy, so
   * the snapshot's.
   */
  private vmTemplate(): Json {
    const saved = path.join(this.dir, 'before', 'config', 'config.json');
    return readJson(fs.existsSync(this.marker) && fs.existsSync(saved) ? saved : this.vmConfigFile());
  }

  /** The copy rewritten for this VM, in migrate/next: config/config.json and data/. */
  rewrite(): { next: string; publicUrl: string } {
    const vm = this.vmTemplate();
    const publicUrl = (this.o.publicUrl ?? String(vm.publicUrl ?? '')).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s?#]+$/.test(publicUrl)) throw new Error(`no public URL for the VM's portal (${publicUrl || 'config.json publicUrl is empty'}): pass --public-url https://<node>.<tailnet>.ts.net, or set it with fffctl configure --public-url`);
    const beastCfg = readJson(path.join(this.stage, 'beast', 'config.json'));
    const next = path.join(this.dir, 'next');
    fs.rmSync(next, { recursive: true, force: true });
    fs.mkdirSync(path.join(next, 'config'), { recursive: true, mode: 0o700 });
    // A reflink where the disk has them (the copy can be gigabytes); the stage stays as BEAST's, for the next delta.
    fs.cpSync(path.join(this.stage, 'beast', 'data'), path.join(next, 'data'), { recursive: true, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE });
    const c = rewriteConfig(beastCfg, vm, { publicUrl, beastId: this.o.beastId });
    writeJson(path.join(next, 'config', 'config.json'), c.config);
    for (const n of c.notes) this.say(`  config: ${n}`);
    for (const w of c.windowsPaths) this.say(`  config: WARNING ${w.key} is still a Windows path (${w.value})`);
    const data = path.join(next, 'data');
    const s = rewriteState(readJson(path.join(data, 'state.json')), { beastId: this.o.beastId, sshHost: this.o.beastSshHost, publicUrl, beastConfig: beastCfg, standingRoot: String(vm.standingRoot ?? path.join(this.o.root, 'agents')) });
    writeJson(path.join(data, 'state.json'), s.state);
    for (const n of s.notes) this.say(`  state: ${n}`);
    // Its earlier versions still call BEAST local: a fallback to one of them would undo the conversion.
    for (const f of fs.readdirSync(data).filter((n) => /^state\.json\.\d+$/.test(n))) fs.rmSync(path.join(data, f));
    const ow = path.join(data, 'outside-watch.json');
    if (fs.existsSync(ow)) writeJson(ow, cleanOutsideWatch(readJson(ow)));
    return { next, publicUrl };
  }

  /** The portal's account owns it, and only it reads it (its secrets among the rest). */
  private async chownTree(p: string) {
    await this.ownerOnly(p);
    if (!this.o.user) return;
    const r = await run('chown', ['-R', `${this.o.user}:${this.o.user}`, p]);
    if (r.code !== 0) throw new Error(`chown ${p}: ${r.stderr.trim()}`);
  }

  private async ownerOnly(p: string) {
    if (process.platform === 'win32' || !fs.existsSync(p)) return;
    const r = await run('chmod', ['-R', 'go-rwx', p]);
    if (r.code !== 0) throw new Error(`chmod ${p}: ${r.stderr.trim()}`);
  }

  /** The portal stopped: the rewritten copy becomes its config and data, and the conversations go where it resumes them. */
  async install(next: string, moves: HistoryMove[]): Promise<string[]> {
    const data = path.join(this.o.root, 'data');
    const cfgFile = this.vmConfigFile();
    fs.rmSync(data, { recursive: true, force: true });
    fs.renameSync(path.join(next, 'data'), data);
    fs.renameSync(path.join(next, 'config', 'config.json'), cfgFile);
    fs.rmSync(next, { recursive: true, force: true });
    await this.chownTree(data);
    await this.chownTree(cfgFile);
    fs.chmodSync(cfgFile, 0o600);
    fs.chmodSync(data, 0o700);
    const projects = path.join(this.o.root, 'home', '.claude', 'projects');
    const installed: string[] = [];
    for (const m of moves) {
      const from = path.join(this.stage, 'claude', m.fromFolder);
      const to = path.join(projects, m.toFolder);
      for (const name of [`${m.sdkSessionId}.jsonl`, m.sdkSessionId]) {
        const src = path.join(from, name);
        if (!fs.existsSync(src)) continue;
        fs.mkdirSync(to, { recursive: true, mode: 0o700 });
        fs.rmSync(path.join(to, name), { recursive: true, force: true });
        fs.cpSync(src, path.join(to, name), { recursive: true, preserveTimestamps: true });
        installed.push(path.join(to, name));
      }
    }
    if (installed.length) {
      for (const d of [path.join(this.o.root, 'home', '.claude'), projects]) if (fs.existsSync(d) && this.o.user) await run('chown', [`${this.o.user}:${this.o.user}`, d]);
      for (const d of new Set(moves.map((m) => path.join(projects, m.toFolder)))) if (fs.existsSync(d)) await this.chownTree(d);
    }
    this.say(`installed the copy as the portal's config and data${installed.length ? `, and ${installed.length} conversation file(s) under ${projects}` : ''}`);
    return installed;
  }

  // ---- the portal's state before

  private snapshot(dest: string) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(this.o.root, 'config'), path.join(dest, 'config'), { recursive: true, preserveTimestamps: true });
    const data = path.join(this.o.root, 'data');
    if (fs.existsSync(data)) fs.cpSync(data, path.join(dest, 'data'), { recursive: true, preserveTimestamps: true });
  }

  private async restoreSnapshot(src: string) {
    const data = path.join(this.o.root, 'data');
    const config = path.join(this.o.root, 'config');
    this.wipe([path.join(this.o.root, 'config', 'config.json'), ...SECRET_FILES.filter((f) => f.startsWith('data/')).map((f) => path.join(this.o.root, f))]);
    fs.rmSync(data, { recursive: true, force: true });
    if (fs.existsSync(path.join(src, 'data'))) fs.renameSync(path.join(src, 'data'), data);
    else fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    fs.rmSync(config, { recursive: true, force: true });
    fs.renameSync(path.join(src, 'config'), config);
    fs.rmSync(src, { recursive: true, force: true });
    await this.chownTree(data);
    await this.chownTree(config);
  }

  /** Overwrite, then remove (best effort on a copy-on-write disk; the files go either way). */
  private wipe(files: string[]) {
    for (const f of files) {
      try {
        const size = fs.statSync(f).size;
        fs.writeFileSync(f, Buffer.alloc(size));
      } catch {
        // not there
      }
      fs.rmSync(f, { force: true });
    }
  }

  private async waitHealthy(dryRun: boolean): Promise<Json | undefined> {
    const end = Date.now() + this.o.healthSeconds * 1000;
    while (Date.now() < end) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.o.port}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const h = (await res.json()) as Json;
          if (h.ok === true && (!dryRun || h.dryRun === true)) return h;
        }
      } catch {
        // not up yet
      }
      await sleep(1000);
    }
    return undefined;
  }

  private transcriptsIn(data: string) {
    try {
      return fs.readdirSync(path.join(data, 'transcripts')).filter((n) => n.endsWith('.jsonl')).length;
    } catch {
      return 0;
    }
  }

  private countsAt(data: string): Counts {
    const work = fs.existsSync(path.join(data, 'work.json')) ? readJson(path.join(data, 'work.json')) : undefined;
    return countsOf(readJson(path.join(data, 'state.json')), work, this.transcriptsIn(data));
  }

  /** Change 10's check (design 7.2 check 3): a copied orchestrator conversation resumes here, on the token file. */
  async resumeCheck(moves: HistoryMove[], installed: string[]): Promise<{ ok: boolean; line: string; extra?: string }> {
    const vm = readJson(this.vmConfigFile());
    const state = readJson(path.join(this.o.root, 'data', 'state.json'));
    const dispatcher = String(state.orchestratorId ?? '');
    const pickOne = moves.find((m) => m.sessionId === dispatcher && installed.some((f) => f.endsWith(`${m.sdkSessionId}.jsonl`))) ?? moves.find((m) => m.kind === 'orchestrator' && installed.some((f) => f.endsWith(`${m.sdkSessionId}.jsonl`)));
    if (!pickOne) return { ok: false, line: 'no copied orchestrator conversation to resume' };
    const tokenFile = String(vm.claudeTokenFile ?? '');
    if (!tokenFile || !fs.existsSync(tokenFile)) return { ok: false, line: `no token file (${tokenFile || 'claudeTokenFile is not set'}): fffctl claude-token first` };
    const cwd = String((vm.repo as Json | undefined)?.basePath ?? '');
    if (!cwd || !fs.existsSync(cwd)) return { ok: false, line: `no base clone at ${cwd || '(repo.basePath)'}: fffctl base-clone first` };
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(this.o.root, 'home'), LANG: 'C.UTF-8', CLAUDE_CODE_OAUTH_TOKEN: token };
    // --fork-session: the copied conversation is read, never written, so the cut-over's copy is BEAST's as it is.
    const r = await run(this.o.claude, ['-p', '--resume', pickOne.sdkSessionId, '--fork-session', '--output-format', 'json', '--max-turns', '1', 'This is a check that this conversation resumed on another computer. Reply with only the word: resumed'], { env, cwd, asUser: this.o.user, timeoutMs: 6 * 60_000 });
    let j: Json = {};
    try {
      j = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Json;
    } catch {
      // not JSON: the failure detail says why
    }
    const forked = typeof j.session_id === 'string' && /^[\w-]+$/.test(j.session_id) ? path.join(this.o.root, 'home', '.claude', 'projects', pickOne.toFolder, `${j.session_id}.jsonl`) : undefined;
    const what = `${pickOne.kind} "${pickOne.title}" (${pickOne.sdkSessionId})`;
    if (r.code === 0 && j.is_error === false) return { ok: true, line: `${what} resumed here on the token file: it answered "${String(j.result ?? '').trim().slice(0, 60)}"`, extra: forked };
    return { ok: false, line: `${what} did not resume: ${String(j.result ?? '').slice(0, 200) || failureDetail({ ...r, stdout: r.stdout.slice(-400), stderr: r.stderr.slice(-400) })}`, extra: forked };
  }

  // ---------------------------------------------------------------- the modes

  async key(): Promise<number> {
    this.say(`This VM's portal key, for BEAST (C:\\ProgramData\\ssh\\administrators_authorized_keys for an administrator):\n\n${await this.keyLine()}\n`);
    try {
      this.say(`BEAST answers: ${await this.connect()}`);
      return 0;
    } catch (e) {
      this.say((e as Error).message);
      return 2;
    }
  }

  /** The portal is stopped: snapshot it the first time, install the copy, FFSB_DRY_RUN on, the Funnel and backups off. */
  private async installDryRun(again: boolean, next: string, moves: HistoryMove[]): Promise<string[]> {
    if (!again) {
      // What this VM's portal had: the rollback puts it back.
      this.snapshot(path.join(this.dir, 'before'));
      const funnel = this.o.tailscale ? await this.sys.funnelState() : undefined;
      const backups = await this.sys.backupsActive();
      writeJson(this.marker, { startedAt: new Date().toISOString(), funnel: funnel ?? null, backups, histories: [] });
      this.say(`snapshot of this VM's own config and data in ${path.join(this.dir, 'before')}`);
    } else this.say('a dry run is in place already: refreshing its copy (its snapshot stays)');
    const marker = readJson(this.marker);
    for (const f of (marker.histories as string[] | undefined) ?? []) fs.rmSync(f, { recursive: true, force: true });
    await this.sys.setDryRun(true);
    const installed = await this.install(next, moves);
    writeJson(this.marker, { ...marker, histories: installed });
    if (this.o.tailscale && marker.funnel === 'funnel') await this.sys.setFunnel('serve');
    if (marker.backups) await this.sys.setBackups(false);
    return installed;
  }

  async dryRunCopy(): Promise<number> {
    const hello = await this.connect();
    this.say(`BEAST answers over ssh: ${hello}`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const again = fs.existsSync(this.marker);
    const pulled = await this.pullAll();
    const { next } = this.rewrite();
    const before = this.countsAt(path.join(this.stage, 'beast', 'data'));
    await this.sys.stopPortal();
    let installed: string[] = [];
    try {
      installed = await this.installDryRun(again, next, pulled.moves);
    } catch (e) {
      await this.sys.startPortal().catch(() => undefined);
      throw new Error(`${(e as Error).message}. ${fs.existsSync(this.marker) ? "sudo fffctl migrate --rollback-dry-run puts this VM's own portal back." : 'Nothing was changed.'}`);
    }
    const marker = readJson(this.marker);
    const t0 = Date.now();
    await this.sys.startPortal();
    const health = await this.waitHealthy(true);
    const checks: [string, boolean, string][] = [];
    checks.push(['starts as a dry run', !!health, health ? `/api/health: ok, dryRun, version ${String(health.version ?? '?')}` : `no healthy dry-run answer on port ${this.o.port} within ${this.o.healthSeconds} s`]);
    await sleep(health ? 8000 : 0);
    const logs = await this.sys.logsSince(t0);
    const restored = logs.split('\n').filter((l) => /DATA RESTORED|restored the version|restored from|was all zero bytes/i.test(l));
    checks.push(['no data restored on load', !restored.length, restored.length ? restored.slice(0, 3).join(' | ') : 'no "restored" line in its log']);
    const after = this.countsAt(path.join(this.o.root, 'data'));
    const fewer = (Object.keys(before) as (keyof Counts)[]).filter((k) => after[k] < before[k]);
    const diffs = countDiffs(before, after);
    checks.push(['counts equal BEAST\'s copy', !fewer.length, `${Object.entries(before).map(([k, v]) => `${k} ${v}`).join(', ')}${diffs.length ? `; here after the start: ${diffs.join('; ')}${fewer.length ? '' : ' (more: made at its start)'}` : '; the same here'}`]);
    if (this.o.resumeCheck) {
      const r = await this.resumeCheck(pulled.moves, installed);
      if (r.extra) writeJson(this.marker, { ...readJson(this.marker), histories: [...installed, r.extra] });
      checks.push(['an orchestrator conversation resumes', r.ok, r.line]);
    }
    this.say('');
    this.say('Dry run checks:');
    for (const [name, ok, detail] of checks) this.say(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
    this.say('');
    this.say(`The copy took ${secs(pulled.ms)}. This VM's portal now runs BEAST's copy as a DRY RUN (FFSB_DRY_RUN=1): it acts on nothing outside itself, and ${marker.funnel === 'funnel' ? 'the Funnel is off (tailnet only)' : 'it was not on the Funnel'}${marker.backups ? '; its backups are paused' : ''}.`);
    this.say('By hand next (docs/portal-on-ffbox-host.md 7.2, checks 2 and 4-13): sign in over the tailnet, open transcripts, download an attachment; then');
    this.say('  sudo fffctl migrate --rollback-dry-run      (puts this VM\'s own portal back and wipes the copy and its secrets)');
    const failed = checks.filter(([, ok]) => !ok).length;
    this.writeReport('dry-run');
    return failed ? 1 : 0;
  }

  async rollbackDryRun(): Promise<number> {
    if (!fs.existsSync(this.marker)) {
      this.say('no dry run is in place (nothing to roll back)');
      return 0;
    }
    const marker = readJson(this.marker);
    await this.sys.stopPortal();
    await this.sys.setDryRun(false);
    for (const f of (marker.histories as string[] | undefined) ?? []) fs.rmSync(f, { recursive: true, force: true });
    const before = path.join(this.dir, 'before');
    if (!fs.existsSync(path.join(before, 'config'))) throw new Error(`the snapshot ${before} is missing: nothing restored. The copy is still in ${path.join(this.o.root, 'data')}`);
    await this.restoreSnapshot(before);
    if (!this.o.keepStage) {
      this.wipe(SECRET_FILES.map((f) => path.join(this.stage, 'beast', f.replace(/^config\//, ''))));
      fs.rmSync(this.stage, { recursive: true, force: true });
    }
    if (this.o.tailscale && marker.funnel === 'funnel') await this.sys.setFunnel('funnel');
    if (marker.backups) await this.sys.setBackups(true);
    fs.rmSync(this.marker, { force: true });
    await this.sys.startPortal();
    const h = await this.waitHealthy(false);
    this.say(`rolled back: this VM's own config and data are back, the copied conversations and ${this.o.keepStage ? 'the dry-run portal\'s copy are' : 'the pulled copy are'} removed${this.o.keepStage ? ' (the pulled copy is kept for the cut-over\'s delta)' : ''}, FFSB_DRY_RUN is off${marker.funnel === 'funnel' ? ', the Funnel is back' : ''}${marker.backups ? ', backups run again' : ''}.`);
    this.say(h ? `the portal is up (${String(h.version ?? '?')})` : 'WARNING: the portal does not answer yet: fffctl status, fffctl logs');
    this.writeReport('rollback');
    return h ? 0 : 1;
  }

  async cutOver(): Promise<number> {
    if (fs.existsSync(this.marker)) throw new Error('a dry run is still in place: sudo fffctl migrate --rollback-dry-run first');
    const hello = await this.connect();
    this.say(`BEAST answers over ssh: ${hello}`);
    if (this.o.tailscale && (await this.sys.funnelState()) !== 'funnel') throw new Error(`the Funnel is not on (tailscale funnel status), so the daemons and people could not reach this portal: fffctl tailscale-join, or tailscale funnel --bg http://127.0.0.1:${this.o.port}; --no-tailscale skips this check when the portal is reached some other way`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // 1. The first copy while BEAST still runs, so the stop waits only for what changes after it; rewritten once to check
    // it before anything is touched.
    const first = await this.pullAll();
    const { publicUrl } = this.rewrite();
    const beastCfg = readJson(path.join(this.stage, 'beast', 'config.json'));
    const beastPort = Number(beastCfg.port ?? 8790);
    this.say('');
    this.say(`Next: BEAST's portal drains (up to ${this.o.drainMinutes} min), sends every connected machine daemon to ${publicUrl}, and is stopped; its ${this.o.beastTask} task is disabled. People lose the portal until this one is up (a few minutes). ${first.moves.length} conversation(s) move with it.`);
    const typed = (await this.sys.ask('Type CUT OVER to go on (anything else stops here, changing nothing): ')).trim();
    if (typed !== 'CUT OVER') {
      this.say('stopped: nothing on BEAST was touched.');
      return 3;
    }
    const snap = path.join(this.dir, `before-cutover-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    // This VM's own portal goes first: a daemon sent here meets a closed door (it retries), not a portal that refuses its token.
    await this.sys.stopPortal();
    this.snapshot(snap);
    const giveUp = async (why: string, relocatedAny: boolean) => {
      this.say(`${why}. Stopping here: BEAST keeps running${relocatedAny ? `; the daemons sent to ${publicUrl} come back to BEAST by themselves within about 10 minutes (their fallback)` : ''}.`);
      fs.rmSync(snap, { recursive: true, force: true });
      await this.sys.startPortal();
      this.writeReport('cut-over-stopped');
      return 1;
    };
    // 2. Drain, relocate, hold (server/restart.ts: the relocate runs before drain.done).
    const req = { drain: true, drainMinutes: this.o.drainMinutes, reason: 'moving the portal to its VM (fffctl migrate --cut-over)', update: false, hold: true, relocate: publicUrl };
    const w = await this.beast.ps(requestPs(this.o.beastRoot), JSON.stringify(req), 60_000);
    if (w.code !== 0) return giveUp(`could not ask BEAST's portal to drain (${failureDetail(w)})`, false);
    this.say(`asked BEAST's portal to drain, relocate its daemons to ${publicUrl} and hold`);
    const waitS = this.o.drainMinutes * 60 + 120;
    const wr = await this.beast.ps(waitPs(this.o.beastRoot, waitS), undefined, (waitS + 60) * 1000);
    const [state, rest = ''] = wr.stdout.split(/\n--\n?/);
    let relocated: { machine: string; ok: boolean; note: string }[] = [];
    try {
      const r = JSON.parse(rest.trim() || '{}') as { machines?: typeof relocated; error?: string };
      relocated = r.machines ?? [];
      if (r.error) this.say(`  relocate: ${r.error}`);
    } catch {
      // no result file
    }
    const outcome = state.trim().split('\n').pop();
    if (outcome !== 'done') return giveUp(`BEAST's portal did not finish its drain (${outcome || failureDetail(wr)}; a hold gives up by itself after 5 minutes)`, relocated.some((m) => m.ok));
    // Code from before the cut-over's relocate (w499, 2/3) drains and holds but moves no daemon, and writes no result.
    if (!rest.trim()) return giveUp("BEAST's portal drained but wrote no relocate result: it runs code from before w499 (2/3), which cannot send its daemons here. Deploy it there first; its hold gives up by itself after 5 minutes", false);
    for (const m of relocated) this.say(`  ${m.ok ? 'relocated' : 'NOT relocated'}: ${m.machine}${m.ok ? '' : ` (${m.note}): redeploy it from here once it is up (machine_daemon redeploy)`}`);
    // 3. Stop BEAST's portal for good; its task disabled, so nothing starts it again.
    const st = await this.beast.ps(stopPs(this.o.beastRoot, this.o.beastTask, beastPort), undefined, 5 * 60_000);
    for (const l of st.stdout.trim().split('\n').filter(Boolean)) this.say(`  BEAST ${l}`);
    if (!/portal: stopped/.test(st.stdout)) {
      await this.restartBeast();
      return giveUp("BEAST's portal still answers after its stop", relocated.some((m) => m.ok));
    }
    // From here BEAST's portal is down: any failure puts everything back.
    const rollBack = async (why: string) => {
      this.say(`${why}: rolling back`);
      await this.sys.stopPortal().catch(() => undefined);
      await this.restoreSnapshot(snap);
      await this.sys.startPortal().catch(() => undefined);
      await this.restartBeast();
      this.say(`rolled back: this VM's portal has its own data again; BEAST's ${this.o.beastTask} task is enabled and started, on its data as it was. The relocated daemons come back to BEAST by themselves within about 10 minutes (their fallback).`);
      this.writeReport('cut-over-rolled-back');
      return 1;
    };
    let t0 = 0;
    try {
      // 4. The rest of the copy: nothing changes on BEAST any more.
      const last = await this.pullAll();
      const { next } = this.rewrite();
      // 5. This portal, for real.
      await this.sys.setDryRun(false);
      await this.install(next, last.moves);
      t0 = Date.now();
      await this.sys.startPortal();
    } catch (e) {
      return rollBack(`the last copy or the start failed (${(e as Error).message})`);
    }
    const h = await this.waitHealthy(false);
    if (!h || h.dryRun) return rollBack(`this portal is not healthy within ${this.o.healthSeconds} s`);
    this.say(`this portal is up (${String(h.version ?? '?')}) at ${publicUrl}`);
    // 6. The daemons that took the relocate say hello here.
    const want = relocated.filter((m) => m.ok).map((m) => m.machine);
    const end = Date.now() + this.o.daemonSeconds * 1000;
    let seen = new Set<string>();
    while (want.length && Date.now() < end) {
      const logs = await this.sys.logsSince(t0);
      seen = new Set(want.filter((id) => logs.includes(`machine ${id} connected`)));
      if (seen.size === want.length) break;
      await sleep(3000);
    }
    for (const id of want) this.say(`  ${seen.has(id) ? 'connected here' : 'NOT connected yet'}: ${id}${seen.has(id) ? '' : ' (it dials here for 10 minutes, then here and BEAST in turn; machine_daemon redeploy from here if it stays away)'}`);
    this.say('');
    this.say('Cut over. By hand now:');
    this.say(`  1. Lothsahn: set FFBox's fff.url to ${publicUrl} (and the escalation base URL) and re-render the connector's unit; the FFBox card shows it connected.`);
    this.say(`  2. Everyone: open ${publicUrl}, sign in, add the phone app again and turn notifications on, and point /mcp at it.`);
    this.say(`BEAST's old portal folder and data stay as they were (its ${this.o.beastTask} task disabled, not removed) for the rollback (design 7.5). This VM's data from before: ${snap}.`);
    this.writeReport('cut-over');
    return seen.size < want.length ? 1 : 0;
  }

  private async restartBeast() {
    const r = await this.beast.ps(restartPs(this.o.beastTask), undefined, 60_000);
    for (const l of r.stdout.trim().split('\n').filter(Boolean)) this.say(`  BEAST ${l}`);
  }

  private writeReport(kind: string) {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const f = path.join(this.dir, `report-${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
      fs.writeFileSync(f, this.report.join('\n') + '\n', { mode: 0o600 });
      this.sys.out(`(this report: ${f})`);
    } catch {
      // the terminal has it
    }
  }
}

// ---------------------------------------------------------------- the VM's own system (systemd, journald, Tailscale)

export function vmSystem(o: Options): System {
  const unit = 'fff-portal.service';
  const dropIn = '/etc/systemd/system/fff-portal.service.d/50-dry-run.conf';
  const sh = async (cmd: string, args: string[]) => {
    const r = await run(cmd, args, { timeoutMs: 5 * 60_000 });
    if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  };
  return {
    stopPortal: async () => void (await sh('systemctl', ['stop', unit])),
    startPortal: async () => {
      // A hold left by fffctl prepare-shutdown would keep it stopped (its ExecCondition).
      fs.rmSync('/run/fff/portal.hold', { force: true });
      await sh('systemctl', ['start', unit]);
    },
    setDryRun: async (on) => {
      if (on) {
        fs.mkdirSync(path.dirname(dropIn), { recursive: true });
        fs.writeFileSync(dropIn, '# fffctl migrate --dry-run-copy (w499): the portal runs a copy and acts on nothing outside itself\n[Service]\nEnvironment=FFSB_DRY_RUN=1\n');
      } else fs.rmSync(dropIn, { force: true });
      await sh('systemctl', ['daemon-reload']);
    },
    logsSince: async (t) => (await run('journalctl', ['-u', unit, '--since', `@${Math.floor(t / 1000)}`, '-o', 'cat', '--no-pager'], { timeoutMs: 60_000 })).stdout,
    funnelState: async () => {
      const r = await run('tailscale', ['funnel', 'status'], { timeoutMs: 30_000 });
      if (r.code !== 0) return undefined;
      if (/\(Funnel on\)/i.test(r.stdout)) return 'funnel';
      return /https:\/\//.test(r.stdout) ? 'serve' : 'off';
    },
    setFunnel: async (s) => {
      await run('tailscale', ['funnel', 'reset'], { timeoutMs: 30_000 });
      await run('tailscale', ['serve', 'reset'], { timeoutMs: 30_000 });
      if (s === 'funnel') await sh('tailscale', ['funnel', '--bg', `http://127.0.0.1:${o.port}`]);
      if (s === 'serve') await sh('tailscale', ['serve', '--bg', `http://127.0.0.1:${o.port}`]);
    },
    backupsActive: async () => (await run('systemctl', ['is-active', 'fff-backup.timer'])).stdout.trim() === 'active',
    setBackups: async (on) => void (await sh('systemctl', [on ? 'start' : 'stop', 'fff-backup.timer'])),
    tailnetIp: async () => {
      const r = await run('tailscale', ['ip', '-4'], { timeoutMs: 15_000 });
      return r.code === 0 ? r.stdout.trim().split('\n')[0] || undefined : undefined;
    },
    ask: (prompt) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (a) => {
          rl.close();
          resolve(a);
        });
      }),
    out: (line) => console.log(line),
  };
}

// ---------------------------------------------------------------- the command line

export const USAGE = `fffctl migrate --key | --dry-run-copy | --rollback-dry-run [--keep-stage] | --cut-over
  options: --ssh USER@HOST (BEAST, default ${DEFAULTS.ssh})  --beast-ssh-host H (what this portal deploys to BEAST by, default --ssh)
           --beast-root DIR (${DEFAULTS.beastRoot})  --beast-claude-dir DIR (${DEFAULTS.beastClaudeDir})  --beast-task NAME (${DEFAULTS.beastTask})
           --public-url URL (default config.json publicUrl)  --drain-minutes N (${DEFAULTS.drainMinutes})  --no-resume-check
  (docs/portal-on-ffbox-host.md 7.2, 7.3; deploy/vm/RUNBOOK.md "Dry run" and "Cut-over")`;

export function parseArgs(argv: string[], base: Omit<Options, 'mode'> = DEFAULTS): Options {
  const o: Partial<Options> & Omit<Options, 'mode'> = { ...base };
  let sshHostSet = false;
  const need = (i: number) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs a value\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const mode = { '--key': 'key', '--dry-run-copy': 'dry-run-copy', '--rollback-dry-run': 'rollback-dry-run', '--cut-over': 'cut-over' }[a] as Mode | undefined;
    if (mode) {
      if (o.mode) throw new Error(`one mode at a time\n${USAGE}`);
      o.mode = mode;
      continue;
    }
    switch (a) {
      case '--ssh': o.ssh = need(i++); break;
      case '--beast-ssh-host': o.beastSshHost = need(i++); sshHostSet = true; break;
      case '--beast-id': o.beastId = need(i++); break;
      case '--beast-root': o.beastRoot = need(i++); break;
      case '--beast-claude-dir': o.beastClaudeDir = need(i++); break;
      case '--beast-task': o.beastTask = need(i++); break;
      case '--public-url': o.publicUrl = need(i++); break;
      case '--root': o.root = need(i++); break;
      case '--port': o.port = Number(need(i++)); break;
      case '--user': o.user = need(i++) || undefined; break;
      case '--claude': o.claude = need(i++); break;
      case '--drain-minutes': o.drainMinutes = Number(need(i++)); break;
      case '--health-seconds': o.healthSeconds = Number(need(i++)); break;
      case '--daemon-seconds': o.daemonSeconds = Number(need(i++)); break;
      case '--no-resume-check': o.resumeCheck = false; break;
      case '--keep-stage': o.keepStage = true; break;
      case '--no-tailscale': o.tailscale = false; break;
      case '-h': case '--help': throw new Error(USAGE);
      default: throw new Error(`unknown option ${a}\n${USAGE}`);
    }
  }
  if (!o.mode) throw new Error(USAGE);
  if (!sshHostSet && base.beastSshHost === DEFAULTS.beastSshHost) o.beastSshHost = o.ssh;
  for (const k of ['port', 'drainMinutes', 'healthSeconds', 'daemonSeconds'] as const) if (!Number.isFinite(o[k]) || (o[k] as number) < 0) throw new Error(`--${k} is a number`);
  if (!/^[\w.-]+@[\w.-]+$/.test(o.ssh)) throw new Error(`--ssh is user@host, not ${o.ssh}`);
  return o as Options;
}

export async function main(argv: string[], sysFor: (o: Options) => System = vmSystem): Promise<number> {
  let o: Options;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (o.user && process.getuid?.() !== 0) {
    console.error('run as root: sudo fffctl migrate ...');
    return 2;
  }
  const m = new Migration(o, sysFor(o));
  try {
    if (o.mode === 'key') return await m.key();
    if (o.mode === 'dry-run-copy') return await m.dryRunCopy();
    if (o.mode === 'rollback-dry-run') return await m.rollbackDryRun();
    return await m.cutOver();
  } catch (e) {
    console.error(`fffctl migrate: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
