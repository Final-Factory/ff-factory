// The update job a daemon starts when the portal asks over its link (w1596, scripts/worker/linkJob.ts): the update, and the
// rollback when the new daemon does not come back. The installer and the OS are stand-ins here; scripts/worker/test/link-e2e.ts
// runs the real ones on a real Windows PC and a real Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUT_BACK, runJob, type JobDeps } from './linkJob.ts';
import { jobName, jobPlist, launchJob } from '../../machine/osJob.ts';
import { jobRemoveScript, jobScript, jobTaskXml, rollbackScript } from '../../server/machineDeployWin.ts';
import type { UpdateJob } from '../../machine/selfUpdate.ts';

const NEW = 'b'.repeat(40);
const OLD = 'a'.repeat(12);

/** A machine: its daemon code folders, what the portal sees, and the steps taken. */
function machine(o: { updateOk?: boolean; updateSwaps?: boolean; comesBack?: 'new' | 'old' | 'never'; swapFails?: boolean } = {}) {
  const folders = { app: OLD as string | undefined, 'app.old': undefined as string | undefined };
  let running: string | undefined = OLD;
  const steps: string[] = [];
  let t = 0;
  const deps: JobDeps = {
    say: () => undefined,
    async update() {
      steps.push('update');
      if (o.updateSwaps !== false) {
        folders['app.old'] = folders.app;
        folders.app = NEW.slice(0, 12);
        running = o.comesBack === 'never' || o.comesBack === 'old' ? undefined : NEW.slice(0, 12);
      }
      return !!o.updateOk;
    },
    tools: async () => 0,
    uninstall: async () => void steps.push('uninstall'),
    version: (which) => folders[which],
    async swapBack() {
      steps.push('swapBack');
      if (o.swapFails) throw new Error('a process still has a file open there');
      [folders.app, folders['app.old']] = [folders['app.old'], undefined];
      running = o.comesBack === 'never' ? undefined : folders.app;
    },
    async restart() {
      steps.push('restart');
    },
    view: async () => (running ? { online: true, daemon: running } : { online: false }),
    save: (j) => void steps.push(`save ${j.before}`),
    sleep: async (ms) => void (t += ms),
    now: () => t,
  };
  return { deps, steps, folders };
}

const job = (extra: Partial<UpdateJob> = {}): UpdateJob => ({ id: 'j1', form: 'update', commit: NEW, root: '/r', appDir: '/r/daemon', service: 'FFFactoryDaemon', createdAt: '', phase: 'running', ...extra });

test('w1596: an update the portal sees through is done; the commit before is kept for a rollback', async () => {
  const m = machine({ updateOk: true });
  const j = job();
  const r = await runJob(j, m.deps);
  assert.deepEqual([r.ok, r.exit, r.before, r.after, r.rollback], [true, 0, OLD, NEW.slice(0, 12), undefined]);
  assert.deepEqual(m.steps, [`save ${OLD}`, 'update']);
});

test('w1596: a new daemon that does not come back is put back by the job: app.old in place, restarted, seen again', async () => {
  const m = machine({ updateOk: false, comesBack: 'old' });
  const r = await runJob(job(), m.deps);
  assert.equal(r.ok, false);
  assert.equal(r.rollback, 'ok');
  assert.equal(r.after, OLD, 'the old code is in app again');
  assert.match(r.note ?? '', /did not come back healthy, so the job put aaaaaaaaa back/);
  assert.deepEqual(m.steps, [`save ${OLD}`, 'update', 'swapBack']);
});

test('w1596: when the code put back does not come online either, it is restarted once and the report says it needs a person', async () => {
  const m = machine({ updateOk: false, comesBack: 'never' });
  const r = await runJob(job(), m.deps);
  assert.equal(r.rollback, 'failed');
  assert.match(r.note ?? '', /is not online either: it needs a person/);
  assert.deepEqual(m.steps.slice(-2), ['swapBack', 'restart'], 'one restart after a minute');
  assert.ok(PUT_BACK.waitMs > PUT_BACK.restartAfterMs);
});

test('w1596: a rollback that cannot move the folders says so; an update that never swapped the code rolls nothing back', async () => {
  const stuck = await runJob(job(), machine({ updateOk: false, comesBack: 'old', swapFails: true }).deps);
  assert.equal(stuck.rollback, 'failed');
  assert.match(stuck.note ?? '', /putting aaaaaaaaa back failed: a process still has a file open there/);

  const m = machine({ updateOk: false, updateSwaps: false });
  const r = await runJob(job(), m.deps);
  assert.equal(r.rollback, undefined, 'nothing to put back');
  assert.match(r.note ?? '', /did not put the new code in place; the daemon on aaaaaaaaa keeps working/);
  assert.ok(!m.steps.includes('swapBack'));
});

test('w1596: a job a reboot cut off only checks: the new daemon seen is done; one not seen is put back', async () => {
  const seen = machine();
  Object.assign(seen.folders, { app: NEW.slice(0, 12), 'app.old': OLD });
  seen.deps.view = async () => ({ online: true, daemon: NEW.slice(0, 12) });
  const ok = await runJob(job({ before: OLD }), seen.deps, true);
  assert.equal(ok.ok, true);
  assert.ok(!seen.steps.includes('update'), 'the installer is not run again');

  const lost = machine({ comesBack: 'old' });
  Object.assign(lost.folders, { app: NEW.slice(0, 12), 'app.old': OLD });
  lost.deps.view = async () => (lost.folders.app === OLD ? { online: true, daemon: OLD } : { online: false });
  const back = await runJob(job({ before: OLD }), lost.deps, true);
  assert.equal(back.rollback, 'ok');
  assert.ok(lost.steps.includes('swapBack'));
});

test('w1596: the tools form and the unload', async () => {
  const m = machine();
  assert.deepEqual(await runJob(job({ form: 'tools' }), m.deps), { ok: true, exit: 0 });
  const u = await runJob(job({ form: 'uninstall' }), m.deps);
  assert.equal(u.ok, true);
  assert.deepEqual(m.steps, ['uninstall']);
});

test("w1596: the job runs as the OS's own, outside the daemon: a scheduled task, a LaunchAgent, a transient systemd unit", async () => {
  const spec = { service: 'FFFactoryDaemon', node: 'C:\\Program Files\\nodejs\\node.exe', args: ['--experimental-strip-types', 'D:\\ffw\\daemon\\src\\scripts\\worker\\linkJob.ts', '--job', 'D:\\ffw\\daemon\\update\\job.json'], cwd: 'D:\\ffw\\daemon', log: 'D:\\ffw\\daemon\\logs\\update-job.log' };
  assert.equal(jobName('win32', 'FFFactoryDaemon'), 'FFFactoryDaemonJob');
  assert.equal(jobName('darwin', 'com.fffactory.daemon'), 'com.fffactory.daemon.job');
  const xml = jobTaskXml(spec);
  assert.match(xml, /<Command>conhost\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node\.exe&quot; --experimental-strip-types D:\\ffw\\daemon\\src\\scripts\\worker\\linkJob\.ts --job D:\\ffw\\daemon\\update\\job\.json<\/Arguments>/);
  assert.match(xml, /<LogonTrigger>[\s\S]*&lt;SID&gt;/, 'at logon too: a job a reboot cut off finishes');
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<ExecutionTimeLimit>PT4H<\/ExecutionTimeLimit>/);
  assert.match(jobScript('FFFactoryDaemonJob', xml), /Register-ScheduledTask -TaskName 'FFFactoryDaemonJob' -Xml \$xml -Force\nStart-ScheduledTask -TaskName 'FFFactoryDaemonJob'/);
  assert.match(jobRemoveScript('FFFactoryDaemonJob'), /elseif \(\$t\.State -eq 'Running'\) \{ 'job=running' \}/, 'never one still running');
  const rb = rollbackScript('D:\\ffw\\daemon', { task: 'FFFactoryDaemon', only: true });
  assert.match(rb, /\$null = Stop-FFDaemon\n/, 'its agents run on (no -Agents)');
  assert.match(rb, /Move-Retry \$app \$failed \}\nMove-Retry \$old \$app/);

  const plist = jobPlist('com.fffactory.daemon.job', { ...spec, node: '/usr/local/bin/node', cwd: '/u/ffw/daemon', log: '/u/ffw/daemon/logs/update-job.log' });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>\n  <key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);

  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { code: 0, out: 'job=started' };
  };
  assert.equal(await launchJob(spec, 'win32', run), 'the FFFactoryDaemonJob scheduled task');
  assert.equal(calls[0][0], 'powershell.exe');
  assert.match(Buffer.from(calls[0].at(-1)!, 'base64').toString('utf16le'), /Register-ScheduledTask -TaskName 'FFFactoryDaemonJob'/);
  calls.length = 0;
  assert.match(await launchJob({ ...spec, service: 'com.fffactory.daemon' }, 'linux', run), /transient systemd unit com\.fffactory\.daemon\.job/);
  assert.deepEqual(calls[0].slice(0, 4), ['systemd-run', '--user', '--quiet', '--collect']);
});
