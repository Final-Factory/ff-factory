// w6221: the start-portal.sh that scripts/instance/new.ts writes, run for real under Git Bash on Windows: the portal it
// starts (a stand-in server/index.ts) is raised to ABOVE_NORMAL, I/O normal and memory normal, and the script still ends
// with the portal's own exit code (the logon task restarts on a failure by it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentGitBash } from '../server/agentGit.ts';
import { parseWhoamiGroups } from '../server/elevation.ts';
import { startScript } from './instance/new.ts';

/**
 * w6475: at Low integrity (an FF worker) the machine's Git Bash dies on the msys shared object directory that the
 * person's Medium Git Bash holds (NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...): 0xC0000022,
 * docs/worker-root.md); the workers' own Git copy (<root>\tools\git) gets its own and runs there. Its root is the one of
 * the agents' node that runs this test (<root>\tools\node\node.exe; testEnv.ts drops FF_WORKER_ROOT). The logon task runs
 * the script at Medium, with the machine's.
 */
const whoami = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
const low = process.platform === 'win32' && parseWhoamiGroups(spawnSync(whoami(), ['/groups', '/fo', 'csv'], { encoding: 'utf8' }).stdout ?? '').integrity === 'low';
const tools = path.dirname(path.dirname(process.execPath));
const root = path.basename(tools).toLowerCase() === 'tools' ? path.dirname(tools) : undefined;
const bash = !low ? 'C:\\Program Files\\Git\\bin\\bash.exe' : root ? agentGitBash(root) : '';
const skip =
  process.platform !== 'win32' ? 'Windows only'
  : !bash ? `at Low integrity the machine's Git Bash dies (0xC0000022), and this node (${process.execPath}) is no worker root's`
  : !fs.existsSync(bash) ? `no Git Bash at ${bash}`
  : false;

test('start-portal.sh raises the portal it starts and ends with its exit code', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffinst-prio-'));
  try {
    fs.mkdirSync(path.join(dir, 'app', 'server'), { recursive: true });
    // the stand-in portal: up long enough to be raised, then ends with a code of its own
    fs.writeFileSync(path.join(dir, 'app', 'server', 'index.ts'), "console.log('stand-in portal up'); setTimeout(() => process.exit(7), 20_000);\n");
    const script = path.join(dir, 'start-portal.sh');
    fs.writeFileSync(script, startScript({ name: 'prio', project: 'Prio Test', port: 18999, dir, nodeDir: path.dirname(process.execPath) }));
    const r = spawnSync(bash, [script], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    const logFile = path.join(dir, 'portal.log');
    assert.ok(fs.existsSync(logFile), `the script wrote no portal.log (status ${r.status}, ${r.error})
${r.stderr}`);
    const log = fs.readFileSync(logFile, 'utf8');
    assert.equal(r.status, 7, `the script's exit code is the portal's\n${r.stderr}\n${log}`);
    assert.match(log, /stand-in portal up/);
    assert.match(log, /portal priority \(w6221\): pid \d+ from class 0x[0-9A-F]+, I\/O \d, memory \d to class 0x8000, I\/O 2, memory 5\r?\n/, log);
    assert.doesNotMatch(log, /raise failed|could not open|error/, log);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
