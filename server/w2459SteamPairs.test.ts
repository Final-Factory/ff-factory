// w2459 (lothsahn, 2026-10-28): pair runs that need Steam lobbies go only to machines with a logged-in Steam client, a
// different account on each leg. w2458 (the pair run for the lobby-browser PR #2757) put its client leg on biscuit, which
// has no Steam client, and died at its Steam check; w2452 died with Steam signed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairRoom, pairText, steamFleetOf, steamPairShort, unfitWhy, type RoomFit } from '../shared/capacity.ts';
import { blockerVerdict, type BlockerFacts } from '../shared/blockers.ts';
import { loginUserOf, mentionsSteam, parseVdf, sanitizeSteamClient, steamLabel, steamLacks, type SteamClient } from '../shared/steam.ts';
import { readSteamClient, type SteamClientDeps } from '../machine/steamClient.ts';
import type { WorkBlocker, WorkItem, WorkPair } from '../shared/types.ts';

const AT = '2026-10-28T08:00:00.000Z';
const on = (accountId: number, persona: string): SteamClient => ({ checkedAt: AT, installed: true, running: true, accountId, persona });
const LOTH = on(7155839, 'Lothsahn');
const SLIMS = on(1234567, 'slims');
const NONE: SteamClient = { checkedAt: AT, installed: false, running: false };
const OUT: SteamClient = { checkedAt: AT, installed: true, running: true };
const STEAM: WorkPair = { legs: 2, steam: 'a Steam lobby join (PR #2757)' };
const work = (pair: WorkPair = STEAM) => ({ title: 'Pair run for w2448: lobby browser', brief: 'Host a lobby.', pair });

// The fleet as it stood on 2026-10-28: BEAST and LothDesktop signed in, biscuit with no Steam client, m3 not reported.
const FIT: Record<string, RoomFit> = {
  beast: { platform: 'win32', steam: SLIMS },
  lothdesktop: { platform: 'win32', steam: LOTH },
  biscuit: { platform: 'linux', steam: NONE },
  lothlaptop: { platform: 'win32', steam: OUT },
  m3: { platform: 'darwin' },
};

test('w2459: a Steam pair is never placed on a computer without signed-in Steam (unfitWhy says what it lacks)', () => {
  assert.equal(unfitWhy(work(), 'beast', FIT), undefined);
  assert.equal(unfitWhy(work(), 'lothdesktop', FIT), undefined);
  assert.match(unfitWhy(work(), 'biscuit', FIT) ?? '', /^biscuit has no Steam client installed, and its pair run needs Steam/);
  assert.match(unfitWhy(work(), 'lothlaptop', FIT) ?? '', /^lothlaptop's Steam client is signed out/);
  assert.match(unfitWhy(work(), 'm3', FIT) ?? '', /^m3's daemon has not reported its Steam client yet/);
  // A pair that needs no Steam still goes anywhere.
  assert.equal(unfitWhy(work({ legs: 2 }), 'biscuit', FIT), undefined);
});

test('w2459: pairRoom picks only computers signed in to Steam, never two on the same account', () => {
  assert.deepEqual(pairRoom(work(), ['beast', 'biscuit', 'lothdesktop'], FIT).pick?.sort(), ['beast', 'lothdesktop']);
  // w2458 as it happened: biscuit and one Steam computer free is no room.
  assert.ok(pairRoom(work(), ['biscuit', 'beast'], FIT).short, 'one signed-in computer is short');
  const twin: Record<string, RoomFit> = { ...FIT, lothlaptop: { platform: 'win32', steam: LOTH } };
  const r = pairRoom(work(), ['lothdesktop', 'lothlaptop'], twin);
  assert.ok(r.short, 'two computers on one account are short');
  assert.match(r.short!, /Lothsahn/);
  for (const ids of [['beast', 'lothdesktop', 'lothlaptop'], ['lothlaptop', 'lothdesktop', 'beast'], ['lothdesktop', 'lothlaptop', 'biscuit', 'beast']]) {
    const pick = pairRoom(work(), ids, twin).pick!;
    assert.equal(pick.length, 2, ids.join());
    assert.equal(new Set(pick.map((id) => twin[id].steam!.accountId)).size, 2, `one account per leg from ${ids.join()}`);
    for (const id of pick) assert.equal(steamLacks(id, twin[id].steam), undefined);
  }
  assert.match(pairText(STEAM), /only on computers signed in to Steam, a different Steam account on each leg \(a Steam lobby join/);
});

test('w2459: steamPairShort names every computer and what it lacks; fleet-wide (offline and busy ones count) it is ok with two accounts', () => {
  const fleet = Object.entries(FIT).map(([id, f]) => ({ id, platform: f.platform, steam: f.steam }));
  assert.equal(steamPairShort(STEAM, fleet), undefined);
  assert.equal(steamPairShort({ legs: 2 }, []), undefined, 'no Steam mark: never short');
  const short = steamPairShort(STEAM, fleet.filter((m) => m.id !== 'beast'))!;
  assert.match(short, /needs 2 computers signed in to different Steam accounts, and only lothdesktop \("Lothsahn"\) is: /);
  for (const lack of ['biscuit has no Steam client installed', "lothlaptop's Steam client is signed out", "m3's daemon has not reported its Steam client yet"]) assert.ok(short.includes(lack), lack);
  const same = steamPairShort(STEAM, [{ id: 'lothdesktop', steam: LOTH }, { id: 'lothlaptop', steam: LOTH }])!;
  assert.match(same, /lothlaptop is signed in to "Lothsahn", the account lothdesktop takes/);
  assert.match(steamPairShort({ ...STEAM, avoid: ['beast'] }, fleet)!, /beast is where an earlier leg failed/);
  // Only pool computers count: a play-only computer or one with no sandbox root runs no leg.
  assert.deepEqual(
    steamFleetOf([{ id: 'beast', sandboxRoot: 'F:/ffw', steam: SLIMS }, { id: 'tv', sandboxRoot: 'D:/ffw', playOnly: 'the living-room PC', steam: LOTH }, { id: 'x' }]).map((m) => m.id),
    ['beast'],
  );
});

test('w2459: the steam gate clears once the fleet has enough Steam computers, or the request is no Steam pair; stays open (late) meanwhile', () => {
  const gate: WorkBlocker = { kind: 'steam', what: 'too few', at: AT, by: 'dispatcher' };
  const pairItem = { id: 'w9', pair: STEAM } as unknown as WorkItem;
  const facts = (short: string | undefined): BlockerFacts => ({ now: Date.parse(AT) + 60_000, work: (id) => (id === 'w9' ? pairItem : undefined), steamShort: () => short });
  assert.equal(blockerVerdict(gate, facts(undefined), 'w9').state, 'clear');
  const open = blockerVerdict(gate, facts('only beast is'), 'w9');
  assert.notEqual(open.state, 'clear');
  assert.match(open.why, /only beast is/);
  assert.equal(blockerVerdict(gate, facts('only beast is'), 'w10').state, 'clear', 'no pair run that needs Steam');
});

test('w2459: the portal keeps an account id and a display name only; loginusers.vdf gives the persona, never the login name', () => {
  assert.deepEqual(sanitizeSteamClient({ checkedAt: AT, installed: true, running: true, accountId: 7155839, persona: 'Lothsahn', AccountName: 'secret-login', token: 'x' }), LOTH);
  assert.equal(sanitizeSteamClient({ installed: true }), undefined, 'no checkedAt: not a report');
  assert.equal(sanitizeSteamClient({ checkedAt: AT, installed: true, running: true, accountId: -4 })!.accountId, undefined);
  const vdf = `"users"\n{\n\t"76561197967421567"\n\t{\n\t\t"AccountName"\t\t"secret-login"\n\t\t"PersonaName"\t\t"Lothsahn"\n\t\t"WantsOfflineMode"\t\t"0"\n\t}\n\t"76561197961500295"\n\t{\n\t\t"AccountName"\t\t"other"\n\t\t"PersonaName"\t\t"slims"\n\t\t"WantsOfflineMode"\t\t"1"\n\t}\n}\n`;
  assert.equal((parseVdf(vdf).users as Record<string, Record<string, string>>)['76561197967421567'].PersonaName, 'Lothsahn');
  assert.deepEqual(loginUserOf(vdf, 7155839), { persona: 'Lothsahn' });
  assert.deepEqual(loginUserOf(vdf, 1234567), { persona: 'slims', offline: true });
  assert.ok(!JSON.stringify(loginUserOf(vdf, 7155839)).includes('secret-login'));
  assert.match(steamLacks('beast', { ...SLIMS, offline: true }) ?? '', /offline mode/);
  assert.equal(steamLabel(LOTH), 'Lothsahn (signed in)');
  assert.equal(steamLabel(undefined), 'not reported yet (an older daemon)');
});

const fake = (o: { platform: NodeJS.Platform; files?: Record<string, string>; reg?: Record<string, string>; procs?: string }): SteamClientDeps & { ran: string[] } => {
  const ran: string[] = [];
  const norm = (f: string) => f.replace(/\\/g, '/');
  return {
    ran,
    platform: o.platform,
    home: '/home/ben',
    now: () => new Date(AT),
    exists: (f) => Object.keys(o.files ?? {}).some((k) => k === norm(f) || k.startsWith(`${norm(f)}/`)),
    read: (f) => o.files?.[norm(f)],
    run: async (cmd, args) => {
      ran.push([cmd, ...args].join(' '));
      if (cmd === 'reg') {
        const key = args[1];
        const v = o.reg?.[key];
        return v === undefined ? { code: 1, stdout: '', stderr: 'not found' } : { code: 0, stdout: `\r\n${key}\r\n    ${args[3]}    ${v}\r\n`, stderr: '' };
      }
      return { code: o.procs ? 0 : 1, stdout: o.procs ?? '', stderr: '' };
    },
  } as SteamClientDeps & { ran: string[] };
};
const USERS = `"users" { "76561197967421567" { "AccountName" "secret-login" "PersonaName" "Lothsahn" "WantsOfflineMode" "0" } }`;

test('w2459: readSteamClient on Windows reads only the Steam keys and its own folder: signed in, signed out, not installed', async () => {
  const signed = fake({
    platform: 'win32',
    reg: { 'HKCU\\Software\\Valve\\Steam': 'REG_SZ    c:/games/steam', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess': 'REG_DWORD    0x6d307f' },
    files: { 'c:/games/steam/steam.exe': '', 'c:/games/steam/config/loginusers.vdf': USERS },
    procs: '"steam.exe","9652","Console","1","120,000 K"\r\n',
  });
  assert.deepEqual(await readSteamClient(signed), LOTH);
  assert.deepEqual(signed.ran, [
    'reg query HKCU\\Software\\Valve\\Steam /v SteamPath',
    'reg query HKCU\\Software\\Valve\\Steam\\ActiveProcess /v ActiveUser',
    'tasklist /FI IMAGENAME eq steam.exe /NH /FO CSV',
  ], 'no drive is scanned: three Steam-only commands');
  const out = fake({ platform: 'win32', reg: { 'HKCU\\Software\\Valve\\Steam': 'REG_SZ    c:/games/steam', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess': 'REG_DWORD    0x0' }, files: { 'c:/games/steam/steam.exe': '' }, procs: '"steam.exe","9652"' });
  assert.deepEqual(await readSteamClient(out), OUT);
  assert.deepEqual(await readSteamClient(fake({ platform: 'win32' })), NONE, 'biscuit-like: no Steam key');
  const stopped = fake({ platform: 'win32', reg: { 'HKCU\\Software\\Valve\\Steam': 'REG_SZ    c:/games/steam' }, files: { 'c:/games/steam/steam.exe': '' }, procs: 'INFO: No tasks are running which match the specified criteria.' });
  assert.deepEqual(await readSteamClient(stopped), { checkedAt: AT, installed: true, running: false });
});

test('w2459: readSteamClient on Linux reads registry.vdf and pgrep', async () => {
  const reg = `"Registry" { "HKCU" { "Software" { "Valve" { "Steam" { "ActiveProcess" { "ActiveUser" "7155839" } } } } } }`;
  const linux = fake({ platform: 'linux', files: { '/home/ben/.steam/registry.vdf': reg, '/home/ben/.steam/steam/config/loginusers.vdf': USERS }, procs: '4242\n' });
  assert.deepEqual(await readSteamClient(linux), LOTH);
  assert.deepEqual(await readSteamClient(fake({ platform: 'linux' })), NONE);
});

test('w2459: request_pair reads a Steam need from a lobby or a Steam join, not from a bare "Steam" branch name', () => {
  assert.ok(mentionsSteam('lobby browser on PR #2757'));
  assert.ok(mentionsSteam('', 'leg 2 joins the host through a Steam invite'));
  assert.ok(mentionsSteam('SteamMatchmaking callbacks fire on both legs'));
  assert.ok(!mentionsSteam('MP-lowore-pin-pair on PR #2340', 'Run it on the build the Steam development branch carries; join over the direct address.'));
});
