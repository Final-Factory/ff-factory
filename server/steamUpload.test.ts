import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteamJobs, branchOf, describeJob, liveBranchesFor, parseAsk, readClaim, refuseUpload, type UploadAsk, type UploadFacts } from './steamUpload.ts';

const SHA = 'a'.repeat(40);
const ask = (over: Partial<UploadAsk> = {}): UploadAsk => ({ version: '1.0.0.50', app: 'main', sha: SHA, runs: { windows: 'w', mac: 'm' }, preview: false, ...over });
const facts = (over: Partial<UploadFacts> = {}): UploadFacts => ({
  machine: 'beast',
  requests: ['w5600'],
  building: true,
  claim: { lane: 'urgent', version: '1.0.0.50', machine: 'beast', request: 'w5600' },
  branch: 'master',
  ...over,
});

test('steam_upload: the caller\'s own release to the branch it names goes on', () => {
  assert.equal(refuseUpload(ask(), facts()), undefined);
  assert.equal(refuseUpload(ask({ live: 'development' }), facts()), undefined);
  assert.equal(refuseUpload(ask({ app: 'demo' }), facts()), undefined);
  assert.equal(refuseUpload(ask(), facts({ branch: 'pre-1.0' })), undefined);
});

test('steam_upload: refuses another request\'s build', () => {
  // The claim names another request: someone else's release.
  assert.match(refuseUpload(ask(), facts({ claim: { lane: 'urgent', version: '1.0.0.50', machine: 'beast', request: 'w5599' } }))!, /w5599.*not one of your requests.*only your own request's build/);
  // Another version than the claim's: another release's build.
  assert.match(refuseUpload(ask({ version: '1.0.0.49' }), facts())!, /another release's build/);
  // Claimed for another computer.
  assert.match(refuseUpload(ask(), facts({ claim: { lane: 'urgent', version: '1.0.0.50', machine: 'lothdesktop', request: 'w5600' } }))!, /names "lothdesktop".*not beast/);
  // Not the builder of a started build plan here.
  assert.match(refuseUpload(ask(), facts({ building: false }))!, /not building a release on beast/);
  // No claim: FFBox's release, not the urgent lane's.
  assert.match(refuseUpload(ask(), facts({ claim: undefined }))!, /no cicd\/release-lane.json.*FFBox uploads its own/);
  assert.match(refuseUpload(ask(), facts({ claim: { lane: 'normal', version: '1.0.0.50', machine: 'beast', request: 'w5600' } }))!, /not urgent/);
  assert.match(refuseUpload(ask(), facts({ claimError: 'HTTP 500' }))!, /could not read the release claim/);
  // A commit on no release branch.
  assert.match(refuseUpload(ask(), facts({ branch: undefined }))!, /not on master or pre-1.0/);
  // Once per version and app.
  assert.match(refuseUpload(ask(), facts({ uploaded: true }))!, /uploaded already/);
});

test('steam_upload: refuses a Steam branch the release did not name', () => {
  for (const live of ['default', 'beta', 'pre-release', 'Development ', 'public']) {
    assert.match(refuseUpload(ask({ live }), facts())!, /sets development live, not .*no other Steam branch is set by an agent/, live);
  }
  // pre-1.0 and the demo set nothing live.
  assert.match(refuseUpload(ask({ live: 'development' }), facts({ branch: 'pre-1.0' }))!, /sets no Steam branch live, not development/);
  assert.match(refuseUpload(ask({ app: 'demo', live: 'development' }), facts())!, /sets no Steam branch live/);
  assert.deepEqual(liveBranchesFor('master', 'main'), ['development']);
  assert.deepEqual(liveBranchesFor('pre-1.0', 'main'), []);
  assert.deepEqual(liveBranchesFor('master', 'demo'), []);
});

test('steam_upload: a preview sets nothing live and needs no claim', () => {
  const none = facts({ building: false, claim: undefined, branch: undefined });
  assert.equal(refuseUpload(ask({ preview: true }), none), undefined);
  assert.match(refuseUpload(ask({ preview: true, live: 'development' }), none)!, /a preview sets nothing live/);
});

test('steam_upload: parseAsk checks the shape', () => {
  const ok = { version: '1.0.0.50', app: 'main', sha: SHA, runs: { windows: 'C:/a', mac: 'C:/b' } };
  assert.deepEqual(parseAsk(ok), { version: '1.0.0.50', app: 'main', sha: SHA, runs: { windows: 'C:/a', mac: 'C:/b' }, preview: false });
  assert.equal((parseAsk({ ...ok, preview: true, live: 'development' }) as UploadAsk).live, 'development');
  assert.match(parseAsk({ ...ok, version: '1.0' }) as string, /four numbers/);
  assert.match(parseAsk({ ...ok, app: 'server' }) as string, /main or demo/);
  assert.match(parseAsk({ ...ok, sha: 'abc' }) as string, /40-character/);
  assert.match(parseAsk({ ...ok, runs: { windows: 'C:/a' } }) as string, /windows and mac/);
  assert.match(parseAsk({ ...ok, runs: { ...ok.runs, ios: 'x' } }) as string, /windows, mac and linux only/);
});

test('steam_upload: the claim and the branch come from GitHub', async () => {
  const claim = { lane: 'urgent', version: '1.0.0.50', machine: 'beast', request: 'w5600' };
  const b64 = Buffer.from(JSON.stringify(claim)).toString('base64');
  const gh = async (_c: string, args: string[]) => {
    const url = args[1];
    if (url.includes('contents/cicd/release-lane.json')) return url.includes(SHA) ? { code: 0, stdout: `${b64.slice(0, 20)}\n${b64.slice(20)}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    if (url.endsWith('...master')) return { code: 0, stdout: 'diverged\n', stderr: '' };
    if (url.endsWith('...pre-1.0')) return { code: 0, stdout: 'ahead\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  assert.deepEqual(await readClaim(gh, 'o/r', SHA), { claim });
  assert.deepEqual(await readClaim(gh, 'o/r', 'b'.repeat(40)), {});
  assert.equal(await branchOf(gh, 'o/r', SHA), 'pre-1.0');
  const err = async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' });
  assert.match((await readClaim(err, 'o/r', SHA)).error!, /502/);
  assert.equal(await branchOf(err, 'o/r', SHA), undefined);
});

test('steam_upload: status with no job finds the running check, then the latest job of any action', () => {
  let now = 1_000;
  const jobs = new SteamJobs(() => now);
  assert.equal(jobs.latestOn('beast'), undefined);
  jobs.start({ id: 'i1', machine: 'beast', key: SteamJobs.keyOf('beast', 'install'), action: 'install', by: 's' });
  jobs.update('i1', { state: 'done' });
  now += 1_000;
  jobs.start({ id: 'c1', machine: 'beast', key: SteamJobs.keyOf('beast', 'check'), action: 'check', by: 's' });
  jobs.start({ id: 'o1', machine: 'lothdesktop', key: SteamJobs.keyOf('lothdesktop', 'check'), action: 'check', by: 's' });
  assert.equal(jobs.latestOn('beast')?.id, 'c1', 'the running check');
  // It ends a second before the caller asks: still that check, not "no job".
  jobs.update('c1', { state: 'done', result: { exit: 0 } });
  assert.equal(jobs.latestOn('beast')?.id, 'c1');
  assert.equal(jobs.latestOn('beast')?.state, 'done');
  assert.equal(jobs.latestOn('m5'), undefined);
});

test('steam_upload: one check per computer every 10 minutes, and a lost daemon fails its job', () => {
  let now = 1_000_000;
  const jobs = new SteamJobs(() => now);
  const j = jobs.start({ id: 'c1', machine: 'beast', key: SteamJobs.keyOf('beast', 'check'), action: 'check', by: 's' });
  assert.equal(jobs.runningOn('beast'), j);
  assert.ok(jobs.checkWait('beast', false) > 0);
  assert.equal(jobs.checkWait('beast', true), 0, 'a guard code goes now');
  now += SteamJobs.CHECK_EVERY_MS;
  assert.equal(jobs.checkWait('beast', false), 0);
  jobs.lost('beast', 'the daemon on beast went offline');
  assert.equal(j.state, 'failed');
  assert.match(j.error!, /unknown whether it finished|whether it finished is unknown/);
  // The daemon's later word still counts.
  jobs.update('c1', { state: 'done', result: { exit: 0 } });
  assert.equal(j.state, 'done');
  assert.match(describeJob(j, now), /Steam login check on beast: done/);
});
