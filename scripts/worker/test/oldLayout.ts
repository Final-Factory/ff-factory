/**
 * Today's machine layout, built in a scratch folder for testing the migration (w513; docs/worker-install.md,
 * "Testing"): a daemon folder with daemon.json and sandboxes.json, a person's clone (non-bare) with one sandbox worktree
 * holding an unpushed commit, a staged change, an unstaged change and an untracked file, a Library seed, a nightly lab,
 * a Claude conversation folder for the sandbox, and the daemon itself running from that folder under its own task name
 * (Windows), connected to a test portal (scripts/worker/test/portal.ts).
 *
 *   node scripts/worker/test/oldLayout.ts <scratch> <portal url> <credential file> <origin repo> <task name>
 *
 * Windows only. Nothing outside <scratch> changes but the task it registers and one folder under ~/.claude/projects.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle, nodeSupport, parseWinProbe } from '../../../server/machineDeploy.ts';
import * as win from '../../../server/machineDeployWin.ts';
import { claudeSlug } from '../migrate.ts';

const [base, portalUrl, credFile, origin, task] = process.argv.slice(2);
if (!task) throw new Error('usage: node scripts/worker/test/oldLayout.ts <scratch> <portal url> <credential file> <origin repo> <task name>');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', ...args], { cwd, stdio: 'pipe', windowsHide: true }).toString();
const id = /^ffm_([a-z0-9-]+)_/.exec(fs.readFileSync(credFile, 'utf8'))![1];

const clone = path.join(base, 'oldclone');
const sbRoot = path.join(base, 'oldsb');
const sb = path.join(sbRoot, 'sbA');
const app = path.join(base, 'oldapp');
const seed = path.join(base, 'oldseed', 'Library');
const nightly = path.join(base, 'oldnightly');
for (const d of [clone, sbRoot, app, path.dirname(seed), nightly]) fs.rmSync(d, { recursive: true, force: true });

// A person's clone and one sandbox with every kind of work in it.
execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'pipe' });
fs.mkdirSync(sbRoot, { recursive: true });
git(clone, 'worktree', 'add', '-q', '-b', 'sandbox/sbA', sb, 'origin/develop');
fs.writeFileSync(path.join(sb, 'committed.txt'), 'unpushed\n');
git(sb, 'add', 'committed.txt');
git(sb, 'commit', '-qm', 'unpushed work');
fs.writeFileSync(path.join(sb, 'staged.txt'), 'staged\n');
git(sb, 'add', 'staged.txt');
fs.appendFileSync(path.join(sb, 'README.md'), 'unstaged line\n');
fs.writeFileSync(path.join(sb, 'untracked.txt'), 'untracked\n');
fs.mkdirSync(path.join(sb, 'Library'), { recursive: true });
fs.writeFileSync(path.join(sb, 'Library', 'big.bin'), Buffer.alloc(1 << 20, 7));
fs.writeFileSync(path.join(sb, '.gitignore'), 'Library/\n');
git(sb, 'add', '.gitignore');

// The seed, the nightly lab, the Claude conversations.
fs.mkdirSync(seed, { recursive: true });
fs.writeFileSync(path.join(seed, 'seed.bin'), Buffer.alloc(1 << 20, 3));
fs.mkdirSync(nightly, { recursive: true });
fs.writeFileSync(path.join(nightly, 'run.json'), '{"night":1}\n');
const claude = path.join(os.homedir(), '.claude', 'projects', claudeSlug(sb));
fs.mkdirSync(claude, { recursive: true });
fs.writeFileSync(path.join(claude, 'test-session.jsonl'), '{"type":"test"}\n');

// The old daemon folder, as the portal's deploy writes it.
fs.mkdirSync(path.join(app, 'logs'), { recursive: true });
const config = {
  portalUrl,
  id,
  token: fs.readFileSync(credFile, 'utf8').trim(),
  repoPath: clone,
  maxSessions: 0,
  appDir: app,
  tempDir: path.join(base, 'oldtmp'),
  unitySlotsDir: path.join(app, 'unity-slots'),
  maxEventsFile: path.join(app, 'max-events.jsonl'),
  cleanup: { everyMinutes: 0, softFreeGB: 0 },
  sandboxes: { root: sbRoot, maxSandboxes: 1, maxAgentsPerSandbox: 1, maxUnity: 1, diskWarnGB: 50, diskCriticalGB: 20, librarySeed: seed },
};
fs.writeFileSync(path.join(app, 'cleanup.json'), JSON.stringify({ everyMinutes: 0, softFreeGB: 0, staleOutput: { mode: 'off' } }));
fs.writeFileSync(path.join(app, 'sandboxes.json'), JSON.stringify([{ id: 'sbA', branch: 'sandbox/sbA', base: 'origin/develop', path: sb, createdAt: new Date().toISOString(), status: 'ready' }], null, 2));

const p = parseWinProbe((await win.psScript(win.LOCAL, win.probeScript(''), { timeoutMs: 120_000 })).stdout);
const tgz = path.join(os.tmpdir(), `ff-oldlayout-${process.pid}.tgz`);
fs.writeFileSync(tgz, Buffer.from(await bundle(SRC), 'base64'));
const must = async (what: string, script: string) => {
  const r = await win.psScript(win.LOCAL, script, { timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new Error(`${what}: ${win.failureDetail(r)}`);
  return r.stdout;
};
await must('upload', win.uploadScript(app, tgz));
await must('npm ci', win.npmScript(p.node!, 'oldlayout', app));
const flag = nodeSupport(p.nodeVersion ?? '').flag;
const out = await must('install', win.installScript({ sid: p.sid, home: p.home, config: JSON.stringify(config, null, 2), node: p.node!, flag, appDir: app, service: { task, only: true } }));
console.log(`old layout in ${base}: daemon ${app} (task ${task}, ${/started=True/.test(out) ? 'started' : 'not started'}), clone ${clone}, sandbox ${sb}, seed ${seed}, nightly ${nightly}, Claude ${claude}`);
