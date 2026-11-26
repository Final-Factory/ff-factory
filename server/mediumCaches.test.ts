import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEDIUM_AGENT_VAR, fixUserPath, mediumCacheFor, planMediumCaches, planUserPath, psWritePath, workerWritable } from '../machine/mediumFolders.ts';
import { EXIT_MEDIUM_REFUSED, USAGE, ffuSlotMain, realFfuSlotDeps, type FfuSlotDeps } from '../machine/ffuSlots.ts';
import { sharedCacheDir, workerToolCacheEnv } from '../machine/sharedCaches.ts';
import { fencedRegisterEnv } from './agentTools.ts';
import { pluginEnv } from './pluginPaths.ts';
import { HOOKS } from './safeGit.ts';

// w5870 (w5862's follow-up): Medium agents also ran from folders workers write: the tool caches in <root>/cache (a .NET
// tool, a Playwright browser, an npm package), the user PATH entry .NET's first run adds there, the ffu slots, the old
// <root>/tools checkout as a plugin fallback, and the marketplace checkout the plugin refresh runs git in.

function install(t: { after: (f: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medium-caches-'));
  for (const c of ['tmp', 'cache', 'tools', 'sandboxes', 'cache-medium']) fs.mkdirSync(path.join(root, c), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('w5870: mediumCacheFor moves a path in <root>/cache to <root>/cache-medium and leaves any other alone', () => {
  const root = path.resolve('/w');
  assert.equal(mediumCacheFor(root, path.join(root, 'cache', 'dotnet')), path.join(root, 'cache-medium', 'dotnet'));
  assert.equal(mediumCacheFor(root, path.join(root, 'cache', 'nuget', 'packages')), path.join(root, 'cache-medium', 'nuget', 'packages'));
  assert.equal(mediumCacheFor(root, sharedCacheDir(root)), undefined);
  assert.equal(mediumCacheFor(root, path.join(root, 'tmp', 'x')), undefined);
});

test('w5870: warn-only by default: one WARNING naming every exposed cache, and Medium agents keep the workers\' caches', (t) => {
  const root = install(t);
  const made: string[] = [];
  const m = planMediumCaches({ root, fenced: true, platform: 'win32', mkdir: (d) => void made.push(d) });
  assert.deepEqual(m.env, {});
  assert.deepEqual(made, [], 'warn mode makes nothing');
  assert.equal(m.lines.length, 1);
  assert.match(m.lines[0], /^WARNING medium agent caches: /);
  for (const k of ['PIP_CACHE_DIR', 'npm_config_cache', 'DOTNET_CLI_HOME', 'PLAYWRIGHT_BROWSERS_PATH', 'NUGET_PACKAGES']) assert.ok(m.lines[0].includes(k), k);
  assert.ok(!m.lines[0].includes('GH_NO_UPDATE_NOTIFIER'), 'a flag is not a folder');
  assert.match(m.lines[0], /"mediumAgentCaches": "on"/);
  // No fence (or no root): nothing to say, as before.
  assert.deepEqual(planMediumCaches({ root, fenced: false, platform: 'win32' }), { env: {}, lines: [] });
  assert.deepEqual(planMediumCaches({ fenced: true, platform: 'win32' }), { env: {}, lines: [] });
});

test('w5870: with the switch on, every cache folder moves to cache-medium, outside what the fences let workers write', (t) => {
  const root = install(t);
  const m = planMediumCaches({ root, fenced: true, mode: 'on', platform: 'linux', extra: [path.join(root, 'tmp'), path.join(root, 'sandboxes')] });
  const workers = workerToolCacheEnv(root, 'linux');
  const folders = Object.keys(workers).filter((k) => path.isAbsolute(workers[k]));
  assert.deepEqual(Object.keys(m.env).sort(), folders.sort());
  for (const [k, v] of Object.entries(m.env)) {
    assert.equal(v, mediumCacheFor(root, workers[k]), k);
    assert.ok(fs.existsSync(v), `${v} is made`);
    assert.ok(!workerWritable(v, root, [path.join(root, 'tmp'), path.join(root, 'sandboxes')]), `${v} is not worker-writable`);
  }
  assert.ok(!m.lines.some((l) => l.startsWith('WARNING')), m.lines.join('\n'));
});

test('w5870: a cache-medium folder that cannot be made keeps the workers\' one, with a WARNING (the w5862 fallback)', (t) => {
  const root = install(t);
  const m = planMediumCaches({
    root,
    fenced: true,
    mode: 'on',
    platform: 'win32',
    mkdir: (d) => {
      if (d.includes('dotnet')) throw new Error('EPERM');
    },
  });
  assert.equal(m.env.DOTNET_CLI_HOME, undefined);
  assert.equal(m.env.PIP_CACHE_DIR, mediumCacheFor(root, workerToolCacheEnv(root, 'win32').PIP_CACHE_DIR));
  assert.ok(m.lines.some((l) => /^WARNING medium agent caches: .*DOTNET_CLI_HOME \(could not make .*EPERM/.test(l)), m.lines.join('\n'));
});

test("w5946 F3: a cache-medium folder or a PATH entry in a folder the fences open whole (workerIntegrityAllow, writeLockExtra, transcripts) counts as workers' too", (t) => {
  const root = install(t);
  const opened = [path.join(root, 'cache-medium', 'pip')];
  const m = planMediumCaches({ root, fenced: true, mode: 'on', platform: 'win32', mkdir: () => {}, opened });
  assert.equal(m.env.PIP_CACHE_DIR, undefined, "an opened cache-medium folder is no better than the workers' one");
  assert.ok(m.lines.some((l) => /^WARNING medium agent caches: .*PIP_CACHE_DIR \(.* is in a folder workers write\)/.test(l)), m.lines.join('\n'));
  const away = path.resolve('/elsewhere/bin');
  assert.deepEqual(planUserPath(`C:\\bin;${away}`, root, [], (s) => s, [path.resolve('/elsewhere')]).exposed, [away]);
  assert.deepEqual(planUserPath(`C:\\bin;${away}`, root, [], (s) => s).exposed, [], "not opened: not the workers'");
});

test('w5870: planUserPath takes off the entries in folders workers write, %VARS% expanded, and keeps the rest in order', () => {
  const root = path.resolve('/w');
  const tools = path.join(root, 'cache', 'dotnet', '.dotnet', 'tools');
  const value = ['%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps', `"${tools}"`, '%FFC%\\x', '', path.join(root, 'cache-medium', 'bin')].join(';');
  const expand = (s: string) => s.replace('%FFC%', path.join(root, 'cache')).replace('%USERPROFILE%', path.resolve('/u'));
  const p = planUserPath(value, root, [], expand);
  assert.deepEqual(p.exposed, [`"${tools}"`, '%FFC%\\x']);
  assert.equal(p.kept, ['%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps', '', path.join(root, 'cache-medium', 'bin')].join(';'));
});

test('w5870: the user PATH check warns by default, writes the PATH back with its kind when on, and never throws', async () => {
  const root = path.resolve('/w');
  const tools = path.join(root, 'cache', 'dotnet', '.dotnet', 'tools');
  const value = `C:\\Users\\Zoë\\bin;${tools}`; // w5946 F1: a non-ASCII entry survives the read and the write
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const unb64 = (script: string) => [...script.matchAll(/FromBase64String\('([^']*)'\)/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
  const calls: string[] = [];
  const read = (kind: string, wrote = 'ok') => async (s: string) => {
    calls.push(s);
    return s.includes('SetValue') ? { code: 0, stdout: `${wrote}\r\n`, stderr: '' } : { code: 0, stdout: `${kind}\r\n${b64(value)}\r\n`, stderr: '' };
  };
  const warn = await fixUserPath({ root, fenced: true, platform: 'win32', runPs: read('ExpandString') });
  assert.equal(warn.length, 1);
  assert.match(warn[0], /^WARNING medium agent caches: the user PATH holds .*tools/);
  assert.equal(calls.filter((c) => c.includes('SetValue')).length, 0, 'warn mode writes nothing');
  calls.length = 0;
  const on = await fixUserPath({ root, fenced: true, mode: 'on', platform: 'win32', runPs: read('ExpandString') });
  assert.match(on[0], /^medium agent caches: took .*tools off the user PATH/);
  assert.equal(calls.at(-1), psWritePath('C:\\Users\\Zoë\\bin', 'ExpandString', value), 'the kept PATH, as REG_EXPAND_SZ');
  assert.deepEqual(unb64(calls.at(-1)!), [value, 'C:\\Users\\Zoë\\bin'], 'the old value and the kept one, byte for byte');
  assert.match(calls.at(-1)!, /RegistryValueKind\]::ExpandString/);
  // w5946 F2: no quote of any kind reaches the script's strings (curly quotes end a PowerShell single-quoted string too).
  const q = psWritePath("a'b\u2019c\u2018d", 'String', 'x');
  assert.deepEqual(unb64(q), ['x', "a'b\u2019c\u2018d"]);
  assert.ok(!/[\u2018-\u201B]/.test(q) && !q.includes("a'b"), 'only base64 carries the value');
  // The write that read back wrong put the old PATH back; a PATH another writer changed since the read stays theirs.
  assert.match((await fixUserPath({ root, fenced: true, mode: 'on', platform: 'win32', runPs: read('String', 'restored') }))[0], /^WARNING .*could not take .*\(restored\); it stays as it is/);
  assert.match((await fixUserPath({ root, fenced: true, mode: 'on', platform: 'win32', runPs: read('String', 'changed') }))[0], /^WARNING .*could not take .*\(changed\)/);
  // A value that is not UTF-8 is left alone.
  calls.length = 0;
  const bad = await fixUserPath({ root, fenced: true, mode: 'on', platform: 'win32', runPs: async (s) => (calls.push(s), { code: 0, stdout: `String\r\n${Buffer.from([0xff, 0x3b]).toString('base64')}\r\n`, stderr: '' }) });
  assert.match(bad[0], /did not read back as UTF-8/);
  assert.equal(calls.length, 1, 'nothing written');
  // A PATH with nothing exposed, no PATH value, a failed read, a throw, and another OS.
  assert.deepEqual(await fixUserPath({ root, fenced: true, mode: 'on', platform: 'win32', runPs: async () => ({ code: 0, stdout: `String\r\n${b64('C:\\bin')}\r\n`, stderr: '' }) }), []);
  assert.deepEqual(await fixUserPath({ root, fenced: true, mode: 'on', platform: 'win32', runPs: async () => ({ code: 0, stdout: '', stderr: '' }) }), []);
  assert.match((await fixUserPath({ root, fenced: true, platform: 'win32', runPs: async () => ({ code: 1, stdout: '', stderr: 'denied' }) }))[0], /could not read the user PATH \(denied\)/);
  assert.match((await fixUserPath({ root, fenced: true, platform: 'win32', runPs: async () => { throw new Error('boom'); } }))[0], /check failed \(boom\)/);
  assert.deepEqual(await fixUserPath({ root, fenced: true, platform: 'darwin', runPs: read('String') }), []);
});

function slotDeps(root: string, medium?: string): FfuSlotDeps & { out: string[]; said: string[] } {
  const out: string[] = [];
  const said: string[] = [];
  const real = realFfuSlotDeps({ FF_WORKER_ROOT: root, FF_SESSION_ID: 'aaaa1111', ...(medium ? { [MEDIUM_AGENT_VAR]: medium } : {}) });
  return { ...real, write: (s) => void out.push(s), say: (s) => void said.push(s), out, said };
}

test('w5870: a Medium agent is refused an ffu slot with the switch on, and warned with it off; a sandbox agent is not asked', (t) => {
  const root = install(t);
  const on = slotDeps(root, 'on');
  assert.equal(on.medium, 'on', 'realFfuSlotDeps reads the variable');
  assert.equal(ffuSlotMain(['take'], on), EXIT_MEDIUM_REFUSED);
  assert.equal(EXIT_MEDIUM_REFUSED, 5, 'not 4, which is "no slot free" (w5946 F4)');
  assert.equal(on.out.join(''), '', 'nothing for eval to run');
  assert.match(on.said.join('\n'), /git clone https:\/\/github\.com\/Final-Factory\/ffu\.git "\$TMPDIR\/ffu"/);
  assert.equal(ffuSlotMain(['where'], slotDeps(root, 'on')), EXIT_MEDIUM_REFUSED);
  const warn = slotDeps(root, 'warn');
  ffuSlotMain(['where'], warn);
  assert.match(warn.said[0], /^ffu-slot: WARNING: you run outside the worker fences/);
  assert.doesNotMatch(warn.said[0], /git clone/, 'no own-clone advice while its temp folder may be the workers\' (w5946 F5)');
  assert.match(USAGE, /exit 5: refused to an agent outside the worker fences/);
  assert.equal(slotDeps(root).medium, undefined);
});

test('w5870: a Medium agent never gets the old <root>/tools checkout as its plugin fallback; a sandbox agent still may', () => {
  const home = path.resolve('/h');
  const root = path.resolve('/w');
  const onlyOld = (p: string) => p.startsWith(path.join(root, 'tools', 'final-factory-agents'));
  const old = path.join(root, 'tools', 'final-factory-agents', 'plugins', 'ff-agents');
  assert.deepEqual(pluginEnv({ env: {}, home, root, readFile: () => '{', exists: onlyOld }), { FF_AGENTS_PLUGIN: old, FF_SKILLS: path.join(old, 'skills') });
  assert.deepEqual(pluginEnv({ env: {}, home, root, medium: true, readFile: () => '{', exists: onlyOld }), {});
  const co = path.join(root, 'tools-medium', 'final-factory-agents', 'plugins', 'ff-agents');
  assert.deepEqual(pluginEnv({ env: {}, home, root, medium: true, readFile: () => '{', exists: () => true }), { FF_AGENTS_PLUGIN: co, FF_SKILLS: path.join(co, 'skills') });
});

test('w5870: the plugin refresh runs git fenced: fixed keys first, a planted program overridden and said, a URL rewrite removed', async (t) => {
  const root = install(t);
  const claudeDir = path.join(root, 'home', '.claude');
  const mp = path.join(claudeDir, 'plugins', 'marketplaces', 'final-factory-agents');
  const said: string[] = [];
  let scan = { code: 1, stdout: '', stderr: '' };
  const seen: string[][] = [];
  const d = { exec: async (_c: string, a: string[]) => (seen.push(a), scan), say: (l: string) => void said.push(l) };
  const cfg = (e: NodeJS.ProcessEnv) => Object.fromEntries(Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => [e[`GIT_CONFIG_KEY_${i}`], e[`GIT_CONFIG_VALUE_${i}`]]));
  // No marketplace yet: nothing to scan, the fixed fence still goes in, and the caller's own entries come after it.
  const none = (await fencedRegisterEnv(d, claudeDir, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' }))!;
  assert.equal(seen.length, 0);
  assert.equal(cfg(none)['core.hooksPath'], HOOKS);
  assert.equal(cfg(none)['core.fsmonitor'], 'false');
  assert.equal(none[`GIT_CONFIG_KEY_${Number(none.GIT_CONFIG_COUNT) - 1}`], 'user.name');
  fs.mkdirSync(mp, { recursive: true });
  // Clean: scanned, nothing said.
  await fencedRegisterEnv(d, claudeDir, {});
  assert.deepEqual(seen[0].slice(seen[0].indexOf('-C'), seen[0].indexOf('-C') + 3), ['-C', mp, 'config']);
  assert.deepEqual(said, []);
  // A filter planted in its local config: overridden to nothing, and a WARNING.
  scan = { code: 0, stdout: 'local\0filter.x.smudge\nevil.exe\0global\0credential.helper\nmanager\0', stderr: '' };
  const env = (await fencedRegisterEnv(d, claudeDir, {}, ' (Medium agents)'))!;
  assert.equal(cfg(env)['filter.x.smudge'], '');
  assert.match(said.at(-1)!, /^WARNING: the marketplace checkout .* \(Medium agents\) sets filter\.x\.smudge in its own config/);
  // A URL rewrite (w5946 F6): unset from that checkout's config, fenced, said, and the refresh goes on.
  scan = { code: 0, stdout: 'local\0url.https://evil/.insteadof\nhttps://github.com/\0', stderr: '' };
  seen.length = 0;
  assert.ok(await fencedRegisterEnv(d, claudeDir, {}));
  const unset = seen.find((a) => a.includes('--unset-all'))!;
  assert.deepEqual(unset.slice(unset.indexOf('-C')), ['-C', mp, 'config', '--local', '--unset-all', 'url.https://evil/.insteadof']);
  assert.ok(unset.includes(`core.hooksPath=${HOOKS}`), 'the unset is fenced too');
  assert.match(said.at(-1)!, /^WARNING: the marketplace checkout .* rewrote remote URLs \(url\.https:\/\/evil\/\.insteadof\).* removed/);
  // One that cannot be removed stops only this folder's refresh.
  const stuck = { exec: async (_c: string, a: string[]) => (a.includes('--unset-all') ? { code: 4, stdout: '', stderr: 'error: could not lock config file' } : scan), say: d.say };
  assert.equal(await fencedRegisterEnv(stuck, claudeDir, {}), undefined);
  assert.match(said.at(-1)!, /^FAILED: .* could not be removed \(error: could not lock config file\)/);
  // A scan that fails: the fixed fence only, said.
  scan = { code: 128, stdout: '', stderr: 'fatal: bad config' };
  assert.equal(cfg((await fencedRegisterEnv(d, claudeDir, {}))!)['core.hooksPath'], HOOKS);
  assert.match(said.at(-1)!, /^WARNING: could not read the marketplace checkout's git config \(fatal: bad config\)/);
});
