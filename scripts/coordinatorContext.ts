/**
 * What every coordinator (the dispatcher, a person's own orchestrator) carries in each call before any conversation: its
 * appended system prompt and its portal tools (w1158, docs/orchestrators.md "What a coordinator's context costs").
 * Builds the same world the tests do, with fakes, and prints the size of each part:
 *
 *   node scripts/coordinatorContext.ts            sizes per coordinator kind, and the 15 biggest tools
 *   node scripts/coordinatorContext.ts --dump DIR  also writes each kind's prompt and tools (as the SDK sends them) to DIR
 *
 * Characters are exact; tokens are characters / 4 (a guess the w1158 measurement checked against the API's own count,
 * docs/orchestrators.md). The claude_code preset and Claude Code's own tools come on top, the same for every version.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Store } from '../server/store.ts';
import { SessionManager, setQueryForTesting } from '../server/sessions.ts';
import { MachineManager } from '../server/machines.ts';
import { Agents } from '../server/agents.ts';
import { Identity } from '../server/identity.ts';
import type { Config } from '../server/config.ts';
import type { Requester, SessionInfo, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { useFakeVault } from '../server/testVault.ts';

export interface ToolText { name: string; description: string; inputSchema: unknown }
export interface CoordinatorContext { kind: string; prompt: string; tools: ToolText[] }

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const MEMBER: Requester = { userId: 'sam', displayName: 'Sam' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }, { ...LOTH, role: 'owner' }, { ...MEMBER, role: 'member' }];

/** The tools as the SDK's MCP server lists them: name, description, JSON schema of the input. */
function toolTexts(belt: { name: string; description: string; schema: unknown }[]): ToolText[] {
  return belt.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.schema as z.ZodRawShape)) }));
}

/** Runs `fn` with a fake world's Agents and each coordinator kind's session info, then closes the world. */
export async function withCoordinators<T>(fn: (agents: Agents, kinds: [string, SessionInfo][]) => Promise<T> | T): Promise<T> {
  useFakeVault();
  setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-context-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/master',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'high' },
    unity: {},
    machines: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  const out = await fn(agents, [
    ['dispatcher', sessions.get(agents.dispatcherId!)!.info],
    ['owner (Lothsahn)', agents.orchestrators.personalFor(LOTH).info],
    ['owner (Ben)', agents.orchestrators.personalFor(BEN).info],
    ['member', agents.orchestrators.personalFor(MEMBER).info],
  ]);
  agents.orchestrators.close();
  sessions.stopAll();
  await new Promise((r) => setTimeout(r, 60));
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  return out;
}

export const coordinatorContexts = (): Promise<CoordinatorContext[]> =>
  withCoordinators((agents, kinds) =>
    kinds.map(([kind, info]) => ({ kind, prompt: (agents.orchestratorOptions(info) as { systemPrompt: { append: string } }).systemPrompt.append, tools: toolTexts(agents.orchestratorBelt(info)) })),
  );

const sizeOf = (c: CoordinatorContext) => {
  const tools = c.tools.reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(t.inputSchema).length, 0);
  return { prompt: c.prompt.length, tools, descriptions: c.tools.reduce((n, t) => n + t.description.length, 0) };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = await coordinatorContexts();
  const dumpAt = process.argv.indexOf('--dump');
  const dump = dumpAt > 0 ? process.argv[dumpAt + 1] : undefined;
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  for (const c of all) {
    const s = sizeOf(c);
    console.log(`${c.kind}: prompt ${k(s.prompt)} chars, ${c.tools.length} tools ${k(s.tools)} chars (descriptions ${k(s.descriptions)}); ~${k((s.prompt + s.tools) / 4)} tokens`);
    if (dump) {
      fs.mkdirSync(dump, { recursive: true });
      const slug = c.kind.replace(/\W+/g, '-').replace(/-$/, '');
      fs.writeFileSync(path.join(dump, `${slug}.prompt.md`), c.prompt);
      fs.writeFileSync(path.join(dump, `${slug}.tools.json`), JSON.stringify(c.tools, null, 1));
    }
  }
  const disp = all[0];
  const rows = disp.tools.map((t) => ({ name: t.name, d: t.description.length, s: JSON.stringify(t.inputSchema).length })).sort((a, b) => b.d + b.s - (a.d + a.s));
  console.log('\nBiggest dispatcher tools (description + schema chars):');
  for (const r of rows.slice(0, 15)) console.log(`  ${r.name}: ${r.d} + ${r.s}`);
  process.exit(0);
}
