import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uvWarmRuns } from '../machine/unityMcp.ts';
import { fileUrlPath, warmUvCache } from '../machine/sharedCaches.ts';

const UVX = { command: 'C:/Users/u/.local/bin/uvx.exe', args: ['--offline', '--from', 'mcpforunityserver==10.0.0', 'mcp-for-unity'] };

test('an offline uvx server warms its own package; any other server is left alone', () => {
  assert.deepEqual(uvWarmRuns(UVX), {
    offline: ['--offline', '--from', 'mcpforunityserver==10.0.0', 'python', '-c', 'pass'],
    online: ['--from', 'mcpforunityserver==10.0.0', 'python', '-c', 'pass'],
  });
  assert.equal(uvWarmRuns({ ...UVX, args: ['--from', 'mcpforunityserver==10.0.0', 'mcp-for-unity'] }), undefined);
  assert.equal(uvWarmRuns({ command: 'node', args: ['--offline', '--from', 'x', 'y'] }), undefined);
  assert.equal(uvWarmRuns({ command: '/usr/local/bin/uvx', args: ['--offline', 'mcp-for-unity'] }), undefined);
});

test('the warm runs offline first, goes online only when the package is missing, in the given cache', async () => {
  const calls: { args: string[]; cache?: string }[] = [];
  const fake = (miss: boolean, onlineFails = false) => async (_bin: string, args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ args, cache: env.UV_CACHE_DIR });
    if (args[0] === '--offline') return miss ? { error: 'not found in the cache' } : {};
    return onlineFails ? { error: 'no network' } : {};
  };
  const runs = uvWarmRuns(UVX);
  assert.match(await warmUvCache(UVX.command, runs, 'V:/ffw/cache/uv', fake(false)) ?? '', /is in V:\/ffw\/cache\/uv/);
  assert.equal(calls.length, 1);
  calls.length = 0;
  assert.match(await warmUvCache(UVX.command, runs, 'V:/ffw/cache/uv', fake(true)) ?? '', /filled/);
  assert.deepEqual(calls.map((c) => [c.args[0], c.cache]), [['--offline', 'V:/ffw/cache/uv'], ['--from', 'V:/ffw/cache/uv']]);
  assert.match(await warmUvCache(UVX.command, runs, 'V:/ffw/cache/uv', fake(true, true)) ?? '', /no Unity MCP bridge: no network/);
  assert.equal(await warmUvCache('node', undefined, 'V:/ffw/cache/uv', fake(true)), undefined);
});

test('the warm for Low agents runs under its own APPDATA and LOCALAPPDATA and says so (BEAST, w5402)', async () => {
  const seen: NodeJS.ProcessEnv[] = [];
  const fake = async (_bin: string, args: string[], env: NodeJS.ProcessEnv) => {
    seen.push(env);
    return args[0] === '--offline' ? { error: 'not found in the cache' } : {};
  };
  const low = { APPDATA: 'F:/ffw/home/AppData/Roaming', LOCALAPPDATA: 'F:/ffw/home/AppData/Local' };
  assert.equal(await warmUvCache(UVX.command, uvWarmRuns(UVX), 'F:/ffw/cache/uv', fake, low, 'Low agents'), 'unity mcp: filled F:/ffw/cache/uv with its package for Low agents');
  assert.equal(seen.length, 2);
  for (const e of seen) assert.deepEqual([e.APPDATA, e.LOCALAPPDATA, e.UV_CACHE_DIR], [low.APPDATA, low.LOCALAPPDATA, 'F:/ffw/cache/uv']);
  const fail = async () => ({ error: 'no network' });
  assert.match(await warmUvCache(UVX.command, uvWarmRuns(UVX), 'F:/ffw/cache/uv', fail, low, 'Low agents') ?? '', /with its package for Low agents, so Low agents here get no Unity MCP bridge: no network/);
});

test('w5542: the daemon never warms a uvx or a package a worker planted in the root, and a Low run reads no uv config', async () => {
  const ran: { bin: string; env: NodeJS.ProcessEnv }[] = [];
  const fake = async (bin: string, _args: string[], env: NodeJS.ProcessEnv) => { ran.push({ bin, env }); return {}; };
  const trust = { root: 'V:/ffw', appDir: 'V:/ffw/daemon' };
  const planted = { command: 'V:/ffw/claude/uvx.exe', args: UVX.args };
  assert.match(await warmUvCache(planted.command, uvWarmRuns(planted), 'V:/ffw/cache/uv', fake, {}, 'agents', trust) ?? '', /V:\/ffw\/claude\/uvx.exe is in a folder workers can write/);
  const pkg = { command: UVX.command, args: ['--offline', '--from', 'file:///V:/ffw/sandboxes/slot1/evil', 'mcp-for-unity'] };
  assert.match(await warmUvCache(pkg.command, uvWarmRuns(pkg), 'V:/ffw/cache/uv', fake, {}, 'agents', trust) ?? '', /workers can write/);
  assert.equal(ran.length, 0);
  // The daemon's own folder and a uvx outside the root are fine; the Low run's APPDATA is in the root, so no uv.toml is read.
  await warmUvCache('V:/ffw/daemon/tools/uvx.exe', uvWarmRuns(UVX), 'V:/ffw/cache/uv', fake, {}, 'agents', trust);
  await warmUvCache(UVX.command, uvWarmRuns(UVX), 'V:/ffw/cache/uv', fake, { APPDATA: 'V:/ffw/low/AppData/Roaming' }, 'Low agents', trust);
  assert.deepEqual(ran.map((r) => [r.bin, r.env.UV_NO_CONFIG]), [['V:/ffw/daemon/tools/uvx.exe', undefined], [UVX.command, '1']]);
});

test('w5810: a file URL names its path with the drive first on Windows, so the root check sees it on every OS', () => {
  assert.equal(fileUrlPath('file:///V:/ffw/sandboxes/slot1/evil'), 'V:/ffw/sandboxes/slot1/evil');
  assert.equal(fileUrlPath('git+file:///C:/ffw/x'), 'C:/ffw/x');
  assert.equal(fileUrlPath('file:///home/u/ffw/evil'), '/home/u/ffw/evil');
  assert.equal(fileUrlPath('mcp-for-unity'), 'mcp-for-unity');
});
