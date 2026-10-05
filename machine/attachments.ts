// Attachments on a machine (docs/attachments.md): the daemon fetches each file a message brings from the portal, over
// HTTP with its own machine token, into the agent's Inbox, and checks its SHA-256 before the message goes on. And the
// other way (publish_attachment): an agent's file goes up to the portal's store the same way, and comes back as an id.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { prepareInbox, publishableFile, sha256File } from '../server/attachments.ts';
import { publishedAttachmentText } from '../shared/attachments.ts';
import type { AttachmentRef, DeliveredAttachment } from '../shared/types.ts';
import { sendChunks, type PublishOptions } from './review.ts';

export interface FetchOptions {
  /** Attempts in all, each resuming where the last stopped (a dropped link over Tailscale). Default 4. */
  tries?: number;
  /** No byte for this long ends an attempt. Default 60 s. */
  idleMs?: number;
  /** The pause before another attempt, doubled each time. Default 2 s. */
  backoffMs?: number;
  fetch?: typeof fetch;
}

/**
 * Fetch one attachment from `<portalUrl>/machine/attachments/<id>` into `dest`, resuming a `.part` left from before
 * (HTTP Range), and keep it only when its size and SHA-256 match. A copy already there with the right hash is kept.
 */
export async function fetchAttachment(portalUrl: string, token: string, ref: AttachmentRef, dest: string, o: FetchOptions = {}): Promise<void> {
  if ((await fs.promises.stat(dest).catch(() => undefined))?.size === ref.size && (await sha256File(dest)) === ref.sha256) return;
  const part = `${dest}.part`;
  const url = `${portalUrl.replace(/\/+$/, '')}/machine/attachments/${encodeURIComponent(ref.id)}`;
  const doFetch = o.fetch ?? fetch;
  const tries = o.tries ?? 4;
  let last: Error | undefined;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, (o.backoffMs ?? 2000) * 2 ** (attempt - 1)));
    let have = (await fs.promises.stat(part).catch(() => undefined))?.size ?? 0;
    if (have > ref.size) {
      await fs.promises.rm(part, { force: true });
      have = 0;
    }
    if (have < ref.size) {
      const ctl = new AbortController();
      let idle: NodeJS.Timeout | undefined;
      const poke = () => {
        clearTimeout(idle);
        idle = setTimeout(() => ctl.abort(new Error(`no data for ${Math.round((o.idleMs ?? 60_000) / 1000)} s`)), o.idleMs ?? 60_000);
      };
      try {
        poke();
        const res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, ...(have ? { range: `bytes=${have}-` } : {}) }, signal: ctl.signal });
        if (res.status === 401 || res.status === 404) {
          // Not this machine's to fetch, or gone: trying again changes nothing.
          await res.body?.cancel();
          throw Object.assign(new Error(res.status === 401 ? 'the portal refused this machine\'s token' : 'the portal has no such attachment for this machine (expired, or not handed to it)'), { final: true });
        }
        if (res.status !== 200 && res.status !== 206) {
          await res.body?.cancel();
          throw new Error(`the portal answered HTTP ${res.status}`);
        }
        if (!res.body) throw new Error('the portal sent no body');
        // 200: the whole file again (the portal ignored the range), so start over.
        const append = res.status === 206 && have > 0;
        const counted = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
        counted.on('data', poke);
        await pipeline(counted, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
      } catch (e) {
        last = e as Error;
        if ((e as { final?: boolean }).final) throw last;
        continue;
      } finally {
        clearTimeout(idle);
      }
    }
    const size = (await fs.promises.stat(part).catch(() => undefined))?.size ?? 0;
    if (size < ref.size) {
      last = new Error(`only ${size} of ${ref.size} bytes arrived`);
      continue;
    }
    const sha = await sha256File(part);
    if (size !== ref.size || sha !== ref.sha256) {
      await fs.promises.rm(part, { force: true });
      last = new Error(`the file arrived damaged (sha256 ${sha.slice(0, 12)}…, expected ${ref.sha256.slice(0, 12)}…)`);
      continue;
    }
    await fs.promises.rename(part, dest);
    return;
  }
  throw last ?? new Error('could not fetch it');
}

/**
 * Fetch a message's attachments into `<folder>/Inbox/` one after another: each comes back with where it is, or why it
 * is not there (the message still goes on, and says so).
 */
export async function fetchAttachments(portalUrl: string, token: string, folder: string, list: AttachmentRef[], o: FetchOptions = {}): Promise<DeliveredAttachment[]> {
  const out: DeliveredAttachment[] = [];
  for (const a of list) {
    try {
      const dest = await prepareInbox(folder, a);
      await fetchAttachment(portalUrl, token, a, dest, o);
      out.push({ ...a, path: dest });
    } catch (e) {
      out.push({ ...a, error: `the machine could not fetch it from the portal: ${(e as Error).message}` });
    }
  }
  return out;
}

/**
 * publish_attachment on a machine (docs/attachments.md, "Agents' files"): read the agent's file here (it must be in
 * `roots`: its working folder or its own temp folder), ask the portal for an upload (`plan`, the rpc: it checks the size
 * cap and records who sends it), then send the bytes over HTTP with this machine's token, in chunks that resume after a
 * dropped link. The portal checks the SHA-256 and answers the new attachment. Returns the tool's answer.
 */
export async function publishAttachmentFromMachine(
  portalUrl: string,
  token: string,
  cwd: string,
  roots: string[],
  args: { file?: unknown },
  plan: (a: Record<string, unknown>) => Promise<string>,
  o: PublishOptions = {},
): Promise<string> {
  const f = await publishableFile(cwd, args.file, roots);
  const sha256 = await sha256File(f.path);
  const u = JSON.parse(await plan({ name: path.basename(f.path), size: f.size, sha256 })) as { uploadId: string; size: number; chunkBytes?: number };
  if (u.size !== f.size) throw new Error('the portal answered an upload of another size');
  const url = `${portalUrl.replace(/\/+$/, '')}/machine/attachments/uploads/${encodeURIComponent(u.uploadId)}`;
  const body = await sendChunks(url, token, f.path, f.size, u.chunkBytes, o, (b) => !!b.attachment);
  const ref = body.attachment as AttachmentRef;
  if (ref.sha256 !== sha256) throw new Error(`${path.basename(f.path)}: the portal stored other bytes (sha256 ${String(ref.sha256).slice(0, 12)}…); publish it again`);
  return publishedAttachmentText(ref, 'worker');
}
