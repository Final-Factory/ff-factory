// w5516 (the w5452 audit's finding 11): the installer installs exactly the commit it is pinned to, or nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INSTALL = path.join(import.meta.dirname, 'worker', 'install.sh');
const CHECKOUT = path.resolve(import.meta.dirname, '..');
const head = () => spawnSync('git', ['-C', CHECKOUT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

function run(args: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffpin-'));
  // An install's record, so the update gets as far as choosing its code (nothing else in the root is read before that).
  fs.writeFileSync(path.join(root, 'root.json'), '{}');
  try {
    const r = spawnSync('bash', [INSTALL, '--update', '--root', root, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}`, left: fs.readdirSync(root).filter((n) => n !== 'root.json') };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('w5516: install.sh refuses a short commit id, and a checkout that is not at the pinned commit, changing nothing', { skip: process.platform === 'win32' || !/^[0-9a-f]{40}$/.test(head()) ? 'needs bash and a git checkout' : false }, () => {
  const short = run(['--ref', head().slice(0, 12)]);
  assert.equal(short.code, 2, short.out);
  assert.match(short.out, /looks like a short commit id: pass the full 40-character id .* Nothing was changed/);
  assert.deepEqual(short.left, [], 'nothing written in the root');

  const other = 'f'.repeat(40);
  const wrong = run(['--source', CHECKOUT, '--ref', other]);
  assert.equal(wrong.code, 2, wrong.out);
  assert.match(wrong.out, new RegExp(`--ref ${other}, but the installer's checkout .* is at ${head()}: refusing, nothing was changed`));
  assert.deepEqual(wrong.left, [], 'nothing written in the root');
});
