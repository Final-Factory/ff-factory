import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ghConfigFolder, ghLoginStorage, machineGhStatusEnv, OWNER_LABEL_ON_SYSTEM_DRIVE, ownerLabelTargets, sayOwnerLabels, hasOwnGithub, holdKeychainLeg, judgeToolLeg, KEYCHAIN_MACH_SERVICES, keychainHeld, keychainHoldFile, machineGhEnv, machineGhToken, ownerReadDenied, ownerReadMore, ownerRunWiring, ownerSecretPaths, ownerSecretPathsMore, ownerToolLegs, sayOwnerRules, type TokenRun } from '../machine/ownerSecrets.ts';
import { NO_READ_UP } from '../machine/lowIntegrity.ts';

const kinds = (l: { kind: string }[]) => new Set(l.map((x) => x.kind));

test('ownerSecretPaths: macOS covers the gh login, ~/.ssh, every browser profile and the login keychain (w5548, w5553)', () => {
  const l = ownerSecretPaths({ platform: 'darwin', home: '/Users/p', env: {} });
  const paths = l.map((x) => x.path);
  for (const p of [
    '/Users/p/.config/gh',
    '/Users/p/.ssh',
    '/Users/p/Library/Application Support/Google',
    '/Users/p/Library/Application Support/Microsoft Edge',
    '/Users/p/Library/Application Support/Firefox',
    '/Users/p/Library/Safari',
    '/Users/p/Library/Containers/com.apple.Safari',
    '/Users/p/Library/Cookies',
    '/Users/p/Library/Keychains',
  ])
    assert.ok(paths.includes(p), `${p} is denied`);
  assert.deepEqual(kinds(l), new Set(['gh', 'ssh', 'browser', 'keychain']));
  // The worker root (~/ffw) is never in it: a deny there would take the workers' own folder.
  assert.ok(!paths.some((p) => p === '/Users/p' || p.startsWith('/Users/p/ffw')));
});

test('ownerSecretPaths: Linux and Windows cover gh, ssh and the browsers', () => {
  const lin = ownerSecretPaths({ platform: 'linux', home: '/home/p', env: {} }).map((x) => x.path);
  for (const p of ['/home/p/.config/gh', '/home/p/.ssh', '/home/p/.config/google-chrome', '/home/p/.mozilla', '/home/p/.local/share/keyrings']) assert.ok(lin.includes(p), p);
  const win = ownerSecretPaths({ platform: 'win32', home: 'C:\\Users\\p', env: { APPDATA: 'C:\\Users\\p\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' } }).map((x) => x.path);
  for (const p of ['C:\\Users\\p\\AppData\\Roaming\\GitHub CLI', 'C:\\Users\\p\\.ssh', 'C:\\Users\\p\\AppData\\Local\\Google\\Chrome\\User Data', 'C:\\Users\\p\\AppData\\Local\\Microsoft\\Edge\\User Data', 'C:\\Users\\p\\AppData\\Roaming\\Mozilla\\Firefox'])
    assert.ok(win.includes(p), p);
});

test("ghConfigFolder follows gh's own order", () => {
  assert.equal(ghConfigFolder({ GH_CONFIG_DIR: '/x' }, 'darwin', '/h'), '/x');
  assert.equal(ghConfigFolder({ XDG_CONFIG_HOME: '/c' }, 'linux', '/h'), '/c/gh');
  assert.equal(ghConfigFolder({ APPDATA: 'D:\\a' }, 'win32', 'C:\\h'), 'D:\\a\\GitHub CLI');
  assert.equal(ghConfigFolder({}, 'darwin', '/h'), '/h/.config/gh');
});

test('machineGhEnv: the machine login reaches only a run with no vault token of its own (w5548)', () => {
  assert.deepEqual(machineGhEnv({ GH_TOKEN: 'vault' }, 'machine'), {}, 'a vault token wins; the machine login is not given');
  assert.deepEqual(machineGhEnv({}, 'machine'), { GH_TOKEN: 'machine' });
  assert.deepEqual(machineGhEnv(undefined, undefined), {}, 'no machine token: nothing, the caller falls back');
  assert.equal(hasOwnGithub({ GH_TOKEN: '' }), false);
});

test('machineGhToken: runs gh auth token without any inherited token, and keeps only a token-shaped answer', () => {
  let seen: NodeJS.ProcessEnv | undefined;
  const ok: TokenRun = (_c, args, o) => {
    seen = o.env;
    assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']);
    return { status: 0, stdout: 'gho_abcdefghijklmnopqrstuvwxyz0123\n' };
  };
  process.env.GH_TOKEN = 'inherited';
  try {
    assert.equal(machineGhToken(ok), 'gho_abcdefghijklmnopqrstuvwxyz0123');
    assert.equal(seen?.GH_TOKEN, undefined, 'an inherited GH_TOKEN would answer itself, not the login');
  } finally {
    delete process.env.GH_TOKEN;
  }
  assert.equal(machineGhToken(() => ({ status: 1, stdout: '' })), undefined);
  assert.equal(machineGhToken(() => ({ status: 0, stdout: 'no oauth token found\n' })), undefined);
  assert.equal(machineGhToken(() => { throw new Error('ENOENT'); }), undefined);
});

test('ownerReadDenied: the gh folder is closed only to a run with a token; Windows gets none (w5553, w5548)', async () => {
  const { ownerReadDenied } = await import('../machine/ownerSecrets.ts');
  const home = '/Users/nobody-w5553';
  const withTok = ownerReadDenied({ platform: 'darwin', home, env: {}, hasToken: true });
  const noTok = ownerReadDenied({ platform: 'darwin', home, env: {}, hasToken: false });
  assert.ok(withTok.includes(`${home}/.config/gh`));
  assert.ok(!noTok.includes(`${home}/.config/gh`));
  for (const p of [`${home}/.ssh`, `${home}/Library/Keychains`, `${home}/Library/Safari`]) assert.ok(noTok.includes(p), p);
  assert.deepEqual(ownerReadDenied({ platform: 'win32', home: 'C:\\Users\\p', env: { APPDATA: 'C:\\Users\\p\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' }, hasToken: true }), []);
  assert.ok(ownerReadDenied({ platform: 'linux', home: '/home/nobody-w5553', env: {}, hasToken: true }).includes('/home/nobody-w5553/.ssh'));
});

test('KEYCHAIN_MACH_SERVICES: authd and SecurityServer together, as probe 4 measured (w5560)', async () => {
  const { KEYCHAIN_MACH_SERVICES } = await import('../machine/ownerSecrets.ts');
  assert.deepEqual([...KEYCHAIN_MACH_SERVICES].sort(), ['com.apple.SecurityServer', 'com.apple.authd']);
});

test('ownerSecretPathsMore (w5749): ~/.netrc, git credentials and the other gh folders, closed with the owner rules', () => {
  const env = { GH_CONFIG_DIR: '/srv/gh', XDG_CONFIG_HOME: '/x/cfg' };
  const mac = ownerSecretPathsMore({ platform: 'darwin', home: '/Users/p', env }).map((s) => s.path);
  for (const p of ['/Users/p/.netrc', '/Users/p/.git-credentials', '/x/cfg/git/credentials', '/Users/p/.config/git/credentials', '/x/cfg/gh', '/Users/p/.config/gh'])
    assert.ok(mac.includes(p), `${p} is listed`);
  // The gh folder in use is ownerSecretPaths' own, never listed twice.
  assert.ok(!mac.includes('/srv/gh'));
  // The enforce PR: every one is in ownerReadDenied now, once each.
  const denied = ownerReadDenied({ platform: 'darwin', home: '/Users/p', env, hasToken: true });
  for (const p of mac) assert.ok(denied.includes(p), `${p} is closed`);
  assert.equal(new Set(denied).size, denied.length, 'no path twice');
  assert.ok(denied.includes('/srv/gh') && denied.includes('/Users/p/.ssh'), 'the earlier rules stay');
  // With no GH_CONFIG_DIR or XDG_CONFIG_HOME, ~/.config/gh is ownerSecretPaths' gh folder, not one of these.
  assert.ok(!ownerSecretPathsMore({ platform: 'darwin', home: '/Users/p', env: {} }).some((s) => s.path === '/Users/p/.config/gh'));
});

test('ownerSecretPathsMore (w5749): Linux flatpak and snap browsers, and ~/.config browsers when XDG_CONFIG_HOME moved', () => {
  const lin = ownerSecretPathsMore({ platform: 'linux', home: '/home/p', env: { XDG_CONFIG_HOME: '/home/p/cfg' } }).map((s) => s.path);
  for (const p of ['/home/p/.var/app/org.mozilla.firefox', '/home/p/.var/app/com.google.Chrome', '/home/p/.var/app/org.chromium.Chromium', '/home/p/snap/brave', '/home/p/.config/google-chrome', '/home/p/.config/gh'])
    assert.ok(lin.includes(p), p);
  const denied = ownerReadDenied({ platform: 'linux', home: '/home/p', env: { XDG_CONFIG_HOME: '/home/p/cfg' }, hasToken: true });
  for (const p of lin) assert.ok(denied.includes(p), `${p} is closed`);
  const plain = ownerSecretPathsMore({ platform: 'linux', home: '/home/p', env: {} }).map((s) => s.path);
  assert.ok(!plain.includes('/home/p/.config/google-chrome'), 'already ownerSecretPaths\' when XDG_CONFIG_HOME is unset');
  assert.ok(!ownerReadDenied({ platform: 'linux', home: '/home/p', env: {}, hasToken: true }).some((p) => p === '/home/p' || p.startsWith('/home/p/ffw')), 'never the home or the worker root');
});

test('ownerSecretPathsMore (w5749): Windows gets none (the system drive is never labelled without a person)', () => {
  assert.deepEqual(ownerSecretPathsMore({ platform: 'win32', home: String.raw`C:\Users\p`, env: { APPDATA: String.raw`C:\Users\p\AppData\Roaming` } }), []);
});

test('owner secrets (w5749): on Windows ownerReadDenied and ownerReadMore touch no file at all, not even to resolve a link', (t) => {
  const real = t.mock.method(fs, 'realpathSync', (p: string) => p);
  const ex = t.mock.method(fs, 'existsSync', () => true);
  const env = { APPDATA: String.raw`C:\Users\p\AppData\Roaming`, GH_CONFIG_DIR: String.raw`C:\Users\p\AppData\Roaming\GitHub CLI` };
  const home = String.raw`C:\Users\p`;
  assert.deepEqual(ownerReadMore({ platform: 'win32', home, env, hasToken: true }), []);
  assert.deepEqual(ownerReadDenied({ platform: 'win32', home, env, hasToken: true }), []);
  assert.equal(real.mock.callCount(), 0);
  assert.equal(ex.mock.callCount(), 0);
});

test('ownerSecretPathsMore (w5749): XDG_CONFIG_HOME at ~/.config (with or without a slash) adds no ~/.config browsers', () => {
  for (const x of ['/home/p/.config', '/home/p/.config/']) {
    const l = ownerSecretPathsMore({ platform: 'linux', home: '/home/p', env: { XDG_CONFIG_HOME: x } }).map((s) => s.path);
    assert.ok(!l.includes('/home/p/.config/google-chrome'), x);
  }
});

test('ownerReadDenied (w5749): the other gh folders stay open to a run with no GitHub token, as the gh folder does; ~/.netrc never', () => {
  const env = { GH_CONFIG_DIR: '/srv/gh' };
  const withTok = ownerReadDenied({ platform: 'linux', home: '/home/p', env, hasToken: true });
  const noTok = ownerReadDenied({ platform: 'linux', home: '/home/p', env, hasToken: false });
  assert.ok(withTok.includes('/home/p/.config/gh'));
  assert.ok(!noTok.includes('/home/p/.config/gh') && !noTok.includes('/srv/gh'));
  assert.ok(noTok.includes('/home/p/.netrc') && noTok.includes('/home/p/.git-credentials'));
});

test('sayOwnerRules (w5749): warn lists the new paths among what on would close, before any machine closes them', () => {
  const owner = ownerReadDenied({ platform: 'darwin', home: '/Users/p', env: {}, hasToken: true });
  const line = sayOwnerRules('warn', 'darwin', owner);
  assert.match(line, /would close \(warn only/);
  assert.match(line, /\/Users\/p\/\.netrc/);
  assert.match(line, /\/Users\/p\/\.git-credentials/);
});

// w5747 (w5733's review of #1232): the daemon's per-run wiring (machine/daemon.ts launchSpecFor uses ownerRunWiring).
const wire = (o: { sandbox?: boolean; enforced: boolean; platform?: NodeJS.Platform; vault?: boolean; machineToken?: string }) => {
  let asked = 0;
  const w = ownerRunWiring({
    sandbox: o.sandbox ?? true,
    enforced: o.enforced,
    platform: o.platform ?? 'darwin',
    home: '/Users/p',
    env: {},
    specEnv: o.vault ? { GH_TOKEN: 'vault-token-value-xxxxxxxx' } : {},
    root: '/Users/p/ffw',
    machineGh: (): Record<string, string> => (asked++, o.machineToken ? { GH_TOKEN: o.machineToken } : {}),
    ghConfigDir: (root) => `${root}/gh-worker`,
  });
  return { ...w, asked };
};

test('ownerRunWiring: the owner read denies and the Keychain mach denies come only with the read fence enforced (w5747)', () => {
  for (const vault of [true, false]) {
    const off = wire({ enforced: false, vault, machineToken: 'machine-token-value-xxxxx' });
    assert.deepEqual(off.owner, [], 'warn or off: no owner path denied');
    assert.equal(off.ownerSecrets, undefined, 'warn or off: no mach or preference deny');
    const on = wire({ enforced: true, vault, machineToken: 'machine-token-value-xxxxx' });
    assert.ok(on.owner.includes('/Users/p/.ssh') && on.owner.includes('/Users/p/Library/Keychains') && on.owner.includes('/Users/p/.config/gh'));
    assert.deepEqual(on.ownerSecrets, { mach: KEYCHAIN_MACH_SERVICES });
  }
  // A run with no token at all keeps the login's folder readable, even enforced; the rest stays closed.
  const bare = wire({ enforced: true });
  assert.ok(!bare.owner.includes('/Users/p/.config/gh') && bare.owner.includes('/Users/p/.ssh'));
  // Not a fenced run, or Windows: nothing.
  assert.deepEqual(wire({ enforced: true, sandbox: false, machineToken: 'm'.repeat(30) }).owner, []);
  const win = wire({ enforced: true, platform: 'win32', machineToken: 'm'.repeat(30) });
  assert.deepEqual(win.owner, []);
  assert.equal(win.ownerSecrets, undefined);
});

test('ownerRunWiring: GH_CONFIG_DIR=<root>/gh-worker only for a fenced macOS or Linux run that holds a token (w5747)', () => {
  for (const enforced of [true, false]) {
    assert.deepEqual(wire({ enforced, vault: true }).ghOwn, { GH_CONFIG_DIR: '/Users/p/ffw/gh-worker' });
    assert.deepEqual(wire({ enforced, machineToken: 'machine-token-value-xxxxx' }).ghOwn, { GH_CONFIG_DIR: '/Users/p/ffw/gh-worker' });
    assert.deepEqual(wire({ enforced, platform: 'linux', vault: true }).ghOwn, { GH_CONFIG_DIR: '/Users/p/ffw/gh-worker' });
    assert.deepEqual(wire({ enforced }).ghOwn, {}, 'no token: gh keeps its own config');
    assert.deepEqual(wire({ enforced, platform: 'win32', vault: true }).ghOwn, {}, 'Windows: lowEnv moves APPDATA instead');
    assert.deepEqual(wire({ enforced, sandbox: false, vault: true }).ghOwn, {});
  }
});

test('ownerRunWiring: the machine GH_TOKEN only for a fenced run without a vault token; the login folder only with no token (w5747)', () => {
  const vault = wire({ enforced: false, vault: true, machineToken: 'machine-token-value-xxxxx' });
  assert.deepEqual(vault.ghMachine, {});
  assert.equal(vault.asked, 0, 'a run with a vault token never reads the machine login');
  assert.equal(vault.ghLoginFolder, false);
  const none = wire({ enforced: false, machineToken: 'machine-token-value-xxxxx' });
  assert.deepEqual(none.ghMachine, { GH_TOKEN: 'machine-token-value-xxxxx' });
  assert.equal(none.ghLoginFolder, false, 'given the token, not the folder');
  const unread = wire({ enforced: false });
  assert.deepEqual(unread.ghMachine, {});
  assert.equal(unread.ghLoginFolder, true, 'the daemon read no token: the old folder fallback');
  const unfenced = wire({ enforced: false, sandbox: false, machineToken: 'machine-token-value-xxxxx' });
  assert.deepEqual(unfenced.ghMachine, {});
  assert.equal(unfenced.asked, 0);
  assert.equal(unfenced.ghLoginFolder, false);
});

test('ownerToolLegs: gh and git ls-remote with the token and an empty gh folder; a Keychain write on a Mac (w5747)', () => {
  const mac = ownerToolLegs({ platform: 'darwin', gh: '/opt/gh', token: 'machine-token-value-xxxxx', ghConfigDir: '/r/gh-worker', credentialEnv: { GIT_CONFIG_COUNT: '2' } });
  assert.deepEqual(mac.legs.map((l) => [l.name, l.expect]), [['gh', 'ok'], ['git ls-remote', 'ok'], ['security', 'refused']]);
  assert.deepEqual(mac.skipped, []);
  for (const l of mac.legs.slice(0, 2)) assert.equal(l.env.GH_CONFIG_DIR, '/r/gh-worker');
  assert.equal(mac.legs[1].env.GIT_CONFIG_COUNT, '2', 'git goes through the credential helper');
  assert.ok(mac.legs.every((l) => !l.args.includes('machine-token-value-xxxxx')), 'the token is never on a command line');
  const linux = ownerToolLegs({ platform: 'linux', gh: 'gh', ghConfigDir: '/r/gh-worker', credentialEnv: {} });
  assert.deepEqual(linux.legs, []);
  assert.equal(linux.skipped.length, 1, 'no token: gh and git are not run, and say so');
});

test('judgeToolLeg: ok legs must exit 0; the Keychain write must fail, at once; no token-looking line is quoted (w5747)', () => {
  assert.deepEqual(judgeToolLeg({ name: 'gh', expect: 'ok' }, { code: 0 }), { name: 'gh', ok: true, said: 'ok' });
  const bad = judgeToolLeg({ name: 'gh', expect: 'ok' }, { code: 1, stderr: 'failed to load config: operation not permitted\nGH_TOKEN ghp_abc' });
  assert.equal(bad.ok, false);
  assert.equal(bad.said, 'exit 1: failed to load config: operation not permitted');
  assert.equal(judgeToolLeg({ name: 'gh', expect: 'ok' }, { code: -1, timedOut: true }).ok, false);
  assert.deepEqual(judgeToolLeg({ name: 'security', expect: 'refused' }, { code: 152 }), { name: 'security', ok: true, said: 'refused at once (exit 152)' });
  assert.equal(judgeToolLeg({ name: 'security', expect: 'refused' }, { code: 0 }).ok, false, 'the write got through');
  assert.equal(judgeToolLeg({ name: 'security', expect: 'refused' }, { code: -1, timedOut: true }).ok, false, 'hung on a dialog');
});

test('sayOwnerRules: warn names what on would close (w5747)', () => {
  const l = sayOwnerRules('warn', 'darwin', ['/Users/p/.ssh']);
  assert.match(l, /would close \(warn only/);
  assert.match(l, /\/Users\/p\/\.ssh/);
  assert.match(l, /com\.apple\.authd and com\.apple\.SecurityServer/);
  assert.match(l, /preference writes/);
  assert.match(sayOwnerRules('on', 'linux', ['/home/p/.ssh']), /owner-secret rules close: reads of \/home\/p\/\.ssh$/);
  assert.match(sayOwnerRules('warn', 'win32', []), /none on Windows/);
});

test('the Keychain write leg is held after it hung or got through, until the code version changes, and still blocks on (w5752)', () => {
  const files = new Map<string, string>();
  const write = (f: string, d: string) => void files.set(f, d);
  const read = (f: string) => {
    const d = files.get(f);
    if (d === undefined) throw new Error('ENOENT');
    return d;
  };
  const file = keychainHoldFile('/d');
  assert.equal(keychainHeld(file, 'v1', read), undefined, 'no hold: the leg runs');
  holdKeychainLeg(file, 'v1', 'hung, a dialog may have been on the screen', write);
  assert.equal(keychainHeld(file, 'v1', read), 'hung, a dialog may have been on the screen');
  assert.equal(keychainHeld(file, 'v2', read), undefined, 'new code: the leg runs again');
  files.set(file, '{not json');
  assert.equal(keychainHeld(file, 'v1', read), undefined, 'a broken hold file is no hold');

  const held = ownerToolLegs({ platform: 'darwin', gh: 'gh', token: 'machine-token-value-xxxxx', ghConfigDir: '/r/gh-worker', credentialEnv: {}, keychainHeld: 'let through' });
  assert.deepEqual(held.legs.map((l) => l.name), ['gh', 'git ls-remote'], 'the held leg does not run');
  assert.equal(held.skipped.length, 1, 'a skipped leg, which blocks on mode in probeOwnerTools');
  assert.match(held.skipped[0], /^security \(held: .*let through/);
  const linux = ownerToolLegs({ platform: 'linux', gh: 'gh', token: 'machine-token-value-xxxxx', ghConfigDir: '/r/gh-worker', credentialEnv: {}, keychainHeld: 'let through' });
  assert.deepEqual(linux.skipped, [], 'the hold means nothing off a Mac');
});

// w5749 (lothsahn, 2026-11-25: "Yes: label those folders on C: and move gh's login out of Credential Manager"; for LothDesktop).
const w = path.win32;
test('ownerLabelTargets (w5749): only LothDesktop labels, gh and ~/.ssh only; browsers left with their reason', () => {
  const home = w.join('C:', 'Users', 'L');
  const env = { APPDATA: w.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: w.join(home, 'AppData', 'Local') };
  const gh = w.join(env.APPDATA, 'GitHub CLI');
  const ssh = w.join(home, '.ssh');
  const chrome = w.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  const there = new Set([gh, ssh, chrome]);
  const plan = ownerLabelTargets({ platform: 'win32', home, env, machineId: 'LothDesktop', exists: (p) => there.has(p) });
  assert.deepEqual(plan.label, [
    { path: gh, sddl: NO_READ_UP.dir },
    { path: ssh, sddl: NO_READ_UP.dir },
  ]);
  assert.deepEqual(
    plan.left.map((l) => l.path),
    [chrome],
  );
  assert.match(plan.left[0].why, /AppContainer/);
});

test('ownerLabelTargets (w5749): every other machine and OS looks at nothing on its system drive', () => {
  let calls = 0;
  const exists = () => (calls++, true);
  for (const o of [
    { platform: 'win32' as const, machineId: 'beast' },
    { platform: 'win32' as const, machineId: undefined },
    { platform: 'darwin' as const, machineId: 'lothdesktop' },
    { platform: 'linux' as const, machineId: 'lothdesktop' },
  ])
    assert.deepEqual(ownerLabelTargets({ ...o, home: w.join('C:', 'Users', 'L'), env: {}, exists }), { label: [], left: [] });
  assert.equal(calls, 0);
  assert.ok(OWNER_LABEL_ON_SYSTEM_DRIVE.has('lothdesktop') && OWNER_LABEL_ON_SYSTEM_DRIVE.size === 1);
});

test('ghLoginStorage (w5749): keyring, file or none, from gh auth status', () => {
  assert.equal(ghLoginStorage(['github.com', '  ✓ Logged in to github.com account Lothsahn (keyring)', '  - Token: gho_***'].join('\n')), 'keyring');
  assert.equal(ghLoginStorage(['github.com', `  ✓ Logged in to github.com account Lothsahn (${w.join('C:', 'U', 'GitHub CLI', 'hosts.yml')})`].join('\n')), 'file');
  assert.equal(ghLoginStorage('You are not logged into any GitHub hosts.'), undefined);
  // A login gh could not check (w5849: an invalid token; a network outage likely the same) is still stored where it says.
  assert.equal(ghLoginStorage(['github.com', `  X Failed to log in to github.com account Lothsahn (${w.join('C:', 'U', 'GitHub CLI', 'hosts.yml')})`].join('\n')), 'file');
  assert.equal(ghLoginStorage('  X Failed to log in to github.com account Lothsahn (keyring)'), 'keyring');
});

test('machineGhStatusEnv (w5749): no token reaches the status check', () => {
  const e = machineGhStatusEnv({ GH_TOKEN: 'x', GITHUB_TOKEN: 'y', PATH: 'p' });
  assert.equal(e.GH_TOKEN, undefined);
  assert.equal(e.GITHUB_TOKEN, undefined);
  assert.equal(e.PATH, 'p');
  assert.equal(e.GH_PROMPT_DISABLED, '1');
});

test('sayOwnerLabels (w5749): warn says what on would label, the gh move, and what stays open', () => {
  const ssh = w.join('C:', 'U', '.ssh');
  const plan = { label: [{ path: ssh, sddl: NO_READ_UP.dir }], left: [{ path: 'Chrome', why: 'AppContainer' }] };
  const line = sayOwnerLabels('warn', plan, 'keyring');
  assert.ok(line.includes(`would label (warn only: no label set) No-Read-Up on ${ssh};`), line);
  assert.match(line, /Credential Manager \(keyring\).*on moves it/);
  assert.match(line, /left open: Chrome \(AppContainer\)$/);
  assert.match(sayOwnerLabels('on', plan, 'file'), /rules label No-Read-Up on .*hosts\.yml/);
  assert.match(sayOwnerLabels('warn', { label: [], left: [] }, undefined), /none on this Windows machine .*only on lothdesktop/);
});
