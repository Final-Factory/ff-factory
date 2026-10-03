// publish_review on a machine (docs/review.md): the daemon reads the agent's files here, asks the portal for a plan (the
// rpc checks names, types and caps), then sends each file over HTTP with the machine's own token, in chunks that resume
// after a dropped link. The portal checks size and SHA-256 and answers where each file went.
import fs from 'node:fs';
import path from 'node:path';
import { REVIEW_CHUNK, REVIEW_TYPES, publishedText, sha256Of } from '../server/review.ts';

export interface PublishOptions {
  /** Attempts per chunk, each after asking the portal where to resume. Default 4. */
  tries?: number;
  backoffMs?: number;
  fetch?: typeof fetch;
}

interface Plan {
  topic: string;
  host: string;
  uploads: { uploadId: string; name: string; size: number; chunkBytes?: number }[];
  /** Where the note went, when the call had one. */
  note?: string;
}

/**
 * Publish `files` (absolute, or relative to `cwd`) under `topic`. `plan` is the portal's publish_review rpc: it gets the
 * topic, the note and each file's name, size and SHA-256, and answers the uploads to send. Returns the tool's answer.
 */
export async function publishFromMachine(
  portalUrl: string,
  token: string,
  cwd: string,
  args: { topic?: unknown; files?: unknown; note?: unknown },
  plan: (a: Record<string, unknown>) => Promise<string>,
  o: PublishOptions = {},
): Promise<string> {
  const list = Array.isArray(args.files) ? args.files.map(String) : [];
  if (!list.length) throw new Error('files: give the paths of the files to publish');
  const local = await Promise.all(
    list.map(async (f) => {
      const p = path.resolve(cwd, f);
      const st = await fs.promises.stat(p).catch(() => undefined);
      if (!st?.isFile()) throw new Error(`${f}: no such file on this machine`);
      if (!REVIEW_TYPES.test(p)) throw new Error(`${f}: only images, video, .md/.txt/.json and .zip may be published`);
      return { path: p, name: path.basename(p), size: st.size, sha256: await sha256Of(p) };
    }),
  );
  const p = JSON.parse(await plan({ topic: args.topic, note: args.note, files: local.map(({ name, size, sha256 }) => ({ name, size, sha256 })) })) as Plan;
  if (p.uploads.length !== local.length) throw new Error('the portal answered a plan for other files');
  const done: { path: string; size: number; sha256: string }[] = [];
  for (const [i, u] of p.uploads.entries()) {
    const where = await sendFile(portalUrl, token, local[i].path, u, o);
    done.push({ path: where, size: u.size, sha256: local[i].sha256 });
  }
  return publishedText(p.host, done, p.note);
}

/** Send one file to PUT <portal>/machine/review/<uploadId>?offset=N; returns where the portal put it. */
async function sendFile(portalUrl: string, token: string, file: string, u: Plan['uploads'][number], o: PublishOptions): Promise<string> {
  const url = `${portalUrl.replace(/\/+$/, '')}/machine/review/${encodeURIComponent(u.uploadId)}`;
  const doFetch = o.fetch ?? fetch;
  const auth = { authorization: `Bearer ${token}` };
  const chunk = Math.min(u.chunkBytes ?? REVIEW_CHUNK, REVIEW_CHUNK);
  const fd = await fs.promises.open(file, 'r');
  try {
    let offset = 0;
    let failures = 0;
    for (;;) {
      const n = Math.min(chunk, u.size - offset);
      const buf = Buffer.alloc(n);
      await fd.read(buf, 0, n, offset);
      let body: { received?: number; path?: string; error?: string } = {};
      let status = 0;
      try {
        const res = await doFetch(`${url}?offset=${offset}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: buf });
        status = res.status;
        body = (await res.json().catch(() => ({}))) as typeof body;
      } catch (e) {
        body = { error: (e as Error).message };
      }
      if (status === 200) {
        if (body.path) return body.path;
        offset = body.received ?? offset + n;
        failures = 0;
        continue;
      }
      // 409: the portal stands elsewhere (a chunk that half arrived): go on from there. Anything else: a few more tries.
      if (status === 409 && typeof body.received === 'number') {
        offset = body.received;
        continue;
      }
      if ([400, 401, 404, 413, 415, 422].includes(status) || ++failures >= (o.tries ?? 4)) throw new Error(`${path.basename(file)}: ${body.error ?? `the portal answered HTTP ${status}`}`);
      await new Promise((r) => setTimeout(r, (o.backoffMs ?? 2000) * 2 ** (failures - 1)));
      const st = await doFetch(url, { headers: auth }).catch(() => undefined);
      const s = st?.ok ? ((await st.json().catch(() => ({}))) as { received?: number }) : {};
      if (typeof s.received === 'number') offset = s.received;
    }
  } finally {
    await fd.close();
  }
}
