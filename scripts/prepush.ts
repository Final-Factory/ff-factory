/**
 * The check every worker runs before it pushes to ff-factory (w924): CI's typecheck, shellcheck, secret-scan and identity
 * rules, run locally so they fail here before CI. Over 2026-09-26..10-10 those rules failed CI 77 times (shellcheck 14,
 * gitleaks 11, identity 52; w922, docs/ci.md).
 *
 *   npm run prepush               (any OS: node scripts/prepush.ts)
 *   npm run prepush -- --no-fetch (compare with the origin/main you already have)
 *
 * Steps:
 *   typecheck   `tsc -p .`, and the web UI's when web/node_modules is installed;
 *   shellcheck  deploy/vm/test/lint.sh --shellcheck-only (bash -n and shellcheck on the VM scripts, as CI does);
 *   gitleaks    the commits in origin/main..HEAD;
 *   identity    scripts/check-identity.ts origin/main..HEAD, the noreply rule as CI applies it.
 * A missing bash, shellcheck or gitleaks skips its step with a loud SKIPPED line, never a failure. Exit 1 when any step
 * failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type Outcome = { status: 'ok' | 'failed' | 'skipped'; note?: string };
export interface Step {
  name: string;
  run: (cwd: string, base: string) => Outcome;
}

const ROOT = path.resolve(import.meta.dirname, '..');
const WIN = process.platform === 'win32';

function sh(cmd: string, args: string[], cwd: string, quiet = false) {
  // npm is npm.cmd on Windows, which only a shell runs.
  return spawnSync(cmd, args, { cwd, stdio: quiet ? 'pipe' : 'inherit', shell: WIN && cmd === 'npm', encoding: 'utf8' });
}

/** Whether a tool runs at all (`<tool> <versionArg>` starts). */
export function has(tool: string, versionArg = '--version'): boolean {
  const r = spawnSync(tool, [versionArg], { stdio: 'pipe' });
  return !r.error;
}

const result = (code: number | null): Outcome => ({ status: code === 0 ? 'ok' : 'failed' });

export const steps: Step[] = [
  {
    name: 'typecheck',
    run: (cwd) => {
      const server = sh('npm', ['run', '--silent', 'typecheck'], cwd);
      if (server.status !== 0) return { status: 'failed', note: 'npm run typecheck' };
      if (!existsSync(path.join(cwd, 'web', 'node_modules'))) return { status: 'ok', note: 'web skipped: no web/node_modules (npm ci --prefix web)' };
      return sh('npm', ['--prefix', 'web', 'run', '--silent', 'typecheck'], cwd).status === 0 ? { status: 'ok' } : { status: 'failed', note: 'web typecheck' };
    },
  },
  {
    name: 'shellcheck',
    run: (cwd) => {
      if (!has('bash')) return { status: 'skipped', note: 'bash is not installed' };
      if (!has('shellcheck')) return { status: 'skipped', note: 'shellcheck is not installed' };
      return result(sh('bash', ['deploy/vm/test/lint.sh', '--shellcheck-only'], cwd).status);
    },
  },
  {
    name: 'gitleaks',
    run: (cwd, base) => {
      if (!has('gitleaks', 'version')) return { status: 'skipped', note: 'gitleaks is not installed' };
      return result(sh('gitleaks', ['git', '.', `--log-opts=${base}..HEAD`, '--redact', '--no-banner', '--verbose'], cwd).status);
    },
  },
  {
    name: 'identity',
    run: (cwd, base) => result(sh(process.execPath, [path.join(ROOT, 'scripts', 'check-identity.ts'), `${base}..HEAD`], cwd).status),
  },
];

/** Runs every step (or the named ones) and prints the summary; returns the exit code. */
export function prepush(cwd: string, base = 'origin/main', only?: string[]): number {
  if (sh('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd, true).status !== 0) {
    console.error(`prepush: ${base} is not there; fetch it first (git fetch origin main)`);
    return 1;
  }
  const outcomes: [string, Outcome][] = [];
  for (const step of steps) {
    if (only && !only.includes(step.name)) continue;
    console.log(`\n== prepush: ${step.name}`);
    outcomes.push([step.name, step.run(cwd, base)]);
  }
  console.log('\n== prepush summary');
  for (const [name, o] of outcomes) {
    const line = `${name}: ${o.status.toUpperCase()}${o.note ? ` (${o.note})` : ''}`;
    if (o.status === 'skipped') console.warn(`!!!!!!!! ${line}: CI will run it; install it to catch this before pushing (docs/ci.md)`);
    else console.log(line);
  }
  return outcomes.some(([, o]) => o.status === 'failed') ? 1 : 0;
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  if (!process.argv.includes('--no-fetch') && sh('git', ['fetch', '--quiet', 'origin', 'main'], ROOT).status !== 0) {
    console.warn('prepush: git fetch origin main failed; comparing with the origin/main already here');
  }
  process.exit(prepush(ROOT));
}
