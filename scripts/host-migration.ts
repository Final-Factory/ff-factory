/**
 * The host migration offline (docs/beast-machine.md): move this host's sandboxes to its own machine daemon, or back,
 * by editing state.json and the daemon's sandboxes.json directly. For when the portal cannot run migrate_host_sandboxes
 * itself (a broken deploy being rolled back). The portal AND the daemon must be stopped: each rewrites its own file.
 *
 *   node scripts/host-migration.ts back --data C:\ff-sandboxes\data --machine beast --daemon-dir C:\Users\rydin\.ff-factory [--dry-run]
 *   node scripts/host-migration.ts to_machine --data ... --machine beast --daemon-dir ... [--dry-run]
 *
 * Nothing on disk besides those two files changes: folders, branches, Libraries and editors stay where they are.
 * Both files are copied next to themselves first (*.pre-host-migration-offline-<time>.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemonRecordFrom, moveStateToHost, moveStateToMachine, type StateFile } from '../server/hostMigration.ts';

export interface OfflineArgs {
  direction: 'to_machine' | 'back';
  data: string;
  machine: string;
  daemonDir?: string;
  dryRun: boolean;
}

/** The command line, or why it is wrong. Exported for tests. */
export function parseArgs(argv: string[]): OfflineArgs | string {
  const [direction, ...rest] = argv;
  if (direction !== 'to_machine' && direction !== 'back') return 'first argument: to_machine or back';
  const get = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const data = get('--data');
  const machine = get('--machine')?.toLowerCase();
  if (!data || !machine) return 'need --data <the portal data folder> and --machine <its id, e.g. beast>';
  return { direction, data, machine, daemonDir: get('--daemon-dir'), dryRun: rest.includes('--dry-run') };
}

/** Whether a pid file names a live process (the portal still running). */
function pidAlive(file: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (!pid) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? Number(fs.readFileSync(file, 'utf8').trim()) : undefined;
  }
}

/**
 * The pids of machine daemons running on this computer (a node process running machine/daemon.ts). With
 * machines.keepAgentsOnRestart the daemon and its agents outlive the portal, and a running daemon would put the
 * sandboxes back with its next snapshot. Exported for tests.
 */
export function runningDaemons(list: () => string = listProcesses): number[] {
  return list()
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && /machine[\\/]daemon\.ts/i.test(m[2]) && Number(m[1]) !== process.pid)
    .map((m) => Number(m[1]));
}

function listProcesses(): string {
  if (process.platform === 'win32') {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }"], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  }
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Daemon rows (machine/sandboxes.ts Rec) after the move: the moved sandboxes added (to_machine) or dropped (back). Exported for tests. */
export function daemonRowsAfter(rows: { id: string }[], state: StateFile, a: Pick<OfflineArgs, 'direction' | 'machine'>, moved: string[]): { id: string }[] {
  if (a.direction === 'back') return rows.filter((r) => !moved.includes(r.id));
  const m = state.machines?.find((x) => x.id === a.machine);
  const added = (m?.sandboxes ?? []).filter((s) => moved.includes(s.id)).map(daemonRecordFrom);
  return [...rows.filter((r) => !moved.includes(r.id)), ...added];
}

export function main(argv: string[], log: (line: string) => void = console.log, daemons: () => number[] = runningDaemons): number {
  const a = parseArgs(argv);
  if (typeof a === 'string') {
    log(`usage: node scripts/host-migration.ts to_machine|back --data <dir> --machine <id> [--daemon-dir <dir>] [--dry-run]\n${a}`);
    return 2;
  }
  const stateFile = path.join(a.data, 'state.json');
  const pid = pidAlive(path.join(a.data, 'server.pid'));
  if (pid && !a.dryRun) {
    log(`the portal still runs (pid ${pid} in ${path.join(a.data, 'server.pid')}): stop it first (scripts\\stop-server.ps1), or it overwrites state.json`);
    return 1;
  }
  const live = a.dryRun ? [] : daemons();
  if (live.length) {
    log(`a machine daemon still runs here (pid ${live.join(', ')}): stop it first (machine_daemon stop while the portal ran, or end its task and that node process), or it puts its sandboxes back`);
    return 1;
  }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as StateFile;
  const r = a.direction === 'back' ? moveStateToHost(state, a.machine) : moveStateToMachine(state, a.machine);
  log(`${a.dryRun ? 'Would move' : 'Moving'} ${r.sandboxes.length} sandbox(es) ${a.direction === 'back' ? `from ${a.machine} to this host` : `to ${a.machine}`}: ${r.sandboxes.join(', ') || 'none'}; ${r.sessions.length} agent record(s), ${r.delegations.length} delegation(s).`);
  const daemonFile = a.daemonDir ? path.join(a.daemonDir, 'sandboxes.json') : undefined;
  let rows: { id: string }[] = [];
  if (daemonFile && fs.existsSync(daemonFile)) rows = JSON.parse(fs.readFileSync(daemonFile, 'utf8'));
  const after = daemonFile ? daemonRowsAfter(rows, state, a, r.sandboxes) : undefined;
  if (daemonFile) log(`${a.machine}'s ${daemonFile}: ${rows.length} → ${after!.length} sandbox(es) (stop its daemon first: it rewrites that file).`);
  else log(`No --daemon-dir: ${a.machine}'s own sandboxes.json is left as it is (${a.direction === 'back' ? 'remove_machine or a daemon without these sandboxes is needed' : 'its daemon will not know these sandboxes'}).`);
  if (a.dryRun) return 0;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  fs.copyFileSync(stateFile, path.join(a.data, `state.pre-host-migration-offline-${stamp}.json`));
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state));
  fs.renameSync(stateFile + '.tmp', stateFile);
  if (daemonFile && after) {
    if (fs.existsSync(daemonFile)) fs.copyFileSync(daemonFile, path.join(a.daemonDir!, `sandboxes.pre-host-migration-offline-${stamp}.json`));
    fs.mkdirSync(a.daemonDir!, { recursive: true });
    fs.writeFileSync(daemonFile, JSON.stringify(after, null, 2));
  }
  log('Done. Start the portal (and the daemon, if it keeps any sandboxes).');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) process.exit(main(process.argv.slice(2)));
