import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The agents' node on a Windows worker root (w1742; lothsahn, 2026-10-22: "we're making random folders under the temp
 * directory and nodejs is triggering the windows firewall. Can we fix that so we dont need to directories or
 * something?"). FF Factory's own tests need node 23.6+ (package.json engines) and a machine's node may be older
 * (lothdesktop: 22.17), so workers unpacked a portable node into their session temp folder, a new program path every
 * session; Windows Firewall asks once per path that listens beyond loopback, and those prompts covered unattended
 * machines (rules left on lothdesktop for three V:\ffw\tmp\ffa-*\ node.exe paths, 2026-10-12..20).
 *
 * This keeps one node at a fixed path in the root, `<root>\tools\node\node.exe`: `worker.ts tools` (the rollout after
 * every verified deploy) puts the pinned version there, the daemon puts its folder first on its agents' PATH
 * (machine/daemon.ts slotEnv), and the install's elevated firewall step gives that one path its rule
 * (scripts/worker/firewall.ps1 -AgentNode). An upgrade replaces the folder's contents, never its path, so the rule
 * keeps fitting. Windows only: a Mac or Linux worker has no such prompt.
 */

/** The pinned build: nodejs.org's SHASUMS256.txt for v24.22.1 (fetched and checked 2026-10-22, w1742). */
export const AGENT_NODE = {
  version: 'v24.22.1',
  zip: 'node-v24.22.1-win-x64.zip',
  sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
} as const;

export const agentNodeDir = (root: string) => path.join(root, 'tools', 'node');
export const agentNodeExe = (root: string) => path.join(agentNodeDir(root), 'node.exe');

type Ran = { code: number | null; stdout: string; stderr: string };
export interface AgentNodeDeps {
  exec: (cmd: string, args: string[], o?: { cwd?: string; timeoutMs?: number }) => Promise<Ran>;
  say: (line: string) => void;
  platform: NodeJS.Platform;
  /** The zip's bytes (nodejs.org by default). */
  download?: (url: string) => Promise<Buffer>;
  /** Windows' own tar.exe (bsdtar reads zip; Git Bash's GNU tar does not). */
  tar?: string;
  now?: () => number;
}

export type AgentNodeResult = 'current' | 'installed' | 'busy' | 'skipped' | 'failed';

const fetchBytes = async (url: string): Promise<Buffer> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

async function versionOf(d: AgentNodeDeps, exe: string): Promise<string | undefined> {
  if (!fs.existsSync(exe)) return undefined;
  const r = await d.exec(exe, ['--version'], { timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/**
 * Put the pinned node at `<root>\tools\node`, unless it is there already. Everything it writes stays in `<root>\tools`.
 * A node still running from the old folder keeps it (Windows cannot move a folder whose program runs): 'busy', and the
 * next rollout tries again.
 */
export async function ensureAgentNode(root: string, d: AgentNodeDeps): Promise<AgentNodeResult> {
  if (d.platform !== 'win32') return 'skipped';
  const dir = agentNodeDir(root);
  const had = await versionOf(d, agentNodeExe(root));
  if (had === AGENT_NODE.version) {
    d.say(`Agent node: ${had} at ${dir} (current).`);
    return 'current';
  }
  const tools = path.dirname(dir);
  const stage = path.join(tools, `node-${AGENT_NODE.version}.part`);
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const url = `https://nodejs.org/dist/${AGENT_NODE.version}/${AGENT_NODE.zip}`;
    const bytes = await (d.download ?? fetchBytes)(url);
    const sum = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sum !== AGENT_NODE.sha256) throw new Error(`${AGENT_NODE.zip} has SHA-256 ${sum}, not the pinned ${AGENT_NODE.sha256}`);
    const zip = path.join(stage, AGENT_NODE.zip);
    fs.writeFileSync(zip, bytes);
    const tar = d.tar ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const x = await d.exec(tar, ['-xf', zip, '-C', stage], { timeoutMs: 10 * 60_000 });
    if (x.code !== 0) throw new Error(`tar could not unpack ${zip}: ${(x.stderr || x.stdout).trim().slice(-300)}`);
    const unpacked = path.join(stage, AGENT_NODE.zip.replace(/\.zip$/, ''));
    const got = await versionOf(d, path.join(unpacked, 'node.exe'));
    if (got !== AGENT_NODE.version) throw new Error(`the unpacked node says ${got ?? 'nothing'}, not ${AGENT_NODE.version}`);
    let old: string | undefined;
    if (fs.existsSync(dir)) {
      old = path.join(tools, `node.old-${(d.now ?? Date.now)()}`);
      try {
        fs.renameSync(dir, old);
      } catch (e) {
        d.say(`Agent node: ${had ?? 'an unknown node'} at ${dir} is in use (${(e as NodeJS.ErrnoException).code}); it stays until the next rollout.`);
        fs.rmSync(stage, { recursive: true, force: true });
        return 'busy';
      }
    }
    fs.renameSync(unpacked, dir);
    fs.rmSync(stage, { recursive: true, force: true });
    if (old) fs.rmSync(old, { recursive: true, force: true });
    d.say(`Agent node: ${AGENT_NODE.version} installed at ${dir}${had ? ` (was ${had})` : ''}; the daemon puts it first on its agents' PATH.`);
    return 'installed';
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    d.say(`WARNING: Agent node: could not put ${AGENT_NODE.version} at ${dir}: ${(e as Error).message}`);
    return 'failed';
  }
}

/** The folder to put first on an agent's PATH: the root's agent node, once it is there (Windows). */
export function agentNodePathDir(root: string | undefined, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (!root || platform !== 'win32') return undefined;
  return exists(agentNodeExe(root)) ? agentNodeDir(root) : undefined;
}
