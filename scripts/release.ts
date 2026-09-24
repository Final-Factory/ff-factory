/**
 * Cut a release: bump the version in package.json (the single source of truth) and web/package.json,
 * move CHANGELOG.md's [Unreleased] notes under the new version, commit "Release vX.Y.Z" and tag it.
 *
 *   npm run release -- patch|minor|major|X.Y.Z [--dry-run]
 *
 * It does not push; it prints the command. Refuses on a dirty tree, an empty [Unreleased] section or
 * an existing tag.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const REPO_URL = 'https://github.com/Final-Factory/ff-factory';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** The next version: a bump kind or an explicit X.Y.Z that must be higher than the current one. */
export function nextVersion(current: string, how: string): string {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`package.json version "${current}" is not X.Y.Z`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (how === 'major') return `${maj + 1}.0.0`;
  if (how === 'minor') return `${maj}.${min + 1}.0`;
  if (how === 'patch') return `${maj}.${min}.${pat + 1}`;
  const e = SEMVER.exec(how);
  if (!e) throw new Error(`give patch, minor, major or a version like 1.2.3 (got "${how}")`);
  if (compare(how, current) <= 0) throw new Error(`${how} is not higher than the current ${current}`);
  return how;
}

export function compare(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const UNRELEASED = /^## \[Unreleased\][^\n]*\n/m;

/** The notes under [Unreleased], trimmed ("" when there are none). */
export function unreleasedNotes(changelog: string): string {
  const m = UNRELEASED.exec(changelog);
  if (!m) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  const rest = changelog.slice(m.index + m[0].length);
  const next = /^## \[|^\[[^\]]+\]: /m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/**
 * CHANGELOG.md with [Unreleased] cut as `version` on `date`: an empty [Unreleased] heading stays on top,
 * and the compare links at the bottom are updated (Keep a Changelog style).
 */
export function cutChangelog(changelog: string, version: string, previous: string, date: string, repo = REPO_URL): string {
  const notes = unreleasedNotes(changelog);
  if (!notes) throw new Error('nothing under [Unreleased] in CHANGELOG.md; write the release notes first');
  const m = UNRELEASED.exec(changelog)!;
  const rest = changelog.slice(m.index + m[0].length);
  const next = /^## \[|^\[[^\]]+\]: /m.exec(rest);
  const after = next ? rest.slice(next.index) : '';
  let out = `${changelog.slice(0, m.index)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${notes}\n\n${after}`;
  // Links: [Unreleased] compares from the new tag; the new version compares from the previous one.
  const unreleasedLink = `[Unreleased]: ${repo}/compare/v${version}...HEAD`;
  const versionLink = `[${version}]: ${repo}/compare/v${previous}...v${version}`;
  if (/^\[Unreleased\]: .*$/m.test(out)) out = out.replace(/^\[Unreleased\]: .*$/m, `${unreleasedLink}\n${versionLink}`);
  else out = `${out.trimEnd()}\n\n${unreleasedLink}\n${versionLink}\n`;
  return out.replace(/\n{3,}/g, '\n\n');
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Set "version" in a package.json and its lockfile's two root entries, keeping the files' formatting. */
export function setPackageVersion(dir: string, version: string) {
  for (const name of ['package.json', 'package-lock.json']) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const json = JSON.parse(text);
    json.version = version;
    if (json.packages?.['']) json.packages[''].version = version;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(f, JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol);
  }
}

function main(argv: string[]) {
  const root = path.resolve(import.meta.dirname, '..');
  const dry = argv.includes('--dry-run');
  const how = argv.find((a) => !a.startsWith('--'));
  if (!how) throw new Error('usage: npm run release -- patch|minor|major|X.Y.Z [--dry-run]');
  const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  const version = nextVersion(current, how);
  const tag = `v${version}`;
  if (!dry && git(root, 'status', '--porcelain')) throw new Error('the working tree has changes; commit or stash them first');
  if (git(root, 'tag', '--list', tag)) throw new Error(`tag ${tag} already exists`);
  const clPath = path.join(root, 'CHANGELOG.md');
  const date = new Date().toISOString().slice(0, 10);
  const changelog = cutChangelog(fs.readFileSync(clPath, 'utf8'), version, current, date);
  const notes = unreleasedNotes(fs.readFileSync(clPath, 'utf8'));
  if (dry) {
    console.log(`would release ${current} -> ${version} (${tag}) with these notes:\n\n${notes}`);
    return;
  }
  setPackageVersion(root, version);
  setPackageVersion(path.join(root, 'web'), version);
  fs.writeFileSync(clPath, changelog);
  git(root, 'add', 'package.json', 'package-lock.json', 'web/package.json', 'web/package-lock.json', 'CHANGELOG.md');
  git(root, 'commit', '-m', `Release ${tag}`);
  git(root, 'tag', '-a', tag, '-m', `FF Factory ${tag}\n\n${notes}`);
  console.log(`Released ${tag}. Push it with:\n  git push origin HEAD ${tag}`);
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${(e as Error).message}`);
    process.exit(1);
  }
}
