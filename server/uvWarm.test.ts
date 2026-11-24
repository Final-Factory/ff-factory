import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uvWarmRuns } from '../machine/unityMcp.ts';
import { warmUvCache } from '../machine/sharedCaches.ts';

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
