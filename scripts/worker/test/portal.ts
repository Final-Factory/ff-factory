/**
 * A throwaway FF Factory portal for testing the worker install end to end (w513; docs/worker-install.md, "Testing"):
 * the real server/index.ts in portal-only mode, against a scratch config and data folder, with the fake agent in
 * place of the Agent SDK for its own orchestrators. It holds one machine record with no deploy behind it, as an
 * enrollment makes, and writes that machine's credential to a file for the installer's -CredentialFile.
 *
 *   node scripts/worker/test/portal.ts <scratch folder> [port=8799] [machine id=wtest]
 *
 * A second http port (port + 1) drives it for the test: POST /sandbox {name} creates a sandbox on the machine, GET
 * /machine shows its record. Nothing here reaches the live portal, its data or its daemons.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fakeQuery } from '../../../e2e/fakeAgent.ts';

const [base, portArg = '8799', id = 'wtest'] = process.argv.slice(2);
if (!base) throw new Error('usage: node scripts/worker/test/portal.ts <scratch folder> [port] [machine id]');
const port = Number(portArg);
fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
const dataDir = path.join(base, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const token = `ffm_${id}_${randomBytes(30).toString('base64url')}`;
fs.writeFileSync(path.join(base, 'credential.txt'), token + '\n', { mode: 0o600 });
fs.writeFileSync(path.join(dataDir, 'machine-tokens.json'), JSON.stringify({ [id]: createHash('sha256').update(token).digest('hex') }, null, 2), { mode: 0o600 });
const now = new Date().toISOString();
const url = `http://127.0.0.1:${port}`;
fs.writeFileSync(
  path.join(dataDir, 'state.json'),
  JSON.stringify({
    sandboxes: [],
    sessions: [],
    settings: { heartbeatMinutes: null },
    machines: [{ id, host: id, purpose: 'worker install test', status: 'ready', online: false, repoPath: '', home: '', portalUrl: url, maxSessions: 0, sessionIds: [], createdAt: now }],
  }),
);
const configFile = path.join(base, 'config.json');
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      port,
      host: '127.0.0.1',
      trustProxy: false,
      publicUrl: url,
      ownerName: 'Tester',
      hostSandboxes: false,
      ledger: { cleanup: { repos: [] } },
      dataDir,
      sandboxRoot: path.join(base, 'host-sandboxes'),
      standingRoot: path.join(base, 'agents'),
      repo: { url: 'https://github.com/Final-Factory/FinalFactory.git', basePath: path.join(base, 'base') },
      defaultBase: 'develop',
      limits: { maxUnity: 1, maxSessions: 4, maxSandboxes: 1, minFreeGB: 0 },
      models: ['opus', 'sonnet', 'haiku'],
      defaultModel: 'haiku',
      voice: { enabled: false, autoInstall: false, tts: false },
      // The test daemon runs on a computer with other work on it: it cleans nothing there.
      machines: { cleanup: { everyMinutes: 0, softFreeGB: 0, staleOutput: { mode: 'off' } } },
    },
    null,
    2,
  ),
);
process.env.FFSB_CONFIG = configFile;
process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const { setQueryForTesting } = await import('../../../server/sessions.ts');
setQueryForTesting(fakeQuery() as never);
const { internals } = await import('../../../server/index.ts');

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const machines = internals.agents.machines;
        if (req.method === 'POST' && req.url === '/sandbox') {
          const { name, base: b } = JSON.parse(body) as { name: string; base?: string };
          const sb = await machines.createSandbox(id, { name, purpose: 'worker install test', base: b, seedLibrary: false, startUnity: false });
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sb));
          return;
        }
        if (req.url === '/machine') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(internals.store.machines.get(id) ?? null));
          return;
        }
        res.writeHead(404).end();
      } catch (e) {
        res.writeHead(400).end(String((e as Error).message));
      }
    });
  })
  .listen(port + 1, '127.0.0.1');
console.log(`test portal on ${url} (machine ${id}; credential in ${path.join(base, 'credential.txt')}; driver on ${port + 1})`);
