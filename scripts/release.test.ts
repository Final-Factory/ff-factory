import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cutChangelog, nextVersion, setPackageVersion, unreleasedNotes } from './release.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('nextVersion: bump kinds and explicit versions', () => {
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.9', 'minor'), '0.2.0');
  assert.equal(nextVersion('0.9.3', 'major'), '1.0.0');
  assert.equal(nextVersion('0.1.0', '0.10.0'), '0.10.0');
  assert.throws(() => nextVersion('0.2.0', '0.1.9'), /not higher/);
  assert.throws(() => nextVersion('0.2.0', '0.2.0'), /not higher/);
  assert.throws(() => nextVersion('0.2.0', 'v0.3.0'), /patch, minor, major/);
  assert.throws(() => nextVersion('1.0', 'patch'), /not X.Y.Z/);
});

const LOG = `# Changelog

Intro.

## [Unreleased]

### Added
- A thing.

## [0.1.0] - 2026-09-24

### Added
- The first things.

[Unreleased]: https://example.test/r/compare/v0.1.0...HEAD
[0.1.0]: https://example.test/r/releases/tag/v0.1.0
`;

test('changelog: the unreleased notes become the new version, links follow', () => {
  assert.equal(unreleasedNotes(LOG), '### Added\n- A thing.');
  const out = cutChangelog(LOG, '0.2.0', '0.1.0', '2026-10-01', 'https://example.test/r');
  assert.match(out, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-10-01\n\n### Added\n- A thing\.\n\n## \[0\.1\.0\] - 2026-09-24/);
  assert.match(out, /^\[Unreleased\]: https:\/\/example\.test\/r\/compare\/v0\.2\.0\.\.\.HEAD$/m);
  assert.match(out, /^\[0\.2\.0\]: https:\/\/example\.test\/r\/compare\/v0\.1\.0\.\.\.v0\.2\.0$/m);
  assert.match(out, /^\[0\.1\.0\]: https:\/\/example\.test\/r\/releases\/tag\/v0\.1\.0$/m);
  assert.equal(unreleasedNotes(out), '');
  // Cutting again with nothing new is refused, and so is a file without the heading.
  assert.throws(() => cutChangelog(out, '0.2.1', '0.2.0', '2026-10-02'), /nothing under \[Unreleased\]/);
  assert.throws(() => unreleasedNotes('# Changelog\n'), /no "## \[Unreleased\]"/);
});

test('setPackageVersion: package.json and the lockfile root, CRLF kept', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{\r\n  "name": "x",\r\n  "version": "0.1.0"\r\n}\r\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', version: '0.1.0', packages: { '': { name: 'x', version: '0.1.0' } } }, null, 2) + '\n');
  setPackageVersion(dir, '0.2.0');
  const pkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  assert.equal(JSON.parse(pkg).version, '0.2.0');
  assert.ok(pkg.endsWith('}\r\n') && !/[^\r]\n/.test(pkg));
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  assert.deepEqual([lock.version, lock.packages[''].version], ['0.2.0', '0.2.0']);
});

test('the repo: one version everywhere, and the changelog has an entry for it', () => {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const v = read('package.json').version;
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(read('web/package.json').version, v, 'web/package.json must match the root version (npm run release keeps them in step)');
  assert.equal(read('package-lock.json').version, v);
  assert.equal(read('web/package-lock.json').version, v);
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, new RegExp(`^## \\[${v.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
  unreleasedNotes(changelog); // has the heading
});
