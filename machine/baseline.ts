// The daemon's half of the machine baseline (w6603, shared/machineBaseline.ts): the versions of the tools its agents run
// and its feature keys, sent in its hello. Read only: it runs each tool's --version and nothing else, and a tool that is
// missing or fails is reported so, never fixed here.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { agentGitDir, agentGitPathDir } from '../server/agentGit.ts';
import { agentNodeExe, agentNodePathDir } from '../server/agentNode.ts';
import { featureFlags, versionOf, type MachineBaseline } from '../shared/machineBaseline.ts';
import { pythonExe } from './benchQueue.ts';
import { installHelpersOf } from './installSsh.ts';

export type ProbeRun = (cmd: string, args: string[], o: { timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The claude its agents run: the daemon's configured one, else the Agent SDK's own binary for this OS (what the sessions
 * start, machine/daemon.ts), else `claude` on the PATH. w6603: a daemon with no `claude` on its task's PATH reported
 * "claude ?" though its agents ran the SDK's copy.
 */
export function agentClaude(configured: string | undefined, platform: NodeJS.Platform = process.platform, arch: string = process.arch, resolve: (id: string) => string = createRequire(import.meta.url).resolve): string {
  if (configured) return configured;
  try {
    const dir = path.dirname(resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/package.json`));
    return path.join(dir, platform === 'win32' ? 'claude.exe' : 'claude');
  } catch {
    return 'claude';
  }
}

/** The programs probed for each tool: [command, args]. On Windows the agents' own node and git (tools/) when installed. */
export function toolCommands(o: { root?: string; claude?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean }): Record<string, [string, string[]]> {
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? fs.existsSync;
  const nodeDir = agentNodePathDir(o.root, platform, exists);
  const gitDir = agentGitPathDir(o.root, platform, exists);
  return {
    agentNode: [nodeDir && o.root ? agentNodeExe(o.root) : 'node', ['--version']],
    claude: [agentClaude(o.claude, platform), ['--version']],
    git: [gitDir && o.root ? path.join(agentGitDir(o.root), 'cmd', 'git.exe') : 'git', ['--version']],
    bash: [gitDir && o.root ? path.join(agentGitDir(o.root), 'bin', 'bash.exe') : 'bash', ['--version']],
    gh: ['gh', ['--version']],
    python: [pythonExe(o.env ?? process.env, platform), ['--version']],
    uv: ['uv', ['--version']],
  };
}

/** Runs each tool's --version (in parallel, 15 s each) and reads the daemon's feature keys. */
export async function probeBaseline(o: { run: ProbeRun; cfg: Record<string, unknown>; root?: string; home?: string; claude?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean }): Promise<MachineBaseline> {
  const cmds = toolCommands(o);
  const entries = await Promise.all(
    Object.entries(cmds).map(async ([name, [cmd, args]]) => {
      const r = await o.run(cmd, args, { timeoutMs: 15000 }).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
      if (r.code === 0) return [name, versionOf(`${r.stdout}\n${r.stderr}`)] as const;
      const why = `${r.stderr || r.stdout}`.trim().split(/\r?\n/)[0] ?? '';
      return [name, /ENOENT|not found|not recognized/i.test(why) || (r.code === -1 && !why) ? 'missing' : `failed (exit ${r.code})`] as const;
    }),
  );
  return { tools: { daemonNode: versionOf(process.version), ...Object.fromEntries(entries) }, flags: { ...featureFlags(o.cfg, { root: o.root, home: o.home }), ...installHelpersOf(o.root) } };
}
