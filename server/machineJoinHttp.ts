import type http from 'node:http';
import { defaultLimits, joinRefusal, parseFacts, WORKER_TAG, type JoinCodes, type JoinLimits, type JoinRecords, type TailnetDevice } from './machineJoin.ts';
import { clientAddress, tailnetOnly } from './remoteChat.ts';
import type { MachinePlatform } from '../shared/types.ts';

/** The bootstrap's `os` fact as the record's platform (w1603: the record says what the PC is from its redeem on). */
const PLATFORM_OF_OS: Record<string, MachinePlatform> = { windows: 'win32', macos: 'darwin', linux: 'linux' };

/**
 * The join bootstrap's two routes (w1592, server/machineJoin.ts), both tailnet-only (a Funnel request is refused):
 *
 * - GET /join/windows.ps1, GET /join/unix.sh: the bootstrap itself (scripts/worker/join.ps1, join.sh) with this portal's
 *   tailnet URL written in, so `irm https://<portal>/join/windows.ps1 | iex` is the whole command at the PC.
 * - GET /join/windows.cmd: the Windows installer to download and double-click (scripts/worker/join.cmd): it runs that
 *   bootstrap, which asks for the code. The dashboard's Add a machine hands out the same file with the code written in
 *   (windowsInstaller), so nothing is typed at the PC.
 * - GET /join: a page for the new PC's browser with that download and the commands.
 * - POST /machine/join {code, facts, check}: the PC proves it may join. The code must be live, and the request must come
 *   from the tailnet device the code was made for (`tailscale whois` of its address). With check, nothing changes: the
 *   answer says which machine and limits the code gives and whether the device carries the worker tag. Without it the
 *   code is used up, the machine's record made (or the waiting one updated) and its credential answered, once.
 */
export interface MachineJoinDeps {
  codes: JoinCodes;
  records: JoinRecords;
  /** `tailscale whois` of a tailnet address, or undefined when the portal cannot tell (no tailscale, a timeout). */
  whois(addr: string): Promise<TailnetDevice | undefined>;
  /** Make the machine's worker_install record (or update the waiting one) and issue its credential, returned once. */
  enrol(o: { machineId: string; tailnetName: string; limits: Required<JoinLimits>; portalUrl: string; by: string; platform?: MachinePlatform }): string;
  /** The URL the PC reached this portal at (originOf), for the record and the bootstrap. */
  portalUrl(req: http.IncomingMessage): string;
  /** A bootstrap's text (join.ps1, join.sh, join.cmd), or undefined when this portal's checkout lacks it. */
  script(kind: JoinScript): string | undefined;
  /** Why it acts on nothing (a dry-run portal), or undefined. */
  refused?(): string | undefined;
  /** A line for the owners' [machines] report. */
  report?(text: string): void;
  now?(): number;
}

const MAX_BODY = 16 * 1024;
/** Wrong codes allowed per address in FAIL_WINDOW_MS before it is refused (a code has 100 bits; this only keeps logs quiet). */
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
/** The placeholder a bootstrap carries for this portal's URL. */
export const PORTAL_URL_MARK = '__FF_PORTAL_URL__';
/** The placeholder join.cmd carries for the join code ('' in the download any PC may take: the bootstrap asks). */
export const JOIN_CODE_MARK = '__FF_JOIN_CODE__';
export type JoinScript = 'windows' | 'unix' | 'cmd';
/** The download's file name. */
export const WINDOWS_INSTALLER_NAME = 'ff-factory-join.cmd';

const SCRIPTS: Record<string, JoinScript> = { '/join/windows.ps1': 'windows', '/join/unix.sh': 'unix', '/join/windows.cmd': 'cmd' };
/** The paths this handler answers (index.ts routes them here). */
export const JOIN_PATHS = new Set(['/machine/join', '/join', ...Object.keys(SCRIPTS)]);

/**
 * join.cmd for `portalUrl`, with `code` written in (or none: the bootstrap then asks for it), in CRLF line endings, which
 * cmd.exe needs. The URL is checked here too, since it goes into a command line: an origin with no quote or space.
 */
export function windowsInstaller(template: string, portalUrl: string, code = ''): string {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(portalUrl)) throw new Error(`not a portal URL: ${portalUrl}`);
  if (!/^[0-9A-Z-]*$/.test(code)) throw new Error('a join code is digits, capital letters and dashes');
  return template.split(PORTAL_URL_MARK).join(portalUrl).split(JOIN_CODE_MARK).join(code).replace(/\r?\n/g, '\r\n');
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The /join page: what a person at the new PC does, with the download. */
export function joinPage(portalUrl: string): string {
  const u = esc(portalUrl);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Add this PC to FF Factory</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#ddd;background:#16181d}
a{color:#7cc4ff}code{background:#262a33;padding:.1rem .3rem;border-radius:4px;user-select:all}.btn{display:inline-block;margin:.5rem 0;padding:.6rem 1rem;background:#2d6cdf;color:#fff;border-radius:6px;text-decoration:none}</style>
</head><body>
<h1>Add this PC to FF Factory</h1>
<ol>
<li>Keep this PC connected to Tailscale.</li>
<li>Get a join code from an owner: the dashboard's <b>Add a machine</b> (it can hand you this installer with the code already in it), or their orchestrator. A code works once, for one hour, on this PC only.</li>
<li><b>Windows:</b> <a class="btn" href="${u}/join/windows.cmd" download="${WINDOWS_INSTALLER_NAME}">Download the installer</a><br>
Double-click it and type the code. Windows warns about a downloaded file first: choose <i>More info</i> and <i>Run anyway</i> (or <i>Run</i>).
Or paste this into a PowerShell window: <code>irm ${u}/join/windows.ps1 | iex</code></li>
<li><b>Mac or Linux:</b> in a terminal: <code>bash -c "$(curl -fsSL ${u}/join/unix.sh)"</code></li>
</ol>
<p>It checks the code first, installs what is missing (Node, Git, Git LFS, Claude Code), sets the PC up, and ends with a summary. No password or credential is shown.</p>
</body></html>
`;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

async function body(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** The handler, with its own record of failed tries per address. */
export function machineJoinHttp(d: MachineJoinDeps) {
  const fails = new Map<string, number[]>();
  const now = () => d.now?.() ?? Date.now();
  const recent = (addr: string) => (fails.get(addr) ?? []).filter((t) => now() - t < FAIL_WINDOW_MS);
  const failed = (addr: string) => fails.set(addr, [...recent(addr), now()]);

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    const off = tailnetOnly(req, 'joining a machine');
    if (off) return send(res, 403, { error: off });

    if (pathname === '/join') {
      if (req.method !== 'GET') return send(res, 405, { error: 'GET /join' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(joinPage(d.portalUrl(req)));
      return;
    }
    const kind = SCRIPTS[pathname];
    if (kind) {
      if (req.method !== 'GET') return send(res, 405, { error: `GET ${pathname}` });
      const text = d.script(kind);
      if (!text) return send(res, 404, { error: `this portal has no ${kind} bootstrap` });
      if (kind === 'cmd') {
        let out: string;
        try {
          out = windowsInstaller(text, d.portalUrl(req));
        } catch (e) {
          return send(res, 400, { error: (e as Error).message });
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${WINDOWS_INSTALLER_NAME}"`, 'cache-control': 'no-store' }).end(out);
        return;
      }
      const out = text.split(PORTAL_URL_MARK).join(d.portalUrl(req));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(out);
      return;
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'POST /machine/join' });
    const addr = clientAddress(req);
    if (recent(addr).length >= MAX_FAILS) return send(res, 429, { error: 'too many wrong join codes from this address; wait 15 minutes' });
    let raw: unknown;
    try {
      raw = await body(req);
    } catch {
      return send(res, 400, { error: 'a JSON body of at most 16 KB' });
    }
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const check = b.check === true;
    const facts = parseFacts(b.facts);

    const device = await d.whois(addr);
    if (!device) return send(res, 503, { error: `the portal could not tell which tailnet device ${addr} is (tailscale whois): try again, or check the portal's Tailscale` });
    const j = d.codes.find(b.code);
    if (!j) {
      failed(addr);
      return send(res, 403, { error: 'that join code is wrong, used or expired: ask an owner for a new one (add_machine with join_code)' });
    }
    if (device.name !== j.tailnetName) {
      failed(addr);
      return send(res, 403, { error: `this join code is for the tailnet device "${j.tailnetName}", and this request came from "${device.name}": run the bootstrap on that PC, or ask for a code for this one (add_machine with join_code and tailnet_name ${device.name})` });
    }
    const why = joinRefusal(d.records, j.machineId);
    if (why) return send(res, 409, { error: why });

    const fromCode = Object.keys(j.limits).length > 0;
    const defaults = defaultLimits(facts);
    const limits: Required<JoinLimits> = {
      maxSandboxes: j.limits.maxSandboxes ?? defaults.maxSandboxes,
      maxAgentsPerSandbox: j.limits.maxAgentsPerSandbox ?? defaults.maxAgentsPerSandbox,
      maxUnity: j.limits.maxUnity ?? defaults.maxUnity,
    };
    const answer = {
      machineId: j.machineId,
      tailnetName: device.name,
      expiresAt: j.expiresAt,
      limits,
      limitsFrom: fromCode ? 'code' : 'defaults',
      defaultsWhy: defaults.why,
      workerTag: WORKER_TAG,
      tagged: device.tags.includes(WORKER_TAG),
      tags: device.tags,
      existing: d.records.get(j.machineId) ? 'waiting' : 'new',
      // w1993: a play-only timing machine plays builds made elsewhere, so its installer makes no Dev Drive (join.ps1 -NoDevDrive).
      playOnly: !!d.records.get(j.machineId)?.playOnly?.trim(),
    };
    if (check) return send(res, 200, { ok: true, check: true, ...answer });

    const refusal = d.refused?.();
    if (refusal) return send(res, 409, { error: refusal });
    // Synchronous from find() to the answer, so two redeems of one code cannot both get here. A record that cannot be
    // made leaves the code as it was, for a second try.
    let credential: string;
    try {
      credential = d.enrol({ machineId: j.machineId, tailnetName: device.name, limits, portalUrl: d.portalUrl(req), by: j.by, ...(facts.os ? { platform: PLATFORM_OF_OS[facts.os] } : {}) });
    } catch (e) {
      return send(res, 409, { error: `the record could not be made: ${(e as Error).message}` });
    }
    d.codes.take(j);
    const last4 = credential.slice(-4);
    console.log(`machine ${j.machineId}: joined from tailnet device ${device.name} with ${j.by}'s join code ...${j.last4}; credential ...${last4} issued`);
    d.report?.(`[machines] ${j.machineId} joined from its tailnet device ${device.name} with ${j.by}'s join code (...${j.last4}); its installer runs there now, and list_machines shows it online when its daemon connects.`);
    return send(res, 200, { ok: true, ...answer, credential, last4, portalUrl: d.portalUrl(req) });
  };
}
