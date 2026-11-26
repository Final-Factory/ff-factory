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
import { HASH_CHECKPOINT_BYTES, feedHash } from './transcriptHash.ts';
import { ThreadGone, askThread, freeInThread, threadOff } from './transcriptThreadClient.ts';

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
export { HASH_CHECKPOINT_BYTES };

/**
 * A running sha256 of a transcript: in the transcript thread (w5888, server/transcriptThread.ts), or here on the event loop when
 * the thread is off or gone. Its state stays where it was made; `feed` reads the file there.
 */
export interface RunningHash {
  /** A copy that goes on apart from this one. */
  copy(): Promise<RunningHash>;
  /** Feeds bytes [from, to) of `file`; false when the file is shorter. With `marks`, a copy is pushed every `every` bytes past the last mark. */
  feed(file: string, from: number, to: number, marks?: HashCheckpoint[], every?: number): Promise<boolean>;
  /** The digest so far, in hex; the hash goes on. */
  hex(): Promise<string>;
}

/** The running hash as it was after the file's first `at` bytes (w5931). */
export interface HashCheckpoint {
  at: number;
  hash: RunningHash;
}

const nextMark = (marks: HashCheckpoint[] | undefined, every: number) => (marks ? (marks.at(-1)?.at ?? 0) + every : Infinity);

/** On the event loop, as before w5888. */
class LoopHash implements RunningHash {
  private readonly hash: crypto.Hash;
  constructor(hash: crypto.Hash = crypto.createHash('sha256')) {
    this.hash = hash;
  }
  async copy(): Promise<RunningHash> {
    return new LoopHash(this.hash.copy());
  }
  feed(file: string, from: number, to: number, marks?: HashCheckpoint[], every = HASH_CHECKPOINT_BYTES): Promise<boolean> {
    return feedHash(this.hash, file, from, to, nextMark(marks, every), every, marks ? (at, copy) => marks.push({ at, hash: new LoopHash(copy) }) : undefined);
  }
  async hex(): Promise<string> {
    return this.hash.copy().digest('hex');
  }
}

/** A hash the transcript thread holds; dropped there once nothing here refers to it. */
const unheld = new FinalizationRegistry<{ gen: number; ref: number }>(({ gen, ref }) => freeInThread(gen, [ref]));

class ThreadHash implements RunningHash {
  private readonly gen: number;
  private readonly ref: number;
  constructor(gen: number, ref: number) {
    this.gen = gen;
    this.ref = ref;
    unheld.register(this, { gen, ref });
  }
  static async make(): Promise<RunningHash> {
    const { gen, ok } = await askThread<{ ref: number }>({ op: 'new' });
    return new ThreadHash(gen, ok.ref);
  }
  async copy(): Promise<RunningHash> {
    const { ok } = await askThread<{ ref: number }>({ op: 'copy', ref: this.ref }, this.gen);
    return new ThreadHash(this.gen, ok.ref);
  }
  async feed(file: string, from: number, to: number, marks?: HashCheckpoint[], every = HASH_CHECKPOINT_BYTES): Promise<boolean> {
    const { ok } = await askThread<{ ok: boolean; marks: { at: number; ref: number }[] }>({ op: 'feed', ref: this.ref, file, from, to, next: nextMark(marks, every), every }, this.gen);
    if (marks) for (const m of ok.marks) marks.push({ at: m.at, hash: new ThreadHash(this.gen, m.ref) });
    else freeInThread(this.gen, ok.marks.map((m) => m.ref));
    return ok.ok;
  }
  async hex(): Promise<string> {
    return (await askThread<string>({ op: 'hex', ref: this.ref }, this.gen)).ok;
  }
}

/** A new running hash: in the thread when it runs, else on the event loop. */
async function newHash(): Promise<RunningHash> {
  if (!threadOff()) {
    try {
      return await ThreadHash.make();
    } catch (e) {
      if (!(e instanceof ThreadGone)) throw e;
    }
  }
  return new LoopHash();
}

/**
 * The running hash of one transcript, as its process appends to it. It hashes only bytes past those it has seen, so an edit
 * to the part already hashed changes nothing here and shows at the next resume. One read at a time. Its hash's thread gone
 * (w5888): it hashes the bytes it had seen again on the event loop and goes on there if they still give the digest it had
 * (`sha`); if they do not, or it has none, it is as the file shrinking: it seals nothing more.
 */
export class TranscriptHasher {
  private hash: RunningHash | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /** The file shrank under it: what it hashed is no longer the file's start, and it seals nothing more. */
  broken = false;
  readonly file: string;
  size: number;
  /** The digest of the file's first `size` bytes, when known: a hash lost with its thread is rebuilt against it (w5888). */
  private sha: string | undefined;
  constructor(file: string, size = 0, hash?: RunningHash, sha?: string) {
    this.file = file;
    this.size = size;
    this.hash = hash;
    this.sha = sha;
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
      try {
        return await this.sealTo(len, final, now);
      } catch (e) {
        if (!(e instanceof ThreadGone)) throw e;
        if (!(await this.rebuildOnLoop())) {
          this.broken = true;
          console.log(`transcript seal: ${this.file}: its running hash went with its thread and its first ${this.size} bytes no longer give the digest it had, so it seals nothing more (w5888)`);
          return undefined;
        }
        return await this.sealTo(len, final, now);
      }
    });
    this.chain = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  private async sealTo(len: number, final: boolean, now: () => Date): Promise<TranscriptSeal | undefined> {
    if (!this.hash && this.size > 0) throw new ThreadGone('no running hash for the bytes already seen');
    const next = await (this.hash ?? (await newHash())).copy();
    if (!(await next.feed(this.file, this.size, len))) {
      this.broken = true;
      return undefined;
    }
    const sha = await next.hex();
    this.hash = next;
    this.size = len;
    this.sha = sha;
    return { v: 1, size: len, sha256: sha, at: now().toISOString(), final };
  }

  /** w5888: its hash again on the event loop, from the file's start; false when those bytes changed or their digest is unknown. */
  private async rebuildOnLoop(): Promise<boolean> {
    const h = new LoopHash();
    if (this.size > 0 && (this.sha === undefined || !(await h.feed(this.file, 0, this.size)) || (await h.hex()) !== this.sha)) return false;
    this.hash = h;
    return true;
  }
}

export type SealCheck =
  | { ok: true; hasher: TranscriptHasher; sealed: boolean; tail: number; checkpoints: HashCheckpoint[] }
  | { ok: false; why: string };

/**
 * Whether `file` may be resumed under `seal`, hashed in the transcript thread (w5888; on the event loop, from the start, when the
 * thread is off or goes meanwhile). No seal (a conversation from before w5563, or one older than SEAL_DAYS): it may, unsealed,
 * and its whole file is what is hashed on. On a pass, `hasher` goes on from the end of the file as it is now; `tail` is what
 * was appended after a seal that was not final (its host ended before the process).
 */
export async function checkSeal(file: string, seal: TranscriptSeal | undefined, every = HASH_CHECKPOINT_BYTES): Promise<SealCheck> {
  if (!threadOff()) {
    try {
      return await checkSealWith(await ThreadHash.make(), file, seal, every);
    } catch (e) {
      if (!(e instanceof ThreadGone)) throw e;
    }
  }
  return checkSealWith(new LoopHash(), file, seal, every);
}

async function checkSealWith(hash: RunningHash, file: string, seal: TranscriptSeal | undefined, every: number): Promise<SealCheck> {
  let len: number;
  try {
    len = (await fs.promises.stat(file)).size;
  } catch {
    return seal ? { ok: false, why: 'its transcript is gone' } : { ok: true, hasher: new TranscriptHasher(file), sealed: false, tail: 0, checkpoints: [] };
  }
  const checkpoints: HashCheckpoint[] = [{ at: 0, hash: await hash.copy() }];
  if (!seal) {
    if (!(await hash.feed(file, 0, len, checkpoints, every))) return { ok: false, why: 'its transcript shrank while it was read' };
    return { ok: true, hasher: new TranscriptHasher(file, len, hash, await hash.hex()), sealed: false, tail: 0, checkpoints };
  }
  if (len < seal.size) return { ok: false, why: `its transcript is ${len} bytes, shorter than the ${seal.size} sealed at ${seal.at}` };
  if (!(await hash.feed(file, 0, seal.size, checkpoints, every)) || (await hash.hex()) !== seal.sha256) return { ok: false, why: `its first ${seal.size} bytes changed since they were sealed at ${seal.at}` };
  if (seal.final && len > seal.size) return { ok: false, why: `${len - seal.size} bytes were added to it after its process had ended (sealed at ${seal.at})` };
  if (!(await hash.feed(file, seal.size, len, checkpoints, every))) return { ok: false, why: 'its transcript shrank while it was read' };
  return { ok: true, hasher: new TranscriptHasher(file, len, hash, await hash.hex()), sealed: true, tail: len - seal.size, checkpoints };
}

/**
 * w5931: the running hash of `file` after our own rewrite of it from byte `from` on (the tool refresh's same-length edits, w2626),
 * hashed again only from the last checkpoint at or before `from` instead of from the file's start: on 2026-11-26 the dispatcher's
 * 1.48 GB transcript took about 31 s to check and the full second pass most of another 43 s, while a person's orchestrator
 * waited behind it to launch. Checkpoints taken past `from` hash bytes that changed, so they go. Undefined when the file
 * shrank meanwhile. Checkpoints whose thread is gone: hashed again on the event loop from the start (w5888).
 */
export async function rehashFrom(file: string, checkpoints: HashCheckpoint[], from: number): Promise<{ hasher: TranscriptHasher; hashedBytes: number } | undefined> {
  let cp: HashCheckpoint | undefined;
  for (const c of checkpoints) if (c.at <= from && (!cp || c.at >= cp.at)) cp = c;
  let len: number;
  try {
    len = (await fs.promises.stat(file)).size;
  } catch {
    return undefined;
  }
  try {
    const at = cp?.at ?? 0;
    const hash = cp ? await cp.hash.copy() : await newHash();
    if (!(await hash.feed(file, at, len))) return undefined;
    return { hasher: new TranscriptHasher(file, len, hash, await hash.hex()), hashedBytes: len - at };
  } catch (e) {
    if (!(e instanceof ThreadGone)) throw e;
    // w5888: the checkpoints went with their thread: hash it all again on the event loop
    const hash = new LoopHash();
    if (!(await hash.feed(file, 0, len))) return undefined;
    return { hasher: new TranscriptHasher(file, len, hash, await hash.hex()), hashedBytes: len };
  }
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
