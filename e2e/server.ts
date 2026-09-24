/**
 * The FF Factory server as the E2E suite runs it: the real server/index.ts, against a throwaway
 * config and data folder, with a scripted fake in place of the Agent SDK (e2e/fakeAgent.ts). No
 * Unity, no Claude, no network. Playwright starts one per browser project (playwright.config.ts).
 *
 *   E2E_PORT=8791 node e2e/server.ts      (needs the web UI built: npm --prefix web run build)
 *
 * Seeded state (fixed, so screenshots are stable):
 *   sandbox "alpha"    ready, Unity stopped: tests start their own worker agents here
 *   sandbox "gallery"  one idle worker with a seeded transcript, for visual snapshots; never changed
 *   sandbox "stuck"    Unity blocked on a dialog (the watchdog's badge)
 *   login              tester / e2e-password-123
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sandbox, SessionInfo, TranscriptEvent } from '../shared/types.ts';
import { fakeQuery } from './fakeAgent.ts';

export const USER = 'tester';
export const PASSWORD = 'e2e-password-123';

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
for (const id of ['alpha', 'gallery', 'stuck']) repo(path.join(sandboxRoot, id), `sandbox/${id}`);
// A short clip in a sandbox's screenshot folder, with the .meta Unity writes beside it (e2e/video.spec.ts).
const videos = path.join(sandboxRoot, 'alpha', 'Assets', 'Screenshots', 'Videos');
fs.mkdirSync(videos, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'e2e', 'fixtures', 'clip.webm'), path.join(videos, 'clip.webm'));
fs.writeFileSync(path.join(videos, 'clip.webm.meta'), 'fileFormatVersion: 2\nguid: 0\n');

const configFile = path.join(base, 'config.json');
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      port,
      host: '127.0.0.1',
      trustProxy: false,
      ownerName: 'Tester',
      dataDir,
      sandboxRoot,
      repo: { url: path.join(base, 'base'), basePath: path.join(base, 'base') },
      defaultBase: 'develop',
      unity: { editorPath: path.join(base, 'no-unity', 'Unity.exe'), watchdog: { stallMinutes: 0, runningPollSeconds: 0, autoDismiss: false } },
      limits: { maxUnity: 2, maxSessions: 50, maxSandboxes: 10, minFreeGB: 0 },
      models: ['opus', 'sonnet'],
      defaultModel: 'opus',
      orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
      worker: { permissionMode: 'bypassPermissions', effort: 'low' },
      voice: { enabled: false, autoInstall: false, tts: false },
    },
    null,
    2,
  ),
);

const T0 = '2026-09-24T09:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const sandbox = (id: string, purpose: string, sessionIds: string[] = []): Sandbox => ({
  id,
  name: id,
  branch: `sandbox/${id}`,
  base: 'develop',
  path: path.join(sandboxRoot, id),
  purpose,
  status: 'ready',
  createdAt: T0,
  unity: { state: 'stopped' },
  sessionIds,
});
const gallery: SessionInfo = {
  id: 'gallery1',
  kind: 'worker',
  sandboxId: 'gallery',
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
fs.writeFileSync(
  path.join(dataDir, 'state.json'),
  JSON.stringify({
    sandboxes: [sandbox('alpha', 'E2E playground'), sandbox('gallery', 'Visual baseline', ['gallery1']), sandbox('stuck', 'Unity blocked demo')],
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

process.env.FFSB_CONFIG = configFile;
// No stored claude.ai login here, so the plan meter reports "unavailable" instead of starting a CLI.
process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const { Auth } = await import('../server/auth.ts');
await new Auth(dataDir, { trustProxy: false }).setUser(USER, PASSWORD);

const { setQueryForTesting } = await import('../server/sessions.ts');
setQueryForTesting(fakeQuery() as never);

const { internals } = await import('../server/index.ts');

// After the server's own reconcile (which clears a blocked state on boot): an editor stuck on a dialog.
// It has no pid and no log, so the poll and the watchdog leave it as it is.
const stuck = internals.store.sandboxes.get('stuck')!;
internals.store.putSandbox({
  ...stuck,
  unity: {
    state: 'blocked',
    detail: 'blocked: Safe Mode: compile errors',
    blocked: {
      reason: 'dialog',
      title: 'Enter Safe Mode?',
      text: 'The project has compilation errors.',
      buttons: ['Enter Safe Mode', 'Ignore', 'Quit'],
      advice: 'Press Ignore, then fix the compile errors.',
      since: at(5),
      resumeState: 'starting',
    },
  },
});
console.log(`e2e: FF Factory test server ready on http://127.0.0.1:${port} (data in ${base})`);
