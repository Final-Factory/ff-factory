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

/**
 * The checkout's HEAD as a full 40-character commit id (w5516): what machine updates install, pinned (server/opsWorker.ts
 * installerRemote, the join scripts). FFSB_GIT_SHA wins when it is a full id; undefined when no full id is known.
 */
export function readCommit(root = ROOT): string | undefined {
  const env = process.env.FFSB_GIT_SHA?.trim().toLowerCase();
  if (env && FULL_COMMIT.test(env)) return env;
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim().toLowerCase();
    return FULL_COMMIT.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** A full git commit id (40 hex characters). */
export const FULL_COMMIT = /^[0-9a-f]{40}$/;

let commitCached: { v: string | undefined } | undefined;
/** The portal's own full commit, read once per process (a release's checkout does not change under it). */
export function portalCommit(): string | undefined {
  commitCached ??= { v: readCommit() };
  return commitCached.v;
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
