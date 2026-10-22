import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_NODE, agentNodeDir, agentNodeExe, agentNodePathDir, ensureAgentNode, type AgentNodeDeps } from './agentNode.ts';

/**
 * w1742: the agents' node lives at one fixed path per Windows worker root, so no worker unpacks its own into a session temp
 * folder (a new program path, and a Windows Firewall prompt, every session). These hold the swap with a fake download
 * and a fake tar: the folder's path never changes, a wrong download is refused, a busy folder is left alone.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-node-'));
const unpackedName = AGENT_NODE.zip.replace(/\.zip$/, '');

/** Deps whose "node.exe" is a text file holding its version, and whose tar makes the unpacked folder. */
function fake(zipBytes: Buffer, o: { tarFails?: boolean; version?: string } = {}) {
  const said: string[] = [];
  const d: AgentNodeDeps = {
    platform: 'win32',
    say: (l) => void said.push(l),
    download: async () => zipBytes,
    tar: 'tar',
    exec: async (cmd, args) => {
      if (cmd === 'tar') {
        if (o.tarFails) return { code: 1, stdout: '', stderr: 'bad zip' };
        const into = path.join(args[args.indexOf('-C') + 1], unpackedName);
        fs.mkdirSync(into, { recursive: true });
        fs.writeFileSync(path.join(into, 'node.exe'), o.version ?? AGENT_NODE.version);
        return { code: 0, stdout: '', stderr: '' };
      }
      // "<exe> --version": the fake exe's text
      return fs.existsSync(cmd) ? { code: 0, stdout: `${fs.readFileSync(cmd, 'utf8')}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'no such file' };
    },
  };
  return { d, said };
}

/** A download whose SHA-256 is the pinned one, as far as the code can tell: the pin replaced for the test. */
function pinned(bytes: Buffer, fn: () => Promise<void>) {
  const real = AGENT_NODE.sha256;
  (AGENT_NODE as { sha256: string }).sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return fn().finally(() => ((AGENT_NODE as { sha256: string }).sha256 = real));
}

test('the agent node goes to <root>/tools/node, is current on the next run, and the path stays when the version changes (w1742)', async () => {
  const root = tmp();
  const zip = Buffer.from('a zip');
  await pinned(zip, async () => {
    const f = fake(zip);
    assert.equal(await ensureAgentNode(root, f.d), 'installed');
    assert.equal(fs.readFileSync(agentNodeExe(root), 'utf8'), AGENT_NODE.version);
    assert.deepEqual(fs.readdirSync(path.join(root, 'tools')), ['node'], 'nothing left beside it');
    assert.equal(await ensureAgentNode(root, f.d), 'current');
    // An older node there: replaced in place, the same folder.
    fs.writeFileSync(agentNodeExe(root), 'v22.0.0');
    assert.equal(await ensureAgentNode(root, f.d), 'installed');
    assert.equal(fs.readFileSync(agentNodeExe(root), 'utf8'), AGENT_NODE.version);
    assert.deepEqual(fs.readdirSync(path.join(root, 'tools')), ['node']);
    assert.match(f.said.at(-1)!, /installed at .*\(was v22\.0\.0\)/);
  });
});

test('a download with the wrong SHA-256, a failed unpack or a wrong version leaves the old node and no part folder (w1742)', async () => {
  const root = tmp();
  fs.mkdirSync(agentNodeDir(root), { recursive: true });
  fs.writeFileSync(agentNodeExe(root), 'v22.0.0');
  const bad = fake(Buffer.from('not the pinned zip'));
  assert.equal(await ensureAgentNode(root, bad.d), 'failed');
  assert.match(bad.said.at(-1)!, /^WARNING: .*SHA-256/);
  const zip = Buffer.from('a zip');
  await pinned(zip, async () => {
    assert.equal(await ensureAgentNode(root, fake(zip, { tarFails: true }).d), 'failed');
    assert.equal(await ensureAgentNode(root, fake(zip, { version: 'v1.0.0' }).d), 'failed');
  });
  assert.equal(fs.readFileSync(agentNodeExe(root), 'utf8'), 'v22.0.0');
  assert.deepEqual(fs.readdirSync(path.join(root, 'tools')), ['node']);
});

test('not Windows: nothing to place, and nothing goes on PATH; Windows: the folder once node.exe is there (w1742)', async () => {
  const root = tmp();
  const f = fake(Buffer.from('x'));
  assert.equal(await ensureAgentNode(root, { ...f.d, platform: 'linux' }), 'skipped');
  assert.ok(!fs.existsSync(path.join(root, 'tools')));
  assert.equal(agentNodePathDir(root, 'darwin', () => true), undefined);
  assert.equal(agentNodePathDir(undefined, 'win32', () => true), undefined);
  assert.equal(agentNodePathDir(root, 'win32', () => false), undefined);
  assert.equal(agentNodePathDir(root, 'win32', () => true), agentNodeDir(root));
});
