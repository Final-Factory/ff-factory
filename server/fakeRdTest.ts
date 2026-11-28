/**
 * For tests (w6462): a fake `run` for server/proc.ts removeTree that answers `cmd /c rd /s /q <dir>` as rd does on Windows
 * (measured on LothDesktop, w6437): by a plain path it answers 0 and leaves every entry whose name ends in a dot or a space
 * or is a device name such as NUL (fsLink.ts isTrickName), with all that is in them, and the folders holding them; a plain
 * path whose own name ends in a dot or a space names the folder without it (`x.` is `x`). By its `\\?\` path it removes all.
 * A link it removes without its target. `rm -rf` (the other OSes) it answers as rm does. Each command is pushed to `calls`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isTrickName, removeLink } from './fsLink.ts';
import type { RunResult } from './proc.ts';

const PREFIX = '\\\\?\\';
/** The path as the test's own fs calls must give it: exact on Windows. */
export const exact = (p: string) => (process.platform === 'win32' && !p.startsWith('\\\\') ? `${PREFIX}${path.resolve(p)}` : p);
const ok: RunResult = { code: 0, stdout: '', stderr: '' };

function removeAll(p: string) {
  const st = fs.lstatSync(exact(p), { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) return void (st.isSymbolicLink() ? removeLink(exact(p)) : fs.rmSync(exact(p), { force: true }));
  for (const e of fs.readdirSync(exact(p))) removeAll(path.join(p, e));
  fs.rmdirSync(exact(p));
}

/** rd's walk by a plain path: what it leaves stays, and so does every folder above it. */
function removePlain(p: string) {
  const st = fs.lstatSync(exact(p));
  if (st.isSymbolicLink() || !st.isDirectory()) return removeAll(p);
  for (const e of fs.readdirSync(exact(p))) if (!isTrickName(e)) removePlain(path.join(p, e));
  if (fs.readdirSync(exact(p)).length === 0) fs.rmdirSync(exact(p));
}

/** `leaveExact`: rd by the \\?\ path leaves them too (a failure removeTree must report). */
export function fakeRd(calls: string[][], o: { leaveExact?: boolean; leaveRm?: boolean } = {}) {
  return async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    if (cmd === 'rm') {
      if (!o.leaveRm) fs.rmSync(args[1], { recursive: true, force: true });
      return ok;
    }
    const p = args[4];
    if (p.startsWith(PREFIX)) {
      const real = process.platform === 'win32' ? p : p.slice(PREFIX.length);
      if (o.leaveExact) removePlain(real);
      else removeAll(real);
      return ok;
    }
    const named = path.join(path.dirname(p), path.basename(p).replace(/[. ]+$/, ''));
    if (!fs.existsSync(exact(named))) return { code: 2, stdout: '', stderr: 'The system cannot find the file specified.' };
    removePlain(named);
    return ok;
  };
}
