// w4638 (r294, w4637): LothDesktop's Steam was kicked off by another sign-in at 2026-11-16 21:36:55 EST and never came back
// by itself; the daemon showed its local times as if they were UTC and counted 21 failed sign-ins where Steam's own log said
// attempt 89. The lines below are LothDesktop's own connection_log.txt and steamui_login.txt as r294 read them, with the
// account id and the local address masked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steamConnection, steamKickedAt, steamStampUtc } from '../shared/steam.ts';
import { readSteamClient, type SteamClientDeps } from '../machine/steamClient.ts';

/** EST, UTC−5: what LothDesktop's Steam wrote its stamps in. */
const est = (stamp: string): string => `${new Date(`${stamp.replace(' ', 'T')}-05:00`).toISOString().slice(0, 19).replace('T', ' ')}Z`;

const KICK = [
  "[2026-11-16 20:46:20] CClientJobGetClientUpdateHosts: cached version not expired",
  "[2026-11-16 21:36:55] [Logged On, 4, 7] [U:1:1234567] RecvMsgClientLoggedOff('Logged In Elsewhere')",
  "[2026-11-16 21:36:55] [Logged On, 4, 7] [U:1:1234567] AsyncDisconnect( bDontWaitOnTCPShutdown: false )",
  "[2026-11-16 21:36:55] [Logged Off, 4, 0] [U:1:1234567] ConnectionDisconnected('Disconnected By Remote Host') : 'Logged In Elsewhere' (162.254.193.75:27018, WebSocket)",
  "[2026-11-16 21:36:55] [Logged Off, 4, 0] [U:1:1234567] ConnectionDisconnected() not auto reconnecting due to Logged In Elsewhere",
  "[2026-11-16 21:36:55] [Logged Off, 0, 0] [U:1:1234567] Sending SteamServersDisconnected_t because we were logged on",
  "[2026-11-16 21:36:56] [Connecting, 0, 11] [U:1:1234567] Connect() starting connection (eNetQOSLevelLow, cmp1-ord1.steamserver.net:443, WebSocket)",
  "[2026-11-16 21:36:56] [Connecting, 0, 11] [U:1:1234567] ConnectionCompleted() (162.254.193.103:443, WebSocket) local address (192.168.0.2:62428)",
  "[2026-11-16 21:37:57] [Connected, 0, 11] [U:1:1234567] RecvMsgClientLogOnResponse() : 'Try another CM' / 'Failure', ignored since we're not waiting for a logon response",
  "[2026-11-16 21:37:58] [Logged Off, 0, 0] [U:1:1234567] ConnectionDisconnected('Disconnected By Remote Host') : 'Failure' (162.254.193.103:443, WebSocket)",
  "[2026-11-16 21:37:58] [Logged Off, 0, 0] [U:1:1234567] StartAutoReconnect() will start in 11.0 seconds (attempt 1)",
  "[2026-11-16 21:37:58] [Logged Off, 0, 0] [U:1:1234567] Sending SteamServerConnectFailure_t No Connection Reconnect",
];

/** The tail the daemon read at 17:41 EST: the log-off had scrolled out of it, and it held only the latest attempts. */
const LATE_TAIL = [
  "[2026-11-17 17:13:06] [Connected, 0, 327] [U:1:1234567] RecvMsgClientLogOnResponse() : 'Try another CM' / 'Failure', ignored since we're not waiting for a logon response",
  "[2026-11-17 17:13:06] [Logged Off, 0, 0] [U:1:1234567] StartAutoReconnect() will start in 742.0 seconds (attempt 87)",
  "[2026-11-17 17:25:46] [Connected, 0, 331] [U:1:1234567] RecvMsgClientLogOnResponse() : 'Try another CM' / 'Failure', ignored since we're not waiting for a logon response",
  "[2026-11-17 17:25:46] [Logged Off, 0, 0] [U:1:1234567] ConnectionDisconnected('Disconnected By Remote Host') : 'Failure' (162.254.193.103:27018, WebSocket)",
  "[2026-11-17 17:25:46] [Logged Off, 0, 0] [U:1:1234567] StartAutoReconnect() will start in 871.0 seconds (attempt 88)",
  "[2026-11-17 17:25:46] [Logged Off, 0, 0] [U:1:1234567] Sending SteamServerConnectFailure_t No Connection Reconnect",
  "[2026-11-17 17:41:23] [Connected, 0, 34] [U:1:1234567] RecvMsgClientLogOnResponse() : 'Try another CM' / 'Failure', ignored since we're not waiting for a logon response",
  "[2026-11-17 17:41:23] [Logged Off, 0, 0] [U:1:1234567] ConnectionDisconnected('Disconnected By Remote Host') : 'Failure' (205.196.6.134:27017, UDP)",
  "[2026-11-17 17:41:23] [Logged Off, 0, 0] [U:1:1234567] StartAutoReconnect() will start in 751.0 seconds (attempt 89)",
];

const LOGIN_KICKED = [
  "[2026-11-14 20:46:19] [ WaitingForLibraryReady ] SetLoginState: Success - OK",
  "[2026-11-16 21:36:55] [ Success ] SetLoginState: WaitingForCredentials - Logged In Elsewhere",
  "[2026-11-16 21:36:56] [ WaitingForCredentials ] UI Request: connect",
  "[2026-11-16 21:37:58] [ WaitingForCredentials ] Received logon failure response",
  "[2026-11-17 17:41:23] [ WaitingForCredentials ] Received logon failure response",
];

/** How the earlier kicks ended (11-14): a fresh start that signed in. */
const LOGIN_BACK = [
  "[2026-11-14 14:08:50] [ Success ] SetLoginState: WaitingForCredentials - Logged In Elsewhere",
  "[2026-11-14 20:46:18] [ None ] SetLoginState: WaitingForNetwork - OK",
  "[2026-11-14 20:46:18] [ WaitingForNetwork ] SetLoginState: WaitingForServerResponse - OK",
  "[2026-11-14 20:46:19] [ WaitingForLibraryReady ] SetLoginState: Success - OK",
];

const SIGNED_IN = [
  "[2026-11-14 20:46:18] [Logging On, 4, 7] [U:1:1234567] RecvMsgClientLogOnResponse() : [U:1:1234567] 'OK'",
  "[2026-11-14 20:46:18] [Logged On, 4, 7] [U:1:1234567] RecvMsgClientLogOnResponse() : processing complete",
];

const KICKED = 'kicked by another sign-in at 2026-11-17 02:36:55Z; needs a person to reconnect';

test('w4638: a Steam log stamp in local time is reported in UTC', () => {
  assert.equal(est('2026-11-17 17:25:46'), '2026-11-17 22:25:46Z', 'the fixture zone itself: 17:25:46 EST is 22:25:46Z');
  // The real converter reads the process's own zone, which is Steam's on the computer that wrote the log.
  const local = new Date(2026, 10, 17, 17, 25, 46);
  assert.equal(steamStampUtc('2026-11-17 17:25:46'), `${local.toISOString().slice(0, 19).replace('T', ' ')}Z`);
  assert.equal(steamStampUtc('not a stamp'), 'not a stamp');
});

test("w4638: 'Logged In Elsewhere' says kicked by another sign-in and needs a person, not a count of 'Try another CM'", () => {
  assert.equal(steamConnection(KICK.join('\r\n'), { utc: est }), KICKED, 'from the connection log alone');
  assert.equal(steamConnection(LATE_TAIL.join('\r\n'), { utc: est, login: LOGIN_KICKED.join('\r\n') }), KICKED,
    'the log-off scrolled out of the tail: the login log still says it waits for a person');
  assert.equal(steamKickedAt(LOGIN_KICKED.join('\n')), '2026-11-16 21:36:55');
  assert.equal(steamKickedAt(LOGIN_BACK.join('\n')), undefined, 'signed in again since');
  assert.equal(steamConnection([...KICK, ...SIGNED_IN].join('\n'), { utc: est, login: LOGIN_BACK.join('\n') }), undefined, 'back on: connected');
});

test("w4638: without a kick, the failed sign-ins count Steam's own attempt number and say their times in UTC", () => {
  // 21 of 89 was the daemon's count from its 64 KB tail; Steam's (attempt N) holds the whole run.
  assert.equal(steamConnection(LATE_TAIL.join('\n'), { utc: est }), "89 sign-ins failed, the last at 2026-11-17 22:41:23Z ('Try another CM')");
});

test('w4638: readSteamClient reads steamui_login.txt beside the connection log', async () => {
  const files: Record<string, string> = {
    'c:/games/steam/steam.exe': '',
    'c:/games/steam/logs/connection_log.txt': LATE_TAIL.join('\r\n'),
    'c:/games/steam/logs/steamui_login.txt': LOGIN_KICKED.join('\r\n'),
  };
  const reg: Record<string, string> = { 'HKCU\\Software\\Valve\\Steam': 'SteamPath    REG_SZ    c:/games/steam', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess': 'ActiveUser    REG_DWORD    0x12d687' };
  const d: SteamClientDeps = {
    platform: 'win32',
    home: 'c:/users/x',
    now: () => new Date('2026-11-17T22:42:00Z'),
    exists: (f) => f.replace(/\\/g, '/') in files,
    read: (f) => files[f.replace(/\\/g, '/')],
    run: async (cmd, args) => cmd === 'reg' ? { code: 0, stdout: reg[args[1]] ?? '', stderr: '' } as never : { code: 0, stdout: '"steam.exe","9796","Console","1","120,000 K"\r\n', stderr: '' } as never,
  };
  const s = await readSteamClient(d);
  assert.match(s.notConnected ?? '', /^kicked by another sign-in at 2026-11-1[67] \d\d:36:55Z; needs a person to reconnect$/);
});
