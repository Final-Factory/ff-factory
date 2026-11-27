// w6542 diagnostic (temporary, removed before merge): log what /proc/$!/winpid names early and late under Git Bash.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const skip = process.platform !== 'win32' ? 'Windows only' : false;
for (const burn of [0, os.cpus().length * 2]) {
  test(`w6542 diag: winpid early and late, ${burn} burners`, { skip }, () => {
    const r = spawnSync(bash, [path.join(import.meta.dirname, 'w6542-diag.sh'), '25', String(burn)], { encoding: 'utf8', timeout: 240_000, windowsHide: true, env: { ...process.env, PATH: `${path.dirname(process.execPath)};${process.env.PATH}` } });
    console.log(`status ${r.status} ${r.error ?? ''}\n${r.stdout}\n${r.stderr}`);
  });
}
