import type http from 'node:http';
import { defaultLimits, joinRefusal, parseFacts, WORKER_TAG, type JoinCodes, type JoinLimits, type JoinRecords, type TailnetDevice } from './machineJoin.ts';
import { clientAddress, tailnetOnly } from './remoteChat.ts';

/**
 * The join bootstrap's two routes (w1592, server/machineJoin.ts), both tailnet-only (a Funnel request is refused):
 *
 * - GET /join/windows.ps1, GET /join/unix.sh: the bootstrap itself (scripts/worker/join.ps1, join.sh) with this portal's
 *   tailnet URL written in, so `irm https://<portal>/join/windows.ps1 | iex` is the whole command at the PC.
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
  enrol(o: { machineId: string; tailnetName: string; limits: Required<JoinLimits>; portalUrl: string; by: string }): string;
  /** The URL the PC reached this portal at (originOf), for the record and the bootstrap. */
  portalUrl(req: http.IncomingMessage): string;
  /** A bootstrap's text, or undefined when this portal's checkout lacks it. */
  script(kind: 'windows' | 'unix'): string | undefined;
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

    const kind = pathname === '/join/windows.ps1' ? 'windows' : pathname === '/join/unix.sh' ? 'unix' : undefined;
    if (kind) {
      if (req.method !== 'GET') return send(res, 405, { error: `GET ${pathname}` });
      const text = d.script(kind);
      if (!text) return send(res, 404, { error: `this portal has no ${kind} bootstrap` });
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
    };
    if (check) return send(res, 200, { ok: true, check: true, ...answer });

    const refusal = d.refused?.();
    if (refusal) return send(res, 409, { error: refusal });
    // Synchronous from find() to the answer, so two redeems of one code cannot both get here. A record that cannot be
    // made leaves the code as it was, for a second try.
    let credential: string;
    try {
      credential = d.enrol({ machineId: j.machineId, tailnetName: device.name, limits, portalUrl: d.portalUrl(req), by: j.by });
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
