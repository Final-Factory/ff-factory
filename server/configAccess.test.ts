import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalSecretRules, readProblem, secretFilesOf, type ReadCtx, type ReadFs } from './secretGuard.ts';
import { memoryGuard } from './orchestratorMemory.ts';
import { mayReadConfig, personalSettingProblem } from './agents.ts';
import { checkOpsShell, opsBrief, OPS_PATHS } from './opsWorker.ts';
import { PERSONAL_TOOLS } from './belts.ts';
import type { SessionInfo } from '../shared/types.ts';

/**
 * w1078: config.json holds no secret, so Lothsahn's and Ben's own orchestrators and the dispatcher may Read and Grep it
 * (lothsahn: "Can we move these two to a separate secrets file and let you read and write the rest?"), and the ops worker
 * reads it through `fffctl config`. Writes go through set_app_config, only in a turn the person started. The secrets folder,
 * where FFBox's connector hash now is, stays closed to every agent. The portal VM's paths (deploy/vm/guest).
 */

const noFs: ReadFs = { realpath: () => undefined, isDir: (p) => (p.endsWith('.json') || /\.json\.(prev|\d)$/.test(p) ? false : undefined) };
const LINUX: ReadCtx = { platform: 'linux', home: '/srv/fff/home', cwd: '/srv/fff/base', fsx: noFs };
const CONFIG = '/srv/fff/config/config.json';
const HASH_FILE = '/srv/fff/secrets/ffbox-connector-token.sha256';

/** The rules an orchestrator gets (Agents.orchestratorSecrets): `config`, the readable config files it was given. */
const rules = (config: string[]) =>
  portalSecretRules({
    configFile: CONFIG,
    appRoot: '/srv/fff/app/current',
    dataDir: '/srv/fff/data',
    secretFiles: secretFilesOf({ providers: { ffbox: { tokenSha256File: HASH_FILE } }, vault: { keyFile: '/etc/fff/vault.key' } }),
    allow: ['/srv/fff/data/orchestrator-memory/person-lothsahn', ...config],
    platform: 'linux',
  });
const owners = rules([CONFIG, `${CONFIG}.prev`, `${CONFIG}.1`]);
const others = rules([]);
const read = (r: ReturnType<typeof rules>, p: string, kind: 'file' | 'search' = 'file') => readProblem(p, kind, r, LINUX);

test("the owners' orchestrators and the dispatcher Read and Grep config.json and its saved versions; nothing else in its folder (w1078)", () => {
  assert.equal(read(owners, CONFIG), undefined);
  assert.equal(read(owners, CONFIG, 'search'), undefined, 'Grep on the file');
  assert.equal(read(owners, `${CONFIG}.prev`), undefined);
  assert.equal(read(owners, `${CONFIG}.1`), undefined);
  // A version it was not given (it held a secret when the session started), and a temp or damaged copy: closed.
  assert.match(read(owners, `${CONFIG}.2`) ?? '', /FF Factory's own/);
  assert.match(read(owners, `${CONFIG}.tmp`) ?? '', /FF Factory's own/);
  assert.match(read(owners, `${CONFIG}.damaged-2026-10-12`) ?? '', /FF Factory's own/);
  // A search from the folder, or above it, would read what is closed.
  assert.match(read(owners, '/srv/fff/config', 'search') ?? '', /would read FF Factory's own files/);
  assert.match(read(owners, '/srv/fff', 'search') ?? '', /would read FF Factory's own files/);
});

test('the secrets folder, where the FFBox connector hash is, stays closed to every orchestrator (w1078)', () => {
  for (const r of [owners, others]) {
    assert.match(read(r, HASH_FILE) ?? '', /FF Factory's own/);
    assert.match(read(r, '/srv/fff/secrets/config.json.before-w1078-2026-10-12T04-00-00-000Z') ?? '', /FF Factory's own/, 'the backup of the old config');
    assert.match(read(r, '/srv/fff/secrets', 'search') ?? '', /FF Factory's own|would read/);
  }
  assert.ok(secretFilesOf({ providers: { ffbox: { tokenSha256File: '/elsewhere/hash' } } }).includes('/elsewhere/hash'), 'a hash file named anywhere is closed too');
  const tmpRules = portalSecretRules({ configFile: '/tmp/ffsb-x/config.json', appRoot: '/srv/fff/app/current', dataDir: '/tmp/ffsb-x/data', platform: 'linux' });
  assert.match(readProblem('/tmp/ffsb-x/secrets/ffbox-connector-token.sha256', 'file', tmpRules, LINUX) ?? '', /FF Factory's own/, "a config folder's own secrets folder is closed");
  const moved = portalSecretRules({ configFile: CONFIG, appRoot: '/srv/fff/app/current', dataDir: '/srv/fff/data', env: { FFSB_SECRETS_DIR: '/var/lib/fff-secrets' }, platform: 'linux' });
  assert.match(readProblem('/var/lib/fff-secrets/ffbox-connector-token.sha256', 'file', moved, LINUX) ?? '', /FF Factory's own/, 'a secrets folder set elsewhere (FFSB_SECRETS_DIR) is closed too');
});

test("other people's orchestrators and standing agents still do not read config.json (w1078)", () => {
  assert.match(read(others, CONFIG) ?? '', /FF Factory's own/);
  assert.match(read(others, `${CONFIG}.prev`) ?? '', /FF Factory's own/);
});

const session = (o: Partial<SessionInfo>): SessionInfo => ({ id: 'o1', kind: 'orchestrator', title: 'x', status: 'idle', createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [], ...o }) as SessionInfo;
const lothsahn = session({ id: 'lo', orchestratorRole: 'personal', requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' } });
const ben = session({ id: 'be', orchestratorRole: 'personal', requestedBy: { userId: 'ben', displayName: 'Ben' } });
const sam = session({ id: 'sa', orchestratorRole: 'personal', requestedBy: { userId: 'sam', displayName: 'Sam' } });
const dispatcher = session({ id: 'di', orchestratorRole: 'dispatcher' });

test('who may read config.json: Lothsahn\'s and Ben\'s own orchestrators and the dispatcher; nobody else (w1078)', () => {
  assert.equal(mayReadConfig(lothsahn), true);
  assert.equal(mayReadConfig(ben), true);
  assert.equal(mayReadConfig(dispatcher), true);
  assert.equal(mayReadConfig(sam), false);
  assert.equal(mayReadConfig(session({ kind: 'standing' })), false);
  assert.equal(mayReadConfig(session({ kind: 'worker', requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' } })), false);
  assert.equal(mayReadConfig(undefined), false);
});

test('a setting changes through set_app_config, from the owners\' own orchestrators only in a turn their person started (w1078)', () => {
  assert.ok(PERSONAL_TOOLS.has('set_app_config'));
  const turn = (who: string) => (id: string) => id === who;
  assert.equal(personalSettingProblem(lothsahn, turn('lo')), undefined);
  assert.equal(personalSettingProblem(ben, turn('be')), undefined);
  assert.match(personalSettingProblem(lothsahn, turn('nobody')) ?? '', /turn Lothsahn started with a message of their own/, "a harness turn (a check-in, a timer, a relayed report) changes nothing");
  assert.match(personalSettingProblem(sam, turn('sa')) ?? '', /Lothsahn's and Ben's own orchestrators/);
  assert.match(personalSettingProblem(undefined, () => true) ?? '', /Lothsahn's and Ben's own orchestrators/);
});

test('an orchestrator never Writes or Edits config.json, whatever turn it is in: the memory guard keeps writes in its memory folder (w1078)', async () => {
  const guard = memoryGuard('/srv/fff/data/orchestrator-memory/person-lothsahn', () => true, 'linux', { realpath: () => undefined, isDir: () => undefined, nlink: () => 1 } as never);
  for (const tool of ['Edit', 'Write']) {
    const r = (await guard({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: CONFIG, content: '{}', new_string: '{}' } } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny', tool);
  }
});

test('the ops worker reads config.json through fffctl config and its check, and nothing else of the portal\'s (w1078)', () => {
  const ctx: ReadCtx = { platform: 'linux', home: OPS_PATHS.home, cwd: OPS_PATHS.scratch, fsx: { realpath: () => undefined } };
  assert.equal(checkOpsShell('fffctl config', ctx), undefined);
  assert.equal(checkOpsShell('fffctl config --check', ctx), undefined);
  assert.equal(checkOpsShell("fffctl config | jq '.intake.nightly.run'", ctx), undefined);
  assert.match(checkOpsShell(`cat ${CONFIG}`, ctx) ?? '', /not yours to read/);
  assert.match(checkOpsShell(`cat ${HASH_FILE}`, ctx) ?? '', /not yours to read/);
  assert.match(checkOpsShell('fffctl claude-token --file /tmp/x', ctx) ?? '', /a person's/, 'gone, and never the worker\'s');
  assert.match(opsBrief('Ben'), /fffctl config/);
});

test('w1097: the ops worker counts the prompts people answered through fffctl approvals, and still reads no transcript', () => {
  const ctx: ReadCtx = { platform: 'linux', home: OPS_PATHS.home, cwd: OPS_PATHS.scratch, fsx: { realpath: () => undefined } };
  assert.equal(checkOpsShell('fffctl approvals', ctx), undefined);
  assert.equal(checkOpsShell('fffctl approvals --since 2026-10-05 --split 2026-10-13', ctx), undefined);
  assert.match(checkOpsShell('cat /srv/fff/data/transcripts/a1b2c3d4.jsonl', ctx) ?? '', /not yours to read/);
  assert.match(checkOpsShell('node /srv/fff/app/current/scripts/cleanup-approvals.ts /srv/fff/data', ctx) ?? '', /no interpreters in the VM/, 'why fffctl approvals exists');
  assert.match(opsBrief('Lothsahn'), /fffctl approvals --since YYYY-MM-DD --split YYYY-MM-DD\` \(w1097\): the permission prompts a person answered, as counts only/);
});
