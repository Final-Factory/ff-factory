// Make a new FF Factory instance on this computer: a project's own portal beside any other (w14, docs/instances.md).
//
// Standing up Light Tree's and Lens Scout's portals by hand took a dozen steps each (docs/project.md, "A second portal on
// machines that already run one"), and a copy rebuilt from a first draft of the scripts failed (w4038). This script is the
// one source of those steps now, with Lens Scout's proven settings as the template:
//
//   1. Refuses a bad name (the list's rule), a non-empty --dir, a port that answers or that a listed instance has, a name
//      already in the list.
//   2. Makes <dir>/{data,secrets,claude-portal,pack/briefs}, clones ff-factory into <dir>/app at the --from checkout's HEAD
//      (from its origin, detached, core.autocrlf false) and builds it as the updater does; clones the project into <dir>/base.
//   3. Writes <dir>/secrets/vault.key (a new key, 0600), <dir>/config.json (configFor, checked by the portal's own
//      loadConfig) and short placeholder briefs in <dir>/pack/briefs.
//   4. Windows: <dir>/start-portal.sh and <dir>/register-tasks.ps1, which it runs: the logon task ff<name>-portal. macOS: the
//      LaunchAgent com.ffinstance.<name>.portal, bootstrapped into gui/<uid> (user/<uid> when nobody is at the screen).
//   5. Starts it and waits up to 3 minutes for http://127.0.0.1:<port>/api/health.
//   6. Adds it to the computer's instances.json (--list; default the updater's), so every verified merge reaches it.
//   7. Prints what only the owner can do: the first login, and per machine its record and its daemon's install line.
//
//   node scripts/instance/new.ts --name <slug> --project "<Project Name>" --repo <git url> --port <n> --dir <folder>
//     [--machines a,b,c] [--owner <Name>] [--payer <id>] [--public-url <url>] [--list <instances.json>]
//     [--from <ff-factory checkout, default this one>] [--dry-run]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../server/config.ts';
import { MACHINE_ID } from '../../server/machineTokens.ts';
import { newKeyText } from '../../server/vault.ts';
import { INSTANCE_NAME, type Instance, type InstanceList, listProblem, readList, realDeps, resolve } from './update-all.ts';

export interface NewOptions {
  name: string;
  project: string;
  repo: string;
  port: number;
  /** The instance's folder, absolute. */
  dir: string;
  machines: string[];
  owner?: string;
  payer?: string;
  publicUrl?: string;
  list?: string;
  from: string;
  dryRun: boolean;
}

const slash = (p: string) => p.replace(/\\/g, '/');
/** A path under the instance's folder, with forward slashes (Lens Scout's config writes F:/ffw/lens-factory/data). */
const under = (dir: string, ...p: string[]) => path.posix.join(slash(dir), ...p);

export const portalTaskName = (name: string) => `ff${name}-portal`;
export const launchLabel = (name: string) => `com.ffinstance.${name}.portal`;
export const BRIEFS = { worldBriefFile: 'world-brief.md', orchestratorBriefFile: 'orchestrator-brief.md', workerBriefFile: 'worker-brief.md' } as const;

/** "owner/name" of a github.com repository URL (https or ssh), or undefined. */
export function githubRepo(url: string): string | undefined {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * The new instance's config.json: Lens Scout's (F:/ffw/lens-factory/config.json, 2026-11-14) with this one's name, port,
 * folders and repository. No Unity, FFBox, Max inbound, outside watch, voice, machine clean-up or host guard polling;
 * machines take GitHub from the vault and keep their agents through a portal restart; new browsers wait for an owner.
 */
export function configFor(o: Pick<NewOptions, 'project' | 'repo' | 'port' | 'dir' | 'owner' | 'payer' | 'publicUrl'>): Record<string, unknown> {
  const at = (...p: string[]) => under(o.dir, ...p);
  const gh = githubRepo(o.repo);
  return {
    port: o.port,
    host: '0.0.0.0',
    // Behind Tailscale serve (the public URL) the proxy's headers are trusted; reached directly, never (the default is true).
    trustProxy: !!o.publicUrl,
    ...(o.publicUrl ? { publicUrl: o.publicUrl.replace(/\/+$/, '') } : {}),
    ...(o.owner ? { ownerName: o.owner } : {}),
    ...(o.payer ? { systemPayer: o.payer } : {}),
    dataDir: at('data'),
    sandboxRoot: at('host-sandboxes'),
    standingRoot: at('agents'),
    repo: { url: o.repo, basePath: at('base') },
    defaultBase: 'origin/main',
    providers: { ffbox: { enabled: false, sendWork: false } },
    ledger: { cleanup: { repos: [] } },
    outsideWatch: { enabled: false },
    // Its own Max files: the default (~/.config/ff-factory) is the computer's other portal's.
    max: { eventsFile: at('data', 'max-events.jsonl'), ffboxConfigDir: at('data', 'ffbox-none'), inbound: { enabled: false } },
    vault: {
      keyFile: at('secrets', 'vault.key'),
      ...(o.payer ? { unattributed: { intake: o.payer, ffbox: o.payer, nightly: o.payer } } : {}),
      // Its own repositories, or it reads Final Factory's and shows their banners (docs/project.md).
      ...(gh ? { githubRepos: [gh] } : {}),
    },
    voice: { enabled: false, autoInstall: false, tts: false },
    machines: { githubFromVault: true, keepAgentsOnRestart: true, cleanup: { everyMinutes: 0, softFreeGB: 0, staleOutput: { mode: 'off' } } },
    hostGuard: { pollSeconds: 0 },
    project: {
      name: o.project,
      description: 'a project whose one-line description is still to be written (config.json project.description)',
      unity: false,
      community: false,
      integration: 'pull-request',
      ...Object.fromEntries(Object.entries(BRIEFS).map(([k, f]) => [k, at('pack', 'briefs', f)])),
    },
    claudeAccounts: { orchestrator: 'vault' },
    deviceApproval: 'members',
  };
}

/** Throws the portal's own complaint about a config (loadConfig reads FFSB_CONFIG). The file goes in a temp folder. */
export function checkConfig(cfg: Record<string, unknown>): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-instance-config-'));
  const was = process.env.FFSB_CONFIG;
  try {
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
    process.env.FFSB_CONFIG = path.join(tmp, 'config.json');
    loadConfig();
  } finally {
    if (was === undefined) delete process.env.FFSB_CONFIG;
    else process.env.FFSB_CONFIG = was;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The placeholder briefs, by file name: enough for a first conversation, to be replaced by the owner. */
export function briefs(o: Pick<NewOptions, 'project' | 'repo' | 'dir' | 'owner'>): Record<string, string> {
  const note = '\n(A placeholder written by scripts/instance/new.ts: replace it with what this deployment is.)\n';
  return {
    [BRIEFS.worldBriefFile]: `- **The project:** ${o.project}, in ${o.repo}; its base clone is ${under(o.dir, 'base')} (origin/main).\n- **Machines:** the computers list_machines shows run the workers, each in its own sandbox.\n- **No Unity, FFBox or Discord** in this deployment.\n${note}`,
    [BRIEFS.orchestratorBriefFile]: `${o.project}'s own portal${o.owner ? `, run by ${o.owner}` : ''}. Work lands as pull requests into main of ${o.repo}.\n${note}`,
    [BRIEFS.workerBriefFile]: `You work on ${o.project} (${o.repo}). Open a pull request into main for each change.\n${note}`,
  };
}

/** "F:\ffw\tools\node" as Git Bash reads it: "/f/ffw/tools/node". */
export const msysPath = (p: string) => slash(p).replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

const TOKEN_VARIABLES = 'CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN';

/** The portal's environment: its own config, secrets and Claude folder; FFSB_TASK_NAME names its own logon task (the one an elevated start would hand off to; FFSB_NO_DEELEVATE keeps it from trying). */
export function portalEnv(o: Pick<NewOptions, 'name' | 'dir'>): Record<string, string> {
  return {
    FFSB_CONFIG: under(o.dir, 'config.json'),
    FFSB_SECRETS_DIR: under(o.dir, 'secrets'),
    FFSB_NO_DEELEVATE: '1',
    FF_CLI_SCRUB: 'off',
    FFSB_TASK_NAME: portalTaskName(o.name),
    CLAUDE_CONFIG_DIR: under(o.dir, 'claude-portal'),
  };
}

/** <dir>/start-portal.sh, in the shape of Lens Scout's F:/ffw/lens-factory/start-portal.sh (Git Bash on Windows). */
export function startScript(o: Pick<NewOptions, 'name' | 'project' | 'port' | 'dir'> & { nodeDir: string }): string {
  const env = Object.entries(portalEnv(o))
    .map(([k, v]) => (/^[\w.-]+$/.test(v) ? `${k}=${v}` : `${k}="${v}"`))
    .join(' ');
  return [
    '#!/bin/bash',
    `# Starts the ${o.project} instance's portal (${o.name}) on :${o.port}, made by scripts/instance/new.ts. Its own data, config,`,
    '# vault and Claude config; nothing shared with another portal on this computer.',
    `export PATH="${msysPath(o.nodeDir)}:$PATH"`,
    `export ${env}`,
    `unset ${TOKEN_VARIABLES}`,
    `cd "${under(o.dir, 'app')}" && exec node server/index.ts >> "${under(o.dir, 'portal.log')}" 2>&1`,
    '',
  ].join('\n');
}

const psSingle = (s: string) => `'${s.replace(/'/g, "''")}'`;
const psDouble = (s: string) => s.replace(/[`"$]/g, (c) => `\`${c}`);

/** <dir>/register-tasks.ps1: the portal's logon task, as Lens Scout's F:/ffw/lens-factory/register-tasks.ps1 registers it. */
export function taskScript(o: Pick<NewOptions, 'name' | 'project' | 'port'> & { dir: string; bash: string }): string {
  const task = portalTaskName(o.name);
  const dir = path.win32.normalize(o.dir);
  return [
    `# Registers the ${o.project} instance's portal (${o.name}) as a logon task for this user (scripts/instance/new.ts).`,
    `# Undo: Unregister-ScheduledTask -TaskName ${task} -Confirm:$false`,
    "$ErrorActionPreference = 'Stop'",
    `$bash = ${psSingle(o.bash)}`,
    `$dir = ${psSingle(dir)}`,
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `',
    '  -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    '$user = $env:USERNAME  # the plain name: over ssh USERDOMAIN reads WORKGROUP (docs/project.md, w4038)',
    '# conhost --headless: no console window on the desktop for someone to close by accident.',
    '$action = New-ScheduledTaskAction -Execute \'conhost.exe\' -Argument "--headless `"$bash`" `"$dir\\start-portal.sh`"" -WorkingDirectory $dir',
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName ${psSingle(task)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal \``,
    `  -Description "${psDouble(o.project)} instance ${o.name} on :${o.port} (scripts/instance/new.ts). Folder: $dir" -Force | Out-Null`,
    `Get-ScheduledTask -TaskName ${psSingle(task)} | Select-Object TaskName, State`,
    '',
  ].join('\r\n');
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The macOS LaunchAgent: the start script's environment, kept alive, in a gui or a background (nobody at the screen) session. */
export function plist(o: Pick<NewOptions, 'name' | 'dir'> & { node: string; home: string }): string {
  const env = { PATH: `${path.posix.dirname(o.node)}:${o.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: o.home, ...portalEnv(o) };
  const s = (v: string) => `<string>${xml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${s(launchLabel(o.name))}`,
    `  <key>ProgramArguments</key><array>${s(o.node)}${s('server/index.ts')}</array>`,
    `  <key>WorkingDirectory</key>${s(under(o.dir, 'app'))}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).map(([k, v]) => `    <key>${k}</key>${s(v)}`),
    '  </dict>',
    `  <key>StandardOutPath</key>${s(under(o.dir, 'portal.log'))}`,
    `  <key>StandardErrorPath</key>${s(under(o.dir, 'portal.log'))}`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    // Background too: with nobody logged in at the screen there is no gui domain (docs/project.md, bootstrap error 125).
    `  <key>LimitLoadToSessionType</key><array>${s('Aqua')}${s('Background')}</array>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The launchd domain to bootstrap into: gui/<uid> when it exists, else user/<uid>. */
export const launchDomain = (uid: number, hasGui: boolean) => `${hasGui ? 'gui' : 'user'}/${uid}`;

/** What the computer says, for the refusals. */
export interface World {
  /** The --dir's entries, or undefined when it does not exist. */
  dirEntries?: string[];
  portAnswers: boolean;
  list?: InstanceList;
  /** The ports the listed instances' configs give. */
  listPorts: number[];
}

/** Every reason not to make it; empty when there is none. */
export function refusals(o: NewOptions, w: World): string[] {
  const out: string[] = [];
  if (!INSTANCE_NAME.test(o.name)) out.push(`--name ${JSON.stringify(o.name)}: lower case letters, digits and -, at most 41 (the instance list's rule)`);
  if (!o.project.trim()) out.push('--project: the project\'s name, e.g. "Lens Scout"');
  if (!/^(https:\/\/|git@|ssh:\/\/)\S+$/.test(o.repo)) out.push(`--repo ${JSON.stringify(o.repo)}: the project's git URL (https://github.com/<owner>/<name>.git)`);
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) out.push(`--port ${o.port}: a port from 1024 to 65535`);
  if (!path.isAbsolute(o.dir)) out.push(`--dir ${o.dir}: an absolute folder`);
  // The start script and the task quote it; these would break the quoting.
  if (/["'$`\n]/.test(o.dir)) out.push(`--dir ${o.dir}: no quotes, $ or backticks`);
  if (w.dirEntries?.length) out.push(`--dir ${o.dir} is not empty (${w.dirEntries.slice(0, 3).join(', ')}${w.dirEntries.length > 3 ? ', ...' : ''}): name a new or empty folder`);
  if (w.portAnswers) out.push(`port ${o.port} answers on this computer: pick a free one`);
  if (w.listPorts.includes(o.port)) out.push(`port ${o.port} is a listed instance's: pick another`);
  if (w.list?.instances.some((i) => i.name === o.name)) out.push(`an instance named ${o.name} is in the list already`);
  for (const m of o.machines) if (!MACHINE_ID.test(m)) out.push(`--machines ${m}: a machine id (lower case letters, digits and -)`);
  if (o.payer && !/^[A-Za-z0-9._-]{1,64}$/.test(o.payer)) out.push(`--payer ${o.payer}: a portal user id`);
  if (o.publicUrl && !/^https?:\/\/[^/\s]+\/?$/.test(o.publicUrl)) out.push(`--public-url ${o.publicUrl}: the portal's base URL, e.g. https://<host>.<tailnet>.ts.net`);
  return out;
}

/** The list entry for the new instance. */
export function listEntry(o: Pick<NewOptions, 'name' | 'dir' | 'machines' | 'publicUrl'>, platform: NodeJS.Platform = process.platform): Instance {
  return {
    name: o.name,
    dir: slash(o.dir),
    portalTask: platform === 'darwin' ? launchLabel(o.name) : portalTaskName(o.name),
    machines: o.machines,
    daemonInApp: false,
    expect: { deviceApproval: 'members', ...(o.publicUrl ? { trustProxy: true } : {}), 'machines.keepAgentsOnRestart': true },
  };
}

/** The list with the entry added, checked as the updater checks it; written atomically unless dryRun. */
export function addToList(file: string, entry: Instance, dryRun = false): InstanceList {
  const l = readList(file);
  if (l.instances.some((i) => i.name === entry.name)) throw new Error(`${file}: an instance named ${entry.name} is in it already`);
  l.instances.push(entry);
  const bad = listProblem(l);
  if (bad) throw new Error(`${file} with ${entry.name}: ${bad}`);
  if (!dryRun) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  return l;
}

/** The list ff-instances-update rolls, from its task's arguments (`... update-all.ts --list "<file>"`). */
export function listFromTaskArgs(args: string): string | undefined {
  return /--list\s+(?:"([^"]+)"|(\S+))/.exec(args)?.slice(1).find(Boolean);
}

/** What the person does after the script: the first login, then per machine its record, its credential and its install. */
export function nextSteps(o: NewOptions, here: { host: string; win: boolean; home: string }): string[] {
  const local = `http://127.0.0.1:${o.port}`;
  const url = o.publicUrl?.replace(/\/+$/, '') ?? `http://${here.host}:${o.port}`;
  const cd = `cd "${under(o.dir, 'app')}" && FFSB_CONFIG="${under(o.dir, 'config.json')}" FFSB_SECRETS_DIR="${under(o.dir, 'secrets')}"`;
  const login = (o.owner ?? 'owner').toLowerCase().replace(/[^a-z0-9._-]+/g, '');
  const cred = (m: string) => `${m === here.host ? slash(here.home) : '~'}/${o.name}-${m}.credential`;
  const out = [
    `1. The owner's login (the first login is an owner), on this computer${here.win ? ' in Git Bash' : ''}:`,
    `     ${cd} node server/user.ts ${login}${o.owner ? ` --name "${o.owner}"` : ''} --role owner`,
    `   then sign in at ${o.publicUrl ? url : local} and put your Claude token and GitHub token in its vault (docs/vault.md).`,
  ];
  if (!o.machines.length) out.push('2. No --machines: add each machine as below once you know them (docs/project.md).');
  o.machines.forEach((m, k) => {
    const n = k + 2;
    const self = m === here.host;
    const portal = self ? local : url;
    out.push(
      `${n}. ${m}: its record first, before its daemon dials (10 failed logins lock the address out for 15 minutes).`,
      `   Signed in as the owner: the sidebar's "Add a machine" (id ${m}; its join code), or POST ${url}/api/machines/join {"id":"${m}"} (add "tailnetName" when its tailnet name is not ${m}).`,
    );
    if (self)
      out.push(
        `   Its credential (this computer: the code's redeem needs a tailnet address), here:`,
        `     ${cd} node server/vaultCli.ts machine-credential issue ${m} --out "${cred(m)}"`,
      );
    else
      out.push(
        `   Its credential: on ${m}, redeem the code (from ${m} on the tailnet; the answer holds the credential once):`,
        `     macOS:   curl -fsS -H 'content-type: application/json' --data '{"code":"<CODE>","facts":{"os":"macos"}}' ${url}/machine/join | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));require("fs").writeFileSync(process.argv[1],j.credential+"\\n",{mode:0o600})' ${cred(m)}`,
        `     Windows: (Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{"code":"<CODE>","facts":{"os":"windows"}}' ${url}/machine/join).credential | Set-Content -NoNewline "$HOME/${o.name}-${m}.credential"`,
      );
    const sh = (root: string, file: string) =>
      `bash -c "$(curl -fsSL https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.sh)" -- --instance ${o.name} --root ${root} --portal-url ${portal} --repo-url ${o.repo} --claude-config-dir ${root}/claude --max-unity 0 --credential-file ${file} && rm ${file}`;
    const ps1 = (root: string, file: string) =>
      `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Final-Factory/ff-factory/main/scripts/worker/install.ps1))) -Instance ${o.name} -Root ${root} -PortalUrl ${portal} -RepoUrl ${o.repo} -ClaudeConfigDir ${root}/claude -MaxUnity 0 -CredentialFile ${file}; Remove-Item ${file}`;
    out.push(`   Then on ${m}, as its user and not elevated, its daemon (install --instance; it asks for the limits):`);
    if (self) out.push(`     ${here.win ? ps1(under(o.dir, 'worker'), cred(m)) : sh(under(o.dir, 'worker'), cred(m))}`);
    else out.push(`     macOS:   ${sh(`~/${o.name}/worker`, cred(m))}`, `     Windows: ${ps1(`<drive>:/${o.name}/worker`, `"$HOME/${o.name}-${m}.credential"`)}`);
  });
  out.push(`${o.machines.length + 2}. list_machines in the portal shows each online once its daemon connects; the updater rolls this instance with the others.`);
  return out;
}

// ---------------------------------------------------------------- the real world

const isWin = process.platform === 'win32';

function sh(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { code: r.status ?? 1, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}
const ps = (script: string) => sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);

function portAnswers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const end = (v: boolean) => {
      s.destroy();
      done(v);
    };
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
    s.setTimeout(1500, () => end(false));
  });
}

async function healthy(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (((await r.json()) as { ok?: boolean }).ok === true) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function gitBash(): string | undefined {
  const roots = [process.env.ProgramFiles, process.env.ProgramW6432, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  return roots.filter((r): r is string => !!r).map((r) => path.join(r, 'Git', 'bin', 'bash.exe')).find((f) => fs.existsSync(f));
}

/** The updater's list: its task's --list, else instances.json beside the --from checkout. */
function defaultList(from: string): string | undefined {
  if (isWin) {
    const r = ps("$t = Get-ScheduledTask -TaskName 'ff-instances-update' -ErrorAction SilentlyContinue; if ($t) { $t.Actions[0].Arguments }");
    const f = r.code === 0 ? listFromTaskArgs(r.out) : undefined;
    if (f && fs.existsSync(f)) return f;
  }
  const beside = path.join(path.dirname(from), 'instances.json');
  return fs.existsSync(beside) ? beside : undefined;
}

const USAGE =
  'usage: node scripts/instance/new.ts --name <slug> --project "<Project Name>" --repo <git url> --port <n> --dir <folder> [--machines a,b,c] [--owner <Name>] [--payer <id>] [--public-url <url>] [--list <instances.json>] [--from <ff-factory checkout>] [--dry-run]';

export function parseOptions(argv: string[]): NewOptions {
  const { values: v } = parseArgs({
    args: argv,
    options: Object.fromEntries([
      ...['name', 'project', 'repo', 'port', 'dir', 'machines', 'owner', 'payer', 'public-url', 'list', 'from'].map((k) => [k, { type: 'string' as const }]),
      ['dry-run', { type: 'boolean' as const }],
    ]),
    strict: true,
  }) as { values: Record<string, string | boolean | undefined> };
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string).trim() : undefined);
  for (const k of ['name', 'project', 'repo', 'port', 'dir']) if (!str(k)) throw new Error(`--${k} is missing\n${USAGE}`);
  return {
    name: str('name')!,
    project: str('project')!,
    repo: str('repo')!,
    port: Number(str('port')),
    dir: path.resolve(str('dir')!),
    machines: (str('machines') ?? '').split(',').map((m) => m.trim().toLowerCase()).filter(Boolean),
    owner: str('owner') || undefined,
    payer: str('payer') || undefined,
    publicUrl: str('public-url') || undefined,
    list: str('list') ? path.resolve(str('list')!) : undefined,
    from: path.resolve(str('from') ?? path.join(import.meta.dirname, '..', '..')),
    dryRun: v['dry-run'] === true,
  };
}

async function main() {
  const o = parseOptions(process.argv.slice(2));
  if (!isWin && process.platform !== 'darwin') throw new Error(`instances run on Windows and macOS (this is ${process.platform})`);
  const dry = o.dryRun;
  const say = (s: string) => console.log(s);
  const step = (s: string) => say(`\n== ${s}${dry ? ' (dry run)' : ''}`);
  const write = (file: string, text: string, mode?: number) => {
    if (dry) return say(`would write ${file}:\n${text.replace(/^/gm, '    ')}`);
    fs.writeFileSync(file, text, mode ? { mode } : {});
    say(`wrote ${file}`);
  };

  step('1. Checks');
  const listFile = o.list ?? defaultList(o.from);
  const list = listFile ? readList(listFile) : undefined;
  const listPorts = (list?.instances ?? []).flatMap((i) => {
    try {
      return [resolve(i).port];
    } catch {
      return [];
    }
  });
  const dirEntries = fs.existsSync(o.dir) ? fs.readdirSync(o.dir) : undefined;
  const bash = isWin ? gitBash() : '/bin/bash';
  const bad = refusals(o, { dirEntries, portAnswers: await portAnswers(o.port), list, listPorts });
  if (!bash) bad.push('Git for Windows\' bash.exe is not under Program Files: the start script runs in it');
  const head = sh('git', ['-C', o.from, 'rev-parse', 'HEAD']);
  const origin = sh('git', ['-C', o.from, 'config', '--get', 'remote.origin.url']);
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.out)) bad.push(`--from ${o.from} is not a git checkout of ff-factory`);
  else if (origin.code !== 0 || !origin.out) bad.push(`--from ${o.from} has no origin to clone from`);
  const cfg = configFor(o);
  try {
    checkConfig(cfg);
  } catch (e) {
    bad.push(`the config it would write is refused by the portal: ${(e as Error).message}`);
  }
  if (bad.length) {
    for (const b of bad) console.error(`refused: ${b}`);
    process.exit(2);
  }
  say(`${o.name}: ${o.project} on :${o.port} in ${o.dir}, ff-factory ${head.out.slice(0, 9)} from ${origin.out}; list ${listFile ?? 'none (skipped)'}`);

  step('2. Folders, ff-factory, the project');
  const app = path.join(o.dir, 'app');
  for (const d of ['data', 'secrets', 'claude-portal', path.join('pack', 'briefs')]) {
    if (dry) say(`would make ${path.join(o.dir, d)}`);
    else fs.mkdirSync(path.join(o.dir, d), { recursive: true });
  }
  const run = (what: string, cmd: string, args: string[], cwd?: string) => {
    if (dry) return say(`would run: ${cmd} ${args.join(' ')}`);
    say(`${what}...`);
    const r = sh(cmd, args, cwd);
    if (r.code !== 0) throw new Error(`${what} failed: ${r.out.split('\n').slice(-3).join(' | ')}`);
  };
  run('clone ff-factory', 'git', ['clone', '--quiet', '-c', 'core.autocrlf=false', origin.out, app]);
  run(`check out ${head.out.slice(0, 9)}`, 'git', ['-C', app, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', head.out]);
  const nodeDir = path.dirname(process.execPath);
  if (dry) say(`would build ${app} (npm ci, the web's npm ci and build: update-all's build)`);
  else {
    say('npm ci and the web build...');
    realDeps({ version: 1, leader: { url: '' }, instances: [], nodeDir }, path.join(o.dir, 'instance-new.log')).build(app);
  }
  // The orchestrators read the project from here; a clone that fails (no GitHub login here) is a next step, not a stop.
  let baseNote = '';
  if (dry) say(`would run: git clone ${o.repo} ${path.join(o.dir, 'base')}`);
  else {
    const r = sh('git', ['clone', '--quiet', o.repo, path.join(o.dir, 'base')]);
    baseNote = r.code === 0 ? '' : `the project's base clone failed (${r.out.split('\n').pop()}): git clone ${o.repo} "${under(o.dir, 'base')}"`;
    say(baseNote || `cloned ${o.repo} into ${path.join(o.dir, 'base')}`);
  }

  step('3. Vault key, config, briefs');
  const keyFile = path.join(o.dir, 'secrets', 'vault.key');
  if (dry) say(`would write ${keyFile} (a new vault key, 0600; never shown)`);
  else {
    fs.writeFileSync(`${keyFile}.tmp`, newKeyText(), { mode: 0o600 });
    fs.chmodSync(`${keyFile}.tmp`, 0o600);
    fs.renameSync(`${keyFile}.tmp`, keyFile);
    say(`wrote ${keyFile} (0600; its content is not shown)`);
  }
  write(path.join(o.dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  for (const [f, text] of Object.entries(briefs(o))) write(path.join(o.dir, 'pack', 'briefs', f), text);

  step('4. Start script and task');
  const home = os.homedir();
  let start: () => void;
  if (isWin) {
    write(path.join(o.dir, 'start-portal.sh'), startScript({ ...o, nodeDir }));
    const reg = path.join(o.dir, 'register-tasks.ps1');
    write(reg, taskScript({ ...o, bash: bash! }));
    run(`register ${portalTaskName(o.name)}`, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', reg]);
    start = () => run(`start ${portalTaskName(o.name)}`, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-ScheduledTask -TaskName ${psSingle(portalTaskName(o.name))}`]);
  } else {
    const label = launchLabel(o.name);
    const file = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    if (!dry) fs.mkdirSync(path.dirname(file), { recursive: true });
    write(file, plist({ ...o, node: process.execPath, home }));
    const uid = process.getuid!();
    const domain = launchDomain(uid, sh('launchctl', ['print', `gui/${uid}`]).code === 0);
    start = () => {
      if (dry) return say(`would run: launchctl bootout ${domain}/${label}; wait for it to go; launchctl bootstrap ${domain} ${file}`);
      sh('launchctl', ['bootout', `${domain}/${label}`]);
      // A bootstrap before the bootout has finished fails with error 5 (docs/project.md).
      for (let t = 0; t < 30 && sh('launchctl', ['print', `${domain}/${label}`]).code === 0; t++) spawnSync('sleep', ['1']);
      const r = sh('launchctl', ['bootstrap', domain, file]);
      if (r.code !== 0) throw new Error(`launchctl bootstrap ${domain} ${file}: ${r.out}`);
      say(`bootstrapped ${label} into ${domain}`);
    };
  }

  step('5. Start and health');
  start();
  let up = true;
  if (dry) say(`would wait up to 3 min for http://127.0.0.1:${o.port}/api/health`);
  else {
    up = await healthy(o.port, 3 * 60_000);
    say(up ? `http://127.0.0.1:${o.port}/api/health answers ok` : `NOT answering after 3 min: see ${path.join(o.dir, 'portal.log')}`);
  }

  step('6. The instance list');
  const entry = listEntry(o);
  if (!listFile) say(`no instance list on this computer (no ff-instances-update task, no instances.json beside ${o.from}): skipped. Add this to one by hand (docs/instances.md):\n${JSON.stringify(entry, null, 2)}`);
  else {
    addToList(listFile, entry, dry);
    say(`${dry ? 'would add' : 'added'} ${o.name} to ${listFile}:\n${JSON.stringify(entry, null, 2)}`);
  }

  step('7. Next steps (they need the owner)');
  if (baseNote) say(`0. ${baseNote}`);
  for (const l of nextSteps(o, { host: os.hostname().toLowerCase(), win: isWin, home })) say(l);
  if (!up) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
