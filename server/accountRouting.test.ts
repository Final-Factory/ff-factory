import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { IntakeManager, type DiscordReader } from './intake.ts';
import { parseBugThread, type DiscordMessage, type DiscordThread } from './intakeRules.ts';
import { PoolHeldError, Vault, fingerprintOf, newKeyText, tokenPersonForWork, type KeySource, type VaultContext } from './vault.ts';
import { machineRunEnv } from './secrets.ts';
import { poolLimits } from './tokenPool.ts';
import { describeItem } from './work.ts';
import { SpendStore, buildReport, renderReport, renderRequest, type SpendContext } from './spend.ts';
import { UNRECORDED_ACCOUNT, zeroTok, type ModelTok } from '../shared/spend.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, TranscriptEvent, UserInfo, WorkItem } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * Whose Claude pool and GitHub token a request's workers run on (w1031): the person who last acted on it, the intake's
 * default for requests nobody asked for, a known Discord or FFBox person's own, and never the host token for a person
 * with a pool. The routing is `tokenPersonForWork` (server/vault.ts); these tests drive the real actions that set it.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'owner' },
];
const GUILD = '530867164866150410';
const BUGS = '1069745561672106015';
const DEV = '1012843817981976686';
const BOT = '1450000000000000001';
const BEN_ID = '111111111111111111';
const LOTH_ID = '222222222222222222';
const STRANGER = '333333333333333333';
const flake = (min: number, n = 0) => (((BigInt(Date.now() + min * 60_000) - 1420070400000n) << 22n) + BigInt(n)).toString();

class FakeDiscord implements DiscordReader {
  hasToken = true;
  guildId = GUILD;
  botId = BOT;
  threads: DiscordThread[] = [];
  starters: Record<string, DiscordMessage> = {};
  chat: DiscordMessage[] = [];
  channelIdOf(alias: string) {
    return ({ beta_bugs: BUGS, dev_chat: DEV } as Record<string, string>)[alias];
  }
  async channelName(id: string) {
    return id === BUGS ? 'beta-bugs' : 'dev-chat';
  }
  async ensureBotId() {
    return this.botId;
  }
  async forumThreads(id: string) {
    return this.threads.filter((t) => t.parent_id === id);
  }
  async message(_ch: string, id: string) {
    if (!this.starters[id]) throw new Error('404 Unknown Message');
    return this.starters[id];
  }
  async messagesAfter(_ch: string, after?: string) {
    return this.chat.filter((m) => !after || BigInt(m.id) > BigInt(after));
  }
  /** A new bug thread posted by a player nobody knows. */
  thread(min: number, title: string, player = STRANGER) {
    const id = flake(min);
    this.threads.push({ id, parent_id: BUGS, name: title, owner_id: player });
    this.starters[id] = { id, author: { id: player, username: 'p', global_name: 'A Player' }, content: 'it broke' };
    return id;
  }
}

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-route-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    workLimits: { intake: { perHour: 100, perDay: 100 } },
    intake: { discord: { enabled: true, dailyCap: 50, bugChannels: ['beta_bugs'], trusted: { [BEN_ID]: 'ben', [LOTH_ID]: 'lothsahn' } }, reviewers: ['ben', 'lothsahn'] },
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  (agents.orchestrators as unknown as { d: { gatherMs: number } }).d.gatherMs = 100;
  const o = agents.orchestrators;
  (o as unknown as { d: { intakeGatherMs: number } }).d.intakeGatherMs = 20;
  const discord = new FakeDiscord();
  const intake = new IntakeManager({ cfg, store, identity: agents.identity, orchestrators: o, discord });
  t.after(async () => {
    intake.close();
    o.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const call = async (info: SessionInfo, name: string, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(info).find((x) => x.name === name);
    if (!tool) throw new Error(`${info.title} has no ${name}`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  /** The person whose Claude pool and GitHub token a worker for `w` gets: what machineSandboxSpec hands machineRunEnv. */
  const runsFor = (w: WorkItem) => tokenPersonForWork(cfg, w) ?? w.requestedBy.userId;
  /** The request filed last (the ledger's own counter; the map's order moves when a request is saved). */
  const newest = () => store.work.get(`w${store.workSeq}`)!;
  let n = 0;
  const TOPICS = ['Splitters misbehave', 'Mass driver overshoots', 'Freighter docks twice', 'Research tree resets', 'Tooltip covers the minimap', 'Ammo belt starves turrets', 'Krillo ignores walls', 'Save menu hides names', 'Lasers cut belts', 'Pipes lose pressure', 'Radar shows ghosts', 'Cargo bay refuses stacks', 'Shield flickers on dock', 'Smelter eats ore'];
  /** An intake request nobody asked for by name: a player's bug thread, waiting for approval. */
  const bug = () => {
    n++;
    intake.fileBug(parseBugThread({ id: flake(n), parent_id: BUGS, name: TOPICS[n - 1], owner_id: `4444444444444444${String(n).padStart(2, '0')}` }, undefined, { channel: '#beta-bugs' }));
    return newest();
  };
  const human = (r: Requester, from: 'human' | 'system' = 'human') => {
    const chat = o.personalFor(r);
    chat.lastFrom = from;
    o.personWrote(chat.info.id);
    return chat;
  };
  return { dir, cfg, store, agents, o, intake, discord, call, runsFor, bug, human, newest };
}

test('the intake default: requests nobody asked for by name run for lothsahn, whoever the system payer is', (t) => {
  const { cfg, bug, runsFor, store } = setup(t);
  const w = bug();
  assert.equal(w.unattributed, true);
  assert.equal(w.requestedBy.userId, 'ben', "the system payer is the owner here: it only pays; it does not decide whose tokens run");
  assert.equal(runsFor(w), 'lothsahn');
  const src = (kind: string) => ({ unattributed: true, source: { kind, untrusted: true } }) as never;
  // Discord bug threads, FFBox reports and diagnoses, release follow-ups, and the nightly lab's regressions
  for (const kind of ['discord-bug', 'ffbox-request', 'ffbox-diagnosis', 'ffbox-branch', 'release', 'nightly']) assert.equal(tokenPersonForWork(cfg, src(kind)), 'lothsahn', kind);
  // The nightly run and review jobs and the Sentry's delegations: "Yes, move the nightly jobs to me" (lothsahn, w1031)
  for (const kind of ['nightly-run', 'nightly-review']) assert.equal(tokenPersonForWork(cfg, src(kind)), 'lothsahn', kind);
  assert.equal(tokenPersonForWork(cfg, { delegation: { id: 'd', agentId: 'nightly-regression-sentry', agentName: 'Sentry', auto: true } } as never), 'lothsahn', "the Sentry's delegations");
  assert.equal(tokenPersonForWork({ vault: { unattributed: { nightly: 'ben' } } }, src('nightly-run')), 'ben', 'a config that still says ben keeps it');
  // config vault.unattributed still moves a kind
  assert.equal(tokenPersonForWork({ vault: { unattributed: { intake: 'ben' } } }, src('release')), 'ben');
  assert.equal(store.work.size, 1);
});

test('a person acting on a request takes it over: each action type, logged, shown, and only a person counts', async (t) => {
  const { o, bug, call, human, runsFor, store, newest, agents } = setup(t);
  const log = (w: WorkItem) => w.log.filter((l) => /now runs for/.test(l));

  // Approving (the web UI route calls approveIntake; update_work approve is the same)
  let w = bug();
  assert.equal(runsFor(w), 'lothsahn');
  o.approveIntake(w.id, BEN);
  assert.equal(runsFor(w), 'ben');
  assert.match(log(w).at(-1)!, /now runs for Ben: Ben approved it \(was lothsahn;/);
  assert.equal(w.runsFor?.displayName, 'Ben');
  assert.match(describeItem(w, () => ''), /Runs for Ben \(Ben approved it\): their Claude pool and GitHub token\./);

  // Acting again as the same person logs nothing more; the other person acting switches it back, logged
  o.bumpWork(w.id, BEN);
  assert.equal(log(w).length, 1);
  o.bumpWork(w.id, LOTH);
  assert.equal(runsFor(w), 'lothsahn');
  assert.match(log(w).at(-1)!, /now runs for Lothsahn: Lothsahn pressed "Start now" \(was ben;/);

  // update_work approve, in their own turn, is the same
  const viaTool = bug();
  const ok = await call(human(BEN).info, 'update_work', { id: viaTool.id, approve: true });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(runsFor(viaTool), 'ben');

  // Declining
  w = bug();
  o.declineIntake(w.id, BEN, 'not now');
  assert.deepEqual([runsFor(w), w.status], ['ben', 'rejected']);
  assert.match(log(w).at(-1)!, /Ben declined it/);

  // Answering the intake question (a design question the worker raised) through update_work, in their own turn
  w = bug();
  o.approveIntake(w.id, LOTH);
  w.status = 'question';
  w.flag = { kind: 'design', text: 'should splitters alternate?', at: new Date().toISOString(), for: [BEN] };
  w.requesters = [LOTH, BEN];
  store.putWork(w);
  assert.equal(runsFor(w), 'lothsahn');
  const answered = await call(human(BEN).info, 'update_work', { id: w.id, note: 'Yes, alternate.' });
  assert.equal(answered.isError, false, answered.text);
  assert.equal(runsFor(w), 'ben');
  assert.match(log(w).at(-1)!, /Ben answered the design question on it/);

  // A note on a request
  w = bug();
  o.approveIntake(w.id, LOTH);
  w.requesters = [LOTH, BEN];
  store.putWork(w);
  await call(human(BEN).info, 'update_work', { id: w.id, note: 'Check the left output too.' });
  assert.equal(runsFor(w), 'ben');
  assert.match(log(w).at(-1)!, /Ben added a note/);

  // A priority change
  w = bug();
  o.approveIntake(w.id, LOTH);
  w.requesters = [LOTH, BEN];
  store.putWork(w);
  await call(human(BEN).info, 'update_work', { id: w.id, priority: 'high' });
  assert.equal(runsFor(w), 'ben');
  assert.match(log(w).at(-1)!, /Ben changed its priority to high/);

  // Reopening
  w = bug();
  o.approveIntake(w.id, LOTH);
  w.status = 'done';
  w.requesters = [LOTH, BEN];
  store.putWork(w);
  const reopened = await call(human(BEN).info, 'update_work', { id: w.id, reopen: true });
  assert.equal(reopened.isError, false, reopened.text);
  assert.equal(w.status, 'new');
  assert.equal(runsFor(w), 'ben');
  assert.match(log(w).at(-1)!, /Ben reopened it/);

  // An owner's note on another owner's request, in their own turn
  const mine = [...store.work.values()].find((x) => x.requestedBy.userId === 'ben' && !x.unattributed);
  assert.equal(mine, undefined, 'every request so far came from the intake');
  await call(human(BEN).info, 'request_work', { title: "Ben's own task", brief: 'x' });
  const own = newest();
  assert.equal(runsFor(own), 'ben', 'filing is a person acting: the filer');
  await call(human(LOTH).info, 'update_work', { id: own.id, note: 'Lothsahn here.' });
  assert.equal(runsFor(own), 'lothsahn');

  // A worker serving two requests runs on the person who acted on either most recently (agents.tokenUserOf)
  const [a, b] = [bug(), bug()];
  o.approveIntake(a.id, BEN);
  o.approveIntake(b.id, LOTH);
  // One stamp for both links: a worker serves the request it was LAST sent, so two stamps a millisecond apart made it serve only the
  // second (b), whose person then won whatever came after. It failed about 1 run in 30 under load, on main too (w1160, measured).
  const sentAt = new Date().toISOString();
  for (const x of [a, b]) {
    x.sessionIds = ['s9'];
    x.links = { s9: { at: sentAt, how: 'sent' } };
    store.putWork(x);
  }
  const tokenUserOf = (agents as unknown as { tokenUserOf(id: string): string | undefined }).tokenUserOf.bind(agents);
  assert.equal(tokenUserOf('s9'), 'lothsahn');
  // The later action wins by its runsFor.at, to the millisecond: wait until the clock has passed the approval's stamp. A
  // 5 ms timer could fire within the same millisecond on a loaded runner, and a tie kept lothsahn (w1173).
  const approved = store.work.get(b.id)!.runsFor!.at;
  while (new Date().toISOString() <= approved) await new Promise((r) => setTimeout(r, 1));
  o.bumpWork(a.id, BEN);
  assert.equal(tokenUserOf('s9'), 'ben');

  // Not acting: a worker's report or a harness turn (a relayed message), and the dispatcher's own decision
  await call(human(BEN).info, 'request_work', { title: "Ben's second task", brief: 'x' });
  const quiet = newest();
  await call(human(LOTH, 'system').info, 'update_work', { id: quiet.id, note: 'a worker said so' });
  assert.equal(quiet.runsFor, undefined, 'a note in a turn that is not theirs');
  assert.equal(log(quiet).length, 0);
  w = bug();
  o.approveIntake(w.id, LOTH);
  const before = w.runsFor;
  o.decide({ id: w.id, action: 'queue', note: 'no room yet' });
  assert.deepEqual(w.runsFor, before, "the dispatcher's decision is not a person acting");
  // A name that is no login here never takes a request over
  assert.equal(o.takeOver(w, { userId: 'nobody', displayName: 'Nobody' }, 'x'), false);
  assert.deepEqual(w.runsFor, before);
});

test('FFBox: an operator answering on FFBox, writing a follow-up or filing a dev request that joins takes it over', async (t) => {
  const { o, bug, runsFor, store } = setup(t);
  let w = bug();
  o.approveIntake(w.id, LOTH);
  w.status = 'question';
  w.question = { text: 'Which build?', at: new Date().toISOString() };
  store.putWork(w);
  o.answerFromFfbox(w.id, BEN, 'The Windows one.');
  assert.deepEqual([runsFor(w), w.status], ['ben', 'new']);
  assert.match(w.log.find((l) => /now runs for/.test(l))!, /Ben answered the question on FFBox/);

  w = bug();
  o.actedOn(w.id, BEN, 'Ben wrote a follow-up on FFBox');
  assert.equal(runsFor(w), 'ben');

  // A dev request of Ben's: filed as his own (runs on his pool); one that joins lothsahn's open request moves it to him
  const conv = (id: string) => ({ id, source: 'discord', title: 'Dock crash', createdAt: new Date().toISOString(), threadId: `t${id}` });
  const filing = (ref: string, c: string) => ({ ref, person: BEN, operator: 'ben', conversation: conv(c), title: 'Nuclear reactor leaks coolant', brief: 'The reactor leaks coolant after a save load.', keys: [], attachments: [], lookbackDays: 7 });
  const filed = o.fileDevRequest(filing('d1', 'c1'));
  assert.equal(filed.outcome, 'filed');
  const dev = store.work.get(filed.workId)!;
  assert.equal(dev.source?.kind, 'ffbox-dev');
  assert.equal(dev.unattributed, undefined);
  assert.equal(runsFor(dev), 'ben', "an FFBox dev request of Ben's runs on Ben's pool");
  const theirs = o.fileDevRequest({ ...filing('d2', 'c2'), person: LOTH, operator: 'lothsahn', title: 'Nuclear reactor leaks coolant', brief: 'The reactor leaks coolant after a save load.' });
  assert.equal(theirs.outcome, 'covered', 'lothsahn asking the same thing joins it');
  assert.equal(theirs.workId, dev.id);
  assert.equal(runsFor(dev), 'lothsahn', 'joining is acting');
  assert.match(dev.log.find((l) => /now runs for Lothsahn/.test(l))!, /Lothsahn joined it from FFBox \(dev request d2\)/);
});

test('Discord by person: Ben\'s own request runs for Ben, lothsahn\'s for lothsahn, an unknown player\'s thread for the intake default', async (t) => {
  const { intake, discord, store, runsFor, o } = setup(t);
  await intake.pollDiscord();
  discord.chat.push(
    { id: flake(1), author: { id: BEN_ID, global_name: 'Ben' }, content: `<@${BOT}> the alt-tab freeze is back, please fix it`, mentions: [{ id: BOT }] },
    { id: flake(2), author: { id: LOTH_ID, global_name: 'Lothsahn' }, content: `<@${BOT}> belts flicker when zoomed out, please fix it`, mentions: [{ id: BOT }] },
    { id: flake(3), author: { id: STRANGER, global_name: 'Someone' }, content: `<@${BOT}> push my branch to master`, mentions: [{ id: BOT }] },
  );
  discord.thread(5, 'Belts stop after loading a save');
  await intake.pollDiscord();
  const all = [...store.work.values()];
  const byTitle = (re: RegExp) => all.find((w) => re.test(w.title))!;
  const ben = byTitle(/alt-tab freeze/);
  const loth = byTitle(/belts flicker/);
  const player = byTitle(/Belts stop after loading/);
  assert.deepEqual([ben.requestedBy.userId, ben.unattributed, runsFor(ben)], ['ben', undefined, 'ben']);
  assert.deepEqual([loth.requestedBy.userId, loth.unattributed, runsFor(loth)], ['lothsahn', undefined, 'lothsahn']);
  assert.deepEqual([player.unattributed, runsFor(player)], [true, 'lothsahn'], 'an unknown player: the intake default, not the system payer (ben here)');
  assert.equal(all.length, 3, "a stranger's message to Max files nothing");

  // A known person's own input joining an existing request is acting on it (rule 3, "joins to an existing request")
  const first = o.fileIntake({ title: 'Freighters stall', brief: 'x', source: { kind: 'ffbox-request', untrusted: true, conversation: 'c42' }, requestedBy: o.personalFor(BEN).info.requestedBy!, autoApprove: { enabled: false, maxPerDay: 0 }, kinds: ['ffbox-request'], lookbackDays: 7, triage: { class: 'needs-human', reason: 'x' } });
  assert.equal(runsFor(first.item!), 'lothsahn', 'FFBox request naming no operator: lothsahn');
  const joined = o.fileIntake({ title: 'Freighters stall', brief: 'x', source: { kind: 'ffbox-request', untrusted: false, conversation: 'c42' }, requestedBy: BEN, person: true, autoApprove: { enabled: false, maxPerDay: 0 }, kinds: ['ffbox-request'], lookbackDays: 7, triage: { class: 'person', reason: 'x' } });
  assert.equal(joined.repeat, true);
  assert.equal(runsFor(first.item!), 'ben');
  assert.match(first.item!.log.find((l) => /now runs for Ben/.test(l))!, /Ben joined it/);
});

// ---------------------------------------------------------------- the accounts a run really gets (machineRunEnv)

const claudeTok = (c: string) => `sk-ant-oat01-${c.repeat(48)}`;
const B1 = claudeTok('b');
const L1 = claudeTok('d');

function vaultOf(t: { after: (fn: () => void) => void }, key: () => KeySource | undefined = () => undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-route-v-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  fs.mkdirSync(path.join(dir, 'data'));
  const make = (k?: () => KeySource) => new Vault({ file: path.join(dir, 'data', 'vault.json'), key: k ?? (() => key() ?? { file: keyFile }) });
  const v = make();
  v.add({ name: 'vault-ben-1', kind: 'claude', value: B1, owner: 'ben', share: 'owner' });
  v.add({ name: 'vault-lothsahn-1', kind: 'claude', value: L1, owner: 'lothsahn', share: 'owner' });
  return { v, make, dir };
}
const ctxOf = (v: Vault): VaultContext & { problems: string[]; missing: string[] } => {
  const problems: string[] = [];
  const missing: string[] = [];
  return { vault: v, payer: () => 'ben', onProblem: (l) => problems.push(l), onGithubMissing: (p, m) => missing.push(`${p}@${m}`), problems, missing, limits: () => poolLimits(undefined), now: () => Date.parse('2026-10-11T12:00:00Z') };
};
const cfgOf = (extra: Record<string, unknown> = {}) => ({ machines: {}, ...extra }) as never;

test("routing reaches the process: an intake or taken-over request starts on lothsahn's pool, never another credential or ben's", (t) => {
  const { v } = vaultOf(t);
  const ctx = ctxOf(v);
  // requested by ben (the system payer), routed to lothsahn by the intake default or by lothsahn's action
  const r = machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: BEN, tokenUser: 'lothsahn', sessionId: 's1' }, ctx);
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, L1);
  assert.match(r.account, /^vault token vault-lothsahn-1 …dddd \(lothsahn's pool/);
  assert.ok(!r.account.includes(L1.slice(13, 40)), 'only the last four characters');
  const benRun = machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: LOTH, tokenUser: 'ben', sessionId: 's2' }, ctx);
  assert.equal(benRun.env.CLAUDE_CODE_OAUTH_TOKEN, B1);
});

test("no fallback (w1078): a person with a pool whose tokens the vault cannot give waits, and the claim holds for lothsahn's work", (t) => {
  const { v, make } = vaultOf(t);
  // the vault key is gone: the entries exist but nothing opens
  const nokey = ctxOf(make(() => ({ why: 'no vault key: test' })));
  for (const tokenUser of ['lothsahn', 'ben']) {
    assert.throws(
      () => machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: BEN, tokenUser, sessionId: 's1' }, nokey),
      (e: unknown) => e instanceof PoolHeldError && new RegExp(`${tokenUser}'s Claude token pool cannot serve a workers run on m3`).test(e.message) && /never runs on another credential/.test(e.message) && !e.message.includes(B1.slice(13, 40)),
      tokenUser,
    );
  }
  // all of lothsahn's tokens at their limits: held (the existing pool rule), not ben's token
  const full = ctxOf(v);
  const meter = { available: true, asOf: '2026-10-11T12:00:00Z', models: [], session: { label: '5-hour', percent: 95 }, weekly: { label: 'weekly', percent: 99.5 } };
  full.usageOf = (fp: string) => (fp === fingerprintOf(L1) ? (meter as never) : undefined);
  assert.throws(() => machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: BEN, tokenUser: 'lothsahn', sessionId: 's1' }, full), PoolHeldError);
  // nothing is reported as a fallback: held is not a problem
  assert.equal(full.problems.length, 0);
  // a person with no token in the vault at all does not start a run on any other account (w1078; before, the host token)
  assert.throws(
    () => machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: { userId: 'sam', displayName: 'Sam' }, sessionId: 's3' }, ctxOf(v)),
    (e: unknown) => e instanceof PoolHeldError && /sam has no Claude token in the vault/.test(e.message),
  );
});

test('a person with no GitHub token in the vault: the run says so loudly, once per notice, and does not hand over another person\'s', (t) => {
  const { v } = vaultOf(t);
  v.add({ name: 'vault-ben-github', kind: 'github', value: `github_pat_${'a'.repeat(60)}`, owner: 'ben', share: 'owner' });
  const ctx = ctxOf(v);
  const cfg = cfgOf({ machines: { githubFromVault: true } });
  const loth = machineRunEnv(cfg, { id: 'm3' }, { role: 'workers', requestedBy: BEN, tokenUser: 'lothsahn', sessionId: 's1' }, ctx);
  assert.equal(loth.env.GH_TOKEN, undefined, "never ben's token for lothsahn's run");
  assert.equal(loth.github, undefined);
  assert.deepEqual(ctx.missing, ['lothsahn@m3'], 'the host is told (index.ts turns this into a notice)');
  assert.match(ctx.problems.join('\n'), /no usable vault GitHub token for a workers run on m3 for lothsahn/);
  const ben = machineRunEnv(cfg, { id: 'm3' }, { role: 'workers', requestedBy: LOTH, tokenUser: 'ben', sessionId: 's2' }, ctx);
  assert.match(ben.env.GH_TOKEN ?? '', /^github_pat_/);
  assert.deepEqual(ctx.missing, ['lothsahn@m3'], 'ben has one: nothing to report for him');
});

// ---------------------------------------------------------------- spend by account

const T0 = Date.parse('2026-10-11T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

test('spend_report attributes each turn to the account its process ran on, and a restart on another account splits the request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-acct-'));
  const item = { id: 'w1', title: 'Account routing', brief: 'x', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: iso(T0), updatedAt: iso(T0), sessionIds: ['s1'], overlaps: [], asks: 0, log: [], links: { s1: { at: iso(T0), how: 'sent' } } } as unknown as WorkItem;
  const info = { id: 's1', kind: 'worker', title: 'w1: x', status: 'idle', permissionMode: 'default', createdAt: iso(T0), lastActivityAt: iso(T0), turns: 0, costUsd: 0, pendingPermissions: [], model: 'claude-sonnet-5-5', ranAs: "vault token vault-ben-1 …bbbb (ben's pool, docs/vault.md)" } as SessionInfo;
  const ctx: SpendContext = { work: () => [item], session: () => info, priorResults: () => 1, now: () => T0 + 600_000 };
  const spend = new SpendStore(dir, ctx);
  const tok = (usd: number): ModelTok => ({ 'claude-sonnet-5-5': { ...zeroTok(), in: 10, out: 100, cr: 1000, cw: 100, usd } });
  const result = (seq: number, t: number, usd: number, cum: ModelTok): TranscriptEvent => ({ seq, t: iso(t), kind: 'result', ok: true, text: 'done', costUsd: usd, turns: 1, durationMs: 30_000, usage: { cum } });
  spend.observe('s1', result(1, T0 + 60_000, 0.5, tok(0.5)));
  // lothsahn acts; the next process starts on his pool, the same session resumes with its totals
  info.ranAs = "vault token vault-lothsahn-1 …EAAA (lothsahn's pool, docs/vault.md)";
  spend.observe('s1', result(2, T0 + 120_000, 1.2, tok(1.2)));
  const r = spend.request('w1')!;
  assert.deepEqual(Object.fromEntries(Object.entries(r.accounts!).map(([k, v]) => [k, Math.round(v.usd * 100) / 100])), { [info.ranAs]: 0.7, "vault token vault-ben-1 …bbbb (ben's pool, docs/vault.md)": 0.5 });
  assert.match(renderRequest(spend, 'w1', (id) => `#/session/${id}`, 7), /Per Claude account[^]*vault-lothsahn-1 …EAAA[^]*vault-ben-1 …bbbb/);
  const report = buildReport(spend, T0 + 600_000, { days: 1 });
  assert.deepEqual(report.accounts.map((a) => a.account), ["vault token vault-lothsahn-1 …EAAA (lothsahn's pool, docs/vault.md)", "vault token vault-ben-1 …bbbb (ben's pool, docs/vault.md)"]);
  assert.match(renderReport(report), /By Claude account the turns ran on[^\n]*vault-lothsahn-1 …EAAA[^\n]*\$0\.70/);
  assert.equal(spend.session('s1')!.accounts![info.ranAs]!.usd.toFixed(2), '0.70');
  // a session that left no account is not credited to one it never ran on
  info.ranAs = undefined;
  spend.observe('s1', result(3, T0 + 180_000, 1.3, tok(1.3)));
  assert.ok(spend.request('w1')!.accounts![UNRECORDED_ACCOUNT]);
  fs.rmSync(dir, { recursive: true, force: true });
});
