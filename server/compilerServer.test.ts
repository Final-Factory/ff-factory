import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beeAccessDenied, compilerServerAdvice, compilerServers, compilerServersAsync, logFileArg, logTail, parseCompilerServers } from '../machine/compilerServer.ts';

// w5347: the exact line slot1's player builds printed while a Low-integrity VBCSCompiler held the pipe (lothdesktop, 2026-11-23).
const SLOT1 =
  "Library\\Bee\\artifacts\\1900b0aEDbg.dag\\Unity.Entities.dll: error CS2012: Cannot open 'V:\\ffw\\sandboxes\\slot1\\Library\\Bee\\artifacts\\1900b0aEDbg.dag\\Unity.Entities.dll' for writing -- 'Access to the path 'V:\\ffw\\sandboxes\\slot1\\Library\\Bee\\artifacts\\1900b0aEDbg.dag\\Unity.Entities.dll' is denied.'";

test('beeAccessDenied finds CS2012 under Library/Bee and nothing else', () => {
  assert.equal(beeAccessDenied(`noise\n${SLOT1}\nmore`), 'V:\\ffw\\sandboxes\\slot1\\Library\\Bee\\artifacts\\1900b0aEDbg.dag\\Unity.Entities.dll');
  assert.equal(beeAccessDenied("error CS2012: Cannot open '/w/p/Library/Bee/artifacts/x.dll' for writing -- 'Access to the path '/w/p/x' is denied.'"), '/w/p/Library/Bee/artifacts/x.dll');
  // a CS2012 outside Bee, or another error, is not this cause
  assert.equal(beeAccessDenied("error CS2012: Cannot open 'V:\\out\\a.dll' for writing -- 'Access to the path is denied.'"), undefined);
  assert.equal(beeAccessDenied("Assets/A.cs(1,1): error CS0103: The name 'Foo' does not exist"), undefined);
});

test('logFileArg reads the value after -logFile', () => {
  assert.equal(logFileArg(['Unity.exe', '-batchmode', '-logFile', 'V:\\t\\b.log', '-quit']), 'V:\\t\\b.log');
  assert.equal(logFileArg(['Unity.exe', '-LOGFILE', '/t/b.log']), '/t/b.log');
  assert.equal(logFileArg(['Unity.exe', '-logFile', '-quit']), undefined);
  assert.equal(logFileArg(['python', 'build.py']), undefined);
});

test('parseCompilerServers takes one object, an array, or junk', () => {
  const one = '{"pid":46552,"rid":4096,"started":"2026-11-23T21:14:48Z","dll":"C:\\\\U\\\\VBCSCompiler.dll"}';
  assert.deepEqual(parseCompilerServers(one), [{ pid: 46552, rid: 4096, started: '2026-11-23T21:14:48Z', dll: 'C:\\U\\VBCSCompiler.dll' }]);
  assert.equal(parseCompilerServers(`[${one},{"pid":7,"rid":8192,"started":"x","dll":""}]`).length, 2);
  assert.deepEqual(parseCompilerServers(''), []);
  assert.deepEqual(parseCompilerServers('not json'), []);
  assert.deepEqual(parseCompilerServers('[{"rid":4096}]'), []);
});

test('compilerServerAdvice names a Low server, the log alone, or nothing', () => {
  const low = { pid: 46552, rid: 0x1000, started: '2026-11-23T21:14:48Z', dll: 'C:\\Unity\\VBCSCompiler.dll' };
  const medium = { pid: 46416, rid: 0x2000, started: 'x', dll: 'C:\\Unity\\VBCSCompiler.dll' };
  const a = compilerServerAdvice('V:\\p\\Library\\Bee\\a.dll', [medium, low]);
  assert.match(a!, /Low-integrity Roslyn compiler server/);
  assert.match(a!, /pid 46552/);
  assert.doesNotMatch(a!, /pid 46416/);
  assert.match(a!, /this run: V:\\p\\Library\\Bee\\a\.dll/);
  assert.match(a!, /do not kill it/);
  assert.match(compilerServerAdvice(undefined, [low])!, /pid 46552/);
  assert.match(compilerServerAdvice('V:\\p\\Library\\Bee\\a.dll', [medium])!, /none runs now/);
  assert.equal(compilerServerAdvice(undefined, [medium]), undefined);
  assert.equal(compilerServerAdvice(undefined, [{ ...low, rid: 0 }]), undefined);
});

test('logTail reads the end of a log and tolerates a missing one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffcs-'));
  const f = path.join(dir, 'u.log');
  fs.writeFileSync(f, 'a'.repeat(100) + SLOT1);
  assert.ok(beeAccessDenied(logTail(f, SLOT1.length + 10)));
  assert.equal(logTail(path.join(dir, 'none.log')), '');
  assert.equal(logTail(undefined), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compilerServers is empty off Windows', async () => {
  assert.deepEqual(compilerServers('linux'), []);
  assert.deepEqual(await compilerServersAsync('linux'), []);
});

test('w5938: the daemon looks for compiler servers off its event loop', () => {
  // beast, 2026-11-24..26: the 15 s look ran the sync compilerServers() on the daemon's main thread (PowerShell, Add-Type
  // and a CIM query: 2.2-5.7 s measured from a sandbox there), and its loop was blocked 90-230 times an hour, up to 72 s.
  const daemon = fs.readFileSync(path.join(import.meta.dirname, '..', 'machine', 'daemon.ts'), 'utf8');
  assert.doesNotMatch(daemon, /\bcompilerServers\(/, 'machine/daemon.ts calls the blocking compilerServers(): use compilerServersAsync()');
});
