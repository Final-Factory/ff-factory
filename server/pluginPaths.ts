import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKETPLACE, toolsCheckout } from './agentTools.ts';

/**
 * Where a worker finds the ff-agents plugin's scripts without searching the disk (w2012, lothsahn: "Stop messing with my
 * c:"). Workers hunting for unity-ui's ui_look.py or evidence-gate's pr_evidence.py ran `find / -name ui_look.py`, which
 * walked all of C: on LothDesktop at about 0.95 cores for minutes (w1894's measurement, 2026-10-24 08:05Z), and the same on
 * m5. Every worker now starts with:
 *
 * - FF_AGENTS_PLUGIN: the ff-agents plugin folder Claude Code loaded for this session, the user-scope `installPath` of
 *   `ff-agents@final-factory-agents` in `<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json` (the same folder a
 *   skill's "Base directory for this skill" line names; read at launch, so it is the version the session runs). Without that
 *   file, FF Factory's own checkout `<root>/tools/final-factory-agents/plugins/ff-agents`, when it is there.
 * - FF_SKILLS: its `skills` folder, so a script is `python "$FF_SKILLS/unity-ui/ui_look.py"` (PowerShell
 *   `$env:FF_SKILLS`) on every OS.
 *
 * A machine with neither gets no variable; the skills' text falls back to the skill's own base directory.
 */
export interface PluginPathDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** The worker install folder, for the fallback checkout. */
  root?: string;
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
}

/** The variables above, or none. Never throws. */
export function pluginEnv(d: PluginPathDeps): Record<string, string> {
  const read = d.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const exists = d.exists ?? ((p: string) => fs.existsSync(p));
  const claudeDir = d.env.CLAUDE_CONFIG_DIR || path.join(d.home, '.claude');
  let plugin: string | undefined;
  try {
    const json = JSON.parse(read(path.join(claudeDir, 'plugins', 'installed_plugins.json'))) as { plugins?: Record<string, { scope?: string; installPath?: unknown }[]> };
    const list = json.plugins?.[`ff-agents@${MARKETPLACE}`];
    const entry = Array.isArray(list) ? (list.find((e) => e?.scope === 'user') ?? list[0]) : undefined;
    if (typeof entry?.installPath === 'string' && entry.installPath) plugin = entry.installPath;
  } catch {
    // No file, or not JSON: the fallback below.
  }
  if (plugin && !exists(path.join(plugin, 'skills'))) plugin = undefined;
  if (!plugin && d.root) {
    const co = path.join(toolsCheckout(d.root), 'plugins', 'ff-agents');
    if (exists(path.join(co, 'skills'))) plugin = co;
  }
  return plugin ? { FF_AGENTS_PLUGIN: plugin, FF_SKILLS: path.join(plugin, 'skills') } : {};
}

/** pluginEnv on this machine. */
export const localPluginEnv = (env: NodeJS.ProcessEnv, root?: string) => pluginEnv({ env, home: os.homedir(), ...(root ? { root } : {}) });
