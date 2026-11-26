// The event loop's side of the transcript thread (server/transcriptThread.ts, w5888). One thread per process, started on the
// first ask; it holds the process open only while an ask is pending. A thread that fails or exits fails what was pending with
// ThreadGone, and the hashes it held go with it: each reference carries the generation of the thread that made it, so one is
// never asked of a later thread. Callers then do the same work on the event loop as before w5888 (transcriptSeal.ts,
// keptTools.ts). FFF_TRANSCRIPT_THREAD=off keeps it all on the event loop; after MAX_FAILS failed threads the process stops
// starting new ones and says so once.
import { Worker } from 'node:worker_threads';
import type { TranscriptAsk } from './transcriptThread.ts';

/** The thread is gone (failed, exited, or never started): do the work on the event loop. */
export class ThreadGone extends Error {}

const MAX_FAILS = 3;

let worker: Worker | undefined;
let gen = 0;
let fails = 0;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Whether the work stays on the event loop: switched off, or too many threads failed. */
export function threadOff(): boolean {
  return process.env.FFF_TRANSCRIPT_THREAD === 'off' || fails >= MAX_FAILS;
}

function start(): Worker {
  const w = new Worker(new URL('./transcriptThread.ts', import.meta.url));
  const mine = ++gen;
  w.unref();
  w.on('message', (m: { id: number; ok?: unknown; error?: string }) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (!pending.size) w.unref();
    if (m.error !== undefined) p.reject(new Error(m.error));
    else p.resolve(m.ok);
  });
  let failed = false;
  const fail = (why: string) => {
    if (failed) return;
    failed = true;
    if (worker === w) worker = undefined;
    fails++;
    console.log(`transcript thread ${mine}: ${why}; what it held is gone and that work runs on the event loop${fails >= MAX_FAILS ? `; ${fails} threads failed, so no more start in this process` : ''} (w5888)`);
    for (const p of pending.values()) p.reject(new ThreadGone(why));
    pending.clear();
  };
  w.on('error', (e: Error) => fail(`failed: ${e?.message ?? e}`));
  w.on('exit', (code) => fail(`stopped (exit ${code})`));
  worker = w;
  return w;
}

/**
 * One ask of the thread, answered with the generation of the thread that answered. With `of`, only of that generation's thread:
 * a reference into a thread that is gone is ThreadGone at once.
 */
export function askThread<T>(req: TranscriptAsk, of?: number): Promise<{ gen: number; ok: T }> {
  if (threadOff()) return Promise.reject(new ThreadGone('the transcript thread is off'));
  if (of !== undefined && (of !== gen || !worker)) return Promise.reject(new ThreadGone(`transcript thread ${of} is gone`));
  let w: Worker;
  try {
    w = worker ?? start();
  } catch (e) {
    fails++;
    return Promise.reject(new ThreadGone(`could not start: ${(e as Error).message}`));
  }
  const id = nextId++;
  const mine = gen;
  return new Promise<{ gen: number; ok: T }>((resolve, reject) => {
    pending.set(id, { resolve: (ok) => resolve({ gen: mine, ok: ok as T }), reject });
    w.ref();
    w.postMessage({ ...req, id });
  });
}

/** Lets the thread drop hashes nobody refers to any more; nothing when their thread is gone. */
export function freeInThread(of: number, refs: number[]): void {
  if (of !== gen || !worker || refs.length === 0) return;
  worker.postMessage({ op: 'free', refs });
}

/** Tests: stop the thread as a crash would, and (with `reset`) forget past failures. */
export async function stopThreadForTests(reset = false): Promise<void> {
  const w = worker;
  if (w) await w.terminate();
  await new Promise((r) => setImmediate(r)); // its exit is counted before a reset, not after
  if (reset) fails = 0;
}

/** Tests: the generation of the thread that runs now, 0 before the first. */
export function threadGenForTests(): number {
  return worker ? gen : 0;
}
