import { spawn, type ChildProcess } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/**
 * The Claude credentials Claude Code takes from a descriptor instead of its environment (the ops worker's launcher,
 * deploy/vm/guest/fff-ops-launch, starts it the same way): the variable, and the one that names the descriptor.
 */
export const PIPED_CREDENTIALS = [
  ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'],
  ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR'],
] as const;

/** The descriptor the credential is written to: the first after stdin, stdout and stderr. */
export const CREDENTIAL_FD = 3;

/**
 * What the child starts with: the environment without the credential, plus the variable that names its descriptor, and the
 * credential to write there. Only the first of PIPED_CREDENTIALS that is set is piped; every one is taken out.
 */
export function pipedEnv(env: Record<string, string | undefined>): { env: Record<string, string>; secret?: string } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  let secret: string | undefined;
  for (const [name, fdName] of PIPED_CREDENTIALS) {
    const v = out[name];
    delete out[name];
    delete out[fdName];
    if (secret === undefined && v) {
      secret = v;
      out[fdName] = String(CREDENTIAL_FD);
    }
  }
  return { env: out, ...(secret !== undefined ? { secret } : {}) };
}

/**
 * Options.spawnClaudeCodeProcess for the agents the portal starts on its own computer (orchestrators, the dispatcher, the
 * bug-thread judge; w5506): Claude Code gets its vault token on a pipe (CREDENTIAL_FD), never in its environment. Every
 * process the portal starts runs as the same account, which may read any of their /proc/<pid>/environ: with the token in
 * the environment, one orchestrator's tools could read another person's vault token there. A pipe leaves it only in
 * claude's memory, which Yama's ptrace_scope 1 keeps from every process that is not its ancestor.
 */
export function tokenPipeSpawner(run: typeof spawn = spawn) {
  return (o: SpawnOptions): SpawnedProcess => {
    const { env, secret } = pipedEnv(o.env as Record<string, string | undefined>);
    const child: ChildProcess = run(o.command, o.args, { cwd: o.cwd, env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe', secret === undefined ? 'ignore' : 'pipe'] });
    const pipe = child.stdio[CREDENTIAL_FD] as NodeJS.WritableStream | null | undefined;
    if (pipe && secret !== undefined) {
      // A claude that exits before it reads the pipe makes this write fail (EPIPE): its own exit says why.
      (pipe as unknown as { on(e: 'error', f: () => void): void }).on('error', () => {});
      pipe.end(secret);
    }
    return child as unknown as SpawnedProcess;
  };
}

/** The options that start an agent's claude with its token on a pipe; none on Windows, which has no descriptor 3 to hand it. */
export const tokenPipeOptions = (platform: NodeJS.Platform = process.platform): { spawnClaudeCodeProcess?: ReturnType<typeof tokenPipeSpawner> } =>
  platform === 'win32' ? {} : { spawnClaudeCodeProcess: tokenPipeSpawner() };
