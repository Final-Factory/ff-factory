import type http from 'node:http';
import { authorizedKeyLine, parseSshRegistration, type MachineSsh } from './machineSsh.ts';

/**
 * /machine/ssh (w568, server/machineSsh.ts): a worker installer setting up the portal's ssh, with its machine's own
 * credential and nothing else. GET: the line that authorizes the portal's key there. POST: its ssh user, the name the
 * portal reaches it by and its host keys, pinned here; the answer says whether the portal's ssh gets in.
 */
export interface MachineSshDeps {
  /** The machine a bearer credential belongs to (MachineManager.authenticate), if it has a record. */
  machineOf(authorization: string | undefined): string | undefined;
  publicKey(): string | undefined;
  tailnetAddress(): Promise<string | undefined>;
  register(id: string, ssh: MachineSsh): Promise<{ host: string; reachable: boolean; detail: string }>;
  /** Why it acts on nothing (a dry-run portal), or undefined. */
  refused?(): string | undefined;
}

const MAX_BODY = 64 * 1024;

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

export async function machineSshHttp(d: MachineSshDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const id = d.machineOf(req.headers.authorization);
  if (!id) return send(res, 401, { error: 'a valid machine token is required' });
  if (req.method === 'GET') {
    const publicKey = d.publicKey();
    if (!publicKey) return send(res, 404, { error: "the portal has no ssh key (~/.ssh/id_ed25519.pub of the portal's account)" });
    const from = await d.tailnetAddress();
    return send(res, 200, { publicKey, from: from ?? null, authorizedKey: authorizedKeyLine(publicKey, from) });
  }
  if (req.method === 'POST') {
    let raw: unknown;
    try {
      raw = await body(req);
    } catch {
      return send(res, 400, { error: 'a JSON body of at most 64 KB' });
    }
    const reg = parseSshRegistration(raw);
    if ('error' in reg) return send(res, 400, reg);
    const why = d.refused?.();
    if (why) return send(res, 409, { error: why });
    return send(res, 200, await d.register(id, reg));
  }
  return send(res, 405, { error: 'GET or POST /machine/ssh' });
}
