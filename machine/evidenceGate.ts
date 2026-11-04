// The Evidence gate before a merge (w3088). The game repo's CLAUDE.md: "A PR that changes simulation or what a player sees
// carries an `## Evidence` section, checked with that skill's `pr_evidence.py` before it merges." w3080's #3180 merged on
// green CI with its section still failing: the worker ran `pr_evidence.py --pr 3180` with no --repo, which printed only a
// usage error (exit 2), and `ff-pr merge` in the same command merged. So both merge paths that act without a person,
// `ff-pr merge` (machine/prFlow.ts) and the merge-on-green pilot (server/blockerWatch.ts ghMerge, w2045), run
// `pr_evidence.py --repo <repo> --pr <n>` first (for the game repo and ffu, EVIDENCE_GATED) and refuse on anything but exit 0: a FAIL, a usage error, a gh failure, or
// no python or no script to run. The script decides which pull requests it covers: one with no game code or assets
// changed prints "PASS: no game code or assets changed" and exits 0, so docs, tools and tests still merge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The repositories whose pull requests the gate checks (lower case). ffu since w3098: pr_evidence.py holds an ffu PR that
 * touches art/ or the code that draws the image (ffu-bake, ffu-render, a .wgsl; w2895, w3097) to its 'Reference capture:'
 * and 'Art language:' lines, and passes any other ffu PR ("no game code or assets changed", exit 0).
 */
export const EVIDENCE_GATED = new Set(['final-factory/finalfactory', 'final-factory/ffu']);

export const evidenceGated = (repo: string) => EVIDENCE_GATED.has(repo.toLowerCase());

/** The python the script runs under: FF_PYTHON, else python on Windows and python3 elsewhere (machine/benchQueue.ts). */
export const evidencePython = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) =>
  env.FF_PYTHON || (platform === 'win32' ? 'python' : 'python3');

const SCRIPT = path.join('skills', 'evidence-gate', 'pr_evidence.py');

function pluginVersion(plugin: string, read: (p: string) => string): number[] {
  try {
    const v = String((JSON.parse(read(path.join(plugin, '.claude-plugin', 'plugin.json'))) as { version?: unknown }).version ?? '');
    return v.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  } catch {
    return [];
  }
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

export interface FindDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** The worker install folder, for FF Factory's own checkout of the plugin repo (server/agentTools.ts toolsCheckout). */
  root?: string;
  exists?: (p: string) => boolean;
  list?: (dir: string) => string[];
  read?: (p: string) => string;
}

/**
 * The newest pr_evidence.py on this machine, by its plugin.json version: the plugin cache's versions, FF_SKILLS's, and the
 * tools checkout's. The newest, because a copy older than the released ff-agents FAILs every pull request ("this
 * pr_evidence.py is ff-agents X, but Y is released", w733), and checklists/merge.md picks it the same way (sort -V).
 * FF_PR_EVIDENCE names one outright. Undefined when there is none: the gate then refuses.
 */
export function findPrEvidence(d: FindDeps): string | undefined {
  const exists = d.exists ?? ((p: string) => fs.existsSync(p));
  const list = d.list ?? ((dir: string) => { try { return fs.readdirSync(dir); } catch { return []; } });
  const read = d.read ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  if (d.env.FF_PR_EVIDENCE) return exists(d.env.FF_PR_EVIDENCE) ? d.env.FF_PR_EVIDENCE : undefined;
  const cache = path.join(d.env.CLAUDE_CONFIG_DIR || path.join(d.home, '.claude'), 'plugins', 'cache', 'final-factory-agents', 'ff-agents');
  const plugins = list(cache).map((v) => path.join(cache, v));
  if (d.env.FF_SKILLS) plugins.push(path.dirname(d.env.FF_SKILLS));
  const root = d.root ?? d.env.FF_WORKER_ROOT;
  if (root) plugins.push(path.join(root, 'tools', 'final-factory-agents', 'plugins', 'ff-agents'));
  let best: { script: string; v: number[] } | undefined;
  for (const p of plugins) {
    const script = path.join(p, SCRIPT);
    if (!exists(script)) continue;
    const v = pluginVersion(p, read);
    if (!best || newer(v, best.v)) best = { script, v };
  }
  return best?.script;
}

export const findLocalPrEvidence = (env: NodeJS.ProcessEnv = process.env) => findPrEvidence({ env, home: os.homedir() });

/** The command the gate runs: the script, the repository and the pull request, always all three. */
export const evidenceArgs = (script: string, repo: string, pr: number | string) => [script, '--repo', repo, '--pr', String(pr)];

export interface EvidenceVerdict {
  ok: boolean;
  /** What it said: the verdict's first line on a pass; on a refusal, the failing lines (or the last lines it printed). */
  lines: string[];
}

/**
 * The verdict of one run: exit 0 passes, anything else refuses. A FAIL names its reasons as `- ` lines after the
 * `evidence-gate: FAIL` line (notes, `- note:`, are left out); a usage error or a gh failure prints no such lines, so its
 * last lines are named instead.
 */
export function evidenceVerdict(code: number, out: string, err: string): EvidenceVerdict {
  const all = `${out}\n${err}`.split(/\r?\n/).map((l) => l.trimEnd());
  if (code === 0) return { ok: true, lines: [all.find((l) => l.trim()) ?? 'PASS'] };
  const fails = all.filter((l) => /^- /.test(l) && !/^- note:/.test(l));
  return { ok: false, lines: fails.length ? fails : all.filter((l) => l.trim()).slice(-4) };
}

/** One refusal, for a person or a worker to act on: the command, how it ended, and each failing line. */
export function evidenceRefusal(repo: string, pr: number | string, code: number, v: EvidenceVerdict): string {
  const how = code === 127 ? 'could not run' : code === 2 ? 'usage error, exit 2' : `exit ${code}`;
  return `the Evidence check refused it (pr_evidence.py --repo ${repo} --pr ${pr}, ${how}):\n${v.lines.map((l) => `  ${l}`).join('\n')}`;
}

/** The refusal when there is no pr_evidence.py to run. */
export const noScriptRefusal = (repo: string, pr: number | string) =>
  `the Evidence check could not run for ${repo}#${pr}: no pr_evidence.py found (the ff-agents plugin cache, FF_SKILLS or the tools checkout); merge it by hand only after pr_evidence.py --repo ${repo} --pr ${pr} passes`;
