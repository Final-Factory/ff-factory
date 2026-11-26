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
// w5545: a test's unity-slot or bench ticket never asks the worker's real daemon (its token would file a real request).
delete process.env.FF_DAEMON_RPC;
delete process.env.FF_DAEMON_TOKEN;
