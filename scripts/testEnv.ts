// The tests never see a real credential (w1584). A worker's environment holds its person's vault GitHub token as GH_TOKEN
// (and may hold a Claude token, an API key, a GitHub App token or an env-kind vault entry); a failing assertion on code that
// read process.env printed one into a stored transcript (w1519, ff-factory PR #445). `npm test` and `npm run test:coverage`
// load this file first (`node --import ./scripts/testEnv.ts --test ...`): it deletes every credential variable from the
// test runner's environment, which the runner copies into each test file's process, and again in each of those processes.
// A test that needs a token sets a fake one itself. scripts/testEnv.test.ts proves a planted token does not get through.
import { secretEnvNames } from '../shared/secretShapes.ts';

for (const name of secretEnvNames(process.env)) delete process.env[name];
// Tests never scrub the real Claude Code transcripts (server/cliScrub.ts, w1688); a test that checks it turns it on.
process.env.FF_CLI_SCRUB ??= 'off';
// w6003: an in-process test daemon on Windows never runs whoami.exe to measure its agents' level (it would read the test
// runner's own token, which differs by machine); machine/agentIntegrity.test.ts covers the measurement.
process.env.FF_MEASURE_INTEGRITY ??= 'off';
// w6099: the tests' checkouts push to bare repositories in a temp folder; server/remoteGuard.ts lets them through only here.
(globalThis as { ffTestLocalRemotes?: boolean }).ffTestLocalRemotes = true;
// w5545: a test's unity-slot or bench ticket never asks the worker's real daemon (its token would file a real request).
delete process.env.FF_DAEMON_RPC;
delete process.env.FF_DAEMON_TOKEN;

// w5915: the tests run the same in a worker's session as in CI. A worker's agent is launched with its session's settings
// (server/agents.ts, machine/sandboxes.ts): FF_GAME_DATA_DIR, FF_SANDBOX_*, FF_WORKER_ROOT, its Claude folder, and git
// settings as GIT_CONFIG_COUNT/KEY_n/VALUE_n (the commit identity and a GitHub credential helper). On BEAST they reached the
// code under test: gameData and liveMachine read the sandbox's game data folder, githubTokens saw the daemon's helper,
// memoryGit committed as the worker, not as the repository's own identity. Every FF_ variable goes, except the switches a
// person sets to opt into a test group or to point at a tool; so do the session's git and Claude Code settings. CLAUDE_CONFIG_DIR
// stays: scripts/ownerAckEval.ts runs on this shell's Claude login.
export const KEPT_FF_ENV = new Set([
  'FF_CLI_SCRUB',
  'FF_MEASURE_INTEGRITY',
  'FF_TIMING_TESTS',
  'FF_NETWORK_TESTS',
  'FF_TEST_FILE_TIMES',
  'FF_TEST_INFLIGHT',
  'FF_PWSH',
  'FF_PYTHON',
  'FF_FFMPEG',
  'FF_AGENT_HOST_FAKE',
  'FF_AGENT_HOST_CODE',
  'FF_LANDLOCK_ABI',
  'FF_LINK_JOB_LOG',
  'FF_LEFTOVERS_CALLERS',
  'FF_GAME_REPO',
]);
const SESSION_ENV = /^(GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(?!GIT_BASH_PATH$)[A-Z_]+)$/;
export function sessionEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => (k.startsWith('FF_') && !KEPT_FF_ENV.has(k)) || SESSION_ENV.test(k));
}
for (const name of sessionEnvNames(process.env)) delete process.env[name];
