import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_GIT, agentGitDir, agentGitPathDir, ensureAgentGit, type AgentGitDeps } from './agentGit.ts';

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
  assert.deepEqual(fs.readdirSync(path.join(root, 'tools')), ['git'], 'no stage or archive left behind');
  assert.equal(await ensureAgentGit(root, fake().d), 'current');
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
