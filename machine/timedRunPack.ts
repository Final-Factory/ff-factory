// timed_run on the worker's computer (w1946, shared/timedRun.ts): read the builds the worker made here, cut them into
// pieces named by their SHA-256, ask the portal which pieces it lacks, and send only those, over HTTP with this machine's
// token as attachments go (machine/attachments.ts). Nothing here starts anything: the timing machine's daemon runs the
// players (machine/timedRunner.ts).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { planPieces, skippedInBuild, MAX_VARIANTS, PIECE_MAX_BYTES, timedArgsProblem, variantNameProblem, type Piece, type TimedVariant } from '../shared/timedRun.ts';
import { sendChunks, type PublishOptions } from './review.ts';

/** A build folder holds a Windows player: finalfactory.exe beside finalfactory_Data. */
export const PLAYER_EXE = 'finalfactory.exe';
export const PLAYER_DATA = 'finalfactory_Data';
/** A folder past these is no player build (1.86 GB and 337 files were BEAST's, measured 2026-10-23). */
const MAX_BUILD_BYTES = 8 * 1024 ** 3;
const MAX_BUILD_FILES = 5000;

/** Whether `p` is inside one of `roots` (both resolved, links followed where they exist). */
export function insideRoots(p: string, roots: string[]): boolean {
  // A path that does not exist yet resolves through its deepest existing parent, so a Windows short
  // name (RUNNER~1) is expanded the same way on both sides (w2116: the Windows CI flake on 5a19097).
  const real = (x: string): string => {
    try {
      return fs.realpathSync.native(x);
    } catch {
      const abs = path.resolve(x);
      const parent = path.dirname(abs);
      return parent === abs ? abs : path.join(real(parent), path.basename(abs));
    }
  };
  const rp = real(p).toLowerCase();
  return roots.filter(Boolean).some((r) => {
    const rr = real(r).toLowerCase();
    return rp === rr || rp.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
  });
}

/** The files of a player build folder (forward-slash paths, sizes), its debug files left out; refused when it is no player. */
export function scanBuild(dir: string): { path: string; size: number }[] {
  const st = fs.statSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new Error(`${dir}: not a folder (give the build folder that holds ${PLAYER_EXE})`);
  if (!fs.existsSync(path.join(dir, PLAYER_EXE)) || !fs.statSync(path.join(dir, PLAYER_DATA), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${dir}: no Windows player here (${PLAYER_EXE} beside ${PLAYER_DATA}); a timed run takes a built Windows player folder`);
  }
  const out: { path: string; size: number }[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skippedInBuild(r)) continue;
      if (e.isSymbolicLink()) throw new Error(`${r}: a link in the build folder; a timed run takes plain files only`);
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const size = fs.statSync(path.join(dir, r)).size;
        out.push({ path: r, size });
        bytes += size;
        if (out.length > MAX_BUILD_FILES || bytes > MAX_BUILD_BYTES) throw new Error(`${dir}: more than ${MAX_BUILD_FILES} files or ${MAX_BUILD_BYTES / 1024 ** 3} GB; is this a player build?`);
      }
    }
  };
  walk('');
  return out;
}

/** Stream a piece's bytes from `dir` to `sink`, part after part. */
async function eachChunk(dir: string, piece: Omit<Piece, 'sha256'>, sink: (b: Buffer) => void | Promise<void>) {
  for (const p of piece.parts) {
    const fh = await fs.promises.open(path.join(dir, p.path), 'r');
    try {
      const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(1, p.length)));
      for (let done = 0; done < p.length; ) {
        const n = Math.min(buf.length, p.length - done);
        const { bytesRead } = await fh.read(buf, 0, n, p.offset + done);
        if (bytesRead !== n) throw new Error(`${p.path}: changed while it was read (the build is still being written?)`);
        await sink(buf.subarray(0, n));
        done += n;
      }
    } finally {
      await fh.close();
    }
  }
}

/** The variant's pieces with their SHA-256. */
export async function hashVariant(dir: string, files: { path: string; size: number }[]): Promise<Piece[]> {
  const out: Piece[] = [];
  for (const p of planPieces(files)) {
    const h = createHash('sha256');
    await eachChunk(dir, p, (b) => void h.update(b));
    out.push({ ...p, sha256: h.digest('hex') });
  }
  return out;
}

/** Write one piece into a file (to send it as one attachment upload). */
export async function writePiece(dir: string, piece: Piece, dest: string): Promise<void> {
  const out = await fs.promises.open(dest, 'w');
  try {
    await eachChunk(dir, piece, async (b) => void (await out.write(b)));
  } finally {
    await out.close();
  }
}

/** What the portal answers the plan: the run, where it goes, and an upload for each piece it lacks. */
export interface TimedPlanAnswer {
  runId: string;
  machine: string;
  uploads: { sha256: string; uploadId: string; chunkBytes?: number }[];
}

export interface TimedRunCall {
  portalUrl: string;
  token: string;
  /** The folders a build may be read from: the sandbox, the session's temp folder, the worker install. */
  roots: string[];
  /** The folders the save may be read from (default `roots`): the sandbox and the session's temp folder. */
  saveRoots?: string[];
  cwd: string;
  tempDir: string;
  args: Record<string, unknown>;
  rpc: (a: Record<string, unknown>) => Promise<string>;
  publish?: PublishOptions;
  log?: (line: string) => void;
}

const abs = (cwd: string, p: unknown) => path.resolve(cwd, String(p ?? '').trim());

/**
 * The worker's timed_run: check and hash the builds and the save, plan with the portal, send the pieces it lacks, then
 * hand the run over (`go`). Returns the portal's answer to the agent.
 */
export async function timedRunFromMachine(c: TimedRunCall): Promise<string> {
  const a = c.args;
  const builds = Array.isArray(a.builds) ? (a.builds as Record<string, unknown>[]) : [];
  if (builds.length < 1 || builds.length > MAX_VARIANTS) throw new Error(`builds: 1 to ${MAX_VARIANTS} entries of { name, path, args? }`);
  const names = new Set<string>();
  const variants: (TimedVariant & { dir: string })[] = [];
  for (const b of builds) {
    const nameProblem = variantNameProblem(b?.name);
    if (nameProblem) throw new Error(`builds: ${nameProblem}`);
    if (names.has(String(b.name))) throw new Error(`builds: the name ${String(b.name)} twice`);
    names.add(String(b.name));
    const argsProblem = timedArgsProblem(b.args);
    if (argsProblem) throw new Error(`builds ${String(b.name)}: ${argsProblem}`);
    const dir = abs(c.cwd, b.path);
    if (!insideRoots(dir, c.roots)) throw new Error(`builds ${String(b.name)}: ${dir} is outside your sandbox, your temp folder and this computer's worker install; build there (or copy the player folder into your temp folder)`);
    const files = scanBuild(dir);
    variants.push({ name: String(b.name), args: ((b.args as string[] | undefined) ?? []).map(String), files, pieces: [], dir });
  }
  const savePath = abs(c.cwd, a.save);
  if (!/\.zip$/i.test(savePath)) throw new Error('save: the path of a Final Factory save (.zip) in your working folder or temp folder');
  if (!insideRoots(savePath, c.saveRoots ?? c.roots) || !fs.statSync(savePath, { throwIfNoEntry: false })?.isFile()) throw new Error(`save: ${savePath} is not a file in your working folder or your temp folder (copy the save there first)`);
  // Each build is read once, whatever names share it (one build timed with and without a switch).
  const byDir = new Map<string, Piece[]>();
  for (const v of variants) {
    const key = path.resolve(v.dir).toLowerCase();
    if (!byDir.has(key)) {
      c.log?.(`timed_run: hashing ${v.dir} (${v.files.length} files)`);
      byDir.set(key, await hashVariant(v.dir, v.files));
    }
    v.pieces = byDir.get(key)!;
  }
  const saveSize = fs.statSync(savePath).size;
  if (!saveSize || saveSize > PIECE_MAX_BYTES) throw new Error('save: empty or larger than 64 MB; pick another save');
  const savePiece: Piece = { sha256: (await hashVariant(path.dirname(savePath), [{ path: path.basename(savePath), size: saveSize }]))[0].sha256, size: saveSize, parts: [{ path: path.basename(savePath), offset: 0, length: saveSize }] };
  const plan = JSON.parse(
    await c.rpc({
      phase: 'plan',
      ...(a.machine ? { machine: a.machine } : {}),
      ...(a.rounds !== undefined ? { rounds: a.rounds } : {}),
      ...(a.sample_s !== undefined ? { sample_s: a.sample_s } : {}),
      ...(a.settle_s !== undefined ? { settle_s: a.settle_s } : {}),
      ...(a.res !== undefined ? { res: a.res } : {}),
      variants: variants.map(({ dir: _dir, ...v }) => v),
      save: { name: path.basename(savePath), size: saveSize, sha256: savePiece.sha256 },
    }),
  ) as TimedPlanAnswer;
  // Each piece the portal lacks, by its hash, from the first build (or the save) that has it.
  const source = new Map<string, { dir: string; piece: Piece }>();
  for (const v of variants) for (const p of v.pieces) if (!source.has(p.sha256)) source.set(p.sha256, { dir: v.dir, piece: p });
  if (!source.has(savePiece.sha256)) source.set(savePiece.sha256, { dir: path.dirname(savePath), piece: savePiece });
  const uploaded: Record<string, string> = {};
  let bytes = 0;
  fs.mkdirSync(c.tempDir, { recursive: true });
  for (const u of plan.uploads) {
    const s = source.get(u.sha256);
    if (!s) throw new Error(`the portal asked for a piece no build here has (${u.sha256.slice(0, 12)}…)`);
    const tmp = path.join(c.tempDir, `timed-${plan.runId}-${u.sha256.slice(0, 16)}.piece`);
    await writePiece(s.dir, s.piece, tmp);
    try {
      const url = `${c.portalUrl.replace(/\/+$/, '')}/machine/attachments/uploads/${encodeURIComponent(u.uploadId)}`;
      const body = await sendChunks(url, c.token, tmp, s.piece.size, u.chunkBytes, c.publish ?? {}, (b) => !!b.attachment);
      const ref = body.attachment as { id: string; sha256: string };
      if (ref.sha256 !== u.sha256) throw new Error(`a piece arrived as other bytes (sha256 ${String(ref.sha256).slice(0, 12)}…); run timed_run again`);
      uploaded[u.sha256] = ref.id;
      bytes += s.piece.size;
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }
  c.log?.(`timed_run ${plan.runId}: sent ${plan.uploads.length} piece(s), ${(bytes / 1024 ** 2).toFixed(0)} MB, to the portal for ${plan.machine}`);
  return c.rpc({ phase: 'go', runId: plan.runId, uploaded, sentBytes: bytes });
}
