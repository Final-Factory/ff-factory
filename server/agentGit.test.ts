import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_GIT, agentGitDir, agentGitPathDir, agentGitStamp, ensureAgentGit, type AgentGitDeps } from './agentGit.ts';

/**
 * w5377: the Git for Low-integrity workers sits at one path, <root>\tools\git. These hold its install with a fake
 * download and a fake self-extractor: a wrong digest is refused, the first bash login runs before the swap, a current one
 * is left alone and non-Windows skips.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-git-'));
const bytes = Buffer.from('portable git');
const sum = crypto.createHash('sha256').update(bytes).digest('hex');

function fake(o: { version?: string; unpackFails?: boolean } = {}) {
  const said: string[] = [];
  const ran: string[] = [];
  const d: AgentGitDeps = {
    platform: 'win32',
    sha256: sum,
    say: (l) => void said.push(l),
    download: async () => bytes,
    exec: async (cmd, args) => {
      ran.push(`${path.basename(cmd)} ${args.join(' ')}`);
      if (cmd.endsWith('.7z.exe.part')) {
        if (o.unpackFails) return { code: 2, stdout: '', stderr: 'bad archive' };
        const into = args.find((a) => a.startsWith('-o'))!.slice(2);
        fs.mkdirSync(path.join(into, 'cmd'), { recursive: true });
        fs.mkdirSync(path.join(into, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(into, 'cmd', 'git.exe'), `git version ${o.version ?? AGENT_GIT.version}.windows.1`);
        fs.writeFileSync(path.join(into, 'bin', 'bash.exe'), '');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd.endsWith('git.exe')) return { code: 0, stdout: `${fs.readFileSync(cmd, 'utf8')}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { d, said, ran };
}

test('installs the pinned PortableGit at <root>\\tools\\git, its first login before the swap', async () => {
  const root = tmp();
  const { d, ran } = fake();
  assert.equal(await ensureAgentGit(root, d), 'installed');
  assert.ok(fs.existsSync(path.join(agentGitDir(root), 'cmd', 'git.exe')));
  const login = ran.findIndex((r) => r.startsWith('bash.exe -lc'));
  assert.ok(login > 0, ran.join('\n'));
  assert.equal(agentGitPathDir(root, 'win32'), agentGitDir(root));
  assert.deepEqual(fs.readdirSync(path.join(root, 'tools')).sort(), ['git', 'git.json'], 'no stage or archive left behind');
  assert.ok(ran.includes(`icacls ${path.join(root, 'tools', `git-${AGENT_GIT.version}.part`, 'git')} /setintegritylevel (OI)(CI)low`), 'labelled Low before the swap');
  const again = fake();
  assert.equal(await ensureAgentGit(root, again.d), 'current');
  assert.deepEqual(again.ran, [], 'a stamped Git is current with nothing run');
});

test('w5717: the installed Git is never run; a changed git.exe or bash.exe is replaced from a fresh download', async () => {
  const root = tmp();
  assert.equal(await ensureAgentGit(root, fake().d), 'installed');
  const live = agentGitDir(root);
  // A Low worker swaps in its own git.exe, which says the pinned version.
  fs.writeFileSync(path.join(live, 'cmd', 'git.exe'), `git version ${AGENT_GIT.version}.windows.1 planted`);
  const { d, ran, said } = fake();
  assert.equal(await ensureAgentGit(root, d), 'installed');
  assert.ok(!ran.some((r) => r.includes(path.join(live, 'cmd'))), ran.join('\n'));
  assert.ok(said.some((l) => l.includes('not the one stamped')), said.join('\n'));
  assert.ok(!fs.readFileSync(path.join(live, 'cmd', 'git.exe'), 'utf8').includes('planted'));
  // A planted bash.exe too.
  fs.writeFileSync(path.join(live, 'bin', 'bash.exe'), 'planted');
  assert.equal(await ensureAgentGit(root, fake().d), 'installed');
  assert.equal(fs.readFileSync(path.join(live, 'bin', 'bash.exe'), 'utf8'), '');
});

test('w5717: an install from before the stamp whose programs are the pinned ones is stamped, not swapped', async () => {
  const root = tmp();
  assert.equal(await ensureAgentGit(root, fake().d), 'installed');
  fs.rmSync(agentGitStamp(root));
  const marker = path.join(agentGitDir(root), 'kept.txt');
  fs.writeFileSync(marker, '');
  const { d, said } = fake();
  assert.equal(await ensureAgentGit(root, d), 'current');
  assert.ok(fs.existsSync(marker), 'the same folder');
  assert.ok(fs.existsSync(agentGitStamp(root)));
  assert.ok(said.some((l) => l.includes('no stamp')) && said.some((l) => l.includes('stamped')), said.join('\n'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'tools')).sort(), ['git', 'git.json']);
});

test('a download with another digest is refused and nothing is placed', async () => {
  const root = tmp();
  const { d, said } = fake();
  d.sha256 = 'f'.repeat(64);
  assert.equal(await ensureAgentGit(root, d), 'failed');
  assert.ok(said.some((l) => l.includes('not the pinned')));
  assert.equal(agentGitPathDir(root, 'win32'), undefined);
});

test('an archive that does not unpack, or the wrong version, fails and leaves the old Git', async () => {
  const root = tmp();
  assert.equal(await ensureAgentGit(root, fake({ unpackFails: true }).d), 'failed');
  assert.equal(await ensureAgentGit(root, fake({ version: '2.1.0' }).d), 'failed');
  assert.equal(agentGitPathDir(root, 'win32'), undefined);
});

test('skips off Windows, and agentGitPathDir answers only on Windows', async () => {
  const root = tmp();
  const { d } = fake();
  d.platform = 'linux';
  assert.equal(await ensureAgentGit(root, d), 'skipped');
  assert.equal(agentGitPathDir(root, 'linux', () => true), undefined);
  assert.equal(agentGitPathDir(undefined, 'win32', () => true), undefined);
});
