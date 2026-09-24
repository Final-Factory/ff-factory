import type http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Agents } from './agents.ts';

/**
 * The /mcp endpoint: the sandbox tool belt over MCP Streamable HTTP, so a Claude Code session on
 * another machine can drive this host directly ("spin up a sandbox for spec 093"). Stateless: a fresh
 * server and transport per request, as the MCP SDK recommends when no session state is needed.
 * Authentication (a bearer API key) happens before this is called.
 */
export async function handleMcp(agents: Agents, keyName: string, req: http.IncomingMessage, res: http.ServerResponse, body: unknown) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null }));
  }
  const server = new McpServer({ name: 'ff-sandboxes', version: '1.0.0' });
  for (const t of [...agents.toolSpecs('human'), ...agents.remoteToolSpecs(`Claude Code (${keyName})`)]) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, t.handler as never);
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
