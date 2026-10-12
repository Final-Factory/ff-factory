import type http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Agents } from './agents.ts';
import { beltFor } from './belts.ts';
import { mcpMeta } from './toolManifest.ts';
import type { Auth } from './auth.ts';
import type { AttachmentStore } from './attachments.ts';
import { asRequester, type Identity } from './identity.ts';
import { mcpUpload, originOf, tailnetOnly } from './remoteChat.ts';
import type { Requester } from '../shared/types.ts';

/** The tools that wait on the orchestrator: their reply is a stream, so progress notices keep the client's own timeout from running out. */
const WAITING_TOOLS = new Set(['orchestrator_send', 'orchestrator_inbox']);
const waitsOnOrchestrator = (body: unknown) => {
  const b = body as { method?: unknown; params?: { name?: unknown } } | undefined;
  return b?.method === 'tools/call' && WAITING_TOOLS.has(String(b.params?.name));
};

/**
 * The /mcp endpoint: the sandbox tool belt over MCP Streamable HTTP, so a Claude Code session on
 * another machine can drive this host directly ("spin up a sandbox for spec 093"). Stateless: a fresh
 * server and transport per request, as the MCP SDK recommends when no session state is needed.
 * Authentication (a bearer API key) happens before this is called. `who`: the login the key acts for; everything
 * its tools start is requested by them (docs/identity.md). `bound`: the key names a login (an unbound one acts for the
 * owner, and may not use the orchestrator chat tools, docs/talk-to-your-orchestrator.md).
 */
export async function handleMcp(agents: Agents, keyName: string, who: Requester, bound: boolean, req: http.IncomingMessage, res: http.ServerResponse, body: unknown) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null }));
  }
  const server = new McpServer({ name: 'ff-sandboxes', version: '1.0.0' });
  // A remote client is a person driving directly: the tools act for them, and ask_orchestrator talks to their own orchestrator.
  const belt = beltFor('remote', agents.toolSpecs('human', agents.fixedActor(who), { role: 'remote', owner: who }));
  for (const t of [...belt, ...agents.remoteToolSpecs(`Claude Code (${keyName})`, who, { who, keyName, bound, refuse: tailnetOnly(req), origin: originOf(req) })]) {
    // Its group as a ToolSearch hint for the client's Claude Code (w1163, server/toolManifest.ts).
    const meta = mcpMeta('remote', t.name);
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema, ...(meta ? { _meta: meta } : {}) }, t.handler as never);
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !waitsOnOrchestrator(body) });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export interface McpRouteDeps {
  agents: Agents;
  auth: Auth;
  identity: Identity;
  attachments: AttachmentStore | undefined;
  send(res: http.ServerResponse, status: number, body: unknown): void;
  readJson(req: http.IncomingMessage): Promise<unknown>;
}

/**
 * /mcp and /mcp/upload, as the server routes them: machine clients authenticate with an API key, not a browser session
 * (no cookies, so no CSRF). A scoped key (nightly, ffbox) is for those reports only. A key bound to a login acts for that
 * person; an unbound one (made before keys had users) for the owner, and the orchestrator chat tools refuse it.
 */
export async function routeMcp(d: McpRouteDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const who = d.auth.bearer(req);
  if (!who.ok) return d.send(res, who.status, { error: who.status === 429 ? 'too many failures' : 'API key required' });
  if (who.scope) return d.send(res, 403, { error: `this key is for ${who.scope} reports only` });
  const keyUser = d.auth.userInfo(who.user);
  const person = keyUser ? asRequester(keyUser) : d.identity.owner();
  if (url.pathname === '/mcp/upload') {
    const r = await mcpUpload(d.attachments, { who: person, bound: !!keyUser, refuse: tailnetOnly(req) }, req, url.searchParams.get('name'));
    return d.send(res, r.status, r.body);
  }
  return await handleMcp(d.agents, who.name, person, !!keyUser, req, res, req.method === 'POST' ? await d.readJson(req) : undefined);
}
