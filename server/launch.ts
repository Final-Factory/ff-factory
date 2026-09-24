import { createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { sandboxGuard } from './guard.ts';
import { standingGuard } from './standingGuard.ts';
import type { StandingToolGroup } from '../shared/types.ts';

/**
 * Everything needed to start an agent process, as plain data: the portal builds it and a machine daemon
 * turns it into SDK options (docs/machines.md). Hooks and MCP servers are functions, so they cannot
 * cross the wire; the spec names them and buildOptions() rebuilds them where the process runs.
 */
export interface LaunchSpec {
  cwd: string;
  model?: string;
  effort?: Options['effort'];
  settingSources: NonNullable<Options['settingSources']>;
  /** Appended to the claude_code system prompt. */
  append: string;
  /** Restrict the built-in tools (undefined: all). */
  tools?: string[];
  disallowedTools?: string[];
  /** Only the MCP servers named here (plus `mcp`); false loads the user's own too. */
  strictMcp: boolean;
  /** An in-process MCP server whose tool calls are answered by `handlers` (on a machine: the portal). */
  mcp?: { server: string; tools: { name: CatalogTool; description: string }[] };
  maxBudgetUsd?: number;
  guard: {
    /** Unity instance prefix (project folder name) and the agent's own folder. */
    id: string;
    ownPath: string;
    protectedPaths: string[];
    gameRepos: string[];
    ownCheckout?: boolean;
    denyToolPrefixes?: string[];
    standing?: { folder: string; groups: StandingToolGroup[]; offLimits: string[] };
  };
  env?: Record<string, string>;
  claudeExecutable?: string;
  /** Created before the process starts: `cwd` itself, and these files (relative to cwd) when missing. */
  init?: { files?: Record<string, string> };
}

/** The tools a spec can ask for, with their input schemas. Descriptions come with the spec. */
export const CATALOG = {
  set_label: { purpose: z.string().describe('One line on what this is being used for now.') },
  request_delegation: {
    title: z.string().describe('Short label, e.g. "Fix null ref in BeltSystem (Discord #412)".'),
    task: z.string().describe('The full brief for the worker.'),
  },
  my_delegations: {},
  wake_me: {
    minutes: z.number().int().min(1).max(1440).describe('How long until you are messaged again.'),
    note: z.string().describe('What to check or do when you wake: this comes back to you word for word.'),
  },
} satisfies Record<string, z.ZodRawShape>;

export type CatalogTool = keyof typeof CATALOG;
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

/** SDK options for a spec. `handlers` answers the spec's MCP tools; `baseEnv` is the process environment to start from. */
export function buildOptions(spec: LaunchSpec, handlers: Partial<Record<CatalogTool, ToolHandler>>, baseEnv: NodeJS.ProcessEnv = process.env): Options {
  const g = spec.guard;
  const hooks = [
    sandboxGuard({
      sandboxId: g.id,
      sandboxPath: g.ownPath,
      protectedPaths: g.protectedPaths,
      gameRepos: g.gameRepos,
      ownCheckout: g.ownCheckout ? {} : undefined,
      denyToolPrefixes: g.denyToolPrefixes,
    }),
    ...(g.standing ? [standingGuard(g.standing)] : []),
  ];
  const mcpServers: NonNullable<Options['mcpServers']> = {};
  if (spec.mcp) {
    mcpServers[spec.mcp.server] = createSdkMcpServer({
      name: spec.mcp.server,
      version: '1.0.0',
      tools: spec.mcp.tools.map((t) =>
        tool(t.name, t.description, CATALOG[t.name], async (args: Record<string, unknown>) => {
          const h = handlers[t.name];
          try {
            if (!h) throw new Error(`${t.name} is not available here`);
            return { content: [{ type: 'text' as const, text: await h(args) }] };
          } catch (e) {
            return { content: [{ type: 'text' as const, text: `ERROR: ${(e as Error).message}` }], isError: true };
          }
        }),
      ),
    });
  }
  return {
    cwd: spec.cwd,
    model: spec.model,
    effort: spec.effort,
    settingSources: spec.settingSources,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.append },
    ...(spec.tools ? { tools: spec.tools } : {}),
    ...(spec.disallowedTools ? { disallowedTools: spec.disallowedTools } : {}),
    strictMcpConfig: spec.strictMcp,
    mcpServers,
    ...(spec.maxBudgetUsd !== undefined ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
    hooks: { PreToolUse: [{ hooks }] },
    // Git fails fast instead of waiting on a credential prompt nobody will answer.
    env: { MCP_TIMEOUT: '120000', ...baseEnv, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...spec.env },
    ...(spec.claudeExecutable ? { pathToClaudeCodeExecutable: spec.claudeExecutable } : {}),
  };
}
