// A resumed conversation sees each FF Factory tool as it is now, not as it was when the agent first loaded it (w2626, asked by
// lothsahn: "File a fix so workers' tool search shows the current tool descriptions"). Claude Code (2.1.312, "kept deferred
// tools") writes each deferred tool's schema into the transcript the first time ToolSearch loads it, as an attachment
// `{type: "deferred_tools_record", entries: [{name, description, input_schema, ...}]}`. A process that resumes the conversation
// seeds every earlier tool reference from those records and resolves a later ToolSearch of the same name against the recorded
// entry, not against the tool the MCP server lists now. After PR #773 gave list_ffbox_files `what: "threads"`, the w2618 worker
// (beast/slot3, on a fresh host) was shown `symbols|reports|diagnosis` by ToolSearch while its threads call went through.
// Before a resumed process starts (between turns, never mid-turn), each record entry of this process's own SDK MCP tools whose
// description or input schema differs from the server's is dropped, in place and at the same length (the line keeps its bytes
// and its place in the parentUuid chain; the CLI appending meanwhile loses nothing). A reference with no record resolves against
// the current tool. A tool no longer served keeps its record. Dropping a record that was current changes nothing the model sees.
// docs/machines.md "A resumed conversation sees each tool as it is now" (w2626).
import fs from 'node:fs';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { MARK, scanRecords, type Stale, type ToolNow } from './keptToolsScan.ts';
import { ThreadGone, askThread } from './transcriptThreadClient.ts';

export type { ToolNow };


const EMPTY_OBJECT = { type: 'object', properties: {} };

/**
 * What Claude Code will be told of each tool of the in-process (SDK) MCP servers, by its full name `mcp__<server>__<tool>`:
 * the description and input schema exactly as the server's tools/list answers them (@modelcontextprotocol/sdk McpServer, the
 * same conversion; keptTools.test.ts holds it equal to a real listTools). A server it cannot read adds nothing.
 */
export function sdkToolsNow(mcpServers: Options['mcpServers']): Map<string, ToolNow> {
  const out = new Map<string, ToolNow>();
  for (const [server, cfg] of Object.entries(mcpServers ?? {})) {
    if (!cfg || cfg.type !== 'sdk') continue;
    const tools = (cfg as unknown as { instance?: { _registeredTools?: Record<string, { enabled?: boolean; description?: string; inputSchema?: unknown }> } }).instance?._registeredTools;
    if (!tools || typeof tools !== 'object') continue;
    for (const [name, t] of Object.entries(tools)) {
      if (!t || t.enabled === false) continue;
      try {
        const obj = normalizeObjectSchema(t.inputSchema as never);
        out.set(`mcp__${server}__${name}`, { description: t.description ?? '', input_schema: obj ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' }) : EMPTY_OBJECT });
      } catch {
        // a schema this converter cannot read: its record stays
      }
    }
  }
  return out;
}


/**
 * Drop from the transcript's deferred-tool records each entry whose tool is in `now` with another description or input schema.
 * Each changed line is written back at its own offset at its own length (spaces pad the end of its JSON). Returns the names
 * dropped, once each. A missing or unreadable file, or a line that would not fit, is left as it is.
 */
export function refreshKeptTools(file: string | undefined, now: Map<string, ToolNow>): string[] {
  if (!file || now.size === 0) return [];
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return [];
  }
  const out: Stale = { writes: [], dropped: new Set() };
  scanRecords(buf, now, buf.indexOf(MARK), out);
  if (out.writes.length === 0) return [];
  const fd = fs.openSync(file, 'r+');
  try {
    for (const w of out.writes) fs.writeSync(fd, w.bytes, 0, w.bytes.length, w.at);
  } finally {
    fs.closeSync(fd);
  }
  return [...out.dropped];
}

/** How long the async refresh scans before it lets the event loop run (w3855). */
const SCAN_SLICE_MS = 50;

/**
 * refreshKeptTools off the event loop's long tasks (w3855: after a portal restart one turn end started every person's orchestrator
 * in one task, each reading its whole transcript; 3.7 s blocked on 2026-11-09 15:11:04 UTC): the file is read and written by the
 * thread pool, and the scan lets the loop run every SCAN_SLICE_MS. `gone`, asked after each wait: the start was stopped meanwhile,
 * so nothing is written. The same records are dropped as refreshKeptTools drops (keptTools.test.ts). w5888: the scan runs in the
 * transcript thread (server/transcriptThread.ts), a window at a time, and on the event loop as before when that thread is gone.
 */
export async function refreshKeptToolsAsync(file: string | undefined, now: Map<string, ToolNow>, gone: () => boolean = () => false, wrote?: { first?: number }): Promise<string[]> {
  if (!file || now.size === 0) return [];
  let out: Stale | undefined;
  try {
    out = await scanInThread(file, now);
  } catch (e) {
    if (!(e instanceof ThreadGone)) return []; // unreadable: left as it is
  }
  out ??= await scanOnLoop(file, now, gone);
  if (!out || out.writes.length === 0 || gone()) return [];
  const fh = await fs.promises.open(file, 'r+');
  try {
    for (const w of out.writes) {
      await fh.write(w.bytes, 0, w.bytes.length, w.at);
      // w5931: where the file first changed, so its hash goes on from a checkpoint before it (rehashFrom)
      if (wrote && (wrote.first === undefined || w.at < wrote.first)) wrote.first = w.at;
    }
  } finally {
    await fh.close();
  }
  return [...out.dropped];
}

/** w5888: the scan in the transcript thread, where a 1.49 GB transcript waits behind nothing; ThreadGone when it is gone or off. */
async function scanInThread(file: string, now: Map<string, ToolNow>): Promise<Stale> {
  const { ok } = await askThread<{ writes: { at: number; bytes: Uint8Array }[]; dropped: string[] }>({ op: 'scan', file, now });
  return { writes: ok.writes.map((w) => ({ at: w.at, bytes: Buffer.from(w.bytes.buffer, w.bytes.byteOffset, w.bytes.byteLength) })), dropped: new Set(ok.dropped) };
}

/** The scan on the event loop, a SCAN_SLICE_MS slice at a time (w3855); undefined when unreadable or stopped. */
async function scanOnLoop(file: string, now: Map<string, ToolNow>, gone: () => boolean): Promise<Stale | undefined> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(file);
  } catch {
    return undefined;
  }
  const out: Stale = { writes: [], dropped: new Set() };
  for (let hit = buf.indexOf(MARK); hit >= 0; ) {
    if (gone()) return undefined;
    const until = performance.now() + SCAN_SLICE_MS;
    hit = scanRecords(buf, now, hit, out, () => performance.now() >= until);
    if (hit >= 0) await new Promise((r) => setImmediate(r));
  }
  return out;
}
