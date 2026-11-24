import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Git for Low-integrity workers on a Windows worker root (w5377, docs/worker-root.md 4.1). A Low agent cannot use
 * the machine's Git: its msys runtime opens a shared object directory named from the msys DLL's path, which a Medium
 * msys (the person's Git Bash, a Medium worker) made first, and the Low one crashes with 0xC0000022 (measured, w5333).
 * A copy at another path names another directory. This keeps one PortableGit at a fixed path, `<root>\tools\git`: in a
 * Low run from there, bash wrote a Low folder, was refused a Medium one, and git committed (measured on LothDesktop,
 * 2026-11-24, w5377). `worker.ts tools` puts it there, like the agents' node (server/agentNode.ts), and nothing it
 * writes leaves `<root>\tools`. Nothing on C: is read or changed.
 */

/** The pinned build: GitHub's digest for the v2.56.1.windows.1 release asset (fetched and checked 2026-11-24, w5377). */
export const AGENT_GIT = {
  version: '2.56.1',
  tag: 'v2.56.1.windows.1',
  file: 'PortableGit-2.56.1-64-bit.7z.exe',
  sha256: '9dd04a608ceb5f6ab32a73709e0ecb159d211da71b697c45ff81f6dd0c6b49c7',
} as const;

export const agentGitDir = (root: string) => path.join(root, 'tools', 'git');
export const agentGitBash = (root: string) => path.join(agentGitDir(root), 'bin', 'bash.exe');
const gitExe = (dir: string) => path.join(dir, 'cmd', 'git.exe');

type Ran = { code: number | null; stdout: string; stderr: string };
export interface AgentGitDeps {
  exec: (cmd: string, args: string[], o?: { cwd?: string; timeoutMs?: number }) => Promise<Ran>;
  say: (line: string) => void;
  platform: NodeJS.Platform;
  download?: (url: string) => Promise<Buffer>;
  now?: () => number;
  /** Tests: the digest to expect instead of the pinned one. */
  sha256?: string;
}

export type AgentGitResult = 'current' | 'installed' | 'busy' | 'skipped' | 'failed';

const fetchBytes = async (url: string): Promise<Buffer> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

async function versionOf(d: AgentGitDeps, dir: string): Promise<string | undefined> {
  if (!fs.existsSync(gitExe(dir))) return undefined;
  const r = await d.exec(gitExe(dir), ['--version'], { timeoutMs: 30_000 });
  // "git version 2.56.1.windows.1"
  return r.code === 0 ? r.stdout.trim().replace(/^git version /, '').replace(/\.windows\.\d+$/, '') : undefined;
}

/**
 * Put the pinned PortableGit at `<root>\tools\git`, unless it is there already. Its first bash login (which copies the
 * hosts files and links git's DLLs) runs here, at Medium, before any Low worker uses it: run first at Low it could not
 * make its links (measured).
 */
export async function ensureAgentGit(root: string, d: AgentGitDeps): Promise<AgentGitResult> {
  if (d.platform !== 'win32') return 'skipped';
  const dir = agentGitDir(root);
  const had = await versionOf(d, dir);
  if (had === AGENT_GIT.version) {
    d.say(`Agent Git: ${had} at ${dir} (current).`);
    return 'current';
  }
  const tools = path.dirname(dir);
  const stage = path.join(tools, `git-${AGENT_GIT.version}.part`);
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    const url = `https://github.com/git-for-windows/git/releases/download/${AGENT_GIT.tag}/${AGENT_GIT.file}`;
    const bytes = await (d.download ?? fetchBytes)(url);
    const sum = crypto.createHash('sha256').update(bytes).digest('hex');
    const want = d.sha256 ?? AGENT_GIT.sha256;
    if (sum !== want) throw new Error(`${AGENT_GIT.file} has SHA-256 ${sum}, not the pinned ${want}`);
    const sfx = path.join(tools, `${AGENT_GIT.file}.part`);
    fs.writeFileSync(sfx, bytes);
    const unpacked = path.join(stage, 'git');
    const x = await d.exec(sfx, ['-y', `-o${unpacked}`], { timeoutMs: 10 * 60_000 });
    fs.rmSync(sfx, { force: true });
    if (x.code !== 0) throw new Error(`the PortableGit archive did not unpack: ${(x.stderr || x.stdout).trim().slice(-300)}`);
    const got = await versionOf(d, unpacked);
    if (got !== AGENT_GIT.version) throw new Error(`the unpacked git says ${got ?? 'nothing'}, not ${AGENT_GIT.version}`);
    await d.exec(path.join(unpacked, 'bin', 'bash.exe'), ['-lc', 'exit 0'], { timeoutMs: 5 * 60_000 });
    let old: string | undefined;
    if (fs.existsSync(dir)) {
      old = path.join(tools, `git.old-${(d.now ?? Date.now)()}`);
      try {
        fs.renameSync(dir, old);
      } catch (e) {
        d.say(`Agent Git: ${had ?? 'an unknown git'} at ${dir} is in use (${(e as NodeJS.ErrnoException).code}); it stays until the next rollout.`);
        fs.rmSync(stage, { recursive: true, force: true });
        return 'busy';
      }
    }
    fs.renameSync(unpacked, dir);
    fs.rmSync(stage, { recursive: true, force: true });
    if (old) fs.rmSync(old, { recursive: true, force: true });
    d.say(`Agent Git: ${AGENT_GIT.version} installed at ${dir}${had ? ` (was ${had})` : ''}; Low-integrity workers use it.`);
    return 'installed';
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    d.say(`WARNING: Agent Git: could not put ${AGENT_GIT.version} at ${dir}: ${(e as Error).message}`);
    return 'failed';
  }
}

/** The root's agent Git folder, once it is there (Windows), for lowEnv. */
export function agentGitPathDir(root: string | undefined, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (!root || platform !== 'win32') return undefined;
  return exists(agentGitBash(root)) && exists(gitExe(agentGitDir(root))) ? agentGitDir(root) : undefined;
}
