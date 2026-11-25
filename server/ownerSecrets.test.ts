import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ghConfigFolder, hasOwnGithub, machineGhEnv, machineGhToken, ownerReadDenied, ownerReadWarn, ownerSecretPaths, ownerSecretPathsWarn, sayOwnerWarnStage, type TokenRun } from '../machine/ownerSecrets.ts';

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

test('ownerSecretPathsWarn (w5749): ~/.netrc, git credentials and the other gh folders, warn stage only', () => {
  const env = { GH_CONFIG_DIR: '/srv/gh', XDG_CONFIG_HOME: '/x/cfg' };
  const mac = ownerSecretPathsWarn({ platform: 'darwin', home: '/Users/p', env }).map((s) => s.path);
  for (const p of ['/Users/p/.netrc', '/Users/p/.git-credentials', '/x/cfg/git/credentials', '/Users/p/.config/git/credentials', '/x/cfg/gh', '/Users/p/.config/gh'])
    assert.ok(mac.includes(p), `${p} is in the warn stage`);
  // The gh folder in use is the enforced one, never listed twice.
  assert.ok(!mac.includes('/srv/gh'));
  // None of them is enforced yet: separate PRs for warn and enforce (lothsahn's lockout rule).
  const denied = ownerReadDenied({ platform: 'darwin', home: '/Users/p', env, hasToken: true });
  for (const p of mac) assert.ok(!denied.includes(p), `${p} is not enforced in the warn PR`);
  // With no GH_CONFIG_DIR or XDG_CONFIG_HOME, ~/.config/gh is the enforced folder, not a warn-stage one.
  assert.ok(!ownerSecretPathsWarn({ platform: 'darwin', home: '/Users/p', env: {} }).some((s) => s.path === '/Users/p/.config/gh'));
});

test('ownerSecretPathsWarn (w5749): Linux flatpak and snap browsers, and ~/.config browsers when XDG_CONFIG_HOME moved', () => {
  const lin = ownerSecretPathsWarn({ platform: 'linux', home: '/home/p', env: { XDG_CONFIG_HOME: '/home/p/cfg' } }).map((s) => s.path);
  for (const p of ['/home/p/.var/app/org.mozilla.firefox', '/home/p/.var/app/com.google.Chrome', '/home/p/.var/app/org.chromium.Chromium', '/home/p/snap/brave', '/home/p/.config/google-chrome', '/home/p/.config/gh'])
    assert.ok(lin.includes(p), p);
  const plain = ownerSecretPathsWarn({ platform: 'linux', home: '/home/p', env: {} }).map((s) => s.path);
  assert.ok(!plain.includes('/home/p/.config/google-chrome'), 'already enforced when XDG_CONFIG_HOME is unset');
  assert.ok(!plain.some((p) => p === '/home/p' || p.startsWith('/home/p/ffw')), 'never the worker root');
});

test('ownerSecretPathsWarn (w5749): Windows gets none (the system drive is never labelled without a person)', () => {
  assert.deepEqual(ownerSecretPathsWarn({ platform: 'win32', home: String.raw`C:\Users\p`, env: { APPDATA: String.raw`C:\Users\p\AppData\Roaming` } }), []);
  assert.equal(sayOwnerWarnStage({ platform: 'win32', home: String.raw`C:\Users\p`, env: {}, mode: 'warn', exists: () => true }), undefined);
});

test('owner secrets warn stage (w5749): on Windows it touches no file at all, not even to resolve a link', (t) => {
  const real = t.mock.method(fs, 'realpathSync', (p: string) => p);
  const ex = t.mock.method(fs, 'existsSync', () => true);
  const env = { APPDATA: String.raw`C:\Users\p\AppData\Roaming`, GH_CONFIG_DIR: String.raw`C:\Users\p\AppData\Roaming\GitHub CLI` };
  const home = String.raw`C:\Users\p`;
  assert.deepEqual(ownerReadWarn({ platform: 'win32', home, env, hasToken: true }), []);
  assert.equal(sayOwnerWarnStage({ platform: 'win32', home, env, mode: 'on' }), undefined);
  assert.equal(real.mock.callCount(), 0);
  assert.equal(ex.mock.callCount(), 0);
});

test('ownerSecretPathsWarn (w5749): XDG_CONFIG_HOME at ~/.config (with or without a slash) adds no ~/.config browsers', () => {
  for (const x of ['/home/p/.config', '/home/p/.config/']) {
    const l = ownerSecretPathsWarn({ platform: 'linux', home: '/home/p', env: { XDG_CONFIG_HOME: x } }).map((s) => s.path);
    assert.ok(!l.includes('/home/p/.config/google-chrome'), x);
  }
});

test('ownerReadWarn (w5749): the other gh folders stay open to a run with no GitHub token, as the gh folder does', () => {
  const env = { GH_CONFIG_DIR: '/srv/gh' };
  const withTok = ownerReadWarn({ platform: 'linux', home: '/home/p', env, hasToken: true });
  const noTok = ownerReadWarn({ platform: 'linux', home: '/home/p', env, hasToken: false });
  assert.ok(withTok.includes('/home/p/.config/gh'));
  assert.ok(!noTok.includes('/home/p/.config/gh'));
  assert.ok(noTok.includes('/home/p/.netrc'));
});

test('sayOwnerWarnStage (w5749): names only the paths that exist, and nothing when none does', () => {
  const line = sayOwnerWarnStage({ platform: 'darwin', home: '/Users/p', env: {}, mode: 'warn', exists: (p) => p === '/Users/p/.netrc' });
  assert.match(line ?? '', /\/Users\/p\/\.netrc exist here/);
  assert.doesNotMatch(line ?? '', /git-credentials/);
  assert.equal(sayOwnerWarnStage({ platform: 'darwin', home: '/Users/p', env: {}, mode: 'warn', exists: () => false }), undefined);
});
