/**
 * The worker install's Dev Drive on a real Windows (w900, docs/worker-install.md "The Dev Drive"): makes a real VHDX with
 * scripts/worker/devdrive.ps1, then does what a PC does to it. GitHub's Windows runner is elevated and has the virtual disk
 * service, so this runs there (.github/workflows/dev-drive.yml); locally, only in an elevated shell on a scratch PC.
 *
 *   node scripts/worker/test/devdrive-e2e.ts <scratch folder>
 *
 * What it checks, each line PASS or FAIL (exit 1 on any FAIL):
 * 1. the first run makes a dynamically expanding VHDX in the root, formats it ReFS, and mounts it at the first free letter
 *    from V: down (the free letters were read before, from the OS, not from the script under test);
 * 2. a second run is idempotent: it reuses the VHDX (same file, same creation time), the same letter, keeps what was on the
 *    drive, and formats nothing;
 * 3. a "reboot" (the VHDX detached) is undone by the boot-mount task ffsb-helper-mount, at the same letter, data intact;
 * 4. when another volume has taken the letter by the next boot, the task mounts it at the next free letter and repoints
 *    daemon.json, the pool's record and the state file;
 * 5. remove takes the tasks, the attachment and the file away.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'devdrive.ps1');
const [scratchArg] = process.argv.slice(2);
if (process.platform !== 'win32') {
  console.log('SKIP: the Dev Drive end to end needs Windows');
  process.exit(0);
}
if (!scratchArg) {
  console.error('usage: node scripts/worker/test/devdrive-e2e.ts <scratch folder>');
  process.exit(2);
}
const scratch = path.resolve(scratchArg);
const root = path.join(scratch, 'root');
const vhdx = path.join(root, 'devdrive.vhdx');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'daemon'), { recursive: true });

let failed = 0;
let letterTaken: string | undefined;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

const ps = (script: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
const run = (args: string[]) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { encoding: 'utf8', timeout: 20 * 60_000 });
  const text = `${r.stdout}${r.stderr}`;
  const m = /^FFW-DEVDRIVE (\{.*\})\s*$/m.exec(text);
  return { code: r.status, text, json: m ? (JSON.parse(m[1]) as Record<string, any>) : undefined };
};
const sid = ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value').stdout.trim();
const user = ps('[Security.Principal.WindowsIdentity]::GetCurrent().Name').stdout.trim();
// Read from the OS here, not through the script under test: drives in use, plus the letters Windows has reserved (MountedDevices).
const usedLetters = (): string[] =>
  ps(`$l = @([IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0,1) })
$l += @((Get-Item 'HKLM:\\SYSTEM\\MountedDevices').GetValueNames() | ForEach-Object { if ($_ -match '^\\\\DosDevices\\\\([A-Za-z]):$') { $Matches[1].ToUpper() } })
$l += @((Get-ChildItem 'HKCU:\\Network' -ErrorAction SilentlyContinue).PSChildName)
($l | Select-Object -Unique) -join ','`)
    .stdout.trim()
    .split(',')
    .filter(Boolean);
/**
 * Another claim on a letter. Windows keeps a letter for the volume that had it (MountedDevices), so no other volume can be given
 * the letter of a detached Dev Drive; what can take it is a persistent network mapping (HKCU\\Network), which the boot task, running
 * as SYSTEM with no user logged on, can only know by reading the profiles' registry hives.
 */
const takeLetter = (l: string) => spawnSync('net', ['use', `${l}:`, '\\\\127.0.0.1\\C$', '/persistent:yes'], { encoding: 'utf8' });
const releaseLetter = (l: string) => void spawnSync('net', ['use', `${l}:`, '/delete', '/y'], { encoding: 'utf8' });
const letterOrder = [...'VUTSRQPONMLKJIHGFEDC', 'B', 'A'];
const firstFree = (taken: string[]) => letterOrder.find((l) => !taken.includes(l));
const attached = () => ps(`(Get-DiskImage -ImagePath '${vhdx}').Attached`).stdout.trim() === 'True';
const helperResult = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ffsb-helpers', 'results', 'mount.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
};
/** Start the boot-mount task the way the machine does, and wait for the result it writes. */
const bootTask = () => {
  const start = Date.now();
  const r = spawnSync('schtasks', ['/run', '/tn', 'ffsb-helper-mount'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, detail: `schtasks: ${r.stdout}${r.stderr}` };
  for (let i = 0; i < 180; i++) {
    const res = helperResult();
    if (res && Date.parse(res.at) >= start) return res as { ok: boolean; detail: string };
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep 2']);
  }
  return { ok: false, detail: 'no result in 6 minutes' };
};

try {
  // Fixtures the letter change must repoint (step 4): daemon.json and the pool's record, as a daemon on the drive has them.
  const free0 = firstFree(usedLetters())!;
  fs.writeFileSync(path.join(root, 'daemon', 'daemon.json'), JSON.stringify({ root, sandboxes: { root: `${free0}:\\sandboxes`, librarySeed: `${free0}:\\seed\\Library` } }, null, 2));
  fs.writeFileSync(path.join(root, 'daemon', 'sandboxes.json'), JSON.stringify([{ id: 'slot1', path: `${free0}:\\sandboxes\\slot1` }], null, 2));

  // 1. The first run.
  const taken1 = usedLetters();
  const first = run(['-Action', 'ensure', '-Root', root, '-MaxGB', '64', '-User', user, '-UserSid', sid]);
  console.log(first.text.split('\n').filter((l) => !l.startsWith('FFW-DEVDRIVE')).join('\n'));
  const j1 = first.json ?? {};
  check(first.code === 0 && !!first.json, 'the first run succeeds', `exit ${first.code}`);
  check(fs.existsSync(vhdx), 'the VHDX is in the root');
  check(j1.created === true, 'it says it created the drive');
  check(j1.letter === firstFree(taken1), 'it took the first free letter from V: down', `letter ${j1.letter}, expected ${firstFree(taken1)}, in use ${taken1.join('')}`);
  check(fs.existsSync(`${j1.letter}:\\`), `${j1.letter}: is there`);
  check(/refs/i.test(String(j1.fileSystem)), 'it is ReFS', `${j1.fileSystem}, Dev Drive format ${j1.devDrive}, block clone ${j1.blockClone}`);
  check(fs.statSync(vhdx).size < 2 * 1024 ** 3, 'the file is dynamic (small until written)', `${(fs.statSync(vhdx).size / 1024 ** 2).toFixed(0)} MB`);
  const letter = String(j1.letter);
  // What the install puts on the drive: a real worktree of the root's clone, and the root's two junctions.
  const gitenv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8', env: gitenv });
  const src = path.join(scratch, 'src');
  fs.mkdirSync(src);
  g(src, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  g(src, 'add', '.');
  g(src, 'commit', '-q', '-m', 'first');
  g(scratch, 'clone', '-q', '--bare', src, path.join(root, 'repo'));
  const wt = g(path.join(root, 'repo'), 'worktree', 'add', '-q', '-b', 'sandbox/slot1', `${letter}:\\sandboxes\\slot1`);
  check(wt.status === 0, `a worktree of the root's clone on ${letter}:`, `${wt.stderr}`.trim());
  for (const name of ['sandboxes', 'seed']) {
    fs.mkdirSync(`${letter}:\\${name}`, { recursive: true });
    fs.symlinkSync(`${letter}:\\${name}`, path.join(root, name), 'junction');
  }
  fs.writeFileSync(`${letter}:\\sandboxes\\slot1\\marker.txt`, 'kept');
  const created0 = fs.statSync(vhdx).birthtimeMs;
  const tasks = ps(`@(Get-ScheduledTask -TaskName 'ffsb-helper-*' | ForEach-Object { $_.TaskName }) -join ','`).stdout.trim();
  check(/ffsb-helper-mount/.test(tasks) && /ffsb-helper-trim/.test(tasks) && /ffsb-helper-compact/.test(tasks), 'the helper tasks are registered', tasks);
  const boot = ps(`(Get-ScheduledTask -TaskName ffsb-helper-mount).Triggers | ForEach-Object { $_.CimClass.CimClassName }`).stdout.trim();
  check(/BootTrigger/.test(boot), 'the mount task also runs at boot', boot);

  // 2. The second run.
  const second = run(['-Action', 'ensure', '-Root', root, '-MaxGB', '64', '-User', user, '-UserSid', sid]);
  check(second.code === 0 && second.json?.created === false, 'a second run reuses the drive and says so');
  check(second.json?.letter === letter, 'with the same letter');
  check(fs.statSync(vhdx).birthtimeMs === created0, 'the VHDX is the same file');
  check(fs.existsSync(`${letter}:\\sandboxes\\slot1\\marker.txt`) && fs.readFileSync(`${letter}:\\sandboxes\\slot1\\marker.txt`, 'utf8') === 'kept', 'what was on the drive is still there');
  const third = run(['-Action', 'ensure', '-Root', root, '-MaxGB', '64']);
  check(third.code === 0 && third.json?.created === false && third.json?.letter === letter, 'a third run with no user changes nothing either');

  // 3. A reboot: the attachment is lost. The boot task brings the drive back at the same letter.
  ps(`Dismount-DiskImage -ImagePath '${vhdx}' | Out-Null`);
  check(!attached() && !fs.existsSync(`${letter}:\\`), 'detached (a reboot or a power cut)');
  const b1 = bootTask();
  check(b1.ok, 'the boot task reports success', b1.detail);
  check(attached() && fs.existsSync(`${letter}:\\sandboxes\\slot1\\marker.txt`), `${letter}: is back with its data`);
  const again = bootTask();
  check(again.ok && /already there/.test(again.detail), 'the boot task run again changes nothing', again.detail);

  // 4. The letter is taken by the next boot: another letter, and everything is repointed.
  ps(`Dismount-DiskImage -ImagePath '${vhdx}' | Out-Null`);
  const sub = takeLetter(letter);
  letterTaken = letter;
  const mapped = spawnSync('reg', ['query', `HKCU\\Network\\${letter}`], { encoding: 'utf8' }).status === 0;
  check(sub.status === 0 && mapped, `a persistent network drive takes ${letter}:`, `${sub.stdout}${sub.stderr}`.replace(/\s+/g, ' ').trim().slice(-200));
  const taken4 = usedLetters();
  const b2 = bootTask();
  const state = JSON.parse(fs.readFileSync(path.join(root, 'devdrive.json'), 'utf8').replace(/^\uFEFF/, ''));
  const moved = String(state.letter);
  check(b2.ok, 'the boot task still succeeds', b2.detail);
  check(moved !== letter && moved === firstFree(taken4), 'the drive took the next free letter', `${letter} -> ${moved}, expected ${firstFree(taken4)}`);
  check(fs.existsSync(`${moved}:\\sandboxes\\slot1\\marker.txt`), `${moved}: holds the data`);
  const dj = JSON.parse(fs.readFileSync(path.join(root, 'daemon', 'daemon.json'), 'utf8').replace(/^\uFEFF/, ''));
  check(dj.sandboxes.root === `${moved}:\\sandboxes` && dj.sandboxes.librarySeed === `${moved}:\\seed\\Library`, 'daemon.json follows', JSON.stringify(dj.sandboxes));
  const pool = JSON.parse(fs.readFileSync(path.join(root, 'daemon', 'sandboxes.json'), 'utf8').replace(/^\uFEFF/, ''));
  check(pool[0].path === `${moved}:\\sandboxes\\slot1`, "the pool's record follows", pool[0].path);
  check(fs.readlinkSync(path.join(root, 'sandboxes')).replace(/\\+$/, '') === `${moved}:\\sandboxes` && fs.readlinkSync(path.join(root, 'seed')).replace(/\\+$/, '') === `${moved}:\\seed`, "the root's junctions follow", fs.readlinkSync(path.join(root, 'sandboxes')));
  const top = g(`${moved}:\\sandboxes\\slot1`, 'rev-parse', '--abbrev-ref', 'HEAD');
  check(top.status === 0 && top.stdout.trim() === 'sandbox/slot1', 'the worktree still opens, on its branch (git worktree repair ran as SYSTEM)', `${top.stdout}${top.stderr}`.trim());
  const listed = g(path.join(root, 'repo'), 'worktree', 'list', '--porcelain').stdout.replace(/\\/g, '/').toLowerCase();
  check(listed.includes(`${moved.toLowerCase()}:/sandboxes/slot1`) && !listed.includes(`${letter.toLowerCase()}:/sandboxes/slot1`), "the root's clone records the new path", listed.split('\n').filter((l) => l.startsWith('worktree')).join(' | '));
  releaseLetter(letter);
  letterTaken = undefined;

  // 5. Remove.
  const rem = run(['-Action', 'remove', '-Root', root]);
  check(rem.code === 0 && !fs.existsSync(vhdx) && !attached(), 'remove detaches and deletes the VHDX');
  check(ps(`@(Get-ScheduledTask -TaskName 'ffsb-helper-*' -ErrorAction SilentlyContinue).Count`).stdout.trim() === '0', 'and takes the tasks away');
} catch (e) {
  console.log(`FAIL: ${(e as Error).message}`);
  failed++;
} finally {
  if (letterTaken) releaseLetter(letterTaken);
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Dismount-DiskImage -ImagePath '${vhdx}' -ErrorAction SilentlyContinue | Out-Null; Get-ScheduledTask -TaskName 'ffsb-helper-*' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`]);
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
