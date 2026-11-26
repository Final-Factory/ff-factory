/**
 * The integrity level a Windows sandbox agent actually runs at, measured (w6003).
 *
 * w6002 (a pair run of a pre-w5297 player) was placed on lothdesktop/slot5, and its worker measured itself at
 * `Low Mandatory Level` (S-1-16-4096) and could build nothing: that player writes the owner's own data folder, which is
 * Medium. Placement had gone by the fence setting, which says what the daemon meant to set up, not what an agent gets.
 * So the daemon runs `whoami.exe /groups` by the route a sandbox agent's own commands take, reads the Mandatory Label
 * line, and reports that level with its worker fence (WorkerFenceReport.agentIntegrity); placement of such a pair run
 * on Windows takes only a measured Medium (or higher) level (shared/capacity.ts legacyUnfitWhy).
 *
 * The route: with the Low fence on, an agent's shell is the agent Git's bash (<root>\tools\git, labelled Low, so it
 * starts at Low whoever starts it), so that bash runs whoami. With the fence off, an agent's claude inherits the daemon's
 * own token, so whoami runs straight from the daemon.
 */
import path from 'node:path';
import type { Exec } from './lowIntegrity.ts';
import type { AgentIntegrity } from '../shared/types.ts';

/** The level a `whoami /groups` output names on its Mandatory Label line, or undefined when it names none. */
export function integrityOf(whoamiGroups: string): AgentIntegrity | undefined {
  const m = /Mandatory Label\\([A-Za-z]+)(?: Plus)? Mandatory Level/i.exec(whoamiGroups);
  if (!m) return undefined;
  const l = m[1].toLowerCase();
  return l === 'untrusted' || l === 'low' || l === 'medium' || l === 'high' || l === 'system' ? l : undefined;
}

/** Whether a measured level writes a Medium folder (the owner's data folder): Medium or above. */
export const writesMedium = (l: AgentIntegrity | undefined) => l === 'medium' || l === 'high' || l === 'system';

/**
 * The command that measures it: through the agent Git's bash when the Low fence is on (MSYS2_ARG_CONV_EXCL keeps Git
 * Bash from turning /groups into a path, w5988), else whoami.exe from the daemon.
 */
export function integrityArgv(o: { lowBash?: string; systemRoot?: string }): string[] {
  const whoami = path.win32.join(o.systemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  if (o.lowBash) return [o.lowBash, '-c', `MSYS2_ARG_CONV_EXCL='*' "${whoami.replace(/\\/g, '/')}" /groups`];
  return [whoami, '/groups'];
}

/** Runs it: the level, or why there is none (the report then has no level, and such a pair run goes elsewhere). */
export async function measureAgentIntegrity(argv: string[], exec: Exec): Promise<{ level: AgentIntegrity } | { why: string }> {
  try {
    const r = await exec(argv[0], argv.slice(1), { timeoutMs: 30_000 });
    const level = integrityOf(r.stdout);
    if (level) return { level };
    return { why: `${path.win32.basename(argv[0])} exit ${r.code}: no Mandatory Label line${r.stderr.trim() ? ` (${r.stderr.trim().slice(0, 200)})` : ''}` };
  } catch (e) {
    return { why: (e as Error).message.slice(0, 200) };
  }
}
