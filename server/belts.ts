// Which tools each orchestrator gets (docs/orchestrators.md). Every tool is built once, by Agents.toolSpecs; a role's
// belt is the selection server/toolManifest.ts gives its kind. A person's own orchestrator gets looking, its own
// wake-ups and heartbeat, follow-ups to its person's workers, the ledger, and messages to other people; the dispatcher
// the rest. A tool added later and not yet in the manifest is the dispatcher's alone, which is the safe way round.
import { z } from 'zod';
import { alwaysLoaded, hasTool, inManifest, toolsOf } from './toolManifest.ts';

/** What a tool belt is built from: the shape of Agents.toolSpecs's entries. */
export interface BeltTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}

/** A person's own orchestrator: read-only visibility, plus a few (server/toolManifest.ts lists which). */
export const PERSONAL_TOOLS: ReadonlySet<string> = new Set(toolsOf('personal'));

/**
 * The orchestration worker's own belt (w597, docs/ops-worker.md): the portal's state, read-only, its own check-ins, and its
 * own timers (w1106: a poll is a timer, which survives deploys, restarts and its idle stop, never a background shell loop).
 */
export const OPS_TOOLS: ReadonlySet<string> = new Set(toolsOf('ops'));

/**
 * The dispatcher's destructive and administrative tools, which run only when a person asked. They run in a turn a
 * person started in the dispatcher's own chat, or for a request (work_id) its person filed or last changed in a turn of
 * their own. Recovery tools (host_recovery, machine_daemon) stay free: the dispatcher answers the host's notices alone.
 */
export const USER_ASKED_TOOLS: ReadonlySet<string> = new Set([
  'delete_sandbox',
  'request_app_update',
  'set_app_config',
  'set_ffbox_config',
  'republish_public',
  'add_machine',
  'remove_machine',
  'relocate_machines',
  'convert_machine',
  'create_standing_agent',
  'update_standing_agent',
  'delete_standing_agent',
  'approve_delegation',
]);

export type BeltRole = 'dispatcher' | 'personal' | 'remote' | 'ops';

/**
 * The tools a coordinator carries in full in every call (w1158, w1163): the manifest's always-loaded ones for its kind
 * (server/toolManifest.ts, docs/tool-manifest.md). Every other tool of its belt is deferred behind ToolSearch.
 */
export const ALWAYS_LOADED: Readonly<Record<'dispatcher' | 'personal', ReadonlySet<string>>> = {
  dispatcher: new Set(toolsOf('dispatcher').filter((t) => alwaysLoaded('dispatcher', t))),
  personal: new Set(toolsOf('personal').filter((t) => alwaysLoaded('personal', t))),
};

/**
 * The tools of a role. `guard` (dispatcher) is asked before a user_asked tool runs, with the work_id it was given;
 * it answers why not, or undefined. Those tools gain an optional work_id for it.
 */
export function beltFor<T extends BeltTool>(role: BeltRole, all: readonly T[], guard?: (tool: string, workId: string | undefined) => string | undefined): T[] {
  if (role !== 'dispatcher') return all.filter((t) => hasTool(role, t.name));
  // A tool the manifest does not list yet is the dispatcher's alone (toolManifest.test.ts fails until it is listed).
  return all
    .filter((t) => hasTool('dispatcher', t.name) || !inManifest(t.name))
    .map((t) => {
      if (!USER_ASKED_TOOLS.has(t.name) || !guard) return t;
      return {
        ...t,
        schema: 'work_id' in t.schema ? t.schema : { ...t.schema, work_id: z.string().optional().describe('The request (w12) this serves, when a person asked for it through their orchestrator.') },
        handler: async (args: Record<string, unknown>) => {
          const why = guard(t.name, typeof args.work_id === 'string' ? args.work_id : undefined);
          if (why) return { content: [{ type: 'text' as const, text: `ERROR: ${why}` }], isError: true };
          return t.handler(args);
        },
      };
    });
}
