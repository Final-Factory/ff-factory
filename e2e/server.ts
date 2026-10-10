/**
 * The FF Factory server as the E2E suite runs it: the real server/index.ts, against a throwaway
 * config and data folder, with a scripted fake in place of the Agent SDK (e2e/fakeAgent.ts). No
 * Unity, no Claude, no network. Playwright starts one per browser project (playwright.config.ts).
 *
 *   E2E_PORT=8791 node e2e/server.ts      (needs the web UI built: npm --prefix web run build)
 *
 * Seeded state (fixed, so screenshots are stable):
 *   machine "pc"       an in-process machine daemon (server/testMachine.ts): real git worktrees, a stand-in Unity editor,
 *                      the same fake agent; its clean-up never runs
 *   sandbox "pc/alpha"    ready, Unity stopped: tests start their own worker agents here
 *   sandbox "pc/gallery"  one idle worker with a seeded transcript, for visual snapshots; never changed
 *   review clip        <sandbox root>/_review/w000-clips/clip.webm, a short clip in the review folder (e2e/video.spec.ts;
 *                      the portal holds no sandboxes of its own, w510, and videos from a machine are not shown yet)
 *   login              tester / e2e-password-123 (the owner)
 *   second login       teammate / e2e-teammate-456, "Team Mate", a member (e2e/identity.spec.ts), with an /mcp API
 *                      key bound to it in <data folder>/../teammate-key.txt
 *   third login        compactor / e2e-password-789, "Compact Tester", a member whose own orchestrator only
 *                      e2e/compact.spec.ts writes to: a person's message cancels its orchestrator's wake_me, so the
 *                      test that checks /compact keeps one cannot share the owner's with the other tests
 *   dispatcher turns   POST <port + 200> (e2e/fixtures.ts, sendToChat): the only way a test makes the dispatcher take a turn
 *   Max                a mock Discord on <port + 100> (e2e/mockDiscord.ts) with a bot token in a scratch ffbox config, and
 *                      five seeded events from the gallery worker (e2e/max.spec.ts)
 *   provider "ffbox"   only with E2E_PROVIDER=1 (the provider projects, e2e/provider.spec.ts): switched on, with
 *                      E2E_PROVIDER_TOKEN as its connector token. Off everywhere else, so no other page changes.
 *   intake             only with E2E_INTAKE=1 (the intake projects, e2e/intake.spec.ts): the Discord intake on, reading the
 *                      mock Discord, with Discord id INTAKE_TRUSTED trusted as tester; its cursors start at the server's
 *                      start, so only what a test posts is new; "Check Discord now" polls at most every second
 *                      (30 s in production), so a test's second check need not wait. Off everywhere else.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionInfo, TranscriptEvent } from '../shared/types.ts';
import { RED_PNG, fakeQuery } from './fakeAgent.ts';
import { E2E_PROVIDER_TOKEN } from './mockConnector.ts';
import { CH, SEEDED_CURSORS, snowflake, startMockDiscord, writeFfboxConfig, writeMaxEvents } from './mockDiscord.ts';

export const USER = 'tester';
export const PASSWORD = 'e2e-password-123';
export const MATE = 'teammate';
export const MATE_PASSWORD = 'e2e-teammate-456';
export const COMPACTOR = 'compactor';
export const COMPACTOR_PASSWORD = 'e2e-password-789';
const withProvider = process.env.E2E_PROVIDER === '1';
const withIntake = process.env.E2E_INTAKE === '1';
/** The Discord user id the intake projects trust, mapped to tester (e2e/intake.spec.ts). */
export const INTAKE_TRUSTED = '444444444444444444';

const ROOT = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.E2E_PORT ?? 8791);
const base = path.join(os.tmpdir(), `ffsb-e2e-${port}`);

if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
  console.error('e2e: the web UI is not built. Run: npm --prefix web run build');
  process.exit(1);
}

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
const dataDir = path.join(base, 'data');
const sandboxRoot = path.join(base, 'sandboxes');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(sandboxRoot, { recursive: true });
fs.writeFileSync(path.join(base, 'vault.key'), randomBytes(32).toString('base64'), { mode: 0o600 });

// A tiny git repo stands in for the game repo: the base clone and each sandbox folder.
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
function repo(dir: string, branch: string) {
  fs.mkdirSync(path.join(dir, 'Screenshots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Mock game repo\n');
  git(dir, 'init', '-q', '-b', branch);
  git(dir, '-c', 'user.name=E2E', '-c', 'user.email=e2e@users.noreply.github.com', 'add', '-A');
  git(dir, '-c', 'user.name=E2E', '-c', 'user.email=e2e@users.noreply.github.com', 'commit', '-q', '-m', 'Initial commit');
}
repo(path.join(base, 'base'), 'develop');
// A short clip in the review folder (the default <sandbox root>/_review), where workers publish theirs (e2e/video.spec.ts).
const clips = path.join(sandboxRoot, '_review', 'w000-clips');
fs.mkdirSync(clips, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'e2e', 'fixtures', 'clip.webm'), path.join(clips, 'clip.webm'));

// Max (docs/max.md): the token in a scratch ffbox config, a mock Discord, and what agents' ffdiscord calls wrote.
const discordPort = port + 100;
await startMockDiscord(discordPort);
writeFfboxConfig(path.join(base, 'ffbox'));
writeMaxEvents(path.join(base, 'max-events.jsonl'), 'gallery1');
fs.writeFileSync(path.join(dataDir, 'max.json'), JSON.stringify({ events: [], cursors: SEEDED_CURSORS, channels: {} }));
// The intake's first look is done: only threads and messages posted from now on are new.
if (withIntake) {
  const start = snowflake(new Date(Date.now() - 1000).toISOString());
  fs.writeFileSync(path.join(dataDir, 'intake.json'), JSON.stringify({ cursors: { [`bug:${CH.betaBugs}`]: start, [`bug:${CH.bugs}`]: start, [`req:${CH.devChat}`]: start }, recent: [], versions: {} }));
}

const configFile = path.join(base, 'config.json');
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      port,
      host: '127.0.0.1',
      trustProxy: false,
      ownerName: 'Tester',
      // The ledger cleanup links no repo's PRs here (it would ask GitHub); its quiet-request rule still runs.
      ledger: { cleanup: { repos: [] } },
      dataDir,
      sandboxRoot,
      // The token vault (docs/vault.md, e2e/vault.spec.ts): its key outside data/, readable by its owner only.
      vault: { keyFile: path.join(base, 'vault.key') },
      repo: { url: path.join(base, 'base'), basePath: path.join(base, 'base') },
      defaultBase: 'develop',
      models: ['opus', 'sonnet'],
      defaultModel: 'opus',
      // Worker updates reach people's own orchestrators (docs/orchestrators.md; e2e/orchestrators.spec.ts).
      // Automatic compaction (w535) only when a test asks for it ("#ctx 950000"): the fake's context grows 5k a message.
      // It checks 200 ms after a turn's end, not 2 s: another test's turn ending meanwhile puts the check off again.
      orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true, compactAtTokens: 900_000, compactAtTurnUsd: 0, compactSettleMs: 200 },
      worker: { permissionMode: 'bypassPermissions', effort: 'low' },
      voice: { enabled: false, autoInstall: false, tts: false },
      // The machine "pc" never watches this host from outside (it would ping it and alert a phone).
      outsideWatch: { enabled: false },
      // A 20 MB cap: e2e/attachments.spec.ts sends a 9 MB file (two chunks) and is refused a 21 MB one.
      attachments: { maxMB: 20 },
      max: { eventsFile: path.join(base, 'max-events.jsonl'), ffboxConfigDir: path.join(base, 'ffbox'), discordApi: `http://127.0.0.1:${discordPort}/api/v10`, inbound: { pollMinutes: 60 } },
      ...(withIntake ? { intake: { discord: { enabled: true, bugChannels: ['beta_bugs', 'bug_reports'], trusted: { [INTAKE_TRUSTED]: 'tester' }, pollMinutes: 120, checkNowSeconds: 1 }, reviewers: ['tester'] } } : {}),
      // The provider projects also take FFBox's ledger check and its fix branches (docs/intake.md; e2e/provider.spec.ts).
      ...(withProvider
        ? {
            providers: { ffbox: { enabled: true, tokenSha256: createHash('sha256').update(E2E_PROVIDER_TOKEN).digest('hex') } },
            intake: { ffbox: { enabled: true, boardCheck: true, escalations: true, repo: 'Final-Factory/FinalFactory' } },
          }
        : {}),
    },
    null,
    2,
  ),
);

const T0 = '2026-09-24T09:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const gallery: SessionInfo = {
  id: 'gallery1',
  kind: 'worker',
  machineId: 'pc',
  machineSandbox: 'gallery',
  title: 'Seeded worker',
  status: 'idle',
  model: 'opus',
  permissionMode: 'bypassPermissions',
  sdkSessionId: 'fake-gallery',
  createdAt: T0,
  lastActivityAt: at(4),
  turns: 1,
  costUsd: 0.42,
  pendingPermissions: [],
  lastResult: 'The belt splitter now balances all three outputs.',
};
process.env.FFSB_CONFIG = configFile;
// The machine "pc" and its sandboxes alpha and gallery, made before the portal boots so its record (with gallery1) is
// there when the portal restores its sessions; its daemon connects once the portal listens.
const { createTestMachine } = await import('../server/testMachine.ts');
const pc = await createTestMachine({ id: 'pc', portalUrl: `http://127.0.0.1:${port}`, parent: base, prefix: 'machine-', maxSandboxes: 4, maxAgentsPerSandbox: 50, sandboxes: ['alpha', 'gallery'] });
for (const id of ['alpha', 'gallery']) fs.mkdirSync(path.join(pc.path(id), 'Screenshots'), { recursive: true });
// A screenshot in a sandbox that the orchestrator mentions by path (e2e/images.spec.ts).
fs.writeFileSync(path.join(pc.path('gallery'), 'Screenshots', 'orch-proof.png'), Buffer.from(RED_PNG, 'base64'));
fs.writeFileSync(
  path.join(dataDir, 'state.json'),
  JSON.stringify({
    sandboxes: [],
    machines: [pc.record({ gallery: ['gallery1'] })],
    sessions: [gallery],
    settings: { heartbeatMinutes: null },
  }),
);
/** A transcript event before its seq is assigned (Omit over each member of the union). */
type Unnumbered = TranscriptEvent extends infer E ? (E extends TranscriptEvent ? Omit<E, 'seq'> : never) : never;
const events: Unnumbered[] = [
  { t: at(0), kind: 'user', from: 'human', text: 'Make the belt splitter balance its three outputs (zebrafish).' },
  { t: at(1), kind: 'assistant', text: 'I will look at **SplitterSystem** first, then write a test.\n\n- read the system\n- add a failing test\n- fix it' },
  { t: at(2), kind: 'tool_use', toolUseId: 'tu1', name: 'Bash', input: { command: 'git status --short', description: 'Show changed files' } },
  { t: at(2), kind: 'tool_result', toolUseId: 'tu1', isError: false, text: ' M Assets/Scripts/SplitterSystem.cs' },
  { t: at(3), kind: 'assistant', text: 'The belt splitter now balances all three outputs.' },
  { t: at(4), kind: 'result', ok: true, text: 'The belt splitter now balances all three outputs.', costUsd: 0.42, turns: 3, durationMs: 95_000 },
];
fs.mkdirSync(path.join(dataDir, 'transcripts'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'transcripts', 'gallery1.jsonl'), events.map((e, i) => JSON.stringify({ seq: i + 1, ...e })).join('\n') + '\n');

// No stored claude.ai login here, so the plan meter reports "unavailable" instead of starting a CLI;
// and no agents' token from the environment this runs in, which the meter would poll for real.
process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
// No GitHub login (w904): the portal probes its own gh login at start, and a developer's would show a token banner here.
process.env.GH_CONFIG_DIR = path.join(base, 'gh');
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
// Nor a real Discord token: Max reads only the scratch ffbox config above.
for (const k of ['DISCORD_TOKEN', 'FFDISCORD_APP_TOKEN', 'FFDISCORD_SERVER_ID', 'FFBOX_SECRETS', 'FFBOX_CONFIG_DIR']) delete process.env[k];
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const { Auth } = await import('../server/auth.ts');
const auth = new Auth(dataDir, { trustProxy: false });
await auth.setUser(USER, PASSWORD);
await auth.setUser(MATE, MATE_PASSWORD, { displayName: 'Team Mate', role: 'member' });
await auth.setUser(COMPACTOR, COMPACTOR_PASSWORD, { displayName: 'Compact Tester', role: 'member' });
fs.writeFileSync(path.join(base, 'teammate-key.txt'), auth.createApiKey('teammate-laptop', MATE));
// FFBox's key for Max's escalations (docs/intake.md), scoped to POST /api/intake/ffbox (e2e/provider.spec.ts).
if (withProvider) fs.writeFileSync(path.join(base, 'ffbox-key.txt'), auth.createApiKey('ffbox', undefined, 'ffbox'));

const { setQueryForTesting } = await import('../server/sessions.ts');
setQueryForTesting(fakeQuery() as never);

const { internals } = await import('../server/index.ts');
await pc.connect(internals.machines);

// The dispatcher takes no person's message any more (docs/orchestrators.md), so a test that needs its fake model to take
// a turn (call one of its tools) has this stand-in on <port + 200> (which also patches a request for e2e/ledger.spec.ts): it sends the owner's words straight to the
// session, as the owner's message used to arrive. Only this test harness has it.
const { default: http } = await import('node:http');
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        // /patch-work {id, patch}: fields set on a request, to age it or give it PRs (e2e/ledger.spec.ts).
        if (req.url === '/patch-work') {
          const { id, patch } = JSON.parse(body) as { id: string; patch: Record<string, unknown> };
          const w = internals.store.work.get(id);
          if (!w) throw new Error(`no request ${id}`);
          internals.store.putWork({ ...w, ...patch });
          res.writeHead(200).end('{}');
          return;
        }
        // /wake {id, minutes}: a real wake_me for an agent (e2e/agentState.spec.ts, w475).
        if (req.url === '/wake') {
          const { id, minutes } = JSON.parse(body) as { id: string; minutes: number };
          (internals.agents as unknown as { waker: { schedule: (id: string, m: number, n: string) => string } }).waker.schedule(id, minutes, 'e2e check-in');
          res.writeHead(200).end('{}');
          return;
        }
        // /patch-session {id, patch}: fields set on a session, e.g. backgroundTasks (e2e/agentState.spec.ts, w475).
        if (req.url === '/patch-session') {
          const { id, patch } = JSON.parse(body) as { id: string; patch: Record<string, unknown> };
          const info = internals.sessions.get(id).info;
          Object.assign(info, patch);
          internals.store.putSession(info);
          res.writeHead(200).end('{}');
          return;
        }
        const { text } = JSON.parse(body) as { text: string };
        internals.sessions.send(internals.agents.dispatcherId!, text, 'human', undefined, { requestedBy: { userId: USER, displayName: 'Tester' } });
        res.writeHead(200).end('{}');
      } catch (e) {
        res.writeHead(400).end(String((e as Error).message));
      }
    });
  })
  .listen(port + 200, '127.0.0.1');
console.log(`e2e: FF Factory test server ready on http://127.0.0.1:${port} (data in ${base})`);
