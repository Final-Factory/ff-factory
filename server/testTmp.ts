// w6476: a test's own temp folder, removed when it is done. One full run of the suite on Windows left about 550 folders in
// the system temp folder (BEAST, 2026-11-27): factories that made a folder per test and never removed it, and removals that failed
// because the folder was still held (an open database, a live child process) or threw before the next hook ran.
// tmpDir(prefix, t) removes the folder after that test (t.after); tmpDir(prefix) removes it when the test file's process
// exits, for a helper that has no test context. Either way a folder that cannot be removed fails the file, naming it: a
// handle still open is a leak to fix, never a removal to skip.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const atExit = new Set<string>();
let hooked = false;

/** Remove a test's folder, retrying while Windows still holds a file in it (antivirus, a child that is ending). */
export function removeTmp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** A new folder in the system temp named `<prefix>XXXXXX`, removed after the test `t`, or when this process exits. */
export function tmpDir(prefix: string, t?: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => removeTmp(dir));
  else {
    atExit.add(dir);
    if (!hooked) {
      hooked = true;
      process.on('exit', removeAtExit);
    }
  }
  return dir;
}

function removeAtExit(): void {
  const left: string[] = [];
  for (const dir of atExit) {
    try {
      removeTmp(dir);
    } catch (e) {
      left.push(`${dir}: ${(e as Error).message}`);
    }
  }
  if (left.length) {
    process.stderr.write(`w6476: test temp folders could not be removed (something still holds them):\n${left.join('\n')}\n`);
    process.exitCode = 1;
  }
}
