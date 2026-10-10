import { createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { POST_CHANNELS } from '../shared/ffboxPost.ts';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { sandboxGuard } from './guard.ts';
import { standingGuard } from './standingGuard.ts';
import { publicIdentityEnv } from './publicGit.ts';
import { usageEnv } from './usage.ts';
import type { StandingToolGroup } from '../shared/types.ts';
import { WORK_LIVE_STATES, type WorkLiveState } from '../shared/workState.ts';
import type { SecretRules } from './secretGuard.ts';

/** A stdio MCP server the agent process starts (on a machine: the daemon's Unity MCP server, machine/unityMcp.ts). */
export interface StdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Everything needed to start an agent process, as plain data: the portal builds it and a machine daemon
 * turns it into SDK options (docs/machines.md). Hooks and MCP servers are functions, so they cannot
 * cross the wire; the spec names them and buildOptions() rebuilds them where the process runs.
 */
export interface LaunchSpec {
  cwd: string;
  /** A machine sandbox (docs/machines.md): the daemon checks cwd is its folder and gives the guard its editor state. */
  sandbox?: string;
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
  /**
   * Give the agent the machine's Unity MCP server as "UnityMCP", confined to its place's editor (the sandbox's, else
   * the main clone's): the daemon fills in `stdioMcp` from it (machine/unityMcp.ts). An older daemon ignores it.
   */
  unityMcp?: boolean;
  /** Stdio MCP servers the process starts, by name (the daemon's, never the portal's: commands are the machine's). */
  stdioMcp?: Record<string, StdioServer>;
  /** An in-process MCP server whose tool calls are answered by `handlers` (on a machine: the portal). */
  mcp?: { server: string; tools: { name: CatalogTool; description: string }[] };
  maxBudgetUsd?: number;
  guard: {
    /** Unity instance prefix (project folder name) and the agent's own folder. */
    id: string;
    ownPath: string;
    protectedPaths: string[];
    gameRepos: string[];
    denyToolPrefixes?: string[];
    /** `secrets`: what it may not read (server/secretGuard.ts); the home secrets are added where it runs. */
    standing?: { folder: string; groups: StandingToolGroup[]; offLimits: string[]; secrets?: SecretRules };
    /** Public repos and their commit identity (config publicGitIdentity). */
    publicIdentity?: { repos: string[]; name?: string; email?: string };
    /** The machine's worker install folder (w896): the guard refuses a delete outside it. An older daemon ignores it. */
    workerRoot?: string;
  };
  env?: Record<string, string>;
  /**
   * Run on the computer's stored claude.ai login (docs/accounts.md): credentials in the process environment it
   * starts from are dropped (usage.ts AUTH_ENV), so only a token in `env` (a person's own) can override the login.
   */
  login?: boolean;
  /** Commit as this identity in clones of these public repos ("owner/name"), via publicIdentityEnv on the machine. */
  publicGit?: { name: string; email: string; repos: string[] };
  claudeExecutable?: string;
  /** Created before the process starts: `cwd` itself, and these files (relative to cwd) when missing. */
  init?: { files?: Record<string, string> };
}

/** A request's live state (shared/workState.ts), as read_work takes it. */
const LIVE_STATE = z.enum(WORK_LIVE_STATES as unknown as [WorkLiveState, ...WorkLiveState[]]);

/** The tools a spec can ask for, with their input schemas. Descriptions come with the spec. */
export const CATALOG = {
  /** Retired (w575): sandbox labels are their names. Listed in no spec; kept so workers started before it get an answer. */
  set_label: { purpose: z.string().describe('Retired: labels no longer change.') },
  request_delegation: {
    title: z.string().describe('Short label, e.g. "Fix null ref in BeltSystem (Discord #412)".'),
    task: z.string().describe('The full brief for the worker.'),
  },
  my_delegations: {},
  wake_me: {
    minutes: z.number().int().min(1).max(1440).describe('How long until you are messaged again.'),
    note: z.string().describe('What to check or do when you wake: this comes back to you word for word.'),
  },
  /** w754: cancel the worker's own pending wake_me check-in (it has one at a time). */
  cancel_wake: {},
  /** docs/orchestrators.md, "Waiting, Queued, Blocked" (w754): the worker says its request waits only on other requests or pull requests. */
  blocked_on: {
    requests: z.array(z.string().max(16)).max(6).optional().describe('Requests ("w727") that must close as done first. A request often closes later than its pull request merges: to wait for a merge, name the pull request in prs.'),
    prs: z.array(z.string().max(200)).max(6).optional().describe('Pull requests that must MERGE first: "owner/repo#123" or the github.com link.'),
    deploys: z.array(z.string().max(40)).max(2).optional().describe('Deploys that must happen first (w890): "portal" for a portal deploy, or a machine id for that machine\'s daemon update. It clears when a different commit runs there; you are resumed then, in any free sandbox, for the check that comes after it.'),
    what: z.string().min(1).max(200).describe('What you wait for, in a line ("w727 PR #1291 and w752 fix merged into develop").'),
    request: z.string().max(16).optional().describe('The request ("w750") that waits, when you serve several; default: the one you are on.'),
  },
  /** docs/orchestrators.md, "Waiting, Queued, Blocked" (w691): the worker says only a person can move it on. */
  waiting_on_person: {
    who: z.string().min(1).max(120).describe('Whose action it waits on: a name ("Ben"), several separated by commas, or "a reviewer".'),
    what: z.string().min(1).max(400).describe('What they must do, in a line ("reboot the m3 and log in: FileVault asks for a password").'),
    request: z.string().max(16).optional().describe('The request ("w665") it is about, when you serve several; default: all of them.'),
  },
  unity: {
    action: z.enum(['status', 'start', 'stop', 'restart', 'clear_batch']),
    force: z.boolean().optional().describe('stop/restart: kill the editor at once instead of asking it to quit first (a frozen editor ignores that).'),
  },
  switch_branch: {
    branch: z.string().describe('The branch to switch to, e.g. "spec-098-belts".'),
    create_from: z.string().optional().describe('Base for a branch that exists neither here nor on origin. Default origin/develop.'),
  },
  /** docs/review.md. On a machine the daemon sends the files itself: the portal gives the plan, the daemon uploads. */
  publish_review: {
    topic: z.string().describe('A short folder name for what is reviewed, e.g. "w283-enemy-attacks".'),
    files: z.array(z.string()).min(1).describe('Paths of the stills, clips and notes on this computer (absolute, or relative to your working folder).'),
    note: z.string().optional().describe('A few lines for the reviewer: what each file shows. Saved beside them as note.md.'),
  },
  /** docs/attachments.md. On a machine the daemon answers it itself: the portal gives the record, the daemon fetches the file. */
  fetch_attachment: {
    id: z.string().describe('The attachment id, e.g. "att_k2m9x0q7p3a1" (from an [attachments] list).'),
  },
  /**
   * docs/attachments.md, "Agents' files". On a machine the daemon sends the file itself: the portal checks the size and
   * opens an upload bound to that machine, the daemon sends the bytes, the portal checks the SHA-256 and makes the id.
   */
  publish_attachment: {
    file: z.string().describe('The file to hand on (a save, a log, a zip, any file): its path on this computer, absolute or relative to your working folder. It must be in your working folder or your own temp folder (TMP).'),
  },
  /** docs/ffbox.md, "Players' reports". On a machine the portal fetches the report from FFBox and the daemon the files. */
  fetch_ffbox_report: {
    id: z.string().max(64).describe('The FFBox report id, e.g. "20261003T101500Z-desync-3a9f01c2d4".'),
    file: z.string().max(260).optional().describe('One file inside the zip, exactly as the report lists it (e.g. "logs/Player.log"). Default: the whole zip.'),
  },
  /** docs/ffbox.md, "Bug threads' files". On a machine the portal fetches the files from FFBox and the daemon puts them in the Inbox. */
  fetch_discord_thread_files: {
    thread: z.string().max(200).describe('The Discord thread: its URL, e.g. "https://discord.com/channels/530867164866150410/1558176042089447425" (a message link in it works), or its id.'),
    file: z.string().max(260).optional().describe('One file of the thread by its name, e.g. "BugReport_20261009_185502.zip". Default: every file of the thread.'),
    sha256: z.string().max(64).optional().describe('One file by its SHA-256 (from an earlier answer), for when the thread has two files of one name.'),
  },
  /** docs/ffbox.md, "Posting as Max" (w901). FFBox posts; the daemon reads `file` on the machine and sends its content as text. */
  post_as_max: {
    channel: z.enum(POST_CHANNELS).describe('Where to post. dev_patch_notes: a release\'s patch notes. dev_chat: the developers\' chat. agent_testing: a test channel.'),
    text: z.string().max(2000).optional().describe('The message, at most 2000 characters. Give this or file.'),
    file: z.string().max(260).optional().describe('A file on this computer in your working folder or your own temp folder (TMP) whose content is the message (at most 16 KB and 2000 characters), e.g. Temp/post-0.50.0.94.md. Give this or text.'),
    skip_lines: z.number().int().min(0).max(20).optional().describe('With file: leave out its first N lines (a release-notes file starts with two lines that are not the post: skip_lines 2).'),
    thread: z.string().max(25).optional().describe('A Discord thread id, a thread of that channel.'),
    key: z.string().max(80).optional().describe('The dedupe key: a message with the same key in the same place is posted once, and a repeat answers the first one\'s link. Required for dev_patch_notes: the release\'s version, e.g. 0.50.0.94.'),
  },
  /** docs/orchestrators.md, "Workers read the ledger" (w642). Read-only: the portal answers from the ledger (server/workRead.ts). */
  read_work: {
    id: z.string().max(16).optional().describe('One request in full, e.g. "w631": yours, one yours names, or (with a ledger-read grant) any open or stalled one.'),
    all: z.boolean().optional().describe("List the ledger's open and stalled requests, not only yours and the ones they name. Needs a ledger-read grant on one of your open requests."),
    status: z.enum(['open', 'stalled', 'open_and_stalled', 'any']).optional().describe('Default: any for your own list, open_and_stalled with all (any is refused there).'),
    state: z
      .union([LIVE_STATE, z.array(LIVE_STATE).min(1).max(WORK_LIVE_STATES.length)])
      .optional()
      .describe('Only requests in these live states: working (mid-turn, or between turns with its own work going), waiting (on input: a person must act), queued (capacity only), blocked (on a thing: another request, a deploy, a machine, a usage limit, a lock, a time, CI), followup (merged, follow-up pending), stalled.'),
    person: z.string().max(64).optional().describe('Only the requests of this person (user id or display name).'),
    offset: z.number().int().min(0).optional().describe('Skip this many matching requests (the next page).'),
    limit: z.number().int().min(1).max(50).optional().describe('Requests per page, default 20, at most 50; a page also stops at 40,000 characters.'),
  },
} satisfies Record<string, z.ZodRawShape>;

export type CatalogTool = keyof typeof CATALOG;
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

/** The spec's public-repo identity as git env (public-identity.gitconfig in the machine daemon's folder, FF_APP_DIR). */
function publicGitEnvFor(spec: LaunchSpec, baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  if (!spec.publicGit?.repos.length) return {};
  try {
    return publicIdentityEnv(spec.publicGit, spec.publicGit.repos, path.join(baseEnv.FF_APP_DIR || path.join(os.homedir(), '.ff-factory'), 'public-identity.gitconfig'), baseEnv);
  } catch (e) {
    console.warn('public git identity:', (e as Error).message);
    return {};
  }
}

/**
 * The git credential helper for a run the token vault gave a GitHub token (docs/vault.md, w512): for https://github.com
 * only, the helpers git would otherwise use are cleared (an empty value resets the list) and one reads GH_TOKEN from the
 * environment when git asks. So git pushes as that token whatever helper the machine has (a keyring, Git Credential
 * Manager), and the token is never written to any config. Command-scope config entries (GIT_CONFIG_*), appended after
 * the ones already in `prior` (the public identity's).
 */
export const GITHUB_HELPER = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f';
export function githubCredentialEnv(prior: Record<string, string | undefined>): Record<string, string> {
  const n = Number(prior.GIT_CONFIG_COUNT ?? 0) || 0;
  return {
    [`GIT_CONFIG_KEY_${n}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n + 1}`]: GITHUB_HELPER,
    GIT_CONFIG_COUNT: String(n + 2),
  };
}

/**
 * SDK options for a spec. `handlers` answers the spec's MCP tools; `processEnv` is the environment to start from (without its
 * credentials for spec.login); `editorRunning`, for a machine sandbox, says whether its editor is up (raw branch switches are
 * refused then).
 */
export function buildOptions(spec: LaunchSpec, handlers: Partial<Record<CatalogTool, ToolHandler>>, processEnv: NodeJS.ProcessEnv = process.env, editorRunning?: () => boolean): Options {
  const baseEnv = spec.login ? usageEnv(processEnv) : processEnv;
  const g = spec.guard;
  const hooks = [
    sandboxGuard({
      sandboxId: g.id,
      sandboxPath: g.ownPath,
      protectedPaths: g.protectedPaths,
      gameRepos: g.gameRepos,
      denyToolPrefixes: g.denyToolPrefixes,
      publicIdentity: g.publicIdentity,
      workerRoot: g.workerRoot,
      editorRunning,
    }),
    ...(g.standing ? [standingGuard(g.standing)] : []),
  ];
  const mcpServers: NonNullable<Options['mcpServers']> = {};
  for (const [name, srv] of Object.entries(spec.stdioMcp ?? {})) mcpServers[name] = { type: 'stdio', command: srv.command, args: srv.args, ...(srv.env ? { env: srv.env } : {}) };
  if (spec.mcp) {
    mcpServers[spec.mcp.server] = createSdkMcpServer({
      name: spec.mcp.server,
      version: '1.0.0',
      // A tool this code does not know (a newer portal talking to an older daemon) is left out, not fatal.
      tools: spec.mcp.tools.filter((t) => (t.name in CATALOG ? true : (console.warn(`launch: no tool "${t.name}" in this version; left out`), false))).map((t) =>
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
    env: (() => {
      const env: Record<string, string | undefined> = { MCP_TIMEOUT: '120000', ...baseEnv, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...publicGitEnvFor(spec, baseEnv), ...spec.env };
      // A vault GitHub token (GH_TOKEN): gh reads it itself; git gets a helper that reads it (githubCredentialEnv).
      return spec.env?.GH_TOKEN ? { ...env, ...githubCredentialEnv(env) } : env;
    })(),
    ...(spec.claudeExecutable ? { pathToClaudeCodeExecutable: spec.claudeExecutable } : {}),
  };
}
