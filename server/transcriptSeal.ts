// Claude Code's transcripts are sealed between processes (w5563, asked by lothsahn: "transcripts are read-only to workers").
// A conversation resumes from its transcript (`<CLAUDE_CONFIG_DIR>/projects/<slug>/<session id>.jsonl`, server/cliTranscript.ts),
// and a worker's fence lets it write the worker root, where its agents' Claude home is: a planted or edited transcript would
// steer the agent that resumes it. Claude Code only appends to its transcript, resume and /compact included (measured on m5,
// 2026-11-25, Claude Code 2.1.x: a 152,106-byte file kept its first 152,106 bytes, hash and all, through a resume and a
// /compact that took it to 304,320). So the host that runs the conversation hashes what the process appends, as it appends
// it, and records the length and that hash at each turn's end and when the process has exited (`final`), in a folder the
// fence keeps read-only to workers (<appDir>/transcript-seals on a machine, beside meters/; the portal's data folder for its
// own sessions). Before a process resumes the conversation, the file's first `size` bytes must hash to the seal, and a sealed
// final file must not have grown: otherwise the conversation is not resumed (AgentSession starts a fresh one and says so).
// docs/transcript-seal.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** How long a conversation's seal is kept after its last turn: a conversation resumed later than that resumes unsealed. */
export const SEAL_DAYS = 90;

export interface TranscriptSeal {
  v: 1;
  /** Bytes of the transcript the hash covers. */
  size: number;
  /** sha256 of its first `size` bytes, hex. */
  sha256: string;
  at: string;
  /** Taken after the process exited: nothing should append to it until the next process resumes it. */
  final: boolean;
}

export interface SealStore {
  load(conversation: string): TranscriptSeal | undefined;
  save(conversation: string, seal: TranscriptSeal): void;
}

/** A Claude Code session id is a uuid: anything else is no file name of ours. */
const SAFE = /^[A-Za-z0-9_-]{1,80}$/;

const isSeal = (s: unknown): s is TranscriptSeal => {
  const x = s as TranscriptSeal;
  return !!x && x.v === 1 && Number.isSafeInteger(x.size) && x.size >= 0 && typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256) && typeof x.final === 'boolean';
};

/** One small JSON file per conversation in `dir` (the pattern of server/meterStates.ts); files untouched for SEAL_DAYS go. */
export function sealStore(dir: string, now: () => number = Date.now): SealStore {
  let pruned = false;
  const file = (c: string) => path.join(dir, `${c}.json`);
  const prune = () => {
    pruned = true;
    const old = now() - SEAL_DAYS * 86_400_000;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.endsWith('.json') && !n.endsWith('.tmp')) continue;
      try {
        const p = path.join(dir, n);
        if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true });
      } catch {
        // another process removed or is writing it
      }
    }
  };
  return {
    load(c) {
      if (!SAFE.test(c)) return undefined;
      try {
        const s: unknown = JSON.parse(fs.readFileSync(file(c), 'utf8'));
        return isSeal(s) ? s : undefined;
      } catch {
        return undefined;
      }
    },
    save(c, seal) {
      if (!SAFE.test(c)) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        // written beside and renamed: a process that dies mid-write leaves the last whole one
        const tmp = `${file(c)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(seal));
        fs.renameSync(tmp, file(c));
      } catch {
        // an unsaved seal leaves the last one: the next resume finds the file longer than it, which a live process explains
      }
      if (!pruned) prune();
    },
  };
}

/** w5931: how far apart checkSeal keeps copies of its running hash, so a rewrite late in the file re-hashes only from there. */
export const HASH_CHECKPOINT_BYTES = 64 << 20;

/** The running hash as it was after the file's first `at` bytes (w5931). */
export interface HashCheckpoint {
  at: number;
  hash: crypto.Hash;
}

/**
 * Feeds `hash` bytes [from, to) of `file`; false when the file is shorter than `to`. With `marks`, a copy of the hash is kept
 * each time it passes another HASH_CHECKPOINT_BYTES (w5931).
 */
async function feed(hash: crypto.Hash, file: string, from: number, to: number, marks?: HashCheckpoint[], every = HASH_CHECKPOINT_BYTES): Promise<boolean> {
  if (to <= from) return true;
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(1 << 20, to - from, every));
    let next = marks ? (marks.at(-1)?.at ?? 0) + every : Infinity;
    for (let at = from; at < to; ) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, to - at), at);
      if (bytesRead === 0) return false;
      hash.update(buf.subarray(0, bytesRead));
      at += bytesRead;
      if (marks && at >= next) {
        marks.push({ at, hash: hash.copy() });
        next = at + every;
      }
    }
    return true;
  } finally {
    await fh.close();
  }
}

/**
 * The running hash of one transcript, as its process appends to it. It hashes only bytes past those it has seen, so an edit
 * to the part already hashed changes nothing here and shows at the next resume. One read at a time.
 */
export class TranscriptHasher {
  private hash = crypto.createHash('sha256');
  private chain: Promise<unknown> = Promise.resolve();
  /** The file shrank under it: what it hashed is no longer the file's start, and it seals nothing more. */
  broken = false;
  readonly file: string;
  size: number;
  constructor(file: string, size = 0, hash?: crypto.Hash) {
    this.file = file;
    this.size = size;
    if (hash) this.hash = hash;
  }

  /** Hashes what was appended since, then the seal; undefined when the file is missing or shrank (nothing is sealed then). */
  seal(final: boolean, now: () => Date = () => new Date()): Promise<TranscriptSeal | undefined> {
    const run = this.chain.then(async () => {
      if (this.broken) return undefined;
      let len: number;
      try {
        len = (await fs.promises.stat(this.file)).size;
      } catch {
        return undefined;
      }
      if (len < this.size) {
        this.broken = true;
        return undefined;
      }
      const next = this.hash.copy();
      if (!(await feed(next, this.file, this.size, len))) {
        this.broken = true;
        return undefined;
      }
      this.hash = next;
      this.size = len;
      return { v: 1 as const, size: len, sha256: next.copy().digest('hex'), at: now().toISOString(), final };
    });
    this.chain = run.catch(() => undefined);
    return run.catch(() => undefined);
  }
}

export type SealCheck =
  | { ok: true; hasher: TranscriptHasher; sealed: boolean; tail: number; checkpoints: HashCheckpoint[] }
  | { ok: false; why: string };

/**
 * Whether `file` may be resumed under `seal`, read through the thread pool. No seal (a conversation from before w5563, or one
 * older than SEAL_DAYS): it may, unsealed, and its whole file is what is hashed on. On a pass, `hasher` goes on from the end
 * of the file as it is now; `tail` is what was appended after a seal that was not final (its host ended before the process).
 */
export async function checkSeal(file: string, seal: TranscriptSeal | undefined, every = HASH_CHECKPOINT_BYTES): Promise<SealCheck> {
  let len: number;
  try {
    len = (await fs.promises.stat(file)).size;
  } catch {
    return seal ? { ok: false, why: 'its transcript is gone' } : { ok: true, hasher: new TranscriptHasher(file), sealed: false, tail: 0, checkpoints: [] };
  }
  const hash = crypto.createHash('sha256');
  const checkpoints: HashCheckpoint[] = [{ at: 0, hash: hash.copy() }];
  if (!seal) {
    if (!(await feed(hash, file, 0, len, checkpoints, every))) return { ok: false, why: 'its transcript shrank while it was read' };
    return { ok: true, hasher: new TranscriptHasher(file, len, hash), sealed: false, tail: 0, checkpoints };
  }
  if (len < seal.size) return { ok: false, why: `its transcript is ${len} bytes, shorter than the ${seal.size} sealed at ${seal.at}` };
  if (!(await feed(hash, file, 0, seal.size, checkpoints, every)) || hash.copy().digest('hex') !== seal.sha256) return { ok: false, why: `its first ${seal.size} bytes changed since they were sealed at ${seal.at}` };
  if (seal.final && len > seal.size) return { ok: false, why: `${len - seal.size} bytes were added to it after its process had ended (sealed at ${seal.at})` };
  if (!(await feed(hash, file, seal.size, len, checkpoints, every))) return { ok: false, why: 'its transcript shrank while it was read' };
  return { ok: true, hasher: new TranscriptHasher(file, len, hash), sealed: true, tail: len - seal.size, checkpoints };
}

/**
 * w5931: the running hash of `file` after our own rewrite of it from byte `from` on (the tool refresh's same-length edits, w2626),
 * hashed again only from the last checkpoint at or before `from` instead of from the file's start: on 2026-11-26 the dispatcher's
 * 1.48 GB transcript took about 31 s to check and the full second pass most of another 43 s, while a person's orchestrator
 * waited behind it to launch. Checkpoints taken past `from` hash bytes that changed, so they go. Undefined when the file
 * shrank meanwhile.
 */
export async function rehashFrom(file: string, checkpoints: HashCheckpoint[], from: number): Promise<{ hasher: TranscriptHasher; hashedBytes: number } | undefined> {
  let cp: HashCheckpoint = { at: 0, hash: crypto.createHash('sha256') };
  for (const c of checkpoints) if (c.at <= from && c.at >= cp.at) cp = c;
  let len: number;
  try {
    len = (await fs.promises.stat(file)).size;
  } catch {
    return undefined;
  }
  const hash = cp.hash.copy();
  if (!(await feed(hash, file, cp.at, len))) return undefined;
  return { hasher: new TranscriptHasher(file, len, hash), hashedBytes: len - cp.at };
}

/** Whether `pid` still runs (signal 0); a pid we may not signal runs. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Resolves once `pid` has exited (true) or `maxMs` passed (false), looking every `stepMs`. */
export async function pidGone(pid: number, maxMs = 30_000, stepMs = 200, alive: (pid: number) => boolean = pidAlive): Promise<boolean> {
  for (let waited = 0; ; waited += stepMs) {
    if (!alive(pid)) return true;
    if (waited >= maxMs) return false;
    await new Promise((r) => setTimeout(r, stepMs).unref?.());
  }
}
