import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghConfigFolder, hasOwnGithub, machineGhEnv, machineGhToken, ownerSecretPaths, type TokenRun } from '../machine/ownerSecrets.ts';

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
