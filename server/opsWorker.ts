import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { HookCallback, Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, Requester, SessionInfo } from '../shared/types.ts';
import type { GateNeed } from '../shared/reactionGrant.ts';
import { isMidTurn, type SessionHandle, type SessionManager } from './sessions.ts';
import type { Store } from './store.ts';
import { readProblem, realReadFs, type ReadCtx, type SecretRules } from './secretGuard.ts';
import { scanShell } from './standingGuard.ts';
import { redactSecrets } from './secrets.ts';
import type { TimerAuthority } from './timers.ts';
import type { LinkUpdateFlags, LinkUpdateReport } from './machineProtocol.ts';
import { installerSummary } from './machineRollout.ts';

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
  /** A restart grant (ops_worker restart, w974) is good for this long, once: fff-ops-priv refuses `fffctl restart` without one. */
  restartGrantMs: 15 * 60_000,
  /** After a deploy or a restart, the next portal start within this long tells the worker to report. */
  deployReportMs: 60 * 60_000,
  /** A verified portal deploy is attributed to a deploy asked for this long before it (build + drain + verify window). */
  deployAskedMs: 3 * 60 * 60_000,
};

/** Where the portal leaves a deploy grant for fff-ops-priv (root reads it; fff-ops cannot reach the data folder). */
export const OPS_GRANT = 'ops-deploy.grant';

/** Where the portal leaves a restart grant (ops_worker restart, w974): its own file, so neither grant opens the other command. */
export const OPS_RESTART_GRANT = 'ops-restart.grant';

/** Why a caller may not use it (a refusal names who may). */
export const OPS_REFUSED = `the orchestration worker takes messages only from Lothsahn's and Ben's own orchestrators (w597); not from the dispatcher, other people, standing agents, the intake, FFBox or /mcp`;

/** Whether this orchestrator session is Lothsahn's or Ben's own. */
export function opsAllowedOrchestrator(info: Pick<SessionInfo, 'kind' | 'orchestratorRole' | 'requestedBy'> | undefined): Requester | undefined {
  if (!info || info.kind !== 'orchestrator' || info.orchestratorRole !== 'personal' || !info.requestedBy) return undefined;
  return OPS_PEOPLE.includes(info.requestedBy.userId.toLowerCase()) ? info.requestedBy : undefined;
}

// ---------------------------------------------------------------- the guard

/**
 * Where git and GitHub jobs run (w1869: w1788's branch deletes failed on "no git here" until lothsahn's orchestrator said to
 * use m3's gh login): over ssh on a machine whose gh is signed in, checked first. A non-interactive ssh shell on a Mac has
 * no Homebrew on its PATH, hence the export (the command that worked, 2026-10-23 15:16Z, the portal's journal).
 */
export const OPS_GITHUB_ROUTE = `run git and gh on a machine whose gh is signed in, over ssh (m3 first, else beast): \`ssh m3 'export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; gh auth status 2>&1 | grep -v Token; gh api -X DELETE repos/OWNER/REPO/git/refs/heads/BRANCH'\` (docs/ops-worker.md, "Git and GitHub jobs")`;

/** Commands that fetch, install, build or change things locally, which the worker runs on the target machine instead. */
const DENIED: Record<string, string> = Object.fromEntries([
  // w1869: the refusal names the route, so a GitHub job works without a person's hint.
  ...['git', 'gh', 'git-lfs'].map((c) => [c, `no git here: ${OPS_GITHUB_ROUTE}`]),
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
 * `grant` marks the forms fff-ops-priv allows although they change state, on a stated condition (w597, w676); `ops` names
 * those forms when only some of a command's changing forms are the worker's (w1415: apikey issue and revoke).
 */
export const FFFCTL_FORMS: Record<string, { allowed: string[]; changes: string[]; grant?: string; ops?: string[] }> = {
  status: { allowed: [''], changes: [] },
  state: { allowed: [''], changes: [] },
  // config.json to read, and the check that it holds no secret (w1078).
  config: { allowed: ['', '--check'], changes: [] },
  // fff.conf's settings (w1537): get redacts what is a person's; set changes one, never a credential, key or secret (fffctl conf).
  conf: {
    allowed: ['', 'get'],
    changes: ['set'],
    ops: ['set'],
    grant: "when a person asks; never a credential, key or secret, the deploy's code, the VM's layout or the worker's own fences (fffctl's CONF_REFUSED)",
  },
  // The permission prompts people answered, as counts only (w1097): scripts/cleanup-approvals.ts as the portal's account.
  approvals: { allowed: ['', '--since', '--split'], changes: [] },
  // Where the VM's disk went (w2267): sizes, counts, dates and paths only, and auth.log's and syslog's lines counted by program.
  'disk-usage': { allowed: [''], changes: [] },
  help: { allowed: [''], changes: [] },
  units: { allowed: ['', '--check'], changes: [] },
  logs: { allowed: ['', 'N'], changes: ['-f'] },
  vault: { allowed: ['list', 'list --names', 'help'], changes: ['init', 'export-key', 'add', 'add-claude', 'put', 'rotate', 'grant', 'remove', 'rename', 'export', 'new-key'] },
  'machine-credential': { allowed: ['list'], changes: ['issue', 'revoke'] },
  // API keys for member logins (w1415): issue writes the key straight into a file on a machine (fff-ops-priv), revoke ends one.
  apikey: {
    allowed: ['list'],
    changes: ['issue', 'revoke'],
    ops: ['issue', 'revoke'],
    grant: "member logins only: never an owner's, never ben's or lothsahn's, never the owner's or a scoped key (server/memberKeys.ts)",
  },
  // Logins (w1864): list shows ids, roles and names; delete removes a member login and everything of its own, in the portal.
  user: {
    allowed: ['list'],
    changes: ['delete'],
    ops: ['delete'],
    grant: "member logins only, for the person whose job it is (--by ben or lothsahn): never an owner's, never ben's or lothsahn's (server/loginDelete.ts)",
  },
  // Secrets already on disk (w1584): the dry run counts them, paths and counts only; the scrub rewrites files (a person's).
  'scrub-secrets': { allowed: ['--dry-run'], changes: [''] },
  migrate: { allowed: ['--help'], changes: ['--key', '--dry-run-copy', '--rollback-dry-run', '--cut-over'] },
  watchdog: { allowed: [], changes: ['run', 'pause', 'resume', 'reset'] },
  update: { allowed: [], changes: [''], grant: "only with the deploy grant of a person's own turn (ops_worker deploy)" },
  restart: { allowed: [], changes: [''], grant: "only with the restart grant of a person's own turn (ops_worker restart)" },
  rollback: { allowed: [], changes: [''] },
  'prepare-shutdown': { allowed: [], changes: [''] },
  start: { allowed: [], changes: [''] },
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

/**
 * `fffctl conf set` (w1537): a key whose name says it holds a secret, or a value that looks like one, is refused here, before
 * sudo, so it reaches neither sudo's log nor fff-ops-priv's. The same words as CONF_SECRET_NAME in fffctl (a test compares
 * them); fffctl refuses the rest of what is a person's (CONF_REFUSED) as root.
 */
export const FFFCTL_CONF_SECRET_NAME = /TOKEN|KEY|SECRET|PASS|CREDENTIAL|AUTH|PEM|CERT|PRIVATE|RECIPIENT|COOKIE|SALT/;

/** Why `fffctl conf set KEY VALUE` is refused before it runs, or undefined. */
function confSetProblem(key: string | undefined, value: string | undefined): string | undefined {
  if (key !== undefined && FFFCTL_CONF_SECRET_NAME.test(key)) return `fffctl conf set ${key}: its name says it holds a credential, key or secret, which is a person's`;
  if (value !== undefined && (redactSecrets(value) !== value || /[A-Za-z0-9_+/=-]{32,}/.test(value))) return `fffctl conf set ${key ?? ''}: that value looks like a token or key: never type one (a person sets it)`;
  return undefined;
}

/** The commands whose first word after them is a form: the guard checks that word (fff-ops-priv checks every word). */
const FFFCTL_FORM_WORD = ['vault', 'machine-credential', 'migrate', 'apikey', 'scrub-secrets', 'user'];

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
    if (name === 'fffctl' && words[i + 1] !== undefined && !OPS_FFFCTL.includes(words[i + 1])) return `fffctl ${words[i + 1]} is a person's (rollbacks, settings, the vault, migrations): you have fffctl ${OPS_FFFCTL.join(', ')}`;
    if (name === 'fffctl' && words[i + 1] === 'conf' && words[i + 2] === 'set') {
      const why = confSetProblem(words[i + 3], words[i + 4]);
      if (why) return why;
    }
    if (name === 'fffctl' && FFFCTL_FORM_WORD.includes(words[i + 1] ?? '')) {
      const forms = FFFCTL_FORMS[words[i + 1]];
      const form = words[i + 2];
      const yours = [...forms.allowed, ...(forms.ops ?? [])];
      if (form === undefined || !yours.some((a) => a.split(' ')[0] === form)) return `fffctl ${words[i + 1]} ${form ?? ''}`.trim() + ` is a person's (it changes the vault, a credential or the migration): you have fffctl ${yours.map((a) => `${words[i + 1]} ${a}`).join(', ')}`;
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

/** A script of its scratch folder, as text (the poll check reads what a backgrounded script would run), or undefined. */
function scratchScript(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, 200_000);
  } catch {
    return undefined;
  }
}

/** What a shell poll looks like: a loop, a sleep (Start-Sleep, timeout /t), or watch. */
const POLL_WORDS = /(^|[^\w-])(while|until|for|sleep|watch)\b|Start-Sleep|\btimeout\s+\/t\b/i;

export const POLL_REFUSED =
  'a poll or a wait is a timer (set_timer: every N minutes, until, max_fires; it survives portal deploys, restarts and your idle stop), never a background shell loop or sleep: your process ends at a deploy, a restart and after 60 min idle, and the loop with it (w1106: w1070\'s idle poll died at the first deploy and nothing noticed). Run the check once now in the foreground, then set_timer to run it again';

/**
 * Why a shell command is a poll that would outlive the turn (w1106), or undefined: one sent to the background (the Bash
 * tool's run_in_background, a trailing &, nohup, setsid, disown) that loops or sleeps, itself or in a script of its
 * scratch folder that it runs. A backgrounded installer or a one-off command passes; so does a loop in the foreground.
 */
export function pollProblem(cmd: string, background: boolean, script: (abs: string) => string | undefined = scratchScript): string | undefined {
  const detached = background || /(^|[^&|>])&\s*($|[;)\n])/.test(cmd) || /(^|[\s;&|(])(nohup|setsid|disown)\b/.test(cmd);
  if (!detached) return undefined;
  if (POLL_WORDS.test(cmd)) return POLL_REFUSED;
  for (const word of cmd.split(/[\s;&|()'"]+/)) {
    if (!/\.(sh|bash|ps1)$/i.test(word)) continue;
    const abs = path.posix.resolve(OPS_PATHS.scratch, word);
    if (!inScratch(abs)) continue;
    const text = script(abs);
    if (text && POLL_WORDS.test(text)) return `${POLL_REFUSED} (${word} loops or sleeps)`;
  }
  return undefined;
}

/**
 * Its PreToolUse hook: every tool call is logged (redacted) to the portal's journal, which is the audit beside its
 * transcript; Write and Edit only in its scratch; reads never of FF Factory's own files; the shell through checkOpsShell,
 * and never a background poll (pollProblem, w1106).
 */
export function opsGuard(
  log: (line: string) => void = (l) => console.log(l),
  read: ReadCtx = { platform: 'linux', home: OPS_PATHS.home, cwd: OPS_PATHS.scratch, fsx: realReadFs },
  script: (abs: string) => string | undefined = scratchScript,
): HookCallback {
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
      const why = checkOpsShell(String(args.command ?? ''), read, rules) ?? pollProblem(String(args.command ?? ''), args.run_in_background === true, script);
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
You run inside the FF Factory portal's VM (fff, on Loth2400) as the Linux account fff-ops, with a real shell. You take jobs only from Lothsahn's and Ben's own orchestrators; each message says whose it is. ${ownerName ? `The portal's owner is ${ownerName}.` : ''} Your job is orchestration: reaching the machines (beast, lothdesktop, m3, m5, biscuit and new ones) over ssh and copying files to and from them with scp, reading the portal's state, pinning a new machine's host key, and issuing machine credentials and member logins' API keys. Anything heavy runs on the target machine over ssh, never here.

What you have:
- \`ssh <machine> '<command>'\`: as the portal's account with its key. Machines by their aliases (m3, m5, beast, Loth2800: deploy/vm/guest/machines.ssh) or the user@host list_machines shows for a machine its installer registered. Only pinned host keys connect. Send the remote command in single quotes; pipe a script with \`ssh m5 'bash -s' < script.sh\` (Windows: \`ssh beast 'powershell -NoProfile -Command -' < script.ps1\`). The worker installer is run there (docs/worker-install.md). To update a machine's install, run its update there and nothing else (docs/worker-install.md, "Updating"; it asks nothing, keeps every setting, the machine's own credential and the PATH, restarts the daemon and says what the portal sees): on a Mac \`ssh m5 'bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)" -- --update --root <root>'\`, on Windows \`ssh beast 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1))) -Update -Root <root>"'\`. An update needs no new credential: never issue one for it. An update never needs a drain or a wait (w605): it stops only the daemon, agents mid-turn run on in their own agent hosts and the new daemon adopts them, so run it at once. After a portal deploy you do not update the machines: FF Factory does that itself once the deploy has verified (w887).
- An installer rerun is yours, never a person's (w855, lothsahn: "don't ask ben to run installers"): the same update command with \`--max-sandboxes N\`, \`--max-agents-per-sandbox N\` or \`--max-unity N\` (Windows \`-MaxSandboxes\`, …) changes only what it names, and a sandbox count on a worker-root install changes in no other way. You run it when the job's message says an owner's open request asks for it (a \`[machine update for wNNN, approved by <name> …]\` message from ops_worker machine_update, or a job in which Lothsahn or Ben asked for the change themselves); the settings are the ones the message names, not more. A change nobody asked for, or one the message does not name, is not yours to make: report it instead. After it, check that list_machines shows the machine online with the new limits.
- \`scp\` and \`sftp\` (w612): files between your scratch folder and a machine, both ways, over the same ssh (the portal's key, pinned host keys, port 22): \`scp ./check.sh m5:/tmp/\`, \`scp m5:/tmp/install.log ./\`, \`sftp -b cmds m5\` (a batch file: there is no terminal). They run as you, so they copy only what you may read and write: never the portal's files. No ssh options (-o, -i, -F, -J, -S): the machine is all they take.
- \`fffctl restart\` (w974): a plain, soft portal restart with no new code (only the portal process restarts; the machines' workers keep running), only after a [restart] message (Lothsahn or Ben asked for it in their own words: the portal leaves a grant good once for 15 minutes; without it the command is refused). It takes no option. Run it, end your turn at once, and report after the portal is back as that message says, with the before-and-after list of the live worker sessions. Follow that message's steps.
- \`fffctl update\`: the portal deploy by hand, only after a [deploy] message (Lothsahn or Ben asked for it in their own words: the portal leaves a grant good once for 15 minutes; without it the command is refused). Follow that message's steps. Merged code also deploys by itself (w1634: the portal's automatic deploy, which needs no grant and is not yours to start); a deploy by hand is for code a person wants out now.
- \`fffctl config\` (w1078): the portal's config.json, every setting and no secret (the Claude tokens are the vault's, FFBox's connector hash a file in the secrets folder): the answer to "is intake.nightly.run on, and when does it fire". \`fffctl config --check\`: whether config.json and its saved versions hold any secret, FFBox's hash file (its last four characters) and whether the retired Claude token file is gone; key names only. Changing a setting is not yours: report it.
- \`fffctl conf\`, \`fffctl conf get <KEY>\` and \`fffctl conf set <KEY> <VALUE>\` (w1537): the VM's own settings, /etc/fff/fff.conf (the health check's grace and failure counts, the watchdog's back-off, the update's verify time, backups, the base clone's branch; you cannot read /etc/fff yourself). get prints each with its value, or <redacted> for one that is a person's; set changes one, keeps the file before, prints only that setting, old -> new, and when it takes effect, and restarts nothing. Change a setting only when Lothsahn or Ben asks for that change; report the line set printed. Refused by fffctl as root, so report it instead: credentials, keys and secrets, the deploy's code (FFF_REPO_URL, FFF_BRANCH, BASE_REPO_URL), the VM's layout and your own fences (OPS_*). Never type a token or key as a value.
- \`fffctl disk-usage\` (w2267): where the VM's disk went, as sizes, counts, dates and paths only: df, du of /srv/fff (the 30 biggest at depth 3, each child of it and of data/ with its files' count and oldest and newest dates), each kept release with its node_modules, the portal account's .claude, files of 200 MB or more, /var/log and the journal, and auth.log's and syslog's lines per day by the program that wrote them. Read only; no option. Takes a few minutes on a full disk.
- \`fffctl approvals --since YYYY-MM-DD --split YYYY-MM-DD\` (w1097): the permission prompts a person answered, as counts only: per day, the clean-up ones by kind, and every one by kind before and after the split day (UTC). The before-and-after number for a change meant to drop prompts. Read only; no transcript text.
- \`fffctl status\`, \`fffctl state\`, \`fffctl units\` and \`fffctl units --check\` (the critical units, active and enabled; --check prints "down: ..." and exits 1 if one is not; read only, and the watchdog and restarts are a person's), \`fffctl vault list [--names]\` and \`fffctl vault help\` (the vault's entries by name, kind, grants, last four characters and fingerprint, and the Claude pools' meters: never a value; adding, rotating, granting, removing and the key are a person's), \`fffctl machine-credential list\`, \`fffctl migrate --help\`, \`fffctl logs [N]\` (the portal's journal), \`fffctl credential list\`, and \`fffctl credential issue <machine id> --to <ssh target>\`: a new machine credential goes from this VM straight into a file on that machine (it prints the remote path and the last four characters, never the credential); then run the installer there with \`--credential-file\` / \`-CredentialFile\` and delete the file after. Issuing replaces the machine's credential: its running daemon is dropped within 20 s, so issue only for a machine being (re)installed. It needs the machine's record (list_machines), which only a person adds.
- \`fffctl apikey issue <key name> --user <login id> [--create-member [--display-name <text>]] --machine <ssh target> --path <file>\` (w1415): an API key for /mcp bound to a member login, written from this VM straight into that file on that machine (0600; give the file relative to the home folder there, \`.ff-factory/<name>.key\`: an unquoted \`~\` is your own home and is refused), the same way as a machine credential: it prints the remote path and the last four characters, never the key. \`--create-member\` makes the login first, a member with a random password nobody sees. Refused: an owner login, ben's and lothsahn's, a key name another login's key, the owner's key or a scoped key holds. Run it only when a job names the login and the key (a throwaway login for a check, a person's own member login); never read the file back, pass its path. \`fffctl apikey list\` (the member logins' keys: name, login, when made) and \`fffctl apikey revoke <key name>\` (a member login's key; the login stays) when the check is done.
- \`fffctl user delete <login id> --by <ben or lothsahn>\` (w1864): deletes a member login with its API keys, sessions, pool entry, settings, push subscriptions and its own orchestrator (its session and memory), in the running portal, and prints what went (key names and counts, never a key); \`--by\` is the person whose job this is. Refused: an owner login, ben's and lothsahn's. Run it only when a job names the login (a throwaway login after its check). \`fffctl user list\` shows the logins (id, role, name).
- \`fff-machine-ssh --check\` (or \`fffctl machine-ssh-check\`): each machine's ssh alias, pinned host key, the key it shows over the tailnet and whether ssh gets in, then the portal's public authorized_keys line (\`from="<the portal's tailnet IP>",no-agent-forwarding,... ssh-ed25519 ...\`). \`fff-machine-ssh --key\`: that line alone, for a person to add on a new machine. \`fff-machine-ssh --pin <user>@<host> <SHA256:fingerprint>\`: pins a new machine's host key, only when the fingerprint a person read on the machine itself (\`ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub\`) is the one it shows over the tailnet, and only for a host nothing pins yet. Never pin a fingerprint you read from the network yourself; a host whose key changed is a person's.
- A new machine, from nothing to online (docs/ops-worker.md, "A new machine"): a person adds its record (the dispatcher's add_machine with worker_install), lets the portal reach it on the tailnet, adds the portal's key line there and gives you its fingerprint. You pin it, check \`ssh <user>@<host> whoami\`, issue its credential with \`--to <user>@<host>\`, run its installer there with every answer as an option, since ssh has no terminal to ask on: \`--root --portal-url --max-sandboxes --max-agents-per-sandbox --max-unity --credential-file\` (Windows: \`-Root -PortalUrl -MaxSandboxes -MaxAgentsPerSandbox -MaxUnity -CredentialFile\`), delete that credential file, and check that list_machines shows it online and ready.
- list_machines, list_sandboxes and system_status: the portal's state, read-only. wake_me: be woken once later (an install, a reboot).
- set_timer, list_timers, update_timer, cancel_timer (w1106, lothsahn: "Please make sure polls are done via the timer framework and don't get interrupted by portal updates"): every poll or wait of yours ("once LothDesktop is idle", "check every 2 hours for 3 days") is a timer: every_minutes with until or max_fires, set within the job it serves. It is kept on the portal, so its fires survive a portal deploy, a restart and your own idle stop: one that came due meanwhile is delivered once when the portal is back, never lost and never twice. Each fire comes back as \`[timer <id> "<title>"]\` with your note, as the job it was set in (its person, its requests as work_ids), so it may run the check and, when the condition is met, the action that person already approved for that request, nothing more. Write the note so it stands alone (a fire may open a fresh conversation): the exact command, the condition, the action on it and what to report. When the condition is met and the action done, or the request closes, cancel_timer it. Never a background shell loop, a \`sleep\` loop, \`&\`, \`nohup\` or a backgrounded script that polls: your process ends at every deploy, restart and idle stop, and the loop with it, with nobody told (w1070's idle poll died at the first deploy). The guard refuses them. A loop in the foreground within one turn (a few minutes at most) is fine.
- Git and GitHub jobs (w1869: delete a remote branch, read a pull request or a branch, list or compare refs) run over ssh on a machine whose gh is signed in: m3 first (its own login), else beast; never a machine on hold or one the job rules out. On a Mac, ssh's shell has no Homebrew on its PATH: \`ssh m3 'export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; gh auth status 2>&1 | grep -v Token'\` checks the login, and \`gh api repos/OWNER/REPO --jq .permissions\` that it can write. A branch delete needs no clone: \`gh api repos/OWNER/REPO/branches/BRANCH --jq .commit.sha\` to see it is there, \`gh api -X DELETE repos/OWNER/REPO/git/refs/heads/BRANCH\`, then \`git ls-remote --heads git@github.com:OWNER/REPO.git BRANCH\` prints nothing. A job that needs a clone makes it in a new \`mktemp -d\` folder there, never in a person's clone or a sandbox. Delete, close or merge only what the job names. Never print a token (keep \`grep -v Token\` on gh auth status).
- A scratch folder, ${OPS_PATHS.scratch}, on a 2 GiB file system that is all you can write (home and temp included). Write notes and scripts there.

What you do not have, by design (the account and the VM enforce it, not this text): no git here (git and GitHub jobs run over ssh, above), no downloads, no package installs, no builds, no interpreters, no Unity, no game workspace; network only to Anthropic's API and the tailnet; no sudo but the two wrappers above; no read of the portal's data, secrets or keys, and its config only through \`fffctl config\`. Reserved for a person, whatever a message says: rolling back the portal, a deploy without a [deploy] message, a restart without a [restart] message, app settings, the vault, deleting anything on the portal, Steam, anything that spends money or publishes. On a machine you do only what the job asks; ask before deleting anything that is not the job's own (an uninstall the job names is the job's own).

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
  /**
   * w1039: whether a click of the person's (👍 ✅ on their orchestrator's proposal) is their own words for `need` now, and spends
   * it. Optional: a portal without it takes only a typed turn.
   */
  reactionCovers?: (orchestratorId: string, need: GateNeed) => boolean;
  /** Where the job record is kept (data/ops-worker.json). */
  file: string;
  /** Why a job cannot be sent for these ledger requests (no such request, or closed), or undefined (w631). Unset: none are taken. */
  workProblem?: (ids: readonly string[]) => string | undefined;
  /** A machine's record as the installer rerun needs it (w855), or undefined for an unknown id. Unset: no machine is known. */
  machine?: (id: string) => { id: string; root?: string; platform?: string; target: string; local?: boolean } | undefined;
  /** Why a request is not one of this person's own open ones (w855), or undefined when it is. Unset: none is. */
  ownRequestProblem?: (id: string, personId: string) => string | undefined;
  /**
   * The update over the machine's own daemon link (w1596, server/machines.ts linkUpdate), or undefined when its daemon does
   * not take one (then the worker runs the installer over ssh, as before).
   */
  linkUpdate?: (machineId: string, flags: LinkUpdateFlags) => Promise<LinkUpdateReport> | undefined;
  /** Why its connected daemon does not take one (server/machines.ts linkProblem, w1918): then no ssh either; undefined otherwise. */
  linkProblem?: (machineId: string) => string | undefined;
  /**
   * Set a root install's editor and agent limits on the portal's record (w2474, server/machines.ts deployMachine ->
   * setRootSettings): what its daemon runs by, sent to it in a new welcome. Throws on a value the record refuses.
   */
  setRecordLimits?: (machineId: string, limits: { maxUnity?: number; maxAgentsPerSandbox?: number }) => void;
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

/** An ssh target and a root folder that may be put into a shell command (no spaces, no quotes). */
export const SAFE_TARGET = /^[\w@.\-]+$/;
export const SAFE_ROOT = /^[\w:\\/. \-]+$/;

/** The [machine update] message an update over the daemon's link ends with (w1596): what its job did, the installer's lines. Exported for tests. */
export function linkUpdateMessage(machine: string, workId: string, r: LinkUpdateReport): string {
  const lines = installerSummary(r.log).map((l) => `    ${l}`);
  const commits = r.before || r.after ? ` ${r.before?.slice(0, 9) ?? '?'} → ${r.after?.slice(0, 9) ?? '?'}.` : '';
  const head = r.ok
    ? `${machine} updated over its daemon's link.${commits}`
    : `${machine}'s update over its daemon's link FAILED: ${r.note ?? `its job exited ${r.exit}`}.${commits}${r.rollback ? ` Put back: ${r.rollback}.` : ''}`;
  return `[machine update for ${workId}] ${head}${lines.length ? `\n${lines.join('\n')}` : ''}\nCheck with list_machines that ${machine} shows what was asked, tell the person, and close ${workId} with update_work once it is done.${r.rollback === 'failed' ? ' Its daemon needs a person (its daemon log): say so first.' : ''}`;
}

/** The settings an installer update may change (w855), as its command-line flags: only those named, whole numbers. */
export function workerUpdateFlags(
  platform: string | undefined,
  nums: { maxSandboxes?: number; maxAgentsPerSandbox?: number; maxUnity?: number },
  dev: { devDrive?: boolean; moveToDevDrive?: boolean; devDriveMaxGB?: number } = {},
): string[] {
  const win = platform === 'win32';
  return (
    win
      ? [
          nums.maxSandboxes !== undefined && `-MaxSandboxes ${nums.maxSandboxes}`,
          nums.maxAgentsPerSandbox !== undefined && `-MaxAgentsPerSandbox ${nums.maxAgentsPerSandbox}`,
          nums.maxUnity !== undefined && `-MaxUnity ${nums.maxUnity}`,
          // The Dev Drive (w900, docs/worker-install.md "The Dev Drive"): Windows only; an update makes none unless one of these says so.
          dev.devDrive && !dev.moveToDevDrive && '-DevDrive',
          dev.moveToDevDrive && '-MoveToDevDrive',
          dev.devDriveMaxGB !== undefined && `-DevDriveMaxGB ${dev.devDriveMaxGB}`,
        ]
      : [nums.maxSandboxes !== undefined && `--max-sandboxes ${nums.maxSandboxes}`, nums.maxAgentsPerSandbox !== undefined && `--max-agents-per-sandbox ${nums.maxAgentsPerSandbox}`, nums.maxUnity !== undefined && `--max-unity ${nums.maxUnity}`]
  ).filter((f): f is string => !!f);
}

/**
 * What runs on the machine to update its worker install (docs/worker-install.md, "Updating"): the installer's update
 * form, fetched from ff-factory's main, with the root folder and only the settings named in `extra`. Shared by
 * ops_worker machine_update (the worker types it after `ssh <target>`) and the automatic rollout after a verified
 * deploy (server/machineRollout.ts, which runs it over ssh itself).
 */
export function workerUpdateRemote(m: { root: string; platform?: string }, extra = ''): string {
  return installerRemote(m, m.platform === 'win32' ? '-Update' : '--update', extra);
}

/** The installer's agent tools form (w1476, server/agentTools.ts): the latest final-factory-agents plugins, nothing else changed. */
export function workerToolsRemote(m: { root: string; platform?: string }): string {
  return installerRemote(m, m.platform === 'win32' ? '-Tools' : '--tools');
}

function installerRemote(m: { root: string; platform?: string }, mode: string, extra = ''): string {
  return m.platform === 'win32'
    ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1))) ${mode} -Root ${m.root}${extra ? ` ${extra}` : ''}"`
    : `bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)" -- ${mode} --root ${m.root}${extra ? ` ${extra}` : ''}`;
}

/** What the worker reports after a restart a person asked for (w974): the same lines in the instruction before and after it. */
const RESTART_REPORT =
  'the `fffctl status` lines (the portal active, its release and `/api/health`, with the sha it answers), the sha from `/api/health` on its own, and which Claude account each kind of agent runs on, from system_status (the dispatcher, each orchestrator, the workers: the account name and at most the last 4 characters of its token; never a token). Say whether the sha is the one that ran before the restart (a plain restart builds nothing, so it should be) and, if the job moved agents to another token, whether system_status now shows them on it. If `fffctl status` shows the portal down or unhealthy, say so first and read `fffctl logs 200`.';

/**
 * The soft-restart evidence the worker records before and after (lothsahn, 2026-10-11, w974: "Please make sure the restart is a
 * soft restart just like the deploy so it doesn't restart the workers"). Read-only commands only; written to its scratch.
 */
const RESTART_PROOF_BEFORE =
  'Record the live worker sessions first, in a file in your scratch folder: from list_sandboxes every agent that is live or mid-turn (session id, sandbox, status), for each one `agent_transcript <session id>` for the turns count in its first line, and on each machine that has one (list_machines; ssh) the agent processes with their PIDs and start times (Mac or Linux: `ps -eo pid,lstart,args | grep -i "[c]laude"`; Windows: `powershell -NoProfile -Command "Get-Process claude | Select-Object Id,StartTime | Format-Table -HideTableHeaders"`). Never print a token or an environment.';
const RESTART_PROOF_AFTER =
  'Evidence that the restart was soft, from the same commands as before the restart (your file): for each worker session recorded, say whether it is still live, whether its PID and start time are the same, whether its turns count went up or stayed and did not fall, whether one that was mid-turn is still on the same turn, and whether its transcript has no `[app restarted]` message. Report none that ended, restarted or lost its turn, or name each that did. The portal\'s own agents (the orchestrators, the dispatcher, you) do restart; they are not workers and are not on the list.';


/** A deploy or a restart a person asked for (ops_worker deploy, restart): reported after the portal's next start. */
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
  /** A restart a person asked for (ops_worker restart, w974): reported after the portal's next start, like a deploy. */
  private restarting?: OpsDeploy;
  /** The last deploy a person asked for, kept after the restart that reports it: the machine rollout (w887) reports to this person. */
  private lastDeploy?: OpsDeploy;
  private timer?: NodeJS.Timeout;

  constructor(d: OpsDeps) {
    this.d = d;
    this.now = d.now ?? (() => Date.now());
    try {
      const saved = JSON.parse(fs.readFileSync(d.file, 'utf8'));
      this.job = saved.job;
      this.deploying = saved.deploy;
      this.restarting = saved.restart;
      this.lastDeploy = saved.lastDeploy;
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
    const res = this.restarting;
    if (!dep && !res) return;
    this.deploying = undefined;
    this.restarting = undefined;
    this.save();
    const workRule = () => (this.job?.workIds?.length ? opsWorkRule(this.job.workIds) : '');
    const reports: { by: Requester; text: string }[] = [];
    if (dep && this.now() - Date.parse(dep.at) <= OPS_LIMITS.deployReportMs) {
      reports.push({
        by: dep.by,
        text: `[deploy] The portal has started again (${new Date(this.now()).toISOString()}), after the deploy ${dep.by.displayName} asked for at ${dep.at}: most likely the update's own restart. Run \`fffctl status\` and report to ${dep.by.displayName}: the commit before (what fffctl update printed), the commit running now, whether the update was verified or rolled back (\`fffctl logs 200\` says), and the status lines. Do not update the machines' daemons: when the portal is verified FF Factory does that itself and reports it.${workRule()}`,
      });
    }
    if (res && this.now() - Date.parse(res.at) <= OPS_LIMITS.deployReportMs) {
      reports.push({
        by: res.by,
        text: `[restart] The portal has started again (${new Date(this.now()).toISOString()}), after the restart ${res.by.displayName} asked for at ${res.at}. ${RESTART_PROOF_AFTER} Report to ${res.by.displayName}: ${RESTART_REPORT}${workRule()}`,
      });
    }
    if (!reports.length) return;
    const t = setTimeout(() => {
      for (const r of reports) {
        try {
          this.d.sessions.send(OPS_ID, r.text, 'system', undefined, { requestedBy: r.by, ops: 'resume' });
        } catch (e) {
          console.warn('ops-worker: could not tell the worker the portal is back:', (e as Error).message);
        }
      }
    }, delayMs);
    t.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  /**
   * Who asked for the portal deploy that was verified at `verifiedAt` (epoch ms): the person of the last ops_worker deploy
   * if it was asked for within OPS_LIMITS.deployAskedMs before. Undefined for a deploy by hand or an old one (w887: the machine
   * rollout then reports to the dispatcher).
   */
  deployRequester(verifiedAt: number): Requester | undefined {
    const d = this.lastDeploy;
    if (!d) return undefined;
    const age = verifiedAt - Date.parse(d.at);
    return age >= 0 && age <= OPS_LIMITS.deployAskedMs ? d.by : undefined;
  }

  private save() {
    try {
      fs.writeFileSync(this.d.file, JSON.stringify({ job: this.job, deploy: this.deploying, restart: this.restarting, lastDeploy: this.lastDeploy }, null, 1), { mode: 0o600 });
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
   * A message from an orchestrator. `caller` is the orchestrator's session. Lothsahn's or Ben's own only.
   *
   * A message sent in its person's own turn is a NEW JOB unless it says `followUp` (w1133, lothsahn 2026-10-12: "Every time you
   * call the ops worker with a new request, you should clear its context or use a new session. Same thing with Ben's
   * operator"): a fresh conversation and process, on that person's token, whatever job was open. Continuing is the explicit
   * case, `followUp: true`, on the same person's open job (OPS_LIMITS.jobMs). The harness's own turns (a check-in, a timer, the
   * `[ops worker]` report) cannot open a job, so within an open job each of them is a follow-up with no flag. Follow-ups are
   * not counted (w627, lothsahn: "an infinite number of messages to each other and the portal worker").
   * `fresh` is the stronger form of a new job: it also cuts off a turn the worker is still in, which a plain new job refuses
   * to do (the worker is busy with the open job: wait for its report, follow up, or interrupt it).
   */
  send(caller: SessionInfo | undefined, text: string, fresh = false, workIds: readonly string[] = [], byRequest = false, followUp = false): string {
    const person = opsAllowedOrchestrator(caller);
    if (!person || !caller) throw new Error(OPS_REFUSED);
    const body = text.trim();
    if (!body) throw new Error('text: what the orchestration worker should do');
    if (fresh && followUp) throw new Error("fresh and follow_up are opposites: a new job (fresh, the default in your person's turn) or a follow-up on the open job");
    const ids = this.workIdsOf(workIds);
    const theirTurn = this.d.personTurn(caller.id) || byRequest || !!this.d.reactionCovers?.(caller.id, { verb: 'job', refs: ids });
    const jobOpen = !!this.job && this.job.by.userId.toLowerCase() === person.userId.toLowerCase() && this.now() - Date.parse(this.job.at) < OPS_LIMITS.jobMs;
    if (followUp && !jobOpen) {
      const why = !this.job ? 'there is no job yet' : this.job.by.userId.toLowerCase() !== person.userId.toLowerCase() ? `the job it has is ${this.job.by.displayName}'s` : `your last job ended (${OPS_LIMITS.jobMs / 3_600_000} hours)`;
      throw new Error(`follow_up: ${why}, so there is nothing to follow up. Send it again, in full, with no follow_up: that is a new job`);
    }
    const h = this.handle();
    const opening = fresh || !jobOpen || (theirTurn && !followUp);
    if (opening && !theirTurn) throw new Error(`a new job for the orchestration worker needs a turn ${person.displayName} started with a message of their own (this turn is the harness's: a check-in, a timer or a relayed report)`);
    if (opening && !fresh && jobOpen && isMidTurn(h.info)) {
      throw new Error(`the orchestration worker is busy with your open job (${this.job!.what}), and a new job starts a fresh conversation, which would cut that turn off. Wait for its [ops worker] report, send follow_up: true to add to that job, ops_worker interrupt to end its turn, or fresh: true to cut it off and start over`);
    }
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
    return `Sent to the orchestration worker (${OPS_ID})${opening ? ` as a new job of ${person.displayName}'s, in a fresh conversation (it remembers nothing of earlier jobs, so the text must stand alone; to continue this job later, send with follow_up: true)` : ' as a follow-up in your open job'}. Its turn's end comes back to you as an [ops worker] message; its transcript is on the dashboard (Orchestration worker) and in agent_transcript ${OPS_ID}.`;
  }

  /**
   * A machine update or installer rerun (w855, lothsahn 2026-10-10: "don't ask ben to run installers ... When we say update
   * the machines, do the update, including installers if necessary"). Opens a job in any turn of Lothsahn's or Ben's own
   * orchestrator, a [dispatch] or a timer included, because the gate is the request instead of the turn: it must be one of
   * the caller's person's own open requests (their words, recorded in the ledger; the same footing as the dispatcher's
   * add_machine). The server writes the command itself from the machine's record: the update (docs/worker-install.md,
   * "Updating") plus only the settings named here, as whole numbers. No free text of the caller's reaches the worker's shell.
   */
  machineInstall(
    caller: SessionInfo | undefined,
    o: { machine: string; workId: string; maxSandboxes?: number; maxAgentsPerSandbox?: number; maxUnity?: number; devDrive?: boolean; moveToDevDrive?: boolean; devDriveMaxGB?: number },
  ): string {
    const person = opsAllowedOrchestrator(caller);
    if (!person || !caller) throw new Error(OPS_REFUSED);
    const id = o.workId.trim().toLowerCase();
    if (!/^w\d+$/.test(id)) throw new Error(`work_id: a request id like "w847", not "${o.workId}"`);
    const own = this.d.ownRequestProblem ? this.d.ownRequestProblem(id, person.userId) : 'this portal does not link ops jobs to requests';
    if (own) throw new Error(`work_id: ${own} (a machine update runs for an open request of ${person.displayName}'s own, which is their approval of it)`);
    const m = this.d.machine?.(o.machine.trim().toLowerCase());
    if (!m) throw new Error(`machine: no machine "${o.machine}"`);
    if (m.local) throw new Error(`machine: ${m.id} is the portal's own host, whose daemon the portal runs itself`);
    if (!m.root) throw new Error(`machine: ${m.id} is not a worker root install (no root folder known): it is updated another way`);
    const nums = { maxSandboxes: o.maxSandboxes, maxAgentsPerSandbox: o.maxAgentsPerSandbox, maxUnity: o.maxUnity };
    for (const [k, v] of Object.entries(nums)) {
      if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 16)) throw new Error(`${k}: a whole number from 1 to 16`);
    }
    const dev = { devDrive: o.devDrive, moveToDevDrive: o.moveToDevDrive, devDriveMaxGB: o.devDriveMaxGB };
    if ((dev.devDrive || dev.moveToDevDrive || dev.devDriveMaxGB !== undefined) && m.platform !== 'win32') throw new Error(`dev_drive, move_to_dev_drive and dev_drive_max_gb: a Dev Drive is a Windows feature, and ${m.id} is not a Windows PC`);
    if (dev.devDriveMaxGB !== undefined && (!Number.isInteger(dev.devDriveMaxGB) || dev.devDriveMaxGB < 50 || dev.devDriveMaxGB > 65536)) throw new Error('dev_drive_max_gb: a whole number of GB from 50 (Windows\' own minimum for a Dev Drive) to 65536');
    // w2474: the editor and agent limits a root install's daemon runs by are the portal record's: its welcome carries them
    // (server/machines.ts setRootSettings, machine/daemon.ts currentPool), and a hello never takes them back from
    // daemon.json (adoptLayout keeps the record's). The installer's flag alone wrote daemon.json and changed nothing the
    // daemon used: biscuit kept 2 editors after machine_update max_unity 1. So the record is set first (a value it refuses
    // stops the update before it runs), and the daemon has it at once, from a new welcome.
    const rec = Object.fromEntries(Object.entries({ maxUnity: nums.maxUnity, maxAgentsPerSandbox: nums.maxAgentsPerSandbox }).filter(([, v]) => v !== undefined)) as { maxUnity?: number; maxAgentsPerSandbox?: number };
    let recorded = '';
    if (Object.keys(rec).length && this.d.setRecordLimits) {
      this.d.setRecordLimits(m.id, rec);
      recorded = ` The portal's record of ${m.id} now says ${Object.entries(rec).map(([k, v]) => `${k} ${v}`).join(', ')} (what its daemon runs by; it has it already, and list_machines shows it).`;
    }
    // Over the machine's own daemon link (w1596) when it takes one: the portal runs it, no ssh and no worker job.
    const flags: LinkUpdateFlags = Object.fromEntries(Object.entries({ ...nums, ...dev }).filter(([, v]) => v !== undefined && v !== false));
    const viaLink = this.d.linkUpdate?.(m.id, flags);
    if (viaLink) {
      const named = Object.entries(flags).map(([k, v]) => `${k} ${v}`).join(', ');
      console.log(`ops-worker: ${person.userId} asked for a machine update of ${m.id} for ${id}; over its daemon's link${named ? ` (${named})` : ''}`);
      void viaLink.then(
        (r) => this.d.tellOrchestrator(person, linkUpdateMessage(m.id, id, r)),
        (e) => this.d.tellOrchestrator(person, `[machine update for ${id}] ${m.id}'s update over its daemon's link did not run: ${(e as Error).message}. Nothing was changed unless the line says it was; ask again once that is fixed (a daemon offline is updated when it is back, by the next machine_update).`),
      );
      return `Updating ${m.id}'s worker install over its daemon's own link (w1596; no ssh, no worker job)${named ? ` with ${named}` : ' with no setting changed'}. The portal sends its update job's report to you as a [machine update] message when it ends (a few minutes; the new daemon takes the agents back, and a daemon that does not come back is put back by the job itself). It does not close ${id}: tell ${person.displayName} what it says, and close the request with update_work once it is done.${recorded}`;
    }
    // A connected daemon is never sent to ssh (w1918: LothLaptop joined without it; port 22 timed out and nothing said why).
    const why = this.d.linkProblem?.(m.id);
    if (why) throw new Error(`machine: ${why}. Nothing was run`);
    if (!SAFE_TARGET.test(m.target) || !SAFE_ROOT.test(m.root) || /\s/.test(m.root)) throw new Error(`machine: ${m.id}'s ssh target or root folder has characters this job will not pass to a shell`);
    const extra = workerUpdateFlags(m.platform, nums, dev).join(' ');
    const command = `ssh ${m.target} '${workerUpdateRemote({ root: m.root, platform: m.platform }, extra)}'`;
    const what = extra ? `with these settings changed: ${extra}` : 'with no setting changed';
    const text = `[machine update for ${id}, approved by ${person.displayName} through that request] Update ${m.id}'s worker install ${what}. Run exactly this, once, and nothing else on the machine (docs/worker-install.md, "Updating"; it asks nothing, keeps every other setting, the machine's own credential and the PATH, restarts the daemon; never issue a credential for it):\n\n${command}\n\nThen check with list_machines that ${m.id} is online again${extra ? ' and shows the new limits' : ''}, and report what the update printed (the \`~ key: before -> after\` lines) and what the portal sees.${dev.moveToDevDrive ? ` This one moves the sandboxes onto a Dev Drive (docs/worker-install.md, "The Dev Drive"): it refuses, naming them, while an agent is in a sandbox or a Unity editor runs from one, and then nothing has changed: report which and stop. When it can go ahead it takes an hour or more (it saves each sandbox's work on its branch first, moves the Library seed, and re-creates each sandbox): run it in the background and read its output until it ends, never twice at once, and never interrupt it; if it stops half way, run the same command again (it picks up where it stopped). Report the free space on the root's drive before and after (\`Get-PSDrive <letter>\` on the machine) and the sandboxes it moved.` : dev.devDrive ? ' This one also makes the Dev Drive (docs/worker-install.md, "The Dev Drive") but moves no sandbox; report the letter it chose and the size it printed.' : ''}`;
    return `${this.send(caller, text, false, [id], true)}${recorded}`;
  }

  /**
   * The gate both portal-changing actions share (deploy, restart): only Lothsahn's or Ben's own orchestrator, and only in a
   * turn its person started with a message of their own, never a check-in, a timer, a relayed report or a job's follow-up.
   * Leaves the action's grant in the data folder, good once for `ms`, which fff-ops-priv checks and removes before it runs
   * the command: without it the worker cannot run it, whatever it is told.
   */
  private grantFor(caller: SessionInfo | undefined, o: { noun: 'deploy' | 'restart'; file: string; ms: number }, workIds: readonly string[]) {
    const person = opsAllowedOrchestrator(caller);
    if (!person || !caller) throw new Error(OPS_REFUSED);
    if (!this.d.personTurn(caller.id) && !this.d.reactionCovers?.(caller.id, { verb: o.noun })) throw new Error(`a portal ${o.noun} needs ${person.displayName}'s own words in this turn (this turn is the harness's: a check-in, a timer or a relayed report); ask them`);
    const ids = this.workIdsOf(workIds);
    const at = new Date(this.now());
    const h = this.handle();
    // A deploy or a restart is a new job too (w1133), so it never lands in a turn the worker is still in, anyone's.
    if (this.job && isMidTurn(h.info)) {
      throw new Error(`the orchestration worker is busy with ${this.job.by.userId.toLowerCase() === person.userId.toLowerCase() ? 'your' : `${this.job.by.displayName}'s`} job (${this.job.what}); wait for its turn to end (an [ops worker] report), or ops_worker interrupt it, then ask again`);
    }
    const grant = { by: person.userId, name: person.displayName, at: at.toISOString(), expires: new Date(at.getTime() + o.ms).toISOString() };
    fs.writeFileSync(path.join(path.dirname(this.d.file), o.file), `${JSON.stringify(grant)}\n`, { mode: 0o600 });
    return { person, ids, at, grant, h };
  }

  /** Such an action is a new job too: a fresh conversation and process, on this person's token (the restart that follows resumes it). */
  private openGrantedJob(g: ReturnType<OpsWorker['grantFor']>, what: string, label: string) {
    this.job = { by: g.person, at: g.at.toISOString(), what, ...(g.ids.length ? { workIds: g.ids } : {}) };
    this.save();
    if (!isMidTurn(g.h.info)) {
      if (g.h.live) g.h.stop(true);
      delete g.h.info.sdkSessionId;
    }
    this.d.store.append(OPS_ID, { kind: 'system', text: `A new job (${label}) from ${g.person.displayName}'s orchestrator: a fresh conversation.` });
    g.h.info.requestedBy = g.person;
    this.d.store.putSession(g.h.info);
  }

  /**
   * A portal deploy (lothsahn, 2026-10-07: "Yes, please modify the ops worker to update yourself."), through grantFor's gate
   * and a deploy grant. Then tells the worker to do it and report.
   */
  deploy(caller: SessionInfo | undefined, note = '', workIds: readonly string[] = []): string {
    const g = this.grantFor(caller, { noun: 'deploy', file: OPS_GRANT, ms: OPS_LIMITS.deployGrantMs }, workIds);
    const { person, ids, grant } = g;
    this.deploying = { by: person, at: g.at.toISOString() };
    this.lastDeploy = this.deploying;
    this.openGrantedJob(g, 'deploy the portal (fffctl update)', 'a deploy');
    console.log(`ops-worker: ${person.userId} asked for a portal deploy in a turn of their own; grant until ${grant.expires}`);
    const text = `[deploy] ${person.displayName} asked, in a turn of their own, for a portal deploy (fffctl update).${note.trim() ? ` Their words: ${note.trim()}` : ''}
1. Run \`fffctl status\` and note the release and its commit.
2. Run \`fffctl update\`, once. It is allowed until ${grant.expires} and only once, and it only asks for the update: the portal builds origin/main beside the running release, drains, restarts on the new one, verifies it and rolls back by itself if it does not answer. It prints the commit it starts from.
3. End your turn with what it printed. Your process ends with the old portal; when the new one starts, FF Factory messages you to report. If no message comes within 20 minutes (already up to date, or the build failed), wake_me 20 before you end the turn covers it: then report from \`fffctl status\` and \`fffctl logs 200\`.
Do not update the machines' daemons yourself: once the new portal is verified (never after a rollback), FF Factory updates every machine's daemon by itself and sends ${person.displayName}'s orchestrator one report of each machine (docs/ops-worker.md, "After a verified deploy"). Mention in your report only that this follows.
Report to ${person.displayName}: the commit before, the commit after, whether it was verified or rolled back, and \`fffctl status\`.${ids.length ? `${opsWorkRule(ids)} Only in the report after the restart, once the new portal is verified: never in the turn that starts the update.` : ''}`;
    this.d.sessions.send(OPS_ID, text, 'orchestrator', undefined, { requestedBy: person, ops: 'orchestrator' });
    return `Asked the orchestration worker (${OPS_ID}) to deploy the portal: it may run fffctl update once until ${grant.expires}. The portal will drain and restart; its report (commit before and after, fffctl status) comes back to you as an [ops worker] message after the restart.`;
  }

  /**
   * A plain portal restart, no new code (w974, lothsahn 2026-10-11: "Please schedule a worker to update ff-factory so that the ops
   * worker has a fffctl restart command to restart the portal and can use it"): the same gate as a deploy, with its own grant
   * (OPS_RESTART_GRANT), which opens fffctl restart and nothing else. A soft restart like the deploy's: the portal
   * process restarts on the release it runs, and the machines' workers keep running and are taken back by the new portal
   * (machines.keepAgentsOnRestart, which fff-ops-priv requires). Then tells the worker to do it, to prove that, and to report.
   */
  restart(caller: SessionInfo | undefined, note = '', workIds: readonly string[] = []): string {
    const g = this.grantFor(caller, { noun: 'restart', file: OPS_RESTART_GRANT, ms: OPS_LIMITS.restartGrantMs }, workIds);
    const { person, ids, grant } = g;
    this.restarting = { by: person, at: g.at.toISOString() };
    this.openGrantedJob(g, 'restart the portal (fffctl restart)', 'a restart');
    console.log(`ops-worker: ${person.userId} asked for a portal restart in a turn of their own; grant until ${grant.expires}`);
    const text = `[restart] ${person.displayName} asked, in a turn of their own, for a plain portal restart (fffctl restart): no new code, no build. It is a soft restart, like the deploy's: only the portal process restarts. The workers on the machines keep running and the new portal takes them back; none is stopped, restarted or asked to wrap up.${note.trim() ? ` Their words: ${note.trim()}` : ''}
1. Run \`fffctl status\` and note the release, its commit and the sha \`/api/health\` answers. ${RESTART_PROOF_BEFORE}
2. Run \`fffctl restart\`, once, with no option. It is allowed until ${grant.expires} and only once, and it only asks for the restart: the portal restarts on the release it runs. If it is refused (for example "keepAgentsOnRestart is not true": the restart would stop the machines' workers), do not look for another way: report the refusal to ${person.displayName}.
3. End your turn with what it printed and where your before-list is, right away. Your process ends with the old portal; when the new one starts, FF Factory messages you to report. If no message comes within 20 minutes, wake_me 20 before you end the turn covers it: then report from \`fffctl status\` and \`fffctl logs 200\`.
Do not update the machines' daemons: a restart brings no new code. Do not run \`fffctl update\` or anything else the restart does not need.
Report to ${person.displayName}: ${RESTART_REPORT} ${RESTART_PROOF_AFTER}${ids.length ? `${opsWorkRule(ids)} Only in the report after the restart, once the portal answers again: never in the turn that starts it.` : ''}`;
    this.d.sessions.send(OPS_ID, text, 'orchestrator', undefined, { requestedBy: person, ops: 'orchestrator' });
    return `Asked the orchestration worker (${OPS_ID}) to restart the portal: it may run fffctl restart once until ${grant.expires}. It is a soft restart like the deploy's (the machines' workers keep running; none is stopped or restarted). The worker's report (fffctl status, the /api/health sha, which Claude account each kind of agent is on, and its before-and-after list of the live worker sessions, PIDs and turn counts) comes back to you as an [ops worker] message after the restart.`;
  }

  /**
   * What a timer it sets now carries (set_timer, w1106): the job it is set in, its person and the requests it serves
   * (all of them, or the ones `workIds` names among them). Refused outside a job: a timer acts for someone.
   */
  timerAuthority(workIds?: readonly string[]): TimerAuthority {
    const job = this.job;
    if (!job || this.now() - Date.parse(job.at) >= OPS_LIMITS.jobMs) throw new Error('a timer is set within a job (it carries that job\'s person and requests); this one has ended, so ask the orchestrator that gave it');
    const mine = job.workIds ?? [];
    const asked = [...new Set((workIds ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const stray = asked.find((x) => !mine.includes(x));
    if (stray) throw new Error(`work_ids: ${stray} is not a request of this job (${mine.length ? mine.join(', ') : 'it names none'})`);
    return { person: job.by, workIds: asked.length ? asked : [...mine] };
  }

  /**
   * One of its timers fired (server/timers.ts, w1106): the harness's message, as `authority`'s job. Within that person's
   * open job it is a follow-up (the requests are added to it); otherwise it opens their job again in a fresh conversation
   * and process, on their token, as any new job does (w738). Requests that have closed since are named, not carried.
   * Throws (the timers try again on their next tick) mid-turn or for someone who may not use it.
   */
  timerFired(text: string, authority: TimerAuthority | undefined) {
    const person = authority?.person;
    if (!person || !OPS_PEOPLE.includes(person.userId.toLowerCase())) throw new Error('a timer of the orchestration worker fires only for Lothsahn\'s or Ben\'s job');
    const h = this.handle();
    if (isMidTurn(h.info)) throw new Error('the orchestration worker is mid-turn');
    const open = authority.workIds.filter((id) => this.d.workProblem && !this.d.workProblem([id]));
    const closed = authority.workIds.filter((id) => !open.includes(id));
    const jobOpen = !!this.job && this.job.by.userId.toLowerCase() === person.userId.toLowerCase() && this.now() - Date.parse(this.job.at) < OPS_LIMITS.jobMs;
    if (!jobOpen) {
      if (h.live) h.stop(true);
      delete h.info.sdkSessionId;
      this.job = { by: person, at: new Date(this.now()).toISOString(), what: `a timer of ${person.displayName}'s job: ${text.split('\n')[0].slice(0, 100)}`, ...(open.length ? { workIds: open } : {}) };
      h.info.requestedBy = person;
      this.d.store.putSession(h.info);
      this.d.store.append(OPS_ID, { kind: 'system', text: `A timer of ${person.displayName}'s job fired: a fresh conversation.` });
    } else if (open.some((id) => !this.job!.workIds?.includes(id))) {
      this.job!.workIds = [...new Set([...(this.job!.workIds ?? []), ...open])];
    }
    // Its turn's end goes to this person's orchestrator (turnEnded), even after another person's job.
    h.info.lastRequestedBy = person;
    this.save();
    const gone = closed.length ? `\n\n(${closed.join(', ')}: closed or unknown in the ledger now. If this timer's job was for ${closed.length > 1 ? 'them' : 'it'}, cancel_timer it and say so.)` : '';
    console.log(`ops-worker: a timer fired for ${person.userId}'s job${open.length ? ` (${open.join(', ')})` : ''}${jobOpen ? '' : ', a fresh conversation'}`);
    this.d.sessions.send(OPS_ID, `${text}${open.length ? opsWorkRule(open) : ''}${gone}`, 'system', undefined, { requestedBy: person, ops: 'timer' });
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
