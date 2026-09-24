import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppVersion } from '../shared/types.ts';

/**
 * This app's version: the semantic version in the root package.json (the single source of truth;
 * scripts/release.ts bumps it) plus the short git SHA of the running checkout. Both are read at
 * startup, so an update shows up after the restart that loads it.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

export function readVersion(root = ROOT): string {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The checkout's HEAD, short; FFSB_GIT_SHA wins (a build without .git); undefined when neither is known. */
export function readSha(root = ROOT): string | undefined {
  const env = process.env.FFSB_GIT_SHA?.trim();
  if (env) return env.slice(0, 12);
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || undefined;
  } catch {
    return undefined;
  }
}

let cached: AppVersion | undefined;

/** Read once per process. */
export function appVersion(): AppVersion {
  cached ??= { version: readVersion(), sha: readSha() };
  return cached;
}

/** "v0.1.0 (1a2b3c4)", or "v0.1.0" without a SHA. */
export function formatVersion(v: Partial<AppVersion> | undefined): string {
  if (!v?.version) return 'unknown version';
  return `v${v.version}${v.sha ? ` (${v.sha})` : ''}`;
}
