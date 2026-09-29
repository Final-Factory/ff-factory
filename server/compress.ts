// Gzip for the page's big replies: /api/state lists every session a portal ever ran (megabytes of JSON at
// thousands of agents), transcripts carry long tool output, and the web bundle is half a megabyte. JSON
// compresses about eightfold, which matters on a phone or a remote link. Small replies go as they are.
import type http from 'node:http';
import fs from 'node:fs';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzip = promisify(zlib.gzip);

/** Below this a reply is sent as it is: compressing it saves little and costs a round of zlib. */
export const GZIP_MIN_BYTES = 16 * 1024;

/** Whether the request's Accept-Encoding allows gzip (and does not refuse it with q=0). */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const v = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const part of v.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

/** Ends `res` with this body: gzipped when it is big enough and the client takes gzip. */
export async function endMaybeGzip(req: http.IncomingMessage | undefined, res: http.ServerResponse, status: number, headers: Record<string, string | number>, body: string | Buffer) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  if (buf.length >= GZIP_MIN_BYTES && acceptsGzip(req?.headers['accept-encoding'])) {
    try {
      const z = await gzip(buf, { level: 6 });
      res.writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'Accept-Encoding', 'content-length': z.length });
      return res.end(z);
    } catch {
      // fall through: send it plain
    }
  }
  res.writeHead(status, { ...headers, ...(buf.length >= GZIP_MIN_BYTES ? { vary: 'Accept-Encoding' } : {}), 'content-length': buf.length });
  res.end(buf);
}

/** Kinds of static file worth compressing (text); images and fonts are compressed already. */
const TEXT = /\.(js|css|html|json|svg|webmanifest|txt|map)$/i;
const cache = new Map<string, { mtimeMs: number; size: number; gz: Buffer }>();

/** A static text file's gzipped bytes, made once per version of the file; undefined for other files. */
export async function gzippedFile(file: string, stat: fs.Stats): Promise<Buffer | undefined> {
  if (!TEXT.test(file) || stat.size < 1024) return undefined;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.gz;
  const gz = await gzip(await fs.promises.readFile(file), { level: 9 });
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, gz });
  return gz;
}
