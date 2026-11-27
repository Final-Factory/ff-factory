// w6221: the start-portal.sh that scripts/instance/new.ts writes, run for real under Git Bash on Windows: the portal it
// starts (a stand-in server/index.ts) is raised to ABOVE_NORMAL, I/O normal and memory normal, and the script still ends
// with the portal's own exit code (the logon task restarts on a failure by it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentGitBash } from '../server/agentGit.ts';
import { parseWhoamiGroups } from '../server/elevation.ts';
import { PORTAL_PRIORITY_PS, startScript } from './instance/new.ts';

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

const RAISED = /portal priority \(w6221\): pid \d+ from class 0x[0-9A-F]+, I\/O \d, memory \d to class 0x8000, I\/O 2, memory 5\r?\n/;

/** Runs the start-portal.sh startScript writes, with a stand-in portal that ends with 7; `plant` edits the script first. */
function runPortal(plant: (script: string) => string = (s) => s): { status: number | null; stderr: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffinst-prio-'));
  try {
    fs.mkdirSync(path.join(dir, 'app', 'server'), { recursive: true });
    // the stand-in portal: up long enough to be raised, then ends with a code of its own
    fs.writeFileSync(path.join(dir, 'app', 'server', 'index.ts'), "console.log('stand-in portal up'); setTimeout(() => process.exit(7), 20_000);\n");
    const script = path.join(dir, 'start-portal.sh');
    fs.writeFileSync(script, plant(startScript({ name: 'prio', project: 'Prio Test', port: 18999, dir, nodeDir: path.dirname(process.execPath) })));
    const r = spawnSync(bash, [script], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    const logFile = path.join(dir, 'portal.log');
    assert.ok(fs.existsSync(logFile), `the script wrote no portal.log (status ${r.status}, ${r.error})
${r.stderr}`);
    return { status: r.status, stderr: r.stderr, log: fs.readFileSync(logFile, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('start-portal.sh raises the portal it starts and ends with its exit code', { skip }, () => {
  const { status, stderr, log } = runPortal();
  assert.equal(status, 7, `the script's exit code is the portal's\n${stderr}\n${log}`);
  assert.match(log, /stand-in portal up/);
  assert.match(log, RAISED, log);
  assert.doesNotMatch(log, /raise failed|could not open|not the portal|error/, log);
});

/** A Windows pid that named a process a moment ago and names none now. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(r.status, 0);
  assert.equal(spawnSync('tasklist.exe', ['/FI', `PID eq ${r.pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(` ${r.pid} `), false);
  return r.pid as number;
}

test('w6542: a winpid read too early, naming a process already gone (error 87), is read again and the portal raised', { skip }, () => {
  // the planted early read: the first read names a process that has ended, as run 46073019269's pid 9096 did
  const read = '  winpid=$(cat "/proc/$portal/winpid" 2>/dev/null)';
  const gone = deadPid();
  const { status, stderr, log } = runPortal((s) => {
    assert.ok(s.includes(read), s);
    return s.replace(read, `${read}\n  [ "$try" = 1 ] && winpid=${gone}`);
  });
  assert.equal(status, 7, `${stderr}\n${log}`);
  assert.match(log, new RegExp(`portal priority \\(w6542\\): read 1 of its winpid, ${gone}, named no portal node.exe yet; reading it again\\r?\\n`), log);
  assert.match(log, RAISED, log);
  assert.equal(log.match(/portal priority \(w6221\)/g)?.length, 1, log);
});

/** PORTAL_PRIORITY_PS run as start-portal.sh runs it (-EncodedCommand), on FF_PORTAL_PID=pid. */
function raise(pid: number): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PORTAL_PRIORITY_PS, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, FF_PORTAL_PID: String(pid) },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** The MSYS bash itself: Git's bin\\bash.exe is a launcher that starts it as its child (seen on windows-latest, PR #1508). */
const msysBash = () => path.join(path.dirname(path.dirname(bash)), 'usr', 'bin', 'bash.exe');

test('w6542: a winpid naming the forked bash.exe raises its node.exe child, never the bash', { skip }, async () => {
  // what an early read named on windows-latest (PR #1508): a bash.exe whose child is the node.exe started in it. Here a
  // bash that does not exec its node (the `; :` after it), so node.exe stays its child as there.
  const stub = spawn(msysBash(), ['-c', `'${process.execPath.replace(/\\/g, '/')}' -e 'console.log(process.pid); setTimeout(() => {}, 30_000)'; :`], { windowsHide: true });
  let node = 0;
  try {
    node = await new Promise<number>((resolve, reject) => {
      stub.stdout.once('data', (d) => resolve(Number(String(d).trim())));
      stub.once('exit', (c) => reject(new Error(`the stand-in bash ended (${c})`)));
    });
    assert.notEqual(node, stub.pid);
    const out = raise(stub.pid as number);
    assert.match(out, new RegExp(`^portal priority \\(w6221\\): pid ${node} from class 0x[0-9A-F]+, I/O \\d, memory \\d to class 0x8000, I/O 2, memory 5 \\(the node.exe child of bash.exe ${stub.pid}\\)\\r?\\n$`), out);
  } finally {
    if (node) try { process.kill(node); } catch { /* ended */ }
    stub.kill();
  }
});

test('w6542: a winpid naming a process that is no node and starts none is not raised', { skip }, () => {
  const other = spawn(msysBash(), ['-c', '/usr/bin/sleep 20; :'], { windowsHide: true });
  try {
    const out = raise(other.pid as number);
    assert.match(out, new RegExp(`^portal priority \\(w6221\\): not the portal: pid ${other.pid} is bash.exe, with no node.exe child\\r?\\n$`), out);
  } finally {
    other.kill();
  }
});
