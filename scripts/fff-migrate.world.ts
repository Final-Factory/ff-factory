// The synthetic BEAST and VM the fffctl migrate tests (scripts/fff-migrate*.test.ts) run against: a fake ssh runs BEAST's
// side here (its PowerShell scripts under pwsh, its tar as tar), the VM's portal and BEAST's portal are the real server.
// The tests are in several files so node runs them side by side (w636): each world has its own folders, ports and BEAST
// temp folder, and PATH is per process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { DEFAULTS, Migration, type Options, type System } from './fff-migrate.ts';
import { ROOT } from '../server/config.ts';
import { claudeProjectFolder } from '../server/vmMigration.ts';
import { Store } from '../server/store.ts';
import { SessionManager } from '../server/sessions.ts';
import { MachineManager } from '../server/machines.ts';
import type { Probes } from '../machine/daemon.ts';
import type { Config } from '../server/config.ts';

// ---------------------------------------------------------------- the synthetic BEAST and VM

export const PWSH = (() => {
  if (process.platform === 'win32') return undefined;
  for (const p of [process.env.FAKE_PWSH, ...(process.env.PATH ?? '').split(':').map((d) => path.join(d, 'pwsh'))]) if (p && fs.existsSync(p)) return p;
  return undefined;
})();
export const skip = !PWSH ? 'needs Linux with pwsh (the fake BEAST runs its PowerShell scripts)' : undefined;

export const HAS_ZSTD = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
export const lanIp = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const gitInit = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
};

/** Every file under `dir` with its content's hash: BEAST's side must be the same after a dry run. */
export function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

export const FAKE_TOKEN = 'sk-ant-oat01-FAKEFORTHEMIGRATIONTEST-' + 'x'.repeat(40);
export const BEAST_TOKEN = 'not-a-real-host-token';

/** A real FF Factory server as a child process, as systemd (the VM) or the ffsb-server task (BEAST) would run it. */
class Portal {
  child?: ChildProcess;
  lines: { t: number; line: string }[] = [];
  exits: (number | null)[] = [];
  dry = false;
  readonly name: string;
  readonly cfgFile: string;
  readonly home: string;
  readonly port: number;
  constructor(name: string, cfgFile: string, home: string, port: number) {
    this.name = name;
    this.cfgFile = cfgFile;
    this.home = home;
    this.port = port;
  }
  async start() {
    if (this.child) return;
    const env: NodeJS.ProcessEnv = { ...process.env, FFSB_CONFIG: this.cfgFile, HOME: this.home, USERPROFILE: this.home, CLAUDE_CONFIG_DIR: path.join(this.home, '.claude') };
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'DISCORD_TOKEN', 'FFSB_DRY_RUN']) delete env[k];
    if (this.dry) env.FFSB_DRY_RUN = '1';
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const take = (d: Buffer) => {
      for (const line of String(d).split('\n')) if (line.trim()) this.lines.push({ t: Date.now(), line });
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    child.once('exit', (code) => {
      this.exits.push(code);
      if (this.child === child) this.child = undefined;
    });
  }
  async stop() {
    const c = this.child;
    if (!c) return;
    const gone = new Promise((r) => c.once('exit', r));
    c.kill('SIGTERM');
    await gone;
  }
  log(since = 0) {
    return this.lines.filter((l) => l.t >= since).map((l) => l.line).join('\n');
  }
  async healthy(ms = 60_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/api/health`);
        if (r.ok) return (await r.json()) as { ok: boolean; dryRun?: boolean; version?: string };
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${this.name} did not come up:\n${this.log().slice(-3000)}`);
  }
}

/** The VM's side of System, for a test: its portal as a child process, no Tailscale, scripted answers. */
class TestSystem implements System {
  lines: string[] = [];
  answers: string[] = [];
  /** How many more starts do nothing (a portal that does not come up). */
  deadStarts = 0;
  readonly portal: Portal;
  constructor(portal: Portal) {
    this.portal = portal;
  }
  async stopPortal() {
    await this.portal.stop();
  }
  async startPortal() {
    if (this.deadStarts > 0) {
      this.deadStarts--;
      return;
    }
    await this.portal.start();
  }
  async setDryRun(on: boolean) {
    this.portal.dry = on;
  }
  async logsSince(t: number) {
    return this.portal.log(t);
  }
  async funnelState() {
    return undefined;
  }
  async setFunnel() {}
  async backupsActive() {
    return false;
  }
  async setBackups() {}
  async tailnetIp() {
    return '100.64.0.10';
  }
  async ask() {
    return this.answers.shift() ?? '';
  }
  out(line: string) {
    this.lines.push(line);
  }
}

export interface World {
  base: string;
  beastRoot: string;
  beastData: string;
  beastClaude: string;
  beastBase: string;
  vm: string;
  vmCfgFile: string;
  vmBase: string;
  opts: Options;
  sys: TestSystem;
  vmPortal: Portal;
  beastPortal: Portal;
  publicUrl: string;
  machineToken: string;
  fake: string;
  /** BEAST's temp folder (its snapshots), this world's own: other tests' worlds run beside it. */
  beastTmp: string;
}

export async function world(t: { after: (fn: () => unknown) => void }): Promise<World> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fff-migrate-'));
  const ip = lanIp()!;
  const [vmPort, beastPort] = [await freePort(), await freePort()];
  const publicUrl = `http://${ip}:${vmPort}`;

  // ---- BEAST: its app folder (config.json, data, scripts), its base clone, its Claude folder
  const beastRoot = path.join(base, 'beast', 'ff-sandboxes');
  const beastData = path.join(beastRoot, 'data');
  const beastBase = path.join(base, 'beast', 'ffsb', '_base');
  const beastClaude = path.join(base, 'beast', 'claude');
  gitInit(beastBase);
  fs.mkdirSync(path.join(beastData, 'transcripts'), { recursive: true });
  fs.mkdirSync(path.join(beastRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(base, 'beast', 'sb'), { recursive: true });
  const beastCfg = {
    port: beastPort,
    host: '127.0.0.1',
    trustProxy: false,
    publicUrl: `http://127.0.0.1:${beastPort}`,
    ownerName: 'Ben',
    dataDir: beastData,
    sandboxRoot: path.join(base, 'beast', 'sb'),
    repo: { url: beastBase, basePath: beastBase, referenceRepo: beastBase },
    defaultBase: 'develop',
    unity: { editorPath: path.join(base, 'no-unity'), watchdog: { stallMinutes: 0, runningPollSeconds: 0, autoDismiss: false } },
    voice: { enabled: false, autoInstall: false, tts: false },
    hostGuard: { pollSeconds: 0 },
    orchestrator: { notifyOnWorkerEvents: false },
    claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: BEAST_TOKEN },
    machines: { keepAgentsOnRestart: true },
  };
  fs.writeFileSync(path.join(beastRoot, 'config.json'), JSON.stringify(beastCfg, null, 2));
  // BEAST's own machine, registered as the portal registers it (its token hashed in machine-tokens.json).
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const session = (id: string, kind: string, over: object = {}) => ({ id, kind, title: id, status: 'idle', permissionMode: 'bypassPermissions', createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, pendingPermissions: [], ...over });
  fs.writeFileSync(
    path.join(beastData, 'state.json'),
    JSON.stringify({ sandboxes: [], orchestratorId: 'disp', sessions: [session('disp', 'orchestrator', { orchestratorRole: 'dispatcher', title: 'Dispatcher', sdkSessionId: 'sdk-disp-1' }), session('w1', 'worker', { machineId: 'beast' })], settings: { heartbeatMinutes: null } }, null, 2),
  );
  const store = new Store(beastData);
  const mm = new MachineManager({ dataDir: beastData, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config, store, new SessionManager({} as Config, store));
  const { token: machineToken } = mm.register({ id: 'beast', host: 'localhost', local: true, purpose: 'unused', status: 'ready', repoPath: beastBase, home: path.join(base, 'beast'), portalUrl: `http://127.0.0.1:${beastPort}` });
  store.flush();
  const item = (id: string, title: string) => ({ id, title, brief: title, priority: 'normal', keys: [], requestedBy: { userId: 'ben', displayName: 'Ben' }, requesters: [{ userId: 'ben', displayName: 'Ben' }], humanAsked: true, status: 'open', createdAt: at, updatedAt: at, sessionIds: [], overlaps: [] });
  fs.writeFileSync(path.join(beastData, 'work.json'), JSON.stringify({ seq: 2, items: [item('w1', 'one'), item('w2', 'two')] }));
  fs.writeFileSync(path.join(beastData, 'transcripts', 'disp.jsonl'), '{"seq":1,"kind":"system","text":"hi"}\n');
  fs.writeFileSync(path.join(beastData, 'transcripts', 'w1.jsonl'), '{"seq":1,"kind":"system","text":"hi"}\n');
  fs.writeFileSync(path.join(beastData, 'outside-watch.json'), JSON.stringify({ topic: 'ffsb-abcdefghijklmnop', mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.5' }));
  fs.mkdirSync(path.join(beastData, 'tools', 'whisper'), { recursive: true });
  fs.writeFileSync(path.join(beastData, 'tools', 'whisper', 'model.bin'), 'big and Windows-only');
  fs.writeFileSync(path.join(beastData, 'supervisor.pid'), '1234');
  fs.mkdirSync(path.join(beastData, 'orchestrator-memory', 'dispatcher'), { recursive: true });
  fs.writeFileSync(path.join(beastData, 'orchestrator-memory', 'dispatcher', 'MEMORY.md'), '- remembered\n');
  // Its stop: what scripts\stop-server.ps1 does, as far as a test can: ask the server to stop, wait for it to go.
  fs.writeFileSync(
    path.join(beastRoot, 'scripts', 'stop-server.ps1'),
    `[IO.File]::WriteAllText((Join-Path $PSScriptRoot '../data/restart.request'), '')
for ($i = 0; $i -lt 120; $i++) { try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:${beastPort}/api/health'; Start-Sleep -Milliseconds 500 } catch { break } }
'stopped'
`,
  );
  const histDir = path.join(beastClaude, 'projects', claudeProjectFolder(beastBase));
  fs.mkdirSync(path.join(histDir, 'sdk-disp-1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(histDir, 'sdk-disp-1.jsonl'), `{"type":"user","cwd":${JSON.stringify(beastBase)},"message":"the dispatcher's history"}\n`);
  fs.writeFileSync(path.join(histDir, 'sdk-disp-1', 'subagents', 'a.jsonl'), '{"type":"user"}\n');
  fs.writeFileSync(path.join(histDir, 'someone-else.jsonl'), 'not copied\n');

  // ---- the VM: its own config.json as the guest install and fffctl configure leave it, its own empty data
  const vm = path.join(base, 'vm');
  const vmBase = path.join(vm, 'base');
  gitInit(vmBase);
  for (const d of ['config', 'data', 'secrets', 'home/.ssh', 'sandboxes', 'agents']) fs.mkdirSync(path.join(vm, d), { recursive: true });
  fs.writeFileSync(path.join(vm, 'secrets', 'claude-oauth-token'), FAKE_TOKEN + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(vm, 'home', '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheMigrationTest fff-portal@fff\n');
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy', 'vm', 'guest', 'config.vm.example.json'), 'utf8'));
  const vmCfg = {
    ...template,
    port: vmPort,
    publicUrl,
    ownerName: 'Lothsahn',
    dataDir: path.join(vm, 'data'),
    sandboxRoot: path.join(vm, 'sandboxes'),
    standingRoot: path.join(vm, 'agents'),
    repo: { ...template.repo, basePath: vmBase },
    hostDiskPaths: [vm],
    review: { root: path.join(vm, 'review') },
    hostGuard: { ...template.hostGuard, pollSeconds: 0 },
    unity: { editorPath: path.join(base, 'no-unity'), watchdog: { stallMinutes: 0, runningPollSeconds: 0, autoDismiss: false } },
    orchestrator: { ...template.orchestrator, notifyOnWorkerEvents: false },
    claudeTokenFile: path.join(vm, 'secrets', 'claude-oauth-token'),
    claudeAccounts: { orchestrator: 'tokenfile', dispatcher: 'tokenfile' },
  };
  const vmCfgFile = path.join(vm, 'config', 'config.json');
  fs.writeFileSync(vmCfgFile, JSON.stringify(vmCfg, null, 2) + '\n');

  // ---- the fakes: ssh runs BEAST's side here; schtasks.exe and claude record what they were asked
  const fake = path.join(base, 'bin');
  fs.mkdirSync(fake);
  const beastTmp = path.join(base, 'beast-tmp');
  fs.mkdirSync(beastTmp);
  fs.writeFileSync(path.join(fake, 'fake.env'), `PWSH=${JSON.stringify(PWSH)}\nLOG=${JSON.stringify(path.join(base, 'ssh.log'))}\nTASKS=${JSON.stringify(path.join(base, 'schtasks.log'))}\nCLAUDE_LOG=${JSON.stringify(path.join(base, 'claude.log'))}\nDENY=${JSON.stringify(path.join(base, 'deny'))}\nOLD_BEAST=${JSON.stringify(path.join(base, 'old-beast'))}\nTRUNCATE=${JSON.stringify(path.join(base, 'truncate'))}\nTARSKIP=${JSON.stringify(path.join(base, 'tarskip'))}\nTARNULL=${JSON.stringify(path.join(base, 'tarnull'))}\nNOZSTD=${JSON.stringify(path.join(base, 'nozstd'))}\nTOKEN_FILE=${JSON.stringify(path.join(vm, 'secrets', 'claude-oauth-token'))}\nBEAST_TMP=${JSON.stringify(beastTmp)}\n`);
  const script = (name: string, body: string) => fs.writeFileSync(path.join(fake, name), `#!/usr/bin/env bash\nset -euo pipefail\n. "$(dirname "$0")/fake.env"\n${body}`, { mode: 0o755 });
  script(
    'ssh',
    `dest=""
while [ $# -gt 0 ]; do
  case "$1" in -i|-o|-p|-l|-F|-E|-J) shift 2 ;; -*) shift ;; *) dest=$1; shift; break ;; esac
done
printf '%s %s\\n' "$dest" "\${1:-}" >>"$LOG"
export TMPDIR=$BEAST_TMP
if [ -e "$DENY" ]; then echo "$dest: Permission denied (publickey)." >&2; exit 255; fi
[ "$dest" = rydin@beast ] || { echo "ssh: Could not resolve hostname $dest" >&2; exit 255; }
if [ "\${1:-}" = powershell.exe ]; then
  shift; args=()
  while [ $# -gt 0 ]; do case "$1" in -ExecutionPolicy) shift 2 ;; *) args+=("$1"); shift ;; esac; done
  # As BEAST's sshd (measured, w508): a script much over 128 KB on stdin never arrives whole. Here over 64 KB fails.
  in=$(mktemp); cat >"$in"
  n=$(wc -c <"$in")
  if [ "$n" -gt 65536 ]; then rm -f "$in"; echo "fake BEAST: $n bytes on stdin never arrive through Windows OpenSSH" >&2; exit 255; fi
  set +e
  # A BEAST portal from before w499 (2/3) ignores relocate: as if the request had none.
  if [ -e "$OLD_BEAST" ]; then sed 's/,"relocate":"[^"]*"//' <"$in" | "$PWSH" "\${args[@]}"; else "$PWSH" "\${args[@]}" <"$in"; fi
  rc=$?; rm -f "$in"; exit $rc
fi
# Any other command (tar): BEAST's sshd never hands it its stdin whole (measured, w508), so here it gets none.
if [ "\${1:-}" = tar ]; then
  args=(); skipped=0
  # bsdtar's --options (the zstd level) is BEAST's; GNU tar takes --zstd at its own level. A BEAST without zstd refuses it.
  while [ $# -gt 0 ]; do
    case "$1" in
      --options) shift 2 ;;
      --zstd) if [ -e "$NOZSTD" ]; then echo "tar.exe: Option --zstd is not supported" >&2; exit 1; fi; args+=("$1"); shift ;;
      *) args+=("$1"); shift ;;
    esac
  done
  # tar on Windows cannot take some names (outside its code page): it leaves them out, says so without the name, exits 1.
  if [ -s "$TARSKIP" ]; then
    for i in "\${!args[@]}"; do
      if [ "\${args[$i]}" = -T ]; then
        f=$(mktemp); sed 's|^|./|' "$TARSKIP" | grep -vxF -f - "\${args[$((i + 1))]}" >"$f" || true
        args[$((i + 1))]=$f; skipped=1
      fi
    done
  fi
  set +e
  # The connection breaking mid-stream, for the next N streams.
  if [ -s "$TRUNCATE" ] && [ "$(cat "$TRUNCATE")" -gt 0 ]; then
    echo $(( $(cat "$TRUNCATE") - 1 )) >"$TRUNCATE"
    "\${args[@]}" </dev/null 2>/dev/null | head -c 3000
    echo "fake: client_loop: send disconnect: Broken pipe" >&2; exit 255
  fi
  # Windows tar stops at a file that changes while it reads it: it has named it ("a <path>", no newline yet), says
  # "tar: (null)" on the same line and exits 1, the archive cut off in that file (measured on BEAST, w508).
  if [ -s "$TARNULL" ]; then
    for i in "\${!args[@]}"; do
      if [ "\${args[$i]}" = -T ]; then
        list=\${args[$((i + 1))]}; bad="./$(head -n 1 "$TARNULL")"
        if grep -qxF "$bad" "$list"; then
          upto=$(mktemp); awk -v b="$bad" '{ print } $0 == b { exit }' "$list" >"$upto"
          args[$((i + 1))]=$upto
          # 512-byte records (no padding to 10 KB), so the cut lands inside that file's data, as Windows tar's does.
          n=$("\${args[@]}" -b 1 </dev/null 2>/dev/null | wc -c)
          "\${args[@]}" -b 1 </dev/null 2>/dev/null | head -c $((n - 1024 - 700))
          grep -v -xF "$bad" "$upto" | sed 's|^|a |' >&2
          printf 'a %star: (null)\n' "$bad" >&2
          exit 1
        fi
      fi
    done
  fi
  # Windows tar's -v: "a <path>" per file on stderr; its messages as they are.
  "\${args[@]}" </dev/null 2> >(sed -u '/^tar: /!s|^|a |' >&2); rc=$?
  if [ "$skipped" = 1 ]; then echo "tar: : Couldn't visit directory: No such file or directory" >&2; [ "$rc" = 0 ] && rc=1; fi
  exit $rc
fi
exec "$@" </dev/null
`,
  );
  script('schtasks.exe', 'printf \'%s\\n\' "$*" >>"$TASKS"\necho "SUCCESS: (fake)"\n');
  script(
    'claude',
    `id=""; prev=""
for a in "$@"; do [ "$prev" = --resume ] && id=$a; prev=$a; done
folder=$(pwd | sed 's/[^a-zA-Z0-9]/-/g')
f="$HOME/.claude/projects/$folder/$id.jsonl"
case " $* " in *"$(cat "$TOKEN_FILE")"*) echo "token on the command line" >>"$CLAUDE_LOG"; exit 9 ;; esac
[ "\${CLAUDE_CODE_OAUTH_TOKEN:-}" = "$(cat "$TOKEN_FILE")" ] && echo "token from the environment" >>"$CLAUDE_LOG"
case " $* " in *" --fork-session "*) echo "forked" >>"$CLAUDE_LOG" ;; esac
if [ -f "$f" ]; then
  mkdir -p "$(dirname "$f")"; echo '{"type":"user"}' >"$(dirname "$f")/fork-1.jsonl"
  echo '{"type":"result","subtype":"success","is_error":false,"result":"resumed","session_id":"fork-1"}'
else
  echo "No conversation found with session ID: $id ($f)" >&2; exit 1
fi
`,
  );
  const PATH0 = process.env.PATH;
  process.env.PATH = `${fake}:${PATH0}`;
  const vmPortal = new Portal('the VM\'s portal', vmCfgFile, path.join(vm, 'home'), vmPort);
  const beastPortal = new Portal("BEAST's portal", path.join(beastRoot, 'config.json'), path.join(base, 'beast'), beastPort);
  const sys = new TestSystem(vmPortal);
  t.after(async () => {
    await vmPortal.stop();
    await beastPortal.stop();
    process.env.PATH = PATH0;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const opts: Options = { ...DEFAULTS, mode: 'dry-run-copy', ssh: 'rydin@beast', beastSshHost: 'rydin@beast', beastRoot, beastClaudeDir: beastClaude, root: vm, port: vmPort, user: undefined, claude: path.join(fake, 'claude'), tailscale: false, healthSeconds: 90, daemonSeconds: 60, drainMinutes: 1 };
  return { base, beastRoot, beastData, beastClaude, beastBase, vm, vmCfgFile, vmBase, opts, sys, vmPortal, beastPortal, publicUrl, machineToken, fake, beastTmp };
}

export const migration = (w: World, mode: Options['mode'], over: Partial<Options> = {}) => new Migration({ ...w.opts, mode, ...over }, w.sys);

export const PROBES: Probes = {
  stats: async () => ({ hostname: 'beast', platform: 'linux', cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: 2 ** 30, memFreeBytes: 2 ** 30 }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

export async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
