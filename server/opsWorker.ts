import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { HookCallback, Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, Requester, SessionInfo } from '../shared/types.ts';
import { isMidTurn, type SessionHandle, type SessionManager } from './sessions.ts';
import type { Store } from './store.ts';
import { readProblem, realReadFs, type ReadCtx, type SecretRules } from './secretGuard.ts';
import { scanShell } from './standingGuard.ts';
import { redactSecrets } from './secrets.ts';

/**
 * The orchestration worker (w597, docs/ops-worker.md): ONE Claude Code session with a real shell, for Lothsahn's and
 * Ben's own orchestrators only, that lives in the portal VM. No Unity, no game workspace, no git, no downloads: it
 * orchestrates (ssh to the enrolled machines with the portal's key, read-only portal state, machine credentials) and
 * runs anything heavy on the target machine over ssh.
 *
 * Its process is not the portal's child in the usual sense. The portal service runs with NoNewPrivileges and holds every
 * secret, so the worker runs as its own Linux account (fff-ops) in a systemd unit of its own (fff-ops@.service, started
 * by fff-ops.socket, one connection at most): the portal connects to that socket and speaks Claude Code's stream-json
 * protocol through it (opsSpawner). The account's fences are the OS's (deploy/vm/guest: unit sandbox, a 2 GiB scratch
 * file system, the network allowlist, a sudoers file with two wrappers); this module adds the server's: who may start or
 * message it, its tool belt, a PreToolUse guard (a seatbelt with clear reasons), the audit log, its model, budget and
 * lifetime.
 */

/** Its one, fixed session id. Never a pool, never a configurable kind (lothsahn, 2026-10-07: "it's hardcoded"). */
export const OPS_ID = 'ops-worker';
export const OPS_TITLE = 'Orchestration worker (portal VM)';
/** The people whose own orchestrators may use it, by login (user id). Nobody else, the dispatcher included. */
export const OPS_PEOPLE: readonly string[] = ['lothsahn', 'ben'];

/** Where it lives in the VM (deploy/vm/guest/install.sh, the orchestration worker step). */
export const OPS_PATHS = {
  socket: '/run/fff-ops/claude.sock',
  root: '/srv/fff-ops',
  home: '/srv/fff-ops/home',
  scratch: '/srv/fff-ops/scratch',
  /** The wrappers on its PATH: ssh (fff-ops-ssh, as the portal's account), scp and sftp (as itself, over fff-ops-scp-ssh) and fffctl (fff-ops-priv, the allowed subcommands). */
  bin: '/usr/local/lib/fff/ops-bin',
};

/** Its settings (docs/ops-worker.md, "Model, budget and lifetime"). Fixed here, like the worker itself. */
export const OPS_LIMITS = {
  model: 'opus',
  effort: 'medium' as EffortLevel,
  /** A process's spend cap (the SDK's maxBudgetUsd): the CLI stops the run when it passes it. A process lives one job. */
  budgetUsd: 25,
  /** An idle process is stopped after this long (the prompt cache's hour, as idle workers: IDLE_REAP_MS); the next message resumes it. */
  idleStopMs: 60 * 60_000,
  /** A turn still running after this long is interrupted (the unit's RuntimeMaxSec is the OS's own backstop). */
  turnMaxMs: 2 * 3_600_000,
  /** A job a person opened in a turn of their own can be followed up by their orchestrator's harness turns this long. */
  jobMs: 12 * 3_600_000,
  /** A deploy grant (ops_worker deploy) is good for this long, once: fff-ops-priv refuses `fffctl update` without one. */
  deployGrantMs: 15 * 60_000,
  /** After a deploy, the next portal start within this long tells the worker to report (the update's own restart). */
  deployReportMs: 60 * 60_000,
};

/** Where the portal leaves a deploy grant for fff-ops-priv (root reads it; fff-ops cannot reach the data folder). */
export const OPS_GRANT = 'ops-deploy.grant';

/** Why a caller may not use it (a refusal names who may). */
export const OPS_REFUSED = `the orchestration worker takes messages only from Lothsahn's and Ben's own orchestrators (w597); not from the dispatcher, other people, standing agents, the intake, FFBox or /mcp`;

/** Whether this orchestrator session is Lothsahn's or Ben's own. */
export function opsAllowedOrchestrator(info: Pick<SessionInfo, 'kind' | 'orchestratorRole' | 'requestedBy'> | undefined): Requester | undefined {
  if (!info || info.kind !== 'orchestrator' || info.orchestratorRole !== 'personal' || !info.requestedBy) return undefined;
  return OPS_PEOPLE.includes(info.requestedBy.userId.toLowerCase()) ? info.requestedBy : undefined;
}

// ---------------------------------------------------------------- the guard

/** Commands that fetch, install, build or change things locally, which the worker runs on the target machine instead. */
const DENIED: Record<string, string> = Object.fromEntries([
  ...['git', 'gh', 'git-lfs'].map((c) => [c, 'no git here: clone and build on the target machine over ssh']),
  ...['curl', 'wget', 'aria2c', 'rsync', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp'].map((c) => [c, 'no downloads in the VM: fetch on the target machine over ssh; copy files to and from the machines with scp or sftp']),
  ...['apt', 'apt-get', 'aptitude', 'dpkg', 'snap', 'pip', 'pip3', 'pipx', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'go', 'gem', 'brew', 'make', 'docker', 'podman'].map((c) => [c, 'no installs or builds in the VM: run them on the target machine over ssh']),
  ...['python', 'python3', 'perl', 'ruby', 'node', 'php', 'lua'].map((c) => [c, 'no interpreters in the VM (they can fetch and install): use jq, or run the script on the target machine']),
  ...['env', 'printenv', 'export', 'declare', 'set'].map((c) => [c, 'the environment is not printed (it may hold a credential)']),
  ...['systemctl', 'journalctl', 'service', 'reboot', 'shutdown', 'poweroff', 'kill', 'pkill', 'killall'].map((c) => [c, "the portal VM's services are a person's (deploy, restart): fffctl status and fffctl logs read them"]),
  ...['eval', 'exec', 'source', '.'].map((c) => [c, 'no eval, exec or source: run the command itself']),
  ['steamcmd', 'Steam is a person\'s'],
  ['fff-vm', 'the host is a person\'s'],
]);

/** Prefixes that run the next word as a command. */
const WRAPPERS = new Set(['nice', 'nohup', 'timeout', 'time', 'stdbuf', 'xargs', 'command', 'builtin', 'ionice', 'setsid']);
const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh']);

/**
 * Every fffctl command and its forms, split by one rule (Lothsahn, 2026-10-09, w745: "anytime a new fffctl command is
 * provided, all read only parts of it should be allowed by the orchestrator worker"): a form that changes nothing (no file
 * write, no unit start or stop, no vault change, no pause or reset, no token value printed) is `allowed`, here and in
 * fff-ops-priv; the rest is `changes` and stays a person's. A new fffctl command or form goes in this table in the same PR;
 * the test "every fffctl command and form is classified" fails until it does. '' is the command without a word after it.
 * `grant` marks the forms fff-ops-priv allows although they change state, on a stated condition (w597, w676).
 */
export const FFFCTL_FORMS: Record<string, { allowed: string[]; changes: string[]; grant?: string }> = {
  status: { allowed: [''], changes: [] },
  state: { allowed: [''], changes: [] },
  help: { allowed: [''], changes: [] },
  units: { allowed: ['', '--check'], changes: [] },
  logs: { allowed: ['', 'N'], changes: ['-f'] },
  vault: { allowed: ['list', 'list --names', 'help'], changes: ['init', 'export-key', 'add', 'put', 'rotate', 'grant', 'remove', 'rename', 'new-key'] },
  'machine-credential': { allowed: ['list'], changes: ['issue', 'revoke'] },
  migrate: { allowed: ['--help'], changes: ['--key', '--dry-run-copy', '--rollback-dry-run', '--cut-over'] },
  watchdog: { allowed: [], changes: ['run', 'pause', 'resume', 'reset'] },
  update: { allowed: [], changes: [''], grant: "only with the deploy grant of a person's own turn (ops_worker deploy)" },
  restart: { allowed: [], changes: [''] },
  rollback: { allowed: [], changes: [''] },
  'prepare-shutdown': { allowed: [], changes: [''] },
  start: { allowed: [], changes: [''] },
  'claude-token': { allowed: [], changes: [''] },
  'claude-login': { allowed: [], changes: [''] },
  'tailscale-join': { allowed: [], changes: [''] },
  'gh-login': { allowed: [], changes: [''] },
  'base-clone': { allowed: [], changes: [''] },
  backup: { allowed: [], changes: [''] },
  'backup-config': { allowed: [], changes: [''] },
  configure: { allowed: [], changes: [''] },
};

/** Words the worker's fffctl wrapper (fff-ops-priv) takes that are not fffctl commands of their own: its machine ssh and `credential`. */
const OPS_ONLY_FFFCTL = ['machine-ssh', 'machine-ssh-check', 'credential'];

/** The fffctl subcommands its fffctl wrapper (fff-ops-priv) runs: everything else is a person's. */
export const OPS_FFFCTL = [...Object.entries(FFFCTL_FORMS).filter(([, f]) => f.allowed.length || f.grant).map(([k]) => k), ...OPS_ONLY_FFFCTL];

/** The commands whose first word after them is a form: the guard checks that word (fff-ops-priv checks every word). */
const FFFCTL_FORM_WORD = ['vault', 'machine-credential', 'migrate'];

/** scp's and sftp's options that take a value (OpenSSH's getopt strings). */
const COPY_VALUE_OPTS = { scp: 'cDFiJloPSX', sftp: 'BbcDFiJloPRSX' };
/** The options that would change the ssh under them: fff-ops-scp-ssh refuses them as well. */
const COPY_SSH_OPTS = 'DFiJoS';

/**
 * Why an scp or sftp command is refused (w612), or undefined: an option that changes its ssh, another port, or a local
 * file of FF Factory's own as its source or destination. A remote path (m5:path, user@host:path) is the machine's.
 */
function copyProblem(name: 'scp' | 'sftp', args: string[], read: ReadCtx, rules: SecretRules): string | undefined {
  const local: string[] = [];
  let operands = 0;
  let options = true;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (options && a === '--') {
      options = false;
      continue;
    }
    if (options && a.length > 1 && a.startsWith('-')) {
      for (let j = 1; j < a.length; j++) {
        const o = a[j];
        if (COPY_SSH_OPTS.includes(o)) return `${name} -${o}: its ssh is fixed (the portal's key, pinned host keys, port 22): give it the machine (m5:path, user@host:path) and nothing else`;
        if (!COPY_VALUE_OPTS[name].includes(o)) continue;
        const v = j + 1 < a.length ? a.slice(j + 1) : args[++k];
        if (o === 'P' && v !== '22') return `${name} -P ${v}: the machines' ssh is on port 22`;
        if (o === 'b' && v !== undefined) local.push(v);
        break;
      }
      continue;
    }
    // scp: a path with a colon before any slash is the machine's. sftp: the machine first, then a local folder.
    if (name === 'scp' ? !/^[^/]*:/.test(a) : operands > 0) local.push(a);
    operands++;
  }
  for (const p of local) {
    if (readProblem(p, 'file', rules, read)) return `${p}: not yours to copy (FF Factory's config, secrets, keys and data stay in the VM)`;
  }
  return undefined;
}

/** What it may not read: FF Factory's own files and secrets in the VM, and any process's environment. */
export function opsSecretRules(): SecretRules {
  return {
    deny: ['/srv/fff', '/etc/fff', '/etc/fff-vm', '/run/credentials', '/root', '/etc/sudoers', '/etc/sudoers.d', '/etc/shadow', '/var/lib/fff-ops', `${OPS_PATHS.home}/.claude/.credentials.json`, `${OPS_PATHS.home}/.ssh`],
    allow: [],
  };
}

/**
 * Why a shell command is refused, or undefined. A seatbelt with reasons: the account's own fences (no sudo but the two
 * wrappers, no network but Anthropic's API and the tailnet, a 2 GiB noexec scratch) hold without it. Commands sent to a
 * machine over ssh are that machine's business and are not looked into: the reinstall work happens there.
 */
export function checkOpsShell(cmd: string, read: ReadCtx, rules = opsSecretRules(), depth = 0): string | undefined {
  if (/\/proc\/[^\s'"]*\/environ/.test(cmd)) return "a process's environment is not read (it may hold a credential)";
  const scan = scanShell(cmd);
  const subst = scan.problems.find((p) => /substitution|unterminated/.test(p));
  if (subst) return `${subst}: run each command on its own (send commands to a machine in single quotes: ssh m5 'hostname')`;
  for (const words of scan.commands) {
    let i = 0;
    // VAR=value prefixes, then wrappers that run the next word (with their own options: timeout -s KILL 10 cmd).
    while (i < words.length) {
      const w = words[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        i++;
        continue;
      }
      const b = path.posix.basename(w);
      if (!WRAPPERS.has(b)) break;
      i++;
      while (i < words.length && words[i].startsWith('-')) i++;
      if (b === 'timeout' && i < words.length && /^\d/.test(words[i])) i++;
    }
    const first = words[i];
    if (!first) continue;
    const name = path.posix.basename(first);
    if (name === 'ssh') continue; // the rest runs on the machine
    if (name === 'sudo') return 'no sudo: the wrappers on your PATH (ssh, fffctl) carry the rights you have';
    // `set -e` and `export X=1` are harmless; bare `set`, `export -p` print the environment.
    const harmless = (name === 'set' && /^[-+]/.test(words[i + 1] ?? '')) || (name === 'export' && words.slice(i + 1).length > 0 && words.slice(i + 1).every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)));
    if (DENIED[name] && !harmless) return `${name}: ${DENIED[name]}`;
    if (name === 'scp' || name === 'sftp') {
      if (first !== name) return `${first}: run ${name} from your PATH (its ${name} goes through the portal's ssh to the machines)`;
      const why = copyProblem(name, words.slice(i + 1), read, rules);
      if (why) return why;
    }
    if (name === 'fffctl' && words[i + 1] !== undefined && !OPS_FFFCTL.includes(words[i + 1])) return `fffctl ${words[i + 1]} is a person's (deploys, restarts, settings, the vault, migrations): you have fffctl ${OPS_FFFCTL.join(', ')}`;
    if (name === 'fffctl' && FFFCTL_FORM_WORD.includes(words[i + 1] ?? '')) {
      const forms = FFFCTL_FORMS[words[i + 1]];
      const form = words[i + 2];
      if (form === undefined || !forms.allowed.some((a) => a.split(' ')[0] === form)) return `fffctl ${words[i + 1]} ${form ?? ''}`.trim() + ` is a person's (it changes the vault, a credential or the migration): you have fffctl ${forms.allowed.map((a) => `${words[i + 1]} ${a}`).join(', ')}`;
    }
    if (SHELLS.has(name)) {
      const c = words.indexOf('-c', i + 1);
      if (c > 0 && words[c + 1] !== undefined) {
        if (depth >= 2) return 'nested shells: run the command itself';
        const inner = checkOpsShell(words[c + 1], read, rules, depth + 1);
        if (inner) return inner;
      }
    }
    for (const w of words.slice(i)) {
      if (!/^(\/|~)/.test(w)) continue;
      const why = readProblem(w, 'file', rules, read);
      if (why) return `${w}: not yours to read (FF Factory's config, secrets, keys or data)`;
    }
  }
  return undefined;
}

/** Whether `p` is inside its scratch folder (posix, `..` resolved). */
export function inScratch(p: string, scratch = OPS_PATHS.scratch): boolean {
  const abs = path.posix.resolve(scratch, p);
  return abs === scratch || abs.startsWith(`${scratch}/`);
}

/**
 * Its PreToolUse hook: every tool call is logged (redacted) to the portal's journal, which is the audit beside its
 * transcript; Write and Edit only in its scratch; reads never of FF Factory's own files; the shell through checkOpsShell.
 */
export function opsGuard(log: (line: string) => void = (l) => console.log(l), read: ReadCtx = { platform: 'linux', home: OPS_PATHS.home, cwd: OPS_PATHS.scratch, fsx: realReadFs }): HookCallback {
  const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } });
  const rules = opsSecretRules();
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = input.tool_name;
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    const shown = tool === 'Bash' ? String(args.command ?? '') : JSON.stringify(args);
    const refuse = (why: string) => {
      log(`ops-worker: REFUSED ${tool}: ${redactSecrets(shown).replace(/\s+/g, ' ').slice(0, 600)} (${why})`);
      return deny(`${why} (the orchestration worker's rules, docs/ops-worker.md)`);
    };
    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      const target = String(args.file_path ?? args.notebook_path ?? '');
      if (!inScratch(target)) return refuse(`write only in your scratch folder ${OPS_PATHS.scratch}; ${target} is outside it`);
    }
    if (tool === 'Read' || tool === 'Grep' || tool === 'Glob' || tool === 'LS') {
      const target = String(args.file_path ?? args.path ?? OPS_PATHS.scratch);
      const why = readProblem(target, tool === 'Read' ? 'file' : 'search', rules, read);
      if (why) return refuse(`${target}: not yours to read (FF Factory's config, secrets, keys or data)`);
    }
    if (tool === 'Bash') {
      const why = checkOpsShell(String(args.command ?? ''), read, rules);
      if (why) return refuse(why);
    }
    log(`ops-worker: ${tool}: ${redactSecrets(shown).replace(/\s+/g, ' ').slice(0, 600)}`);
    return {};
  };
}

// ---------------------------------------------------------------- the process: through fff-ops.socket

/** The environment the launcher is handed (it filters again): Claude Code's own settings and the credential, nothing of the portal's. */
const PASS_ENV = /^(CLAUDE_CODE_[A-Z0-9_]+|ANTHROPIC_[A-Z0-9_]+|CLAUDE_AGENT_SDK_[A-Z0-9_]+|MCP_[A-Z0-9_]+|MAX_THINKING_TOKENS)$/;
/** The portal's own settings that must not reach it, though they match the pattern. */
const NEVER_ENV = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH']);

/** The SDK's own version (its package.json): the launcher refuses a claude binary of another version. */
export function sdkVersion(root = process.cwd()): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

/** The header line the launcher reads before it starts claude: the CLI's arguments and the environment it may have. */
export function opsHeader(o: Pick<SpawnOptions, 'args' | 'env'>, version: string): string {
  // The CLI's own arguments: with a JS runtime the SDK puts the script path first; the launcher runs its own binary.
  const args = [...o.args];
  while (args.length && !args[0].startsWith('-')) args.shift();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env ?? {})) if (typeof v === 'string' && PASS_ENV.test(k) && !NEVER_ENV.has(k)) env[k] = v;
  return `${JSON.stringify({ v: 1, sdkVersion: version, args, env })}\n`;
}

/**
 * Each socket's newest process, settled once its connection is closed at both ends (its Claude Code has exited, or the
 * connection never got going). fff-ops.socket takes one connection at a time (MaxConnections=1) and drops any other the
 * moment it arrives (systemd: "Too many incoming connections (1), dropping connection."), so a new process waits here
 * for the last one first (w638: a fresh job started the new process while the old one was still exiting, and systemd
 * dropped it).
 */
const opsSlots = new Map<string, Promise<void>>();

/** How long a new process waits for the socket's one connection to be free, and how often it tries again meanwhile. */
export const OPS_SLOT = { waitMs: 60_000, retryMs: 250 };

/** The control request Claude Code's own SDK sends to end a turn (Query.interrupt): a stop sends it before the input ends. */
const INTERRUPT = (id: string) => `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })}\n`;

/**
 * Options.spawnClaudeCodeProcess for the worker: connect to fff-ops.socket (only the portal's account may), send the
 * header, wait for the launcher's "OK" (or its "ERR <why>", which becomes the error the transcript shows), then the
 * socket is claude's stdin and stdout.
 *
 * One process at a time (w638). A new one first waits for the last one's connection to close: a stop (kill, the SDK's
 * abort, the idle stop, a fresh job) interrupts the turn and ends claude's input, and the far side closes when claude
 * has exited. systemd frees the connection a moment after that (it stops the unit first), so a connection dropped
 * without a word is tried again every OPS_SLOT.retryMs until OPS_SLOT.waitMs has passed. The SDK hears of a stop at
 * once; the wait is the next process's.
 */
export function opsSpawner(socketPath = OPS_PATHS.socket, version = sdkVersion(), connect: (p: string) => net.Socket = (p) => net.createConnection({ path: p, allowHalfOpen: true }), slot = OPS_SLOT) {
  return (o: SpawnOptions): SpawnedProcess => {
    const ev = new EventEmitter();
    // The SDK writes at once; what it writes waits here until the launcher's OK, then flows to the socket.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const header = opsHeader(o, version);
    let sock: net.Socket | undefined;
    let killed = false;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    let done = false;
    let acked = false;
    const before = opsSlots.get(socketPath) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    opsSlots.set(socketPath, mine);
    void mine.then(() => opsSlots.get(socketPath) === mine && opsSlots.delete(socketPath));
    const deadline = Date.now() + slot.waitMs;
    const finish = (code: number | null, signal: NodeJS.Signals | null, err?: Error) => {
      if (done) return;
      done = true;
      exitCode = err ? 1 : code;
      signalCode = signal;
      stdout.end();
      if (!err) return void ev.emit('exit', code, signal);
      ev.emit('error', err);
      // No code with it: the SDK's exit handler would replace the reason with "Claude Code process exited with code 1"
      // (a custom spawner has no stderr tail to add), and the transcript would say nothing more (w638).
      ev.emit('exit', null, null);
    };
    const attempt = () => {
      if (killed) return release();
      const s = connect(socketPath);
      sock = s;
      s.write(header);
      let head = Buffer.alloc(0);
      let heard = false;
      let failed: Error | undefined;
      s.on('data', (chunk: Buffer) => {
        heard = true;
        // After a stop, its last words (the interrupt's answer, the turn's end) are nobody's.
        if (killed || done) return;
        if (acked) return void stdout.write(chunk);
        head = Buffer.concat([head, chunk]);
        const nl = head.indexOf(10);
        if (nl < 0) {
          if (head.length > 4096) {
            s.destroy();
            finish(1, null, new Error('the orchestration worker\'s launcher answered something other than OK'));
          }
          return;
        }
        const line = head.subarray(0, nl).toString('utf8').trim();
        const rest = head.subarray(nl + 1);
        head = Buffer.alloc(0);
        if (line !== 'OK') {
          s.destroy();
          return finish(1, null, new Error(`the orchestration worker could not start: ${line.replace(/^ERR\s*/, '') || 'no answer'}`));
        }
        acked = true;
        if (rest.length) stdout.write(rest);
        stdin.pipe(s, { end: false });
        stdin.on('end', () => hangUp(s));
      });
      s.on('error', (e: NodeJS.ErrnoException) => {
        // systemd closes a connection it drops with our header unread, which Linux turns into a reset (CI, w638).
        if (!heard && (e.code === 'ECONNRESET' || e.code === 'EPIPE')) return;
        failed = new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? `no ${socketPath}: the orchestration worker runs only in the portal VM, after "fffctl update" installed it (docs/ops-worker.md)` : e.code === 'EACCES' ? `${socketPath}: only the portal's account may connect` : e.message);
      });
      // The far side ended (claude exited, or the launcher refused): close ours too.
      s.on('end', () => s.destroy());
      s.on('close', () => {
        if (failed) finish(1, null, failed);
        else if (!heard && !killed && !done) {
          // Dropped without a word: systemd still holds the one connection for the last process, which is ending.
          if (Date.now() + slot.retryMs < deadline) return void setTimeout(attempt, slot.retryMs);
          finish(1, null, new Error(`the orchestration worker's socket still had its one process after ${Math.round(slot.waitMs / 1000)} s: the last one has not ended (ops_worker status; fffctl logs, journalctl -t fff-ops), or fff-ops@.service fails to start`));
        } else finish(killed ? null : 0, killed ? 'SIGTERM' : null);
        release();
      });
    };
    // Its turn on the socket: after the last process's connection has closed (or the wait is up: then the drops say why).
    let waited: NodeJS.Timeout | undefined;
    void Promise.race([before, new Promise<void>((r) => (waited = setTimeout(r, slot.waitMs)))]).then(() => {
      clearTimeout(waited);
      attempt();
    });
    // Its input ends (the SDK ends it only when the query closes: a stop) or it is killed: Claude Code is told to end its
    // turn, then its input ends, so it exits. The socket stays open until it has (the next process waits for that), at
    // most OPS_SLOT.waitMs.
    const hangUp = (s: net.Socket) => {
      if (s.writableEnded || s.destroyed) return;
      stdin.unpipe(s);
      s.end(INTERRUPT(`ops-stop-${Date.now()}`));
      const t = setTimeout(() => s.destroy(), slot.waitMs);
      t.unref?.();
      s.once('close', () => clearTimeout(t));
    };
    // A stop: the SDK hears the exit now; the wait is the next process's.
    const stop = (signal: NodeJS.Signals) => {
      if (killed) return;
      killed = true;
      finish(null, signal);
      if (sock) acked ? hangUp(sock) : sock.destroy();
    };
    o.signal?.addEventListener('abort', () => stop('SIGTERM'));
    return {
      stdin,
      stdout,
      get killed() {
        return killed;
      },
      get exitCode() {
        return exitCode;
      },
      get signalCode() {
        return signalCode;
      },
      kill(signal: NodeJS.Signals) {
        stop(signal);
        return true;
      },
      on: (e: string, l: (...a: unknown[]) => void) => void ev.on(e, l),
      once: (e: string, l: (...a: unknown[]) => void) => void ev.once(e, l),
      off: (e: string, l: (...a: unknown[]) => void) => void ev.off(e, l),
    } as unknown as SpawnedProcess;
  };
}

// ---------------------------------------------------------------- the brief

export function opsBrief(ownerName: string | undefined): string {
  return `
## You are FF Factory's orchestration worker (w597, docs/ops-worker.md)
You run inside the FF Factory portal's VM (fff, on Loth2400) as the Linux account fff-ops, with a real shell. You take jobs only from Lothsahn's and Ben's own orchestrators; each message says whose it is. ${ownerName ? `The portal's owner is ${ownerName}.` : ''} Your job is orchestration: reaching the machines (beast, lothdesktop, m3, m5, biscuit and new ones) over ssh and copying files to and from them with scp, reading the portal's state, pinning a new machine's host key, and issuing machine credentials. Anything heavy runs on the target machine over ssh, never here.

What you have:
- \`ssh <machine> '<command>'\`: as the portal's account with its key. Machines by their aliases (m3, m5, beast, Loth2800: deploy/vm/guest/machines.ssh) or the user@host list_machines shows for a machine its installer registered. Only pinned host keys connect. Send the remote command in single quotes; pipe a script with \`ssh m5 'bash -s' < script.sh\` (Windows: \`ssh beast 'powershell -NoProfile -Command -' < script.ps1\`). The worker installer is run there (docs/worker-install.md). To update a machine's install, run its update there and nothing else (docs/worker-install.md, "Updating"; it asks nothing, keeps every setting, the machine's own credential and the PATH, restarts the daemon and says what the portal sees): on a Mac \`ssh m5 'bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)" -- --update --root <root>'\`, on Windows \`ssh beast 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1))) -Update -Root <root>"'\`. An update needs no new credential: never issue one for it.
- \`scp\` and \`sftp\` (w612): files between your scratch folder and a machine, both ways, over the same ssh (the portal's key, pinned host keys, port 22): \`scp ./check.sh m5:/tmp/\`, \`scp m5:/tmp/install.log ./\`, \`sftp -b cmds m5\` (a batch file: there is no terminal). They run as you, so they copy only what you may read and write: never the portal's files. No ssh options (-o, -i, -F, -J, -S): the machine is all they take.
- \`fffctl update\`: the portal deploy, only after a [deploy] message (Lothsahn or Ben asked for it in their own words: the portal leaves a grant good once for 15 minutes; without it the command is refused). Follow that message's steps.
- \`fffctl status\`, \`fffctl state\`, \`fffctl units\` and \`fffctl units --check\` (the critical units, active and enabled; --check prints "down: ..." and exits 1 if one is not; read only, and the watchdog and restarts are a person's), \`fffctl vault list [--names]\` and \`fffctl vault help\` (the vault's entries by name, kind, grants, last four characters and fingerprint, and the Claude pools' meters: never a value; adding, rotating, granting, removing and the key are a person's), \`fffctl machine-credential list\`, \`fffctl migrate --help\`, \`fffctl logs [N]\` (the portal's journal), \`fffctl credential list\`, and \`fffctl credential issue <machine id> --to <ssh target>\`: a new machine credential goes from this VM straight into a file on that machine (it prints the remote path and the last four characters, never the credential); then run the installer there with \`--credential-file\` / \`-CredentialFile\` and delete the file after. Issuing replaces the machine's credential: its running daemon is dropped within 20 s, so issue only for a machine being (re)installed. It needs the machine's record (list_machines), which only a person adds.
- \`fff-machine-ssh --check\` (or \`fffctl machine-ssh-check\`): each machine's ssh alias, pinned host key, the key it shows over the tailnet and whether ssh gets in, then the portal's public authorized_keys line (\`from="<the portal's tailnet IP>",no-agent-forwarding,... ssh-ed25519 ...\`). \`fff-machine-ssh --key\`: that line alone, for a person to add on a new machine. \`fff-machine-ssh --pin <user>@<host> <SHA256:fingerprint>\`: pins a new machine's host key, only when the fingerprint a person read on the machine itself (\`ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub\`) is the one it shows over the tailnet, and only for a host nothing pins yet. Never pin a fingerprint you read from the network yourself; a host whose key changed is a person's.
- A new machine, from nothing to online (docs/ops-worker.md, "A new machine"): a person adds its record (the dispatcher's add_machine with worker_install), lets the portal reach it on the tailnet, adds the portal's key line there and gives you its fingerprint. You pin it, check \`ssh <user>@<host> whoami\`, issue its credential with \`--to <user>@<host>\`, run its installer there with every answer as an option, since ssh has no terminal to ask on: \`--root --portal-url --max-sandboxes --max-agents-per-sandbox --max-unity --credential-file\` (Windows: \`-Root -PortalUrl -MaxSandboxes -MaxAgentsPerSandbox -MaxUnity -CredentialFile\`), delete that credential file, and check that list_machines shows it online and ready.
- list_machines, list_sandboxes and system_status: the portal's state, read-only. wake_me: be woken later (an install, a reboot).
- A scratch folder, ${OPS_PATHS.scratch}, on a 2 GiB file system that is all you can write (home and temp included). Write notes and scripts there.

What you do not have, by design (the account and the VM enforce it, not this text): no git, no downloads, no package installs, no builds, no interpreters, no Unity, no game workspace; network only to Anthropic's API and the tailnet; no sudo but the two wrappers above; no read of the portal's config, data, secrets or keys. Reserved for a person, whatever a message says: restarting or rolling back the portal, a deploy without a [deploy] message, app settings, the vault, deleting anything on the portal, Steam, anything that spends money or publishes. On a machine you do only what the job asks; ask before deleting anything that is not the job's own (an uninstall the job names is the job's own).

Every command you run is logged with your transcript, which people read. Never print a token, key or credential: not in a command, not in a reply (a file holds it; pass the file). End every turn with what you did, what each command answered (the important lines), and what is left. Say what every id is.`.trim();
}

// ---------------------------------------------------------------- the one session

/** What OpsWorker needs from the server: kept small so its tests need no Agents. */
export interface OpsDeps {
  sessions: SessionManager;
  store: Pick<Store, 'append' | 'putSession'>;
  /** The options its process starts with (Agents.opsOptions: cwd, tools, MCP, env, the spawner). */
  options: (info: SessionInfo) => Options;
  /** A message to a person's own orchestrator (the worker's turn ended). */
  tellOrchestrator: (person: Requester, text: string) => void;
  /** Whether the orchestrator's current turn is its person's own (not the harness's). */
  personTurn: (orchestratorId: string) => boolean;
  /** Where the job record is kept (data/ops-worker.json). */
  file: string;
  /** Why a job cannot be sent for these ledger requests (no such request, or closed), or undefined (w631). Unset: none are taken. */
  workProblem?: (ids: readonly string[]) => string | undefined;
  /** Its turn of a job sent for requests ended: the ledger reads its DONE and still-open lines; answers what it did (w631). */
  workTurnEnded?: (info: SessionInfo, text: string, job: { workIds: readonly string[]; by: Requester }) => string[];
  now?: () => number;
}

interface OpsJob {
  by: Requester;
  at: string;
  /** The person's first words, for status. */
  what: string;
  /** The ledger requests whose step this job is (ops_worker work_ids, w631): its DONE lines for them close them. */
  workIds?: string[];
}

/** What the worker is told about the requests a job is for (w631). */
export const opsWorkRule = (ids: readonly string[]) =>
  `\n\n[ledger] This job is the step left on ${ids.join(', ')}. When it is done and verified, end your report with a line \`DONE: <id>\` for each of them it finishes (one line each), and say in the report how you verified it. For one with something still left, end with a line \`<id>: still open: <what>\` instead.`;

/** A deploy a person asked for (ops_worker deploy): reported after the portal's next start. */
interface OpsDeploy {
  by: Requester;
  at: string;
}

/**
 * The single orchestration worker: its session (made once, id OPS_ID), who may message it, its job, its lifetime.
 * Every send to it goes through here (SessionManager.send refuses kind 'ops' without opsPass).
 */
export class OpsWorker {
  private readonly d: OpsDeps;
  private readonly now: () => number;
  private job?: OpsJob;
  private deploying?: OpsDeploy;
  private timer?: NodeJS.Timeout;

  constructor(d: OpsDeps) {
    this.d = d;
    this.now = d.now ?? (() => Date.now());
    try {
      const saved = JSON.parse(fs.readFileSync(d.file, 'utf8'));
      this.job = saved.job;
      this.deploying = saved.deploy;
    } catch {
      this.job = undefined;
    }
    d.sessions.events.on('turnEnd', (s: SessionHandle, text: string) => this.turnEnded(s, text));
  }

  /** Its session, made the first time it is needed; restored like an orchestrator's after a restart. */
  handle(): SessionHandle {
    const have = this.d.sessions.sessions.get(OPS_ID);
    if (have) return have;
    return this.d.sessions.create({ id: OPS_ID, kind: 'ops', title: OPS_TITLE, model: OPS_LIMITS.model, effort: OPS_LIMITS.effort, permissionMode: 'bypassPermissions', options: this.d.options });
  }

  /**
   * At the portal's start: check the lifetime limits every minute, and when a deploy was asked for within the last hour,
   * tell the worker the portal is back so it reports (its process ended with the old portal; its conversation did not).
   */
  start(delayMs = 10_000) {
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref?.();
    const dep = this.deploying;
    if (!dep) return;
    this.deploying = undefined;
    this.save();
    if (this.now() - Date.parse(dep.at) > OPS_LIMITS.deployReportMs) return;
    const t = setTimeout(() => {
      try {
        this.d.sessions.send(
          OPS_ID,
          `[deploy] The portal has started again (${new Date(this.now()).toISOString()}), after the deploy ${dep.by.displayName} asked for at ${dep.at}: most likely the update's own restart. Run \`fffctl status\` and report to ${dep.by.displayName}: the commit before (what fffctl update printed), the commit running now, whether the update was verified or rolled back (\`fffctl logs 200\` says), and the status lines.${this.job?.workIds?.length ? opsWorkRule(this.job.workIds) : ''}`,
          'system',
          undefined,
          { requestedBy: dep.by, ops: 'resume' },
        );
      } catch (e) {
        console.warn('ops-worker: could not tell the worker the portal is back:', (e as Error).message);
      }
    }, delayMs);
    t.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  private save() {
    try {
      fs.writeFileSync(this.d.file, JSON.stringify({ job: this.job, deploy: this.deploying }, null, 1), { mode: 0o600 });
    } catch (e) {
      console.warn('ops-worker: could not save its job:', (e as Error).message);
    }
  }

  /** The ledger requests a job is sent for (work_ids, w631): lower case, no repeats, and refused when the ledger has a problem with them. */
  private workIdsOf(ids: readonly string[]): string[] {
    const out = [...new Set(ids.map((x) => x.trim().toLowerCase()).filter(Boolean))];
    if (!out.length) return [];
    const bad = out.find((x) => !/^w\d+$/.test(x));
    if (bad) throw new Error(`work_ids: request ids like "w605", not "${bad}"`);
    const problem = this.d.workProblem ? this.d.workProblem(out) : 'this portal does not link ops jobs to requests';
    if (problem) throw new Error(`work_ids: ${problem}`);
    return out;
  }

  /**
   * A message from an orchestrator. `caller` is the orchestrator's session. Lothsahn's or Ben's own only. A job (a
   * `fresh` start, or the first message after the last job ended) needs a turn its person started themselves; within a
   * job their orchestrator's harness turns (a check-in, a timer) may follow up for OPS_LIMITS.jobMs. Follow-ups are not
   * counted (w627, lothsahn: "an infinite number of messages to each other and the portal worker").
   */
  send(caller: SessionInfo | undefined, text: string, fresh = false, workIds: readonly string[] = []): string {
    const person = opsAllowedOrchestrator(caller);
    if (!person || !caller) throw new Error(OPS_REFUSED);
    const body = text.trim();
    if (!body) throw new Error('text: what the orchestration worker should do');
    const ids = this.workIdsOf(workIds);
    const personTurn = this.d.personTurn(caller.id);
    const jobOpen = !!this.job && this.job.by.userId.toLowerCase() === person.userId.toLowerCase() && this.now() - Date.parse(this.job.at) < OPS_LIMITS.jobMs;
    const h = this.handle();
    const opening = fresh || !jobOpen;
    if (opening && !personTurn) throw new Error(`a new job for the orchestration worker needs a turn ${person.displayName} started with a message of their own (this turn is the harness's: a check-in, a timer or a relayed report)`);
    if (this.job && this.job.by.userId.toLowerCase() !== person.userId.toLowerCase() && isMidTurn(h.info)) {
      throw new Error(`the orchestration worker is busy with ${this.job.by.displayName}'s job (${this.job.what}); wait for its turn to end, or ask them`);
    }
    // Every new job starts a fresh conversation and a fresh process (w738): nothing, no context and no token, carries over from
    // one job to the next, and a job from the other person's orchestrator runs on that person's own pool token. A follow-up
    // within the job keeps both.
    // (A turn still running for the same person, on a job that only expired, is not cut off: it is the same person's token.)
    if (fresh || (opening && !isMidTurn(h.info))) {
      if (h.live) h.stop(true);
      delete h.info.sdkSessionId;
      this.d.store.putSession(h.info);
      this.d.store.append(OPS_ID, { kind: 'system', text: `A new job from ${person.displayName}'s orchestrator: a fresh conversation.` });
    }
    if (opening) {
      this.job = { by: person, at: new Date(this.now()).toISOString(), what: body.replace(/\s+/g, ' ').slice(0, 120), ...(ids.length ? { workIds: ids } : {}) };
      this.save();
      h.info.requestedBy = person;
      this.d.store.putSession(h.info);
    } else if (ids.length && this.job) {
      // A follow-up within the job adds requests to it.
      this.job.workIds = [...new Set([...(this.job.workIds ?? []), ...ids])];
      this.save();
    }
    console.log(`ops-worker: message from ${person.userId}'s orchestrator${opening ? ' (a new job)' : ''}${ids.length ? ` for ${ids.join(', ')}` : ''}: ${redactSecrets(body).replace(/\s+/g, ' ').slice(0, 300)}`);
    this.d.sessions.send(OPS_ID, `${body}${ids.length ? opsWorkRule(ids) : ''}`, 'orchestrator', undefined, { requestedBy: person, ops: 'orchestrator' });
    return `Sent to the orchestration worker (${OPS_ID})${opening ? ` as a new job of ${person.displayName}'s` : ''}. Its turn's end comes back to you as an [ops worker] message; its transcript is on the dashboard (Orchestration worker) and in agent_transcript ${OPS_ID}.`;
  }

  /**
   * A portal deploy (lothsahn, 2026-10-07: "Yes, please modify the ops worker to update yourself."): only Lothsahn's or
   * Ben's own orchestrator, and only in a turn its person started with a message of their own, never a check-in, a
   * timer, a relayed report or a job's follow-up. Leaves a grant in the data folder, good once for
   * OPS_LIMITS.deployGrantMs, which fff-ops-priv checks and removes before it runs `fffctl update`: without it the worker
   * cannot deploy, whatever it is told. Then tells the worker to do it and report.
   */
  deploy(caller: SessionInfo | undefined, note = '', workIds: readonly string[] = []): string {
    const person = opsAllowedOrchestrator(caller);
    if (!person || !caller) throw new Error(OPS_REFUSED);
    if (!this.d.personTurn(caller.id)) throw new Error(`a portal deploy needs ${person.displayName}'s own words in this turn (this turn is the harness's: a check-in, a timer or a relayed report); ask them`);
    const ids = this.workIdsOf(workIds);
    const at = new Date(this.now());
    const previous = this.job;
    const h = this.handle();
    if (previous && previous.by.userId.toLowerCase() !== person.userId.toLowerCase() && isMidTurn(h.info)) {
      throw new Error(`the orchestration worker is busy with ${previous.by.displayName}'s job (${previous.what}); wait for its turn to end, or ask them`);
    }
    const grant = { by: person.userId, name: person.displayName, at: at.toISOString(), expires: new Date(at.getTime() + OPS_LIMITS.deployGrantMs).toISOString() };
    fs.writeFileSync(path.join(path.dirname(this.d.file), OPS_GRANT), `${JSON.stringify(grant)}\n`, { mode: 0o600 });
    this.deploying = { by: person, at: at.toISOString() };
    this.job = { by: person, at: at.toISOString(), what: 'deploy the portal (fffctl update)', ...(ids.length ? { workIds: ids } : {}) };
    this.save();
    // A deploy is a new job too: a fresh conversation and process, on this person's token (the restart that follows resumes it).
    if (!isMidTurn(h.info)) {
      if (h.live) h.stop(true);
      delete h.info.sdkSessionId;
    }
    this.d.store.append(OPS_ID, { kind: 'system', text: `A new job (a deploy) from ${person.displayName}'s orchestrator: a fresh conversation.` });
    h.info.requestedBy = person;
    this.d.store.putSession(h.info);
    console.log(`ops-worker: ${person.userId} asked for a portal deploy in a turn of their own; grant until ${grant.expires}`);
    const text = `[deploy] ${person.displayName} asked, in a turn of their own, for a portal deploy (fffctl update).${note.trim() ? ` Their words: ${note.trim()}` : ''}
1. Run \`fffctl status\` and note the release and its commit.
2. Run \`fffctl update\`, once. It is allowed until ${grant.expires} and only once, and it only asks for the update: the portal builds origin/main beside the running release, drains, restarts on the new one, verifies it and rolls back by itself if it does not answer. It prints the commit it starts from.
3. End your turn with what it printed. Your process ends with the old portal; when the new one starts, FF Factory messages you to report. If no message comes within 20 minutes (already up to date, or the build failed), wake_me 20 before you end the turn covers it: then report from \`fffctl status\` and \`fffctl logs 200\`.
Report to ${person.displayName}: the commit before, the commit after, whether it was verified or rolled back, and \`fffctl status\`.${ids.length ? `${opsWorkRule(ids)} Only in the report after the restart, once the new portal is verified: never in the turn that starts the update.` : ''}`;
    this.d.sessions.send(OPS_ID, text, 'orchestrator', undefined, { requestedBy: person, ops: 'orchestrator' });
    return `Asked the orchestration worker (${OPS_ID}) to deploy the portal: it may run fffctl update once until ${grant.expires}. The portal will drain and restart; its report (commit before and after, fffctl status) comes back to you as an [ops worker] message after the restart.`;
  }

  /** Stop or interrupt it: Lothsahn's or Ben's own orchestrator, any turn (a stop is always safe). */
  async control(caller: SessionInfo | undefined, action: 'stop' | 'interrupt'): Promise<string> {
    const person = opsAllowedOrchestrator(caller);
    if (!person) throw new Error(OPS_REFUSED);
    const h = this.d.sessions.sessions.get(OPS_ID);
    if (!h || !h.live) return 'The orchestration worker has no process running.';
    if (action === 'interrupt') {
      await h.interrupt();
      return 'Interrupted its turn; its process and conversation stay.';
    }
    h.stop(true);
    console.log(`ops-worker: stopped by ${person.userId}'s orchestrator`);
    return 'Stopped its process; its conversation stays, and the next message resumes it.';
  }

  /** One paragraph: its state, its job, its limits. */
  status(): string {
    const h = this.d.sessions.sessions.get(OPS_ID);
    const i = h?.info;
    const state = !i ? 'never started' : `${i.status}${h?.live ? '' : ' (no process)'}, last active ${i.lastActivityAt}, ${i.turns} turn(s), $${i.costUsd.toFixed(2)} so far`;
    const job = this.job ? `job of ${this.job.by.displayName} since ${this.job.at}: ${this.job.what}` : 'no job yet';
    return `Orchestration worker ${OPS_ID} (portal VM, account fff-ops; not game capacity): ${state}; ${job}. Model ${OPS_LIMITS.model}, effort ${OPS_LIMITS.effort}, $${OPS_LIMITS.budgetUsd} a process, stopped after ${OPS_LIMITS.idleStopMs / 60_000} min idle, a turn interrupted after ${OPS_LIMITS.turnMaxMs / 3_600_000} h. Only Lothsahn's and Ben's own orchestrators message it (ops_worker).`;
  }

  /** Its line for list_sandboxes and list_machines: a group of its own, never counted as game capacity. */
  groupLines(): string[] {
    return ['', '## Orchestration worker (the portal VM; not game capacity, not counted in any limit)', `- ${this.status()}`];
  }

  /** Its turn ended: the person whose orchestrator sent the last message hears it, as a worker's would. */
  private turnEnded(s: SessionHandle, text: string) {
    if (s.info.kind !== 'ops') return;
    const who = s.info.lastRequestedBy ?? this.job?.by;
    if (!who) return;
    // A job sent for ledger requests (w631): its DONE and still-open lines for them, and what the ledger did with them.
    let ledger: string[] = [];
    if (this.job?.workIds?.length && this.d.workTurnEnded) {
      try {
        ledger = this.d.workTurnEnded(s.info, text, { workIds: this.job.workIds, by: this.job.by });
      } catch (e) {
        console.warn('ops-worker: the ledger could not read its report:', (e as Error).message);
      }
    }
    try {
      this.d.tellOrchestrator(who, `[ops worker] finished a turn${this.job ? ` (job: ${this.job.what})` : ''}:\n${redactSecrets(text || s.info.lastResult || '(no text)').slice(0, 4000)}${ledger.length ? `\n\n[ledger] ${ledger.join('; ')}` : ''}`);
    } catch (e) {
      console.warn('ops-worker: could not tell the orchestrator:', (e as Error).message);
    }
  }

  /** Its lifetime: an idle process goes after OPS_LIMITS.idleStopMs, a turn is cut after OPS_LIMITS.turnMaxMs. */
  tick(now = this.now()) {
    const h = this.d.sessions.sessions.get(OPS_ID);
    if (!h || !h.live) return;
    const i = h.info;
    const since = now - Date.parse(i.turnOpenSince ?? i.lastActivityAt);
    if (isMidTurn(i)) {
      if (i.turnOpenSince && since > OPS_LIMITS.turnMaxMs) {
        this.d.store.append(OPS_ID, { kind: 'system', text: `Interrupted by FF Factory: the turn ran past ${OPS_LIMITS.turnMaxMs / 3_600_000} h (the orchestration worker's limit).` });
        void h.interrupt();
      }
      return;
    }
    if (now - Date.parse(i.lastActivityAt) > OPS_LIMITS.idleStopMs) {
      this.d.store.append(OPS_ID, { kind: 'system', text: `Stopped by FF Factory while idle for ${OPS_LIMITS.idleStopMs / 60_000} min: its conversation is kept, and the next message resumes it.` });
      h.stop(true);
    }
  }
}
