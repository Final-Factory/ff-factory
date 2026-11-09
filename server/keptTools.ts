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
import { isDeepStrictEqual } from 'node:util';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

export interface ToolNow {
  description: string;
  input_schema: unknown;
}

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

const MARK = Buffer.from('"deferred_tools_record"');

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
 * so nothing is written. The same records are dropped as refreshKeptTools drops (keptTools.test.ts).
 */
export async function refreshKeptToolsAsync(file: string | undefined, now: Map<string, ToolNow>, gone: () => boolean = () => false): Promise<string[]> {
  if (!file || now.size === 0) return [];
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(file);
  } catch {
    return [];
  }
  const out: Stale = { writes: [], dropped: new Set() };
  for (let hit = buf.indexOf(MARK); hit >= 0; ) {
    if (gone()) return [];
    const until = performance.now() + SCAN_SLICE_MS;
    hit = scanRecords(buf, now, hit, out, () => performance.now() >= until);
    if (hit >= 0) await new Promise((r) => setImmediate(r));
  }
  if (out.writes.length === 0 || gone()) return [];
  const fh = await fs.promises.open(file, 'r+');
  try {
    for (const w of out.writes) await fh.write(w.bytes, 0, w.bytes.length, w.at);
  } finally {
    await fh.close();
  }
  return [...out.dropped];
}

interface Stale {
  writes: { at: number; bytes: Buffer }[];
  dropped: Set<string>;
}

/** The record lines from `hit` on, into `out`; returns where to go on when `stop` said so, else -1. */
function scanRecords(buf: Buffer, now: Map<string, ToolNow>, hit: number, out: Stale, stop: () => boolean = () => false): number {
  const { writes, dropped } = out;
  while (hit >= 0) {
    if (stop()) return hit;
    const start = buf.lastIndexOf(0x0a, hit) + 1;
    let end = buf.indexOf(0x0a, hit);
    if (end < 0) end = buf.length;
    hit = buf.indexOf(MARK, end);
    const raw = buf.subarray(start, end);
    let line: { attachment?: { type?: string; entries?: { name?: string; description?: unknown; input_schema?: unknown }[] } };
    try {
      line = JSON.parse(raw.toString('utf8'));
    } catch {
      continue; // a line still being written, or not JSON: not ours to touch
    }
    const a = line?.attachment;
    if (a?.type !== 'deferred_tools_record' || !Array.isArray(a.entries)) continue;
    const stale = a.entries.filter((e) => {
      const cur = typeof e?.name === 'string' ? now.get(e.name) : undefined;
      return cur !== undefined && (e.description !== cur.description || !isDeepStrictEqual(e.input_schema, cur.input_schema));
    });
    if (stale.length === 0) continue;
    a.entries = a.entries.filter((e) => !stale.includes(e));
    const json = Buffer.from(JSON.stringify(line), 'utf8');
    if (json.length > raw.length) continue;
    writes.push({ at: start, bytes: Buffer.concat([json.subarray(0, json.length - 1), Buffer.alloc(raw.length - json.length, 0x20), json.subarray(json.length - 1)]) });
    for (const e of stale) dropped.add(e.name as string);
  }
  return -1;
}
