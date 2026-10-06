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
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { failureDetail, psCommand, psq, stdinOf } from '../server/machineDeployWin.ts';
import {
  SECRET_FILES,
  batchPlan,
  cleanOutsideWatch,
  countDiffs,
  countsOf,
  historyPlan,
  indexSpec,
  manifestDiff,
  manifestDir,
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
  /** The copy (w508): files and megabytes per tar stream, attempts per stream, seconds without a byte before one counts
   * as stalled, seconds between progress lines. */
  batchFiles: number;
  batchMB: number;
  attempts: number;
  stallSeconds: number;
  progressSeconds: number;
  /** How BEAST's files are held still while they are copied (w508): a VSS shadow copy, else a staged copy ("auto"). */
  snapshot: 'auto' | 'vss' | 'copy';
  /** The stream's compression (w517): zstd level 3, else gzip, else bzip2, else none ("auto"); a named one goes first. */
  compress: 'auto' | 'zstd' | 'gzip' | 'bzip2' | 'none';
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
  batchFiles: 2000,
  batchMB: 256,
  attempts: 3,
  stallSeconds: 120,
  progressSeconds: 5,
  snapshot: 'auto',
  compress: 'auto',
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
  /** A progress line (w517): on a terminal redrawn in place; elsewhere a plain line now and then. Absent: out(). */
  live?(line: string): void;
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

/**
 * The most a PowerShell script and its $FFData may be on BEAST's stdin. Measured through BEAST's own sshd (OpenSSH for
 * Windows 9.5p2, cmd.exe as its shell; w508, 2026-10-06): 16, 32, 64 and 128 KB arrive intact, 256 KB and 1 MB never
 * finish, and a command that reads its stdin to the end (tar -T -) never sees the end even at 62 KB. So the copy names
 * its files by line numbers and BEAST writes its own list files: nothing large ever goes to BEAST on stdin.
 */
export const MAX_STDIN_BYTES = 32 * 1024;

/**
 * How a stream is compressed (w517, Lothsahn: "use zstd level 3 ... Don't error. Fallback to gzip or bz2 or finally
 * send uncompressed"). BEAST's tar.exe (bsdtar 3.8.8, built with libzstd, zlib and bz2lib) packs with `remote`; tar
 * here unpacks with `local`, which needs the program `needs`.
 */
export interface Codec {
  name: 'zstd' | 'gzip' | 'bzip2' | 'none';
  label: string;
  remote: string[];
  local: string[];
  needs?: string;
}

export const CODECS: Codec[] = [
  { name: 'zstd', label: 'zstd level 3', remote: ['--zstd', '--options', 'zstd:compression-level=3'], local: ['--zstd'], needs: 'zstd' },
  { name: 'gzip', label: 'gzip', remote: ['-z'], local: ['-z'], needs: 'gzip' },
  { name: 'bzip2', label: 'bzip2', remote: ['-j'], local: ['-j'], needs: 'bzip2' },
  { name: 'none', label: 'none', remote: [], local: [] },
];

/** The codecs to try, best first: a named one, then the rest in order; "none" always last. */
export function codecOrder(want: Options['compress']): Codec[] {
  const first = want === 'auto' ? [] : CODECS.filter((c) => c.name === want);
  return [...first, ...CODECS.filter((c) => !first.includes(c))].filter((c, i, a) => a.indexOf(c) === i);
}

/** One tar stream from BEAST: what came, how it ended. */
export interface StreamResult {
  /** ssh's exit code: BEAST's tar's (0, 1 for warnings such as a locked file), or 255 when the connection broke. */
  sshCode: number;
  untarCode: number;
  /** BEAST's tar's own messages (its stderr, through ssh), and the unpacking tar's. */
  remoteErr: string;
  localErr: string;
  bytes: number;
  /** The files unpacked, by their path in the archive (without "./"). */
  unpacked: Set<string>;
  stalled: boolean;
}

/**
 * BEAST's messages without ssh's own: the host-key notice, and OpenSSH 10's warning about BEAST's 9.5 server
 * ("** This session may be vulnerable to "store now, decrypt later" attacks" and its follow-up lines).
 */
export const quiet = (stderr: string) =>
  stderr
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() && !/^Warning: Permanently added/.test(l) && !/^\*\* /.test(l))
    .join('\n');

/**
 * Windows tar's -v on stderr: the files it named ("a <path>", the newline written only once the file is done) and its
 * messages. One it stopped at has its error on the same line, "a ./data/x.jsonltar: (null)" (measured on BEAST, w508).
 */
export function tarVerbose(stderr: string): { named: string[]; errors: string[] } {
  const named: string[] = [];
  const errors: string[] = [];
  for (const line of stderr.split('\n')) {
    if (!line.trim()) continue;
    const m = /^a (?:\.\/)?(.*?)(tar: .*)?$/.exec(line);
    if (m) {
      named.push(m[1].trim());
      if (m[2]) errors.push(m[2].trim());
    } else errors.push(line.trim());
  }
  return { named, errors };
}

/** BEAST, over ssh as the portal's account with the portal's key. */
export class Beast {
  private readonly o: Options;

  constructor(o: Options) {
    this.o = o;
  }

  private sshArgs(remote: string[], noStdin = false): string[] {
    const home = path.join(this.o.root, 'home');
    return [
      ...(noStdin ? ['-n'] : []),
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

  /** ssh, as the portal's account when this runs as root. */
  private spawnSsh(remote: string[], noStdin = false) {
    const args = this.sshArgs(remote, noStdin);
    return spawn(this.o.user ? 'runuser' : 'ssh', this.o.user ? ['-m', '-u', this.o.user, '--', 'ssh', ...args] : args, { env: this.env(), cwd: '/', stdio: [noStdin ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  }

  private static input(script: string, data?: string): string {
    const input = stdinOf(script, data);
    if (Buffer.byteLength(input) > MAX_STDIN_BYTES) throw new Error(`a script for BEAST of ${Buffer.byteLength(input)} bytes: more than ${MAX_STDIN_BYTES} never arrives through Windows OpenSSH`);
    return input;
  }

  /** A PowerShell script on BEAST (the bootstrap of server/machineDeployWin.ts, fed on stdin), with $FFData. */
  async ps(script: string, data?: string, timeoutMs = 120_000): Promise<Result> {
    const r = await run('ssh', this.sshArgs(psCommand()), { input: Beast.input(script, data), env: this.env(), asUser: this.o.user, timeoutMs });
    return { ...r, stderr: quiet(r.stderr) };
  }

  /**
   * One tar stream: BEAST's own tar packs the files its list file names (`listPath`, written on BEAST by BATCH_PS) and
   * sends the archive on stdout; tar here unpacks it into `dest`, naming each file it unpacks. ssh's stdin stays closed
   * (-n): tar on BEAST reads nothing from it. BEAST's sshd runs commands under cmd.exe (no DefaultShell set), which
   * passes tar's bytes through untouched. A stream with no byte for stallSeconds is ended and reported as stalled.
   */
  stream(root: string, listPath: string, dest: string, onBytes: (n: number) => void, onStart?: (unpacked: Set<string>) => void, codec: Codec = CODECS[CODECS.length - 1]): Promise<StreamResult> {
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    const q = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
    const ssh = this.spawnSsh(['tar', ...codec.remote, '-C', q(root), '-cvf', '-', '-T', q(listPath)], true);
    // Forward slashes for tar where this runs on Windows (a test against BEAST's own sshd); a no-op in the VM.
    const untar = spawn('tar', [...codec.local, '-C', process.platform === 'win32' ? dest.replace(/\\/g, '/') : dest, '-xvf', '-', '--no-same-owner', '--no-same-permissions'], { cwd: '/' });
    const r: StreamResult = { sshCode: -1, untarCode: -1, remoteErr: '', localErr: '', bytes: 0, unpacked: new Set(), stalled: false };
    onStart?.(r.unpacked);
    let last = Date.now();
    const watch = setInterval(() => {
      if (Date.now() - last < this.o.stallSeconds * 1000) return;
      r.stalled = true;
      ssh.kill('SIGKILL');
      untar.kill('SIGKILL');
    }, 1000);
    ssh.stdout!.on('data', (d: Buffer) => {
      last = Date.now();
      r.bytes += d.length;
      onBytes(d.length);
    });
    ssh.stdout!.pipe(untar.stdin);
    untar.stdin.on('error', () => undefined);
    ssh.stderr!.on('data', (d) => (r.remoteErr += d));
    untar.stderr.on('data', (d) => (r.localErr += d));
    // Unpacking failed: the stream is of no use. ssh gets a moment to pass on BEAST's last words (tar's error comes
    // after its data), then it is ended rather than left to the stall limit.
    let grace: NodeJS.Timeout | undefined;
    untar.on('close', (code) => {
      if (code !== 0) grace = setTimeout(() => ssh.kill('SIGKILL'), 5000);
    });
    ssh.on('close', () => clearTimeout(grace));
    let partial = '';
    untar.stdout.on('data', (d) => {
      const lines = (partial + d).split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) r.unpacked.add(l.trim().replace(/^\.\//, ''));
    });
    const done = (c: ReturnType<typeof spawn>) => new Promise<number>((res) => c.on('close', (code) => res(code ?? -1)));
    return Promise.all([done(ssh), done(untar)]).then(([sc, tc]) => {
      clearInterval(watch);
      if (partial.trim()) r.unpacked.add(partial.trim().replace(/^\.\//, ''));
      r.sshCode = sc;
      r.untarCode = tc;
      r.remoteErr = quiet(r.remoteErr);
      return r;
    });
  }

  /**
   * The files tar did not send (a name tar on Windows cannot take, such as one with letters outside its code page, or a
   * file it could not open), one by one through PowerShell: each comes as base64, or is reported gone or unreadable.
   */
  async fetch(data: string, dest: string, paths: Map<number, string>, onBytes: (n: number) => void): Promise<{ got: string[]; gone: string[]; locked: { path: string; why: string }[]; code: number; err: string }> {
    const input = Beast.input(FETCH_PS, data);
    const ssh = this.spawnSsh(psCommand());
    const out = { got: [] as string[], gone: [] as string[], locked: [] as { path: string; why: string }[], code: -1, err: '' };
    let fd: number | undefined;
    let cur = '';
    let partial = '';
    const line = (l: string) => {
      const [kind, idx, rest] = l.split('\t');
      const rel = paths.get(Number(idx));
      if (kind === 'FILE' && rel) {
        const f = path.join(dest, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
        fd = fs.openSync(f, 'w', 0o600);
        cur = rel;
      } else if (kind === 'END' && fd !== undefined) {
        fs.closeSync(fd);
        fd = undefined;
        out.got.push(cur);
      } else if (kind === 'GONE' && rel) out.gone.push(rel);
      else if (kind === 'LOCKED' && rel) out.locked.push({ path: rel, why: rest ?? '' });
      else if (fd !== undefined && l) {
        const b = Buffer.from(l, 'base64');
        fs.writeSync(fd, b);
        onBytes(b.length);
      }
    };
    ssh.stdout!.on('data', (d) => {
      const lines = (partial + d).split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) line(l.replace(/\r$/, ''));
    });
    ssh.stderr!.on('data', (d) => (out.err += d));
    ssh.stdin!.on('error', () => undefined);
    ssh.stdin!.end(input);
    return new Promise((res) =>
      ssh.on('close', (code) => {
        if (partial) line(partial.replace(/\r$/, ''));
        // A file cut off half way is not counted as fetched.
        if (fd !== undefined) {
          fs.closeSync(fd);
          fs.rmSync(path.join(dest, cur), { force: true });
        }
        out.code = code ?? -1;
        res(out);
      }),
    );
  }
}

// ---------------------------------------------------------------- BEAST-side scripts (PowerShell 5.1, and pwsh in CI)

/**
 * Lists files: $FFData is {root, include: [relative paths], skip: [relative paths], run, name}; prints
 * "<size>\t<mtime ms>\t<path>" per file, and keeps the same paths, line for line, in <temp>\fff-migrate-<run>\<name>.all
 * (outside the portal's data: it only reads that), which BATCH_PS and FETCH_PS read by line number. Its last line is
 * "#dir\t<that folder>".
 */
export const MANIFEST_PS = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }
$req = $FFData | ConvertFrom-Json
$dir = Join-Path ([IO.Path]::GetTempPath()) ('fff-migrate-' + $req.run)
$null = New-Item -ItemType Directory -Force -Path $dir
# Lists left by runs a day old or more (one that stopped half way) go.
Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'fff-migrate-*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-1) -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$enc = New-Object Text.UTF8Encoding $false
$list = New-Object IO.StreamWriter((Join-Path $dir ($req.name + '.all')), $false, $enc)
$list.NewLine = [string][char]10
$sb = New-Object Text.StringBuilder
try {
  if (Test-Path -LiteralPath $req.root) {
    $root = (Resolve-Path -LiteralPath $req.root).ProviderPath.TrimEnd([char]92, [char]47)
    $skip = @($req.skip)
    $epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)
    function Add-One($f) {
      $rel = $f.FullName.Substring($root.Length + 1).Replace([char]92, [char]47)
      if ($skip -contains $rel) { return }
      if ($f.PSIsContainer) { foreach ($c in @(Get-ChildItem -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue)) { Add-One $c }; return }
      $ms = [long][Math]::Floor(($f.LastWriteTimeUtc - $epoch).TotalMilliseconds)
      [void]$sb.Append([string]$f.Length).Append([char]9).Append([string]$ms).Append([char]9).Append($rel).Append([char]10)
      $list.WriteLine($rel)
    }
    foreach ($inc in @($req.include)) {
      $p = Join-Path $root $inc
      if (Test-Path -LiteralPath $p) { Add-One (Get-Item -LiteralPath $p -Force) }
    }
  }
} finally { $list.Dispose() }
[void]$sb.Append('#dir').Append([char]9).Append($dir.Replace([char]92, [char]47)).Append([char]10)
[Console]::Out.Write($sb.ToString())
`;

/** Writes a batch's list file: $FFData is {dir, all, out, spec}; the lines of <all> that spec names, each as "./<path>". */
export const BATCH_PS = `
$ErrorActionPreference = 'Stop'
$req = $FFData | ConvertFrom-Json
$enc = New-Object Text.UTF8Encoding $false
$all = [IO.File]::ReadAllLines((Join-Path $req.dir $req.all), $enc)
$out = Join-Path $req.dir $req.out
$w = New-Object IO.StreamWriter($out, $false, $enc)
$w.NewLine = [string][char]10
try {
  foreach ($part in $req.spec.Split(',')) {
    $ab = $part.Split('-'); $a = [int]$ab[0]; $b = if ($ab.Count -gt 1) { [int]$ab[1] } else { $a }
    for ($i = $a; $i -le $b; $i++) { $w.WriteLine('./' + $all[$i]) }
  }
} finally { $w.Dispose() }
'list' + [char]9 + $out.Replace([char]92, [char]47)
`;

/**
 * Sends files one by one: $FFData is {dir, all, root, spec}. Per file "FILE\t<line>\t<size>", its bytes as base64 lines,
 * "END\t<line>"; or "GONE\t<line>", or "LOCKED\t<line>\t<why>" when it cannot be opened. Raw ASCII on stdout.
 */
export const FETCH_PS = `
$ErrorActionPreference = 'Stop'
$req = $FFData | ConvertFrom-Json
$all = [IO.File]::ReadAllLines((Join-Path $req.dir $req.all), (New-Object Text.UTF8Encoding $false))
$root = (Resolve-Path -LiteralPath $req.root).ProviderPath
$win = [Environment]::OSVersion.Platform -eq 'Win32NT'
$o = [Console]::OpenStandardOutput()
function Say([string]$t) { $b = [Text.Encoding]::ASCII.GetBytes($t + [char]10); $o.Write($b, 0, $b.Length) }
$buf = New-Object byte[] 3145728
foreach ($part in $req.spec.Split(',')) {
  $ab = $part.Split('-'); $a = [int]$ab[0]; $b = if ($ab.Count -gt 1) { [int]$ab[1] } else { $a }
  for ($i = $a; $i -le $b; $i++) {
    $p = Join-Path $root $all[$i]
    if ($win) { $p = $p.Replace([char]47, [char]92); if ($p.Length -ge 240 -and -not $p.StartsWith('\\\\?\\')) { $p = '\\\\?\\' + $p } }
    if (-not [IO.File]::Exists($p)) { Say ('GONE' + [char]9 + $i); continue }
    try { $fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite, Delete') } catch { Say ('LOCKED' + [char]9 + $i + [char]9 + ($_.Exception.Message -replace '\\s+', ' ')); continue }
    try {
      Say ('FILE' + [char]9 + $i + [char]9 + $fs.Length)
      while (($n = $fs.Read($buf, 0, $buf.Length)) -gt 0) { Say ([Convert]::ToBase64String($buf, 0, $n)) }
      Say ('END' + [char]9 + $i)
    } finally { $fs.Dispose() }
  }
}
$o.Flush()
`;

/**
 * One point-in-time view of the files to copy, on BEAST, before anything is read (lothsahn, w508: "generate it all in one
 * snapshot, and then tar and compress off a copy"). $FFData: {run, name, root, include, skip, mode}. mode "auto" or
 * "vss": a VSS shadow copy of the volume holding root (one per volume and run, shared by the run's copies), reached
 * through a directory link <temp>\ffm-snap-<run>-<drive>; its id is recorded in <temp>\ffm-shadows.txt at once, so a
 * run that dies has it removed by the next. Otherwise (mode "copy", or VSS refused): a staged copy of the include set
 * in <temp>\fff-migrate-<run>\stage-<name>, by robocopy (backup mode when elevated), after checking the disk has room.
 * Prints "mode", "root" (where to read from), "free", and "vsswhy", "size", "failed" lines as they apply.
 */
export const SNAP_PS = `
$ErrorActionPreference = 'Stop'
$req = $FFData | ConvertFrom-Json
$tmp = [IO.Path]::GetTempPath()
$win = [Environment]::OSVersion.Platform -eq 'Win32NT'
function Say([string]$k, [string]$v) { [Console]::Out.WriteLine($k + [char]9 + $v) }
function Free([string]$p) { try { (New-Object IO.DriveInfo([IO.Path]::GetPathRoot($p))).AvailableFreeSpace } catch { -1 } }
$rootFull = (Resolve-Path -LiteralPath $req.root).ProviderPath.TrimEnd([char]92, [char]47)
$vssWhy = ''
if ($req.mode -ne 'copy') {
  if (-not $win) { $vssWhy = 'not Windows' } else {
    $vol = [IO.Path]::GetPathRoot($rootFull)
    $link = Join-Path $tmp ('ffm-snap-' + $req.run + '-' + $vol.Substring(0, 1))
    $state = Join-Path $tmp 'ffm-shadows.txt'
    if (-not (Test-Path -LiteralPath $link)) {
      # Shadows an earlier run recorded and did not remove (it died, or was stopped): only those, never anyone else's.
      if (Test-Path -LiteralPath $state) {
        $keep = @()
        foreach ($l in [IO.File]::ReadAllLines($state)) {
          $f = $l.Split([char]9)
          if ($f.Count -lt 3) { continue }
          if ($f[0] -eq $req.run) { $keep += $l; continue }
          try { if (Test-Path -LiteralPath $f[2]) { [IO.Directory]::Delete($f[2]) } } catch { }
          try { Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $f[1] } | Remove-CimInstance } catch { }
        }
        [IO.File]::WriteAllLines($state, [string[]]$keep)
      }
      try {
        $r = Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{ Volume = $vol; Context = 'ClientAccessible' }
        if ($r.ReturnValue -ne 0) { throw ('Win32_ShadowCopy.Create returned ' + $r.ReturnValue) }
        $id = [string]$r.ShadowID
        [IO.File]::AppendAllText($state, $req.run + [char]9 + $id + [char]9 + $link + [char]10)
        $dev = [string](Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $id }).DeviceObject
        if (-not $dev) { throw ('no device for shadow ' + $id) }
        $o = & cmd.exe /c mklink /d $link ($dev + '\\') 2>&1
        if (-not (Test-Path -LiteralPath $link)) { throw ('mklink: ' + ($o -join ' ')) }
      } catch {
        $vssWhy = $_.Exception.Message -replace '\\s+', ' '
        try { if (Test-Path -LiteralPath $link) { [IO.Directory]::Delete($link) } } catch { }
        try { if ($id) { Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $id } | Remove-CimInstance } } catch { }
      }
    }
    $mapped = Join-Path $link $rootFull.Substring($vol.Length)
    if (-not $vssWhy -and (Test-Path -LiteralPath $mapped)) {
      Say 'mode' 'vss'
      Say 'root' $mapped.Replace([char]92, [char]47)
      Say 'free' ([string](Free $rootFull) + [char]9 + $vol)
      exit 0
    }
    if (-not $vssWhy) { $vssWhy = 'the shadow copy does not show ' + $rootFull }
  }
  if ($req.mode -eq 'vss') { throw ('no VSS snapshot: ' + $vssWhy) }
}
# A staged copy of the set.
$stage = Join-Path (Join-Path $tmp ('fff-migrate-' + $req.run)) ('stage-' + $req.name)
$null = New-Item -ItemType Directory -Force -Path $stage
$skip = @($req.skip) | ForEach-Object { (Join-Path $rootFull $_) }
$size = [long]0
foreach ($inc in @($req.include)) {
  $p = Join-Path $rootFull $inc
  if (Test-Path -LiteralPath $p -PathType Leaf) { $size += (Get-Item -LiteralPath $p -Force).Length }
  elseif (Test-Path -LiteralPath $p) {
    foreach ($f in @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      $in = $true; foreach ($s in $skip) { if ($f.FullName.StartsWith($s + [IO.Path]::DirectorySeparatorChar)) { $in = $false; break } }
      if ($in) { $size += $f.Length }
    }
  }
}
$free = Free $stage
Say 'free' ([string]$free + [char]9 + [IO.Path]::GetPathRoot($stage))
Say 'size' ([string]$size)
if ($free -ge 0 -and $free -lt $size + 1073741824) { throw ('not enough room on BEAST for a staged copy: ' + $size + ' bytes to copy, ' + $free + ' free at ' + $stage + ' (needs 1 GB to spare)') }
$adm = $false
if ($win) { $adm = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
foreach ($inc in @($req.include)) {
  $src = Join-Path $rootFull $inc
  $dst = Join-Path $stage $inc
  if (-not (Test-Path -LiteralPath $src)) { continue }
  $leaf = Test-Path -LiteralPath $src -PathType Leaf
  if ($win) {
    $common = @('/COPY:DT', '/R:1', '/W:1', '/NP', '/NFL', '/NDL', '/NJH', '/NJS', '/XJ')
    if ($adm) { $common += '/B' }
    if ($leaf) { $a = @((Split-Path -Parent $src), (Split-Path -Parent $dst), (Split-Path -Leaf $src)) + $common }
    else { $a = @($src, $dst, '/E', '/DCOPY:T') + $common; if ($skip.Count) { $a += '/XD'; $a += $skip } }
    $out = & robocopy.exe @a 2>&1 | ForEach-Object { [string]$_ }
    $code = $LASTEXITCODE
    for ($i = 0; $i -lt $out.Count; $i++) { if ($out[$i] -match 'ERROR \\d+ \\(0x[0-9A-Fa-f]+\\) (.*)$') { Say 'failed' ($Matches[1] + ' ' + ($(if ($i + 1 -lt $out.Count) { $out[$i + 1].Trim() } else { '' }))) } }
    if ($code -ge 16) { throw ('robocopy failed (exit ' + $code + '): ' + (($out | Select-Object -Last 3) -join ' | ')) }
  } else {
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst)
    $o = & cp -a $src $dst 2>&1
    foreach ($l in @($o)) { if ([string]$l) { Say 'failed' ([string]$l) } }
    foreach ($s in $skip) { $rel = $s.Substring($rootFull.Length + 1); if ($rel.StartsWith($inc)) { Remove-Item -LiteralPath (Join-Path $stage $rel) -Recurse -Force -ErrorAction SilentlyContinue } }
  }
}
Say 'mode' 'copy'
Say 'vsswhy' $vssWhy
Say 'root' $stage.Replace([char]92, [char]47)
`;

/**
 * Ends a run's snapshot: $FFData is the run. Its links go first (removing a link, never what it points to), then its
 * shadow copies, then its folder of lists and staged copies.
 */
export const DROP_PS = `
$tmp = [IO.Path]::GetTempPath()
$run = [string]$FFData
$n = 0
foreach ($l in @(Get-ChildItem -LiteralPath $tmp -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ('ffm-snap-' + $run + '-*') })) { try { [IO.Directory]::Delete($l.FullName) } catch { } }
$state = Join-Path $tmp 'ffm-shadows.txt'
if (Test-Path -LiteralPath $state) {
  $keep = @()
  foreach ($l in [IO.File]::ReadAllLines($state)) {
    $f = $l.Split([char]9)
    if ($f.Count -ge 3 -and $f[0] -eq $run) { try { Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $f[1] } | Remove-CimInstance; $n++ } catch { } } else { $keep += $l }
  }
  [IO.File]::WriteAllLines($state, [string[]]$keep)
}
$d = Join-Path $tmp ('fff-migrate-' + $run)
if ((Test-Path -LiteralPath $d) -and -not ((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
'dropped' + [char]9 + $n
`;

/** Removes a run's list files from BEAST's temp folder: $FFData is the folder. */
export const CLEAN_PS = `
if ($FFData -and (Split-Path -Leaf $FFData) -like 'fff-migrate-*') { Remove-Item -LiteralPath $FFData -Recurse -Force -ErrorAction SilentlyContinue }
'cleaned'
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
const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : mb(n));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const span = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);
const count = (n: number) => n.toLocaleString('en-US');
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

  /** Into the saved report only: detail a person at the terminal does not need, kept for whoever reads why. */
  private note(line: string) {
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

  /** The compression this run uses, chosen at its first copy (w517). */
  private codec?: Codec;

  /**
   * zstd level 3, else gzip, else bzip2, else none: the first both sides take, tried on one small file of the copy
   * (a stream of its own, unpacked aside). Never an error: "none" always works. The terminal shows each try and the
   * one used ("trying zstd level 3...", "zstd level 3 failed, falling back to gzip...", "using gzip"); why a try
   * failed (tar's own message) goes to the saved report only, since falling back is expected and not a failure.
   */
  private async chooseCodec(root: string, dir: string, all: string, probe: ManifestEntry): Promise<Codec> {
    if (this.codec) return this.codec;
    const order = codecOrder(this.o.compress);
    for (const [i, c] of order.entries()) {
      const next = order[i + 1];
      const fallBack = (why: string) => {
        this.note(`  compression check (${c.name}): ${why}`);
        if (next) this.say(`compression: ${c.label} failed, falling back to ${next.name === 'none' ? 'no compression' : next.label}...`);
      };
      if (c.name === 'none') {
        this.codec = c;
        break;
      }
      if (c.needs && spawnSync(c.needs, ['--version'], { stdio: 'ignore' }).status !== 0) {
        fallBack(`no ${c.needs} here`);
        continue;
      }
      if (i === 0) this.say(`compression: trying ${c.label}...`);
      const lr = await this.beast.ps(BATCH_PS, JSON.stringify({ dir, all, out: 'probe.list', spec: indexSpec([probe.index!]) }), 120_000);
      const listPath = /^list\t(.+)$/m.exec(lr.stdout)?.[1]?.trim();
      const aside = path.join(this.dir, 'probe');
      let refused = '';
      for (let attempt = 1; attempt <= this.o.attempts; attempt++) {
        fs.rmSync(aside, { recursive: true, force: true });
        const r = listPath ? await this.beast.stream(root, listPath, aside, () => undefined, undefined, c) : undefined;
        fs.rmSync(aside, { recursive: true, force: true });
        if (r && r.untarCode === 0 && [0, 1, 2].includes(r.sshCode) && r.unpacked.has(probe.path)) {
          this.codec = c;
          break;
        }
        // A broken connection says nothing about the compression: try again; still broken, keep it (the copy's own
        // retries deal with the connection).
        if (r && (r.sshCode === 255 || r.stalled)) {
          if (attempt < this.o.attempts) {
            this.note(`  compression check (${c.name}): the stream broke off (${tarVerbose(r.remoteErr).errors.slice(-1)[0] ?? `ssh exit ${r.sshCode}`})`);
            this.say(`compression: the connection dropped during the check; trying ${c.label} again...`);
            await sleep(2000);
            continue;
          }
          this.codec = c;
          break;
        }
        refused = r ? (tarVerbose(r.remoteErr).errors.slice(-1)[0] ?? r.localErr.trim().split('\n').slice(-1)[0] ?? `exit ${r.sshCode}`) : 'no probe list';
        break;
      }
      if (this.codec) break;
      fallBack(refused);
    }
    this.codec ??= CODECS[CODECS.length - 1];
    this.say(`compression: using ${this.codec.name === 'none' ? 'no compression' : this.codec.label}`);
    return this.codec;
  }

  /** Runs whose snapshot is still on BEAST: dropped at the end, on a failure, and on Ctrl+C (main). */
  readonly runs = new Set<string>();

  /**
   * The point-in-time view to copy from (w508): SNAP_PS on BEAST, once per run and volume for a shadow copy, or a staged
   * copy of this set. Returns where to read from. Says which, with BEAST's free disk space and anything it could not copy.
   */
  async beastSnapshot(run: string, name: string, label: string, root: string, include: string[], skip: string[]): Promise<string> {
    const t0 = Date.now();
    this.sys.out(`${label}: taking a snapshot on BEAST (${this.o.snapshot === 'copy' ? 'a staged copy' : 'a VSS shadow copy, else a staged copy'})...`);
    this.runs.add(run);
    const stop = this.ticker(() => `  still taking the snapshot (${span((Date.now() - t0) / 1000)})`);
    const r = await this.beast.ps(SNAP_PS, JSON.stringify({ run, name, root, include, skip, mode: this.o.snapshot }), 60 * 60_000).finally(stop);
    const field = (k: string) => [...r.stdout.matchAll(new RegExp(`^${k}\t(.*)$`, 'gm'))].map((m) => m[1].replace(/\r$/, ''));
    const mode = field('mode')[0];
    const at = field('root')[0];
    if (r.code !== 0 || !mode || !at) throw new Error(`no snapshot on BEAST, so nothing is copied (reading the live files would copy a view no one ever had): ${failureDetail(r)}`);
    const [freeBytes, drive] = (field('free')[0] ?? '').split('\t');
    const free = Number(freeBytes) >= 0 ? `${size(Number(freeBytes))} free on BEAST's ${drive || 'disk'}` : "BEAST's free space unknown";
    if (mode === 'vss') this.say(`${label}: snapshot: a VSS shadow copy of BEAST's ${drive || 'volume'}, taken ${new Date().toISOString().slice(11, 19)} UTC; every file is read from it (${free}; ${secs(Date.now() - t0)})`);
    else {
      const why = field('vsswhy')[0];
      this.say(`${label}: snapshot: a staged copy on BEAST, ${size(Number(field('size')[0] ?? 0))}${why ? ` (no VSS shadow copy: ${why})` : ''}; every file is read from it (${free} before it; ${secs(Date.now() - t0)})`);
      const failed = field('failed');
      if (failed.length) this.say(`  ${label}: ${count(failed.length)} file(s) could not be copied into the snapshot and are left out: ${failed.slice(0, 10).join('; ')}${failed.length > 10 ? `; and ${failed.length - 10} more` : ''}`);
    }
    return at;
  }

  /** Removes a run's snapshot from BEAST (its shadow copy, link and staged copies). */
  async dropSnapshot(run: string) {
    if (!this.runs.has(run)) return;
    const r = await this.beast.ps(DROP_PS, run, 120_000).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
    if (r.code === 0) this.runs.delete(run);
    else this.say(`  could not remove the snapshot on BEAST (${failureDetail(r)}); the next run removes it`);
  }

  /** Every snapshot this process took, removed (Ctrl+C, a failure). */
  async dropSnapshots() {
    for (const run of [...this.runs]) await this.dropSnapshot(run);
  }

  /** A progress line every progressSeconds while `what` runs (the listing, a copy): it reads well over plain ssh. */
  private ticker(line: () => string) {
    const t = setInterval(() => (this.sys.live ? this.sys.live(line()) : this.sys.out(line())), this.o.progressSeconds * 1000);
    t.unref?.();
    return () => clearInterval(t);
  }

  /**
   * Brings stage/<name> up to BEAST's files under `root`: what is new or changed is copied, what went is removed (w508).
   * BEAST lists its files and keeps the list; the copy goes in tar streams of at most batchFiles files and batchMB MB,
   * each named to BEAST by line numbers, checked (the archive whole, BEAST's tar's exit and messages) and tried again up
   * to `attempts` times. Files tar did not send come through PowerShell, or are reported gone or unreadable. The
   * manifest is written after each stream and names only files that were unpacked whole, so a run that stops is resumed
   * by the next, which never trusts a file it did not finish.
   */
  async pull(name: string, label: string, liveRoot: string, include: string[], skip: string[] = [], snapRun = `${Date.now()}-${process.pid}`): Promise<{ files: number; bytes: number; fetched: number; removed: number; ms: number; total: number; locked: { path: string; why: string }[]; gone: string[] }> {
    const t0 = Date.now();
    const run = `${snapRun}-${name}`;
    // Everything below reads the snapshot: the listing, every stream and every retry, and the files sent one by one.
    const root = await this.beastSnapshot(snapRun, name, label, liveRoot, include, skip);
    this.sys.out(`${label}: listing BEAST's files under ${liveRoot} (in the snapshot)...`);
    const stopList = this.ticker(() => `  still listing (${span((Date.now() - t0) / 1000)})`);
    const r = await this.beast.ps(MANIFEST_PS, JSON.stringify({ root, include, skip, run, name }), 10 * 60_000).finally(stopList);
    if (r.code !== 0) throw new Error(`listing ${root} on BEAST failed: ${failureDetail(r)}`);
    const dir = manifestDir(r.stdout);
    if (!dir) throw new Error(`listing ${root} on BEAST gave no list folder: ${r.stdout.slice(-300)}`);
    const remote = parseManifest(r.stdout).filter((e) => name !== 'beast' || !skipOnCopy(e.path));
    const total = remote.reduce((n, e) => n + e.size, 0);
    const have = this.loadManifest(name);
    const { fetch, remove } = manifestDiff(remote, have);
    const want = fetch.reduce((n, e) => n + e.size, 0);
    this.say(`${label}: ${count(remote.length)} files, ${size(total)} on BEAST (listed in ${secs(Date.now() - t0)}); to copy: ${count(fetch.length)} files, ${size(want)}${remove.length ? `; ${count(remove.length)} gone there` : ''}`);
    const dest = path.join(this.stage, name);
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    // The manifest from here on: what the stage holds whole. Files about to be copied again are not in it until they are.
    const kept = new Map(have.map((e) => [e.path, e]));
    for (const e of fetch) kept.delete(e.path);
    for (const p of remove) {
      kept.delete(p);
      fs.rmSync(path.join(dest, p), { force: true });
    }
    const save = () => writeJson(this.manifestFile(name), [...kept.values()].map(({ path: p, size: z, mtime }) => ({ path: p, size: z, mtime })));
    save();
    const tc = Date.now();
    let bytes = 0;
    let done = 0;
    let doneBytes = 0;
    const sizes = new Map(fetch.map((e) => [e.path, e.size]));
    // What the progress line shows only ever goes up: a stream tried again does not take back what it showed (w508).
    let shownFiles = 0;
    let shownBytes = 0;
    const progress = () => {
      let inflight = 0;
      for (const p of current ?? []) inflight += sizes.get(p) ?? 0;
      shownFiles = Math.max(shownFiles, Math.min(done + (current?.size ?? 0), fetch.length));
      shownBytes = Math.max(shownBytes, Math.min(doneBytes + inflight, want));
      const s = (Date.now() - tc) / 1000;
      const rate = shownBytes / Math.max(s, 0.001);
      const left = Math.max(want - shownBytes, 0);
      const eta = shownBytes >= 1024 * 1024 && s >= 5 && left > 0 ? `, about ${span(left / rate)} left` : bytes === 0 ? ', waiting for BEAST' : '';
      return `  ${label}: ${count(shownFiles)}/${count(fetch.length)} files, ${size(shownBytes)} of ${size(want)}, ${mb(rate)}/s${eta}`;
    };
    // Files of the stream in flight, as tar here names them while it unpacks.
    let current: Set<string> | undefined;
    const stopCopy = fetch.length ? this.ticker(progress) : () => undefined;
    const missing: ManifestEntry[] = [];
    const locked: { path: string; why: string }[] = [];
    const gone: string[] = [];
    try {
      const batches = batchPlan(fetch, { maxFiles: this.o.batchFiles, maxBytes: this.o.batchMB * 1024 * 1024 });
      const codec = batches.length ? await this.chooseCodec(root, dir, `${name}.all`, [...fetch].sort((a, b) => a.size - b.size)[0]) : CODECS[CODECS.length - 1];
      for (const [bi, batch] of batches.entries()) {
        let res: StreamResult | undefined;
        // The batch as it is streamed: a file tar on BEAST stops at is taken out of it (and sent one by one below).
        let files = batch;
        const out = `${bi}.list`;
        let listPath = '';
        const writeList = async () => {
          const lr = await this.beast.ps(BATCH_PS, JSON.stringify({ dir, all: `${name}.all`, out, spec: indexSpec(files.map((e) => e.index!)) }), 120_000);
          listPath = /^list\t(.+)$/m.exec(lr.stdout)?.[1]?.trim() ?? '';
          if (lr.code !== 0 || !listPath) throw new Error(`BEAST could not write the list for batch ${bi + 1} of ${batches.length}: ${failureDetail(lr)}`);
        };
        await writeList();
        let taken = 0;
        for (let attempt = 1; ; ) {
          res = await this.beast.stream(root, listPath, dest, (n) => (bytes += n), (u) => (current = u), codec);
          current = undefined;
          // Whole: tar here read the archive to its end, and tar on BEAST finished (0; 1 or 2 when some files could not
          // be read, which are dealt with below). 255 is ssh's own failure (the connection), anything else a crash.
          const whole = !res.stalled && res.untarCode === 0 && [0, 1, 2].includes(res.sshCode);
          if (whole) break;
          // tar on BEAST names each file as it packs it (-v): after an error (Windows tar prints "tar: (null)" for one it
          // could not read to the end), the last one named is the one it stopped at.
          const { named, errors } = tarVerbose(res.remoteErr);
          const culprit = !res.stalled && res.sshCode !== 255 && errors.length ? named[named.length - 1] : undefined;
          const why = `${res.stalled ? `no data for ${this.o.stallSeconds} s` : res.untarCode !== 0 ? 'the archive stopped short' : 'tar on BEAST did not finish'} (ssh/BEAST tar exit ${res.sshCode}, unpacking tar exit ${res.untarCode})${errors.length ? `; BEAST: ${errors.slice(-3).join(' | ')}` : ''}${res.localErr ? `; here: ${res.localErr.trim().split('\n').slice(-2).join(' | ')}` : ''}`;
          const bad = culprit ? files.find((e) => e.path === culprit) : undefined;
          if (bad && taken < 20) {
            taken++;
            files = files.filter((e) => e !== bad);
            missing.push(bad);
            this.say(`  ${label}: tar on BEAST stopped at ${bad.path} (${errors.slice(-1)[0] ?? 'no message'}): it is taken out of batch ${bi + 1} and sent on its own; the batch goes on`);
            await writeList();
            continue;
          }
          if (attempt >= this.o.attempts) throw new Error(`${label}: batch ${bi + 1} of ${batches.length} (${count(files.length)} files) failed ${attempt} times: ${why}. The files copied before it are kept; run the same command again to go on from there`);
          this.say(`  ${label}: batch ${bi + 1} of ${batches.length} broke off: ${why}; trying again (${attempt + 1} of ${this.o.attempts})`);
          attempt++;
          await sleep(2000);
        }
        for (const e of files) {
          if (res.unpacked.has(e.path)) {
            kept.set(e.path, e);
            done++;
            doneBytes += e.size;
          } else missing.push(e);
        }
        save();
      }
      // What tar did not send: one by one through PowerShell, which names a file gone or unreadable if it cannot.
      if (missing.length) {
        const paths = new Map(missing.map((e) => [e.index!, e.path]));
        const chunks = batchPlan(missing, { maxFiles: 500, maxBytes: Number.MAX_SAFE_INTEGER });
        for (const chunk of chunks) {
          const f = await this.beast.fetch(JSON.stringify({ dir, all: `${name}.all`, root, spec: indexSpec(chunk.map((e) => e.index!)) }), dest, paths, (n) => (bytes += n));
          const byPath = new Map(chunk.map((e) => [e.path, e]));
          for (const p of f.got) {
            kept.set(p, byPath.get(p)!);
            done++;
            doneBytes += byPath.get(p)!.size;
          }
          gone.push(...f.gone);
          locked.push(...f.locked);
          const answered = new Set([...f.got, ...f.gone, ...f.locked.map((l) => l.path)]);
          for (const e of chunk) if (!answered.has(e.path)) locked.push({ path: e.path, why: `not sent (PowerShell on BEAST: exit ${f.code}${f.err.trim() ? `, ${f.err.trim().split('\n').slice(-2).join(' | ')}` : ''})` });
          save();
        }
      }
    } finally {
      stopCopy();
      // Awaited: a run that ends right after must not leave its lists in BEAST's temp folder.
      await this.beast.ps(CLEAN_PS, dir, 60_000).catch(() => undefined);
    }
    if (fetch.length) {
      const t = Math.max((Date.now() - tc) / 1000, 0.001);
      this.say(`${label}: copied ${count(done)} of ${count(fetch.length)} files, ${size(doneBytes)} of files in ${size(bytes)} over the wire (${this.codec?.label ?? 'none'}${bytes > 0 && doneBytes > 0 ? `, ${(doneBytes / bytes).toFixed(1)}x` : ''}), in ${secs(t * 1000)}: ${mb(doneBytes / t)}/s of files, ${mb(bytes / t)}/s on the wire`);
    }
    const show = (xs: string[]) => `${xs.slice(0, 10).join(', ')}${xs.length > 10 ? `, and ${xs.length - 10} more` : ''}`;
    if (gone.length) this.say(`  ${label}: ${count(gone.length)} file(s) went on BEAST during the copy: ${show(gone)}`);
    if (locked.length) this.say(`  ${label}: ${count(locked.length)} file(s) could not be read on BEAST (open elsewhere, or no access), left out and tried again by the next run: ${show(locked.map((l) => `${l.path} (${l.why})`))}`);
    await this.ownerOnly(dest);
    return { files: remote.length, bytes, fetched: done, removed: remove.length, ms: Date.now() - t0, total, locked, gone };
  }

  /** BEAST's config.json and data\ (without its Windows-only tools and supervisor files), then the conversations. */
  async pullAll(): Promise<{ moves: HistoryMove[]; ms: number }> {
    fs.mkdirSync(this.stage, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stage, 0o700);
    const t0 = Date.now();
    // One snapshot run for both copies: on BEAST's C: one shadow copy holds the portal's data and the conversations.
    const snapRun = `${Date.now()}-${process.pid}`;
    try {
      return await this.pullBoth(snapRun, t0);
    } finally {
      await this.dropSnapshot(snapRun);
    }
  }

  private async pullBoth(snapRun: string, t0: number): Promise<{ moves: HistoryMove[]; ms: number }> {
    const d = await this.pull('beast', "BEAST's config.json and data", this.o.beastRoot, ['config.json', 'data'], ['data/tools'], snapRun);
    this.say(`copied BEAST's config.json and data: ${count(d.files)} files, ${size(d.total)} in all; this time ${count(d.fetched)} file(s), ${size(d.bytes)} over the wire, ${count(d.removed)} removed, in ${secs(d.ms)}`);
    const beastCfg = readJson(path.join(this.stage, 'beast', 'config.json'));
    const state = readJson(path.join(this.stage, 'beast', 'data', 'state.json'));
    const vm = this.vmTemplate();
    const moves = historyPlan(state, { beastBase: String((beastCfg.repo as Json | undefined)?.basePath ?? ''), vmBase: String((vm.repo as Json | undefined)?.basePath ?? path.join(this.o.root, 'base')), vmStandingRoot: String(vm.standingRoot ?? path.join(this.o.root, 'agents')) });
    const include = moves.flatMap((m) => [`${m.fromFolder}/${m.sdkSessionId}.jsonl`, `${m.fromFolder}/${m.sdkSessionId}`]);
    const h = await this.pull('claude', 'the conversations', `${this.o.beastClaudeDir.replace(/[\\/]+$/, '')}/projects`, include, [], snapRun);
    this.say(`copied ${moves.length} conversation(s) to resume (the orchestrators', the dispatcher's, this host's standing agents'): ${count(h.files)} files, ${size(h.total)}; this time ${count(h.fetched)} file(s) in ${secs(h.ms)}`);
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
    ...liveOut(),
  };
}

/**
 * Lines for a person (w517, Lothsahn: "overwrite the first line on every update so it doesn't keep scrolling"): on a
 * terminal the progress line is redrawn in place (\r and ESC[K only, no cursor movement: PuTTY's defaults), without
 * the indent, and the next lasting line takes its place; elsewhere (a log, CI) a progress line at most every 30 s.
 */
export function liveOut(stream: NodeJS.WriteStream = process.stdout, now = () => Date.now()): Pick<System, 'out' | 'live'> {
  let pending = false;
  let last = 0;
  return {
    out: (line) => {
      if (pending) stream.write('\r\x1b[K');
      pending = false;
      stream.write(`${line}\n`);
    },
    live: (line) => {
      if (stream.isTTY) {
        stream.write(`\r\x1b[K${line.trimStart()}`);
        pending = true;
      } else if (now() - last >= 30_000) {
        last = now();
        stream.write(`${line.trimStart()}\n`);
      }
    },
  };
}

// ---------------------------------------------------------------- the command line

export const USAGE = `fffctl migrate --key | --dry-run-copy | --rollback-dry-run [--keep-stage] | --cut-over
  options: --ssh USER@HOST (BEAST, default ${DEFAULTS.ssh})  --beast-ssh-host H (what this portal deploys to BEAST by, default --ssh)
           --beast-root DIR (${DEFAULTS.beastRoot})  --beast-claude-dir DIR (${DEFAULTS.beastClaudeDir})  --beast-task NAME (${DEFAULTS.beastTask})
           --public-url URL (default config.json publicUrl)  --drain-minutes N (${DEFAULTS.drainMinutes})  --no-resume-check
           --snapshot auto|vss|copy (how BEAST's files are held still while copied: a VSS shadow copy, else a staged copy)
           --compress auto|zstd|gzip|bzip2|none (zstd level 3 by default, falling back to the next one either side lacks)
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
      case '--compress': {
        const v = need(i++);
        if (!['auto', 'zstd', 'gzip', 'bzip2', 'none'].includes(v)) throw new Error(`--compress is auto, zstd, gzip, bzip2 or none\n${USAGE}`);
        o.compress = v as Options['compress'];
        break;
      }
      case '--snapshot': {
        const v = need(i++);
        if (v !== 'auto' && v !== 'vss' && v !== 'copy') throw new Error(`--snapshot is auto, vss or copy\n${USAGE}`);
        o.snapshot = v;
        break;
      }
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
  // Ctrl+C (or a stop): the snapshot on BEAST goes too, then the command ends.
  let stopping = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.error(`\n${sig}: removing the snapshot on BEAST, then stopping...`);
    const give = setTimeout(() => process.exit(130), 120_000);
    void m.dropSnapshots().finally(() => {
      clearTimeout(give);
      process.exit(130);
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
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
