// Moving the portal from BEAST into its VM (w499; docs/portal-on-ffbox-host.md section 7, deploy/vm/RUNBOOK.md "Dry
// run" and "Cut-over"): what scripts/fff-migrate.ts does to the copy of BEAST's config.json and data/, as pure
// functions over parsed JSON, so each rewrite is tested on its own. Nothing here reads, writes or runs anything.

import { usesHostClaudeEnv } from './secrets.ts';
import { nextPerMachine } from './appConfig.ts';
import { retiredConfigKeys, withDefaults, withoutRetiredKeys } from './config.ts';
import { convertMachineRecord, localDaemonExtras } from './machines.ts';
import type { Machine, SessionInfo, StandingAgent } from '../shared/types.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A Windows absolute path ("C:/ffsb", "F:\\ffsb\\x"). */
export const isWindowsPath = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z]:([\\/]|$)/.test(v);

/**
 * The folder Claude Code keeps a working directory's conversations in, under <config dir>/projects: the cwd with every
 * character that is not a letter or a digit turned into "-". Measured on BEAST (2026-10-05): C:\ffsb\_base is
 * "C--ffsb--base", F:\ffsb\shader-blackhole is "F--ffsb-shader-blackhole"; in the VM /srv/fff/base is "-srv-fff-base".
 */
export const claudeProjectFolder = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** Every string value in `v` that is a Windows path, with its key path ("repo.basePath", "protectedPaths[0]"). */
export function windowsPathsIn(v: unknown, at = ''): { key: string; value: string }[] {
  if (isWindowsPath(v)) return [{ key: at || '(value)', value: v }];
  if (Array.isArray(v)) return v.flatMap((x, i) => windowsPathsIn(x, `${at}[${i}]`));
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => windowsPathsIn(x, at ? `${at}.${k}` : k));
  return [];
}

/**
 * The keys whose value is where things are on the computer the portal runs on: the VM's config.json has them right, and
 * BEAST's would be wrong there. Whole values, replaced as they are.
 */
export const HOST_KEYS = ['port', 'host', 'trustProxy', 'dataDir', 'sandboxRoot', 'standingRoot', 'unity', 'protectedPaths', 'hostDiskPaths', 'review', 'voice', 'hostGuard'] as const;

export interface ConfigRewrite {
  config: Json;
  /** What was changed beyond the host keys, for the report (never a value that could be a secret). */
  notes: string[];
  /** Windows paths left in the result: the portal may refuse them (loadConfig) or use them wrongly. */
  windowsPaths: { key: string; value: string }[];
}

/**
 * BEAST's config.json as the VM's portal runs it (design 7.3 step 5): BEAST's settings, people, tokens, intake, FFBox and
 * machine settings, with this computer's paths and server settings from the VM's own config.json (`vm`, which the guest
 * install and `fffctl configure` wrote), voice off, `publicUrl`, the
 * orchestrators and the dispatcher on the token file when the VM has one (design 5.2), keepAgentsOnRestart, and
 * machines.useHostClaudeEnv set for BEAST so its workers keep the account they have today (design 5.3). The keys the
 * portal's own sandbox pool had (w510, config RETIRED_CONFIG_KEYS) are left out.
 */
export function rewriteConfig(beast: Json, vm: Json, o: { publicUrl: string; beastId: string }): ConfigRewrite {
  const notes: string[] = [];
  const out: Json = structuredClone(beast);
  for (const k of HOST_KEYS) {
    if (vm[k] === undefined) delete out[k];
    else out[k] = structuredClone(vm[k]);
  }
  out.publicUrl = o.publicUrl;
  // The base clone the orchestrators read is the VM's; the host-sandbox seeding (reference repo, Library seed) is not used.
  const repo: Json = { ...(isObj(beast.repo) ? beast.repo : {}), ...(isObj(vm.repo) ? { basePath: vm.repo.basePath } : {}) };
  for (const k of ['referenceRepo', 'librarySeed', 'librarySeedGB', 'librarySeedCopy']) delete repo[k];
  if (isObj(vm.repo) && !repo.url && vm.repo.url) repo.url = vm.repo.url;
  out.repo = repo;
  // The portal holds no sandboxes or editors (w510): of the limits only minFreeRamGB is left, the VM's own.
  if (isObj(vm.limits)) out.limits = pick(vm.limits, ['minFreeRamGB']);
  if (!out.ownerName && vm.ownerName) out.ownerName = vm.ownerName;
  // The subscription token the guest stored (fffctl claude-token, design 5.2).
  if (typeof vm.claudeTokenFile === 'string' && vm.claudeTokenFile) {
    out.claudeTokenFile = vm.claudeTokenFile;
    out.claudeAccounts = { ...(isObj(beast.claudeAccounts) ? beast.claudeAccounts : {}), orchestrator: 'tokenfile', dispatcher: 'tokenfile' };
    notes.push('the orchestrators and the dispatcher run on the stored subscription token (claudeAccounts "tokenfile")');
  } else notes.push('the VM has no claudeTokenFile: the orchestrators and the dispatcher keep BEAST\'s accounts (run fffctl claude-token and fffctl configure --claude-tokenfile first)');
  // BEAST's workers keep their account: as the portal's own host it followed claudeAccounts.workers; as a machine it
  // follows machines.useHostClaudeEnv, whose default is true (design 5.3).
  const machines: Json = { ...(isObj(beast.machines) ? beast.machines : {}), keepAgentsOnRestart: true };
  const u = machines.useHostClaudeEnv;
  if (!(isObj(u) && typeof u[o.beastId] === 'boolean')) {
    const keep = usesHostClaudeEnv(withDefaults(beast), { id: o.beastId, local: true } as Machine);
    machines.useHostClaudeEnv = nextPerMachine(u, o.beastId, keep);
    notes.push(`machines.useHostClaudeEnv for ${o.beastId}: ${keep} (its workers ${keep ? 'run on this portal\'s token, as they do now' : 'keep its own stored login, as they do now'})`);
  }
  out.machines = machines;
  // Paths only BEAST had: Max's FFBox config folder and events file, an orchestrator memory folder, voice tools.
  dropWindowsPaths(out, 'max', notes);
  dropWindowsPaths(out, 'orchestrator', notes);
  // Keys nothing reads any more (w510: the portal's own sandbox pool, editors and standing agents) are left behind.
  const retired = retiredConfigKeys(out);
  if (retired.length) notes.push(`left out, as nothing reads them any more (w510): ${retired.join(', ')}`);
  const config = withoutRetiredKeys(out);
  return { config, notes, windowsPaths: windowsPathsIn(config) };
}

function pick(o: Json, keys: string[]): Json {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

function dropWindowsPaths(cfg: Json, key: string, notes: string[]) {
  const block = cfg[key];
  if (!isObj(block)) return;
  for (const [k, v] of Object.entries(block)) {
    if (isWindowsPath(v)) {
      delete block[k];
      notes.push(`${key}.${k} dropped (a path on BEAST): the default applies`);
    }
  }
}

export interface StateRewrite {
  state: Json;
  notes: string[];
}

/**
 * BEAST's data/state.json for the VM's portal: BEAST's own machine record goes from local to ssh (change 3, as
 * convert_machine does, keeping its sandboxes, agents and token), and every machine's portalUrl becomes the VM's
 * public URL, which redeploys write into daemon.json. A standing agent with no machine had its folder on BEAST: it gets
 * one under the VM's standingRoot (it does not run there, D16, until it is moved to a machine).
 */
export function rewriteState(state: Json, o: { beastId: string; sshHost: string; publicUrl: string; beastConfig: Json; standingRoot: string }): StateRewrite {
  const notes: string[] = [];
  const out: Json = structuredClone(state);
  const machines = Array.isArray(out.machines) ? (out.machines as Machine[]) : [];
  const beastCfg = withDefaults(o.beastConfig);
  out.machines = machines.map((m) => {
    if (m.id === o.beastId && m.local) {
      const next = convertMachineRecord(m, 'ssh', { sshHost: o.sshHost, portalUrl: o.publicUrl, port: beastCfg.port, extras: localDaemonExtras(beastCfg) });
      notes.push(`${m.id}: from the portal's own host to a machine reached over ssh (${o.sshHost}), dialling ${o.publicUrl}`);
      return next;
    }
    if (m.local) notes.push(`${m.id} is marked local but is not ${o.beastId}: left as it is`);
    if (m.portalUrl !== o.publicUrl) notes.push(`${m.id}: portal URL ${m.portalUrl ?? '(none)'} -> ${o.publicUrl}`);
    return { ...m, portalUrl: o.publicUrl };
  });
  if (!machines.some((m) => m.id === o.beastId)) notes.push(`no machine "${o.beastId}" in the state: nothing converted`);
  const standing = Array.isArray(out.standingAgents) ? (out.standingAgents as StandingAgent[]) : [];
  out.standingAgents = standing.map((a) => {
    if (a.machineId || !isWindowsPath(a.folder)) return a;
    const folder = `${o.standingRoot.replace(/\/+$/, '')}/${a.id}`;
    notes.push(`standing agent ${a.id}: folder ${a.folder} -> ${folder}`);
    return { ...a, folder };
  });
  return { state: out, notes };
}

/** data/outside-watch.json without BEAST's network adapter (its MAC, address and broadcast): the VM has its own. */
export function cleanOutsideWatch(s: Json): Json {
  const out = { ...s };
  for (const k of ['mac', 'ip', 'broadcast', 'collectedAt']) delete out[k];
  return out;
}

/** One conversation to carry over: its Claude session id and the project folders it moves between (change 10). */
export interface HistoryMove {
  sessionId: string;
  kind: 'orchestrator' | 'standing';
  title: string;
  sdkSessionId: string;
  fromFolder: string;
  toFolder: string;
}

/**
 * Which Claude Code conversations the VM's portal resumes and where they go (design change 10): every orchestrator's
 * (the dispatcher's and each person's), whose cwd is the base clone, and each standing agent's on this host (no
 * machine), whose cwd is its folder. Workers and agents on machines keep theirs where they run.
 */
export function historyPlan(state: Json, o: { beastBase: string; vmBase: string; vmStandingRoot: string }): HistoryMove[] {
  const sessions = Array.isArray(state.sessions) ? (state.sessions as SessionInfo[]) : [];
  const standing = new Map((Array.isArray(state.standingAgents) ? (state.standingAgents as StandingAgent[]) : []).map((a) => [a.id, a]));
  const out: HistoryMove[] = [];
  for (const s of sessions) {
    if (!s.sdkSessionId || !/^[\w-]+$/.test(s.sdkSessionId) || s.machineId) continue;
    if (s.kind === 'orchestrator') {
      out.push({ sessionId: s.id, kind: 'orchestrator', title: s.title, sdkSessionId: s.sdkSessionId, fromFolder: claudeProjectFolder(o.beastBase), toFolder: claudeProjectFolder(o.vmBase) });
    } else if (s.kind === 'standing' && s.standingId) {
      const a = standing.get(s.standingId);
      if (!a || a.machineId || !a.folder) continue;
      out.push({ sessionId: s.id, kind: 'standing', title: s.title, sdkSessionId: s.sdkSessionId, fromFolder: claudeProjectFolder(a.folder), toFolder: claudeProjectFolder(`${o.vmStandingRoot.replace(/\/+$/, '')}/${a.id}`) });
    }
  }
  return out;
}

/** What the dry run compares between BEAST's copy and what the VM's portal holds after it started. */
export interface Counts {
  sessions: number;
  orchestrators: number;
  sandboxes: number;
  machines: number;
  standingAgents: number;
  workItems: number;
  transcripts: number;
}

export function countsOf(state: Json, work: Json | undefined, transcripts: number): Counts {
  const n = (k: string) => (Array.isArray(state[k]) ? (state[k] as unknown[]).length : 0);
  return {
    sessions: n('sessions'),
    orchestrators: Array.isArray(state.sessions) ? (state.sessions as SessionInfo[]).filter((s) => s.kind === 'orchestrator').length : 0,
    sandboxes: n('sandboxes'),
    machines: n('machines'),
    standingAgents: n('standingAgents'),
    workItems: work && Array.isArray(work.items) ? work.items.length : 0,
    transcripts,
  };
}

/** The keys where two counts differ, "key: a vs b". */
export function countDiffs(a: Counts, b: Counts): string[] {
  return (Object.keys(a) as (keyof Counts)[]).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} vs ${b[k]}`);
}

// ---------------------------------------------------------------- the file manifest (the resumable copy)

/** One file on BEAST: its path relative to the root (forward slashes), size in bytes, and mtime in ms. */
export interface ManifestEntry {
  path: string;
  size: number;
  mtime: number;
  /** Its line in the list BEAST kept of this listing (w508): batches name files by these numbers, never by their names. */
  index?: number;
}

/**
 * Lines of "<size>\t<mtime ms>\t<relative path>" (the manifest script's output), in order; bad lines are skipped. A line
 * starting with "#" is a note (the folder BEAST kept the list in), not a file. Each entry's index is its line among the
 * file lines, as BEAST numbered them in the list it kept.
 */
export function parseManifest(text: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  let index = -1;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    index++;
    const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    const p = m[3].replace(/\\/g, '/');
    if (p.startsWith('/') || p.split('/').includes('..')) continue;
    out.push({ path: p, size: Number(m[1]), mtime: Number(m[2]), index });
  }
  return out;
}

/** The folder BEAST kept a listing's file list in: its "#dir\t<path>" line. */
export function manifestDir(text: string): string | undefined {
  return /^#dir\t(.+?)\r?$/m.exec(text)?.[1];
}

/**
 * The files to copy, in batches of at most `maxFiles` files and `maxBytes` bytes (a larger file alone), in the order
 * BEAST listed them. Each batch is one tar stream, checked and retried on its own (w508).
 */
export function batchPlan(files: ManifestEntry[], o: { maxFiles: number; maxBytes: number }): ManifestEntry[][] {
  const out: ManifestEntry[][] = [];
  let cur: ManifestEntry[] = [];
  let bytes = 0;
  for (const e of [...files].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    if (cur.length && (cur.length >= o.maxFiles || bytes + e.size > o.maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(e);
    bytes += e.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Line numbers as ranges, "0-1999,2105,2107-2110": how a batch is named to BEAST, in a few bytes (w508). */
export function indexSpec(indices: number[]): string {
  const s = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]));
    i = j + 1;
  }
  return parts.join(',');
}

/** The numbers an indexSpec names. */
export function expandSpec(spec: string): number[] {
  if (!spec) return [];
  return spec.split(',').flatMap((p) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(p);
    if (!m) throw new Error(`not an index range: ${p}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    return Array.from({ length: b - a + 1 }, (_, k) => a + k);
  });
}

/** What to fetch (new or changed in size or mtime) and what to remove from the copy (gone on BEAST). */
export function manifestDiff(remote: ManifestEntry[], have: ManifestEntry[]): { fetch: ManifestEntry[]; remove: string[] } {
  const mine = new Map(have.map((e) => [e.path, e]));
  const theirs = new Set(remote.map((e) => e.path));
  return {
    fetch: remote.filter((e) => {
      const h = mine.get(e.path);
      return !h || h.size !== e.size || h.mtime !== e.mtime;
    }),
    remove: have.filter((e) => !theirs.has(e.path)).map((e) => e.path),
  };
}

/** Whether a path under BEAST's data folder stays behind: big Windows-only tools, and its supervisor's own files. */
export function skipOnCopy(rel: string): boolean {
  return /^data\/(tools\/|supervisor\.pid$|supervisor\.log(\.\d+)?$|restart\.request$|restart\.lock$|drain\.done$|update\.request$|deelevate\.last$|relocate\.result\.json$)/.test(rel);
}

/**
 * Files in the copy that hold secrets: removed (overwritten first) by the dry run's rollback, so no copy of BEAST's
 * tokens, keys, logins or sessions stays in the VM (the brief: "wipes the copied secrets").
 */
export const SECRET_FILES = ['config/config.json', 'data/machine-tokens.json', 'data/api-keys.json', 'data/users.json', 'data/auth-sessions.json', 'data/vapid.json', 'data/push-subscriptions.json', 'data/outside-watch.json'];
