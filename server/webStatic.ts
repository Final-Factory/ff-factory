// The built web UI (web/dist). The bundles under /assets/ carry a content hash in their names, so they are
// cached for good; index.html names them and must be fetched fresh, or a browser keeps an old UI after a
// deploy. A page also stays open for days, so the page learns the build it was served (a <meta> tag in
// index.html) and the build the server holds now (webBuild, in /api/health and the app state), and reloads
// when they differ (web/src/freshness.ts).
import type http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acceptsGzip, gzippedFile } from './compress.ts';
import { BUILD_META } from '../shared/freshness.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Kept, but asked about again before each use: an unchanged file costs a 304. */
export const REVALIDATE = 'no-cache';

const builds = new Map<string, { mtimeMs: number; size: number; html: string; build: string }>();

/** index.html as built, and its build id (a hash of it: it names every hashed bundle); re-read when the file changes. */
function readIndex(webDir: string): { html: string; build: string } | undefined {
  const file = path.join(webDir, 'index.html');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  const hit = builds.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const html = fs.readFileSync(file, 'utf8');
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, html, build: crypto.createHash('sha256').update(html).digest('hex').slice(0, 12) };
  builds.set(file, entry);
  return entry;
}

/** The web UI build in `webDir` now; undefined while it is not built. A rebuild shows without a restart. */
export function webBuild(webDir: string): string | undefined {
  return readIndex(webDir)?.build;
}

/** index.html with the build it is named in a <meta> tag, which the page reads at start. */
export function withBuildMeta(html: string, build: string): string {
  return html.replace(/<head>/i, (h) => `${h}\n    <meta name="${BUILD_META}" content="${build}" />`);
}

/**
 * The install's own name for the page and the PWA (w15): unset on Final Factory's install, which serves the build's
 * "FF Factory" as it is; on another install `title` ("Ryding Factory for Lens Scout") names the page and the installed
 * app, `short` (the project, "Lens Scout") its Home Screen label.
 */
export interface WebBrand {
  title: string;
  short: string;
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** index.html with this install's name in its <title> and Home Screen title (w15). */
export function withBrand(html: string, brand: WebBrand | undefined): string {
  if (!brand) return html;
  return html
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(brand.title)}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/i, (_m, a: string, b: string) => `${a}${escapeHtml(brand.short)}${b}`);
}

/** The PWA manifest with this install's name (w15). */
export function brandedManifest(json: string, brand: WebBrand): string {
  const m = JSON.parse(json) as Record<string, unknown>;
  m.name = brand.title;
  m.short_name = brand.short;
  if (typeof m.description === 'string') m.description = `The control room for ${brand.short}'s agents: sandboxes, machines and standing agents.`;
  return JSON.stringify(m, null, 2);
}

function etagMatches(header: string | undefined, etag: string): boolean {
  return !!header && header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

/** Serves a file of the built web UI; any other path is the app (index.html), except a missing bundle. */
export async function serveStatic(webDir: string, req: http.IncomingMessage, url: URL, res: http.ServerResponse, brand?: WebBrand) {
  let file: string;
  try {
    file = path.normalize(path.join(webDir, decodeURIComponent(url.pathname)));
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('bad request');
  }
  if (!file.startsWith(webDir)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'forbidden' }));
  }
  const missing = !fs.existsSync(file) || fs.statSync(file).isDirectory();
  // A page from an older build asking for one of its bundles that a rebuild removed: index.html in its place
  // would fail as a script with a MIME error, which the page cannot tell from a network error.
  if (missing && url.pathname.startsWith('/assets/')) {
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end('not found');
  }
  if (missing || file === path.join(webDir, 'index.html')) return serveIndex(webDir, req, res, brand);
  if (brand && path.extname(file) === '.webmanifest') {
    const body = Buffer.from(brandedManifest(fs.readFileSync(file, 'utf8'), brand));
    res.writeHead(200, { 'content-type': TYPES['.webmanifest'], 'cache-control': REVALIDATE, 'content-length': body.length });
    return res.end(body);
  }
  const headers = {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? IMMUTABLE : REVALIDATE,
  };
  // The bundle and styles gzipped (made once per build, server/compress.ts).
  const gz = acceptsGzip(req.headers['accept-encoding']) ? await gzippedFile(file, fs.statSync(file)) : undefined;
  if (gz) {
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'Accept-Encoding', 'content-length': gz.length });
    return res.end(gz);
  }
  res.writeHead(200, headers);
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

function serveIndex(webDir: string, req: http.IncomingMessage, res: http.ServerResponse, brand?: WebBrand) {
  const index = readIndex(webDir);
  if (!index) {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end('Web UI not built. Run: npm run build');
  }
  const etag = `"${index.build}"`;
  const headers = { 'content-type': TYPES['.html'], 'cache-control': REVALIDATE, etag };
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  const body = Buffer.from(withBrand(withBuildMeta(index.html, index.build), brand));
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(body);
}
