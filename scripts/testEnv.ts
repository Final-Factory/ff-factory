// The tests never see a real credential (w1584). A worker's environment holds its person's vault GitHub token as GH_TOKEN
// (and may hold a Claude token, an API key, a GitHub App token or an env-kind vault entry); a failing assertion on code that
// read process.env printed one into a stored transcript (w1519, ff-factory PR #445). `npm test` and `npm run test:coverage`
// load this file first (`node --import ./scripts/testEnv.ts --test ...`): it deletes every credential variable from the
// test runner's environment, which the runner copies into each test file's process, and again in each of those processes.
// A test that needs a token sets a fake one itself. scripts/testEnv.test.ts proves a planted token does not get through.
import { secretEnvNames } from '../shared/secretShapes.ts';

for (const name of secretEnvNames(process.env)) delete process.env[name];
