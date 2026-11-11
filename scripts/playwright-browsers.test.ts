import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../server/config.ts';

/**
 * scripts/playwright-browsers.sh, CI's browser install (w3942), run against stand-ins for sudo, npx, apt-get, dpkg and
 * dpkg-query. Their apt-get hangs, as Azure's mirror and archive.ubuntu.com both did on 2026-11-11 (run 43057579193): a
 * cache hit must finish without calling it, and a miss must still get through on its second try.
 */

const SCRIPT = path.join(ROOT, 'scripts', 'playwright-browsers.sh');
const skip = process.platform === 'win32' ? 'bash stand-ins for apt and dpkg; CI runs it on Linux' : false;

interface Run { status: number | null; ms: number; calls: string; out: string; ghOutput: string; debs: string[]; mirrors: string }

function run(opts: { hit: boolean; cached?: string[]; uninstalled?: string[]; archiveOkFromTry?: number }): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-browsers-'));
  const bin = path.join(dir, 'bin');
  const debs = path.join(dir, 'debs');
  const archives = path.join(dir, 'archives');
  const calls = path.join(dir, 'calls.log');
  for (const d of [bin, archives]) fs.mkdirSync(d);
  const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  stub('sudo', 'exec "$@"');
  stub('pkill', `echo "pkill $*" >> "${calls}"`);
  stub('fuser', 'exit 1');
  // The hung archive: exec keeps one pid, so the script's `timeout` ends it.
  stub('apt-get', `echo "apt-get $*" >> "${calls}"; exec sleep 600`);
  stub('dpkg', `echo "dpkg $*" >> "${calls}"`);
  stub('dpkg-query', `case " ${(opts.uninstalled ?? []).join(' ')} " in *" \${@: -1} "*) exit 1;; esac; echo "install ok installed"`);
  stub(
    'npx',
    [
      `echo "npx $*" >> "${calls}"`,
      'case "$*" in',
      `  *--dry-run*) echo 'sudo -- sh -c "apt-get update&& apt-get install -y --no-install-recommends libfoo libbar"' ;;`,
      '  *--with-deps*)',
      `    n=$(( $(cat "${dir}/tries" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/tries"`,
      `    if [ $n -ge ${opts.archiveOkFromTry ?? 99} ]; then touch "${archives}/libfoo_1_amd64.deb" "${archives}/libbar_1_amd64.deb"; exit 0; fi`,
      '    exec apt-get install -y libfoo libbar ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
  );
  if (opts.cached) {
    fs.mkdirSync(debs);
    for (const d of opts.cached) fs.writeFileSync(path.join(debs, d), '');
  }
  const mirrors = path.join(dir, 'apt-mirrors.txt');
  fs.writeFileSync(mirrors, 'http://azure.archive.ubuntu.com/ubuntu/\thttp://archive.ubuntu.com/ubuntu/\n');
  const ghOutput = path.join(dir, 'gh-output');
  fs.writeFileSync(ghOutput, '');
  const t0 = Date.now();
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BROWSERS: 'webkit',
      HIT: String(opts.hit),
      TRY_SECONDS: '2',
      DEBS: debs,
      APT_ARCHIVES: archives,
      APT_CONF: path.join(dir, 'keep-debs.conf'),
      APT_MIRRORS: mirrors,
      GITHUB_OUTPUT: ghOutput,
      ImageVersion: '20261109.1',
    },
  });
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const out: Run = {
    status: r.status,
    ms: Date.now() - t0,
    calls: read(calls),
    out: `${r.stdout}${r.stderr}`,
    ghOutput: read(ghOutput),
    debs: fs.existsSync(debs) ? fs.readdirSync(debs).filter((f) => f.endsWith('.deb')).sort() : [],
    mirrors: read(mirrors),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('playwright-browsers: a cache hit installs with dpkg and never asks the hung archive', { skip }, () => {
  const r = run({ hit: true, cached: ['libbar_1_amd64.deb', 'libfoo_1_amd64.deb'] });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.calls, /apt-get/, 'no apt call on a hit');
  assert.doesNotMatch(r.calls, /--with-deps/);
  assert.match(r.calls, /dpkg -i \S*libbar_1_amd64\.deb \S*libfoo_1_amd64\.deb/);
  assert.match(r.calls, /npx playwright install webkit/);
  assert.ok(r.ms < 20_000, `took ${r.ms} ms`);
  assert.equal(r.ghOutput, '', 'a hit saves nothing');
});

test('playwright-browsers: a miss gets through a hung first try and keeps its .debs for the cache', { skip }, () => {
  const r = run({ hit: false, archiveOkFromTry: 2 });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /try 1\) did not finish/);
  assert.match(r.calls, /pkill -x apt-get/);
  assert.doesNotMatch(r.mirrors, /azure/, 'the second try leaves Azure\'s mirror');
  assert.deepEqual(r.debs, ['libbar_1_amd64.deb', 'libfoo_1_amd64.deb']);
  assert.match(r.ghOutput, /^save=true$/m);
});

test('playwright-browsers: a miss whose archive hangs on both tries fails inside its limits', { skip }, () => {
  const r = run({ hit: false });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /try 2\) did not finish/);
  assert.equal(r.ghOutput, '');
});

test('playwright-browsers: a hit that leaves a package uninstalled falls back to the network', { skip }, () => {
  const r = run({ hit: true, cached: ['libfoo_1_amd64.deb'], uninstalled: ['libbar'], archiveOkFromTry: 1 });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Not installed after the cached packages: libbar/);
  assert.match(r.calls, /--with-deps/);
  assert.match(r.ghOutput, /^save=true$/m);
});
