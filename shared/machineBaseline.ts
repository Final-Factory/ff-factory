// Machine baseline (w6603, lothsahn: "every windows box should be the same, etc aside from sizing"): what a daemon reports
// of its tools and features, and where machines of one OS disagree. Warn only: the portal shows the differences
// (list_machines, the daemon's hello in its journal) and changes nothing.
//
// A difference is one of three kinds: sizing (agents, editors, sandboxes, RAM/CPU/disk thresholds: allowed and never
// reported here), an OS difference (allowed: machines are only compared with machines of their own OS) or drift (any
// other key on which two machines of one OS disagree).

import type { MachinePlatform } from './types.ts';

/** What one daemon reports (its hello's info.baseline). Values are short strings; "unset" where a key has no value. */
export interface MachineBaseline {
  /** Tool versions as the tool itself prints them (`git --version`, ...), or "missing" / "failed: <why>". */
  tools: Record<string, string>;
  /** The daemon's feature keys (FEATURE_KEYS), each as normalised JSON; paths under its root read <root>. */
  flags: Record<string, string>;
}

/**
 * The daemon.json keys that turn features, fences and hardening on or off: the ones every machine of an OS should agree
 * on. Every other DaemonConfig key is in NON_FEATURE_KEYS (a test keeps the two lists covering it exactly).
 */
export const FEATURE_KEYS = [
  'workerFence',
  'workerPrefFence',
  'workerCaps',
  'workerIntegrity',
  'mediumAgentFolders',
  'mediumAgentCaches',
  'workerIntegrityAllow',
  'workerIntegrityLockGameData',
  'workerTranscriptLabels',
  'editorFence',
  'agentHosts',
  'tray',
  'foregroundLockGuard',
  'leftovers',
  'writeLock',
  'writeLockExtra',
  'transcriptLock',
  'editorTmpdir',
  'daemonTmpdir',
  'toolsDiskLock',
  'winCiFirst',
  'runnerPriority',
  'pathFence',
  'storeLock',
  'sharedLock',
  'hostRestage',
  'liveRunGuard',
  'editorGitPackages',
  'longRuns',
  'sandboxCacheTrim',
  'freezeWatch',
  'unityMcpScopedHome',
  'pinnedPortalHosts',
] as const;

/**
 * The DaemonConfig keys left out of the baseline, on purpose. Identity and folders: env, extraRoots, portalUrl, id, token,
 * tokenFile, root, repoPath, claude, appDir, unityEditorRoot, unityPath, tempDir, maxEventsFile, unityMcpServer,
 * previousPortalUrl, relocatedAt, configFile, unitySlotsDir, slotQueueDir. Sizing and timing: maxSessions, sandboxes,
 * sandboxIdleStopMinutes, sessionSweep, cleanup. One machine's own: hostGuard (the portal host's guard), voice (a GPU
 * machine's), updateOrigin (tests only).
 */
export const NON_FEATURE_KEYS = [
  'env', 'extraRoots', 'portalUrl', 'id', 'token', 'tokenFile', 'root', 'repoPath', 'claude', 'appDir', 'unityEditorRoot',
  'unityPath', 'tempDir', 'maxEventsFile', 'unityMcpServer', 'previousPortalUrl', 'relocatedAt', 'configFile',
  'unitySlotsDir', 'slotQueueDir', 'maxSessions', 'sandboxes', 'sandboxIdleStopMinutes', 'sessionSweep', 'cleanup',
  'hostGuard', 'voice', 'updateOrigin',
] as const;

/** Feature keys whose value is sizing (sandboxCacheTrim's kept builds and GB): compared only as on, off or unset. */
const ON_OFF_KEYS: ReadonlySet<string> = new Set(['sandboxCacheTrim']);

/** The tools a daemon reports, in the order list_machines shows them. */
export const BASELINE_TOOLS = ['daemonNode', 'agentNode', 'claude', 'git', 'bash', 'gh', 'python', 'uv'] as const;

const MAX_VALUE = 160;

/** A value as one comparable string: JSON with sorted keys, the root and home written as <root> and <home>. */
export function flagValue(v: unknown, o: { root?: string; home?: string } = {}): string {
  if (v === undefined) return 'unset';
  let s = JSON.stringify(sortKeys(v)) ?? 'unset';
  for (const [dir, name] of [[o.root, '<root>'], [o.home, '<home>']] as const) {
    if (!dir) continue;
    for (const form of new Set([dir, dir.replace(/\\/g, '/'), JSON.stringify(dir).slice(1, -1)])) s = s.split(form).join(name);
  }
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** The daemon's feature flags from its config, normalised (FEATURE_KEYS). */
export function featureFlags(cfg: Record<string, unknown>, o: { root?: string; home?: string } = {}): Record<string, string> {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, ON_OFF_KEYS.has(k) && cfg[k] !== undefined ? (cfg[k] === false ? 'off' : 'on') : flagValue(cfg[k], o)]));
}

/** The version in a tool's first output line ("git version 2.56.1.windows.1" -> "2.56.1.windows.1"), else the line. */
export function versionOf(out: string): string {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l)) ?? '';
  const m = /v?(\d+\.\d+(?:\.\d+)?(?:[.\-+][0-9A-Za-z.]+)?)/.exec(line);
  return (m ? m[1] : line).slice(0, 60) || 'unknown';
}

export interface BaselineMachine {
  id: string;
  platform?: MachinePlatform;
  baseline?: MachineBaseline;
  /** The portal's own non-sizing sandbox settings for it (belowNormal, slotRepos, Library seed, commit check). */
  portal?: Record<string, string>;
}

/** One key on which machines of one OS disagree: each value and the machines that have it. */
export interface Drift {
  key: string;
  values: { value: string; machines: string[] }[];
}

/**
 * Where machines of one OS disagree, key by key (tools as tool.<name>, flags as flag.<name>, the portal's as
 * portal.<name>). Machines without a report are left out; a key only one machine reports is no drift.
 */
export function baselineDrift(machines: BaselineMachine[]): Map<MachinePlatform, Drift[]> {
  const out = new Map<MachinePlatform, Drift[]>();
  const byOs = new Map<MachinePlatform, BaselineMachine[]>();
  for (const m of machines) {
    if (!m.platform || (!m.baseline && !m.portal)) continue;
    byOs.set(m.platform, [...(byOs.get(m.platform) ?? []), m]);
  }
  for (const [os, ms] of byOs) {
    const keys = new Map<string, Map<string, string[]>>();
    const add = (key: string, value: string, id: string) => {
      const vals = keys.get(key) ?? new Map<string, string[]>();
      vals.set(value, [...(vals.get(value) ?? []), id]);
      keys.set(key, vals);
    };
    for (const m of ms) {
      for (const [k, v] of Object.entries(m.baseline?.tools ?? {})) add(`tool.${k}`, v, m.id);
      for (const [k, v] of Object.entries(m.baseline?.flags ?? {})) add(`flag.${k}`, v, m.id);
      for (const [k, v] of Object.entries(m.portal ?? {})) add(`portal.${k}`, v, m.id);
    }
    const drifts: Drift[] = [];
    for (const [key, vals] of [...keys].sort(([a], [b]) => a.localeCompare(b))) {
      const reported = [...vals.values()].reduce((n, ids) => n + ids.length, 0);
      if (vals.size < 2 || reported < 2) continue;
      drifts.push({ key, values: [...vals].map(([value, ids]) => ({ value, machines: ids.sort() })).sort((a, b) => b.machines.length - a.machines.length || a.value.localeCompare(b.value)) });
    }
    if (drifts.length) out.set(os, drifts);
  }
  return out;
}

/** One machine's drift in a line ("tool.python 3.10.11 (beast: 3.12.10 lothdesktop)"), or undefined when none. */
export function driftLine(id: string, drifts: Drift[] | undefined): string | undefined {
  const mine = (drifts ?? []).filter((d) => d.values.some((v) => v.machines.includes(id)));
  if (!mine.length) return undefined;
  return mine
    .map((d) => {
      const own = d.values.find((v) => v.machines.includes(id))!.value;
      const others = d.values.filter((v) => !v.machines.includes(id)).map((v) => `${v.value} on ${v.machines.join(', ')}`);
      return `${d.key} ${own} (${others.join('; ')})`;
    })
    .join('; ');
}

/** A daemon's reported baseline, kept only as short strings (at most 64 keys a side, 160 characters a value), else undefined. */
export function sanitizeBaseline(v: unknown): MachineBaseline | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const side = (x: unknown) =>
    Object.fromEntries(
      Object.entries(x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {})
        .filter(([k, val]) => /^[A-Za-z0-9_.-]{1,40}$/.test(k) && typeof val === 'string')
        .slice(0, 64)
        .map(([k, val]) => [k, (val as string).slice(0, MAX_VALUE)]),
    );
  const b = v as Record<string, unknown>;
  return { tools: side(b.tools), flags: side(b.flags) };
}

/** The portal's own non-sizing sandbox settings of a machine, as BaselineMachine.portal compares them. */
export function portalSettings(p: { librarySeed?: string; belowNormal?: boolean; slotRepos?: string; commitCheck?: string } | null): Record<string, string> | undefined {
  if (!p) return undefined;
  return { librarySeed: p.librarySeed ? 'set' : 'unset', belowNormal: p.belowNormal ? 'on' : 'off', slotRepos: p.slotRepos ?? 'unset', commitCheck: p.commitCheck ?? 'on' };
}
