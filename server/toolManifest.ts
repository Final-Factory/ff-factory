// Every MCP tool FF Factory gives an agent, in one place (w1163, docs/tool-manifest.md): its group, which kinds of
// agent have it, and for which of them it is loaded in every call. Everything else is deferred: Claude Code lists its
// name and loads its schema with ToolSearch, one tool (`select:<name>`) or a whole group (`group_<group>`, its search
// hint). The server builds each kind's tool list from here (server/belts.ts, Agents.machineSandboxSpec,
// StandingAgents.spec), and server/toolManifest.test.ts fails on a tool missing here or loaded in every call by accident.

/**
 * The kinds of agent, by the tools they are given. dispatcher, personal (a person's own orchestrator) and ops (the
 * orchestration worker) run in the portal; remote is a person's own Claude Code on /mcp (server/mcp.ts); worker is a
 * worker in a machine sandbox (its `machine` server, server/launch.ts CATALOG); standing is a standing agent.
 */
export const AGENT_KINDS = ['dispatcher', 'personal', 'remote', 'ops', 'worker', 'standing'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** The groups, each with what it is for (the brief names them; ToolSearch `group_<name>` loads one). */
export const TOOL_GROUPS = {
  core: 'your own conversation, rules and people',
  ledger: 'the work ledger',
  workers: 'workers: start, message, stop, read',
  sandboxes: 'sandboxes, branches, Unity editors',
  machines: 'computers, their daemons, clean-up, the portal',
  timers: 'check-ins, timers, waits',
  ffbox: 'FFBox, Discord bug threads, players\' reports',
  max: 'Max on Discord',
  spend: 'what work costs',
  admin: 'the portal\'s settings and updates',
  standing: 'standing agents and their delegations',
  review: 'review files and attachments',
  chat: 'a person\'s own orchestrator, from their Claude Code',
} as const;
export type ToolGroup = keyof typeof TOOL_GROUPS;

export interface ToolEntry {
  group: ToolGroup;
  /** The kinds that have it. */
  kinds: readonly AgentKind[];
  /**
   * The kinds that carry it in every call. Only the most used, by measurement (docs/tool-manifest.md "Why these"), and
   * every tool of a kind whose process has no ToolSearch (ops, standing): Claude Code sends all of those in full anyway.
   */
  always?: readonly AgentKind[];
  /** Kept so an old agent gets an answer; listed for no kind. */
  retired?: true;
}

const D = 'dispatcher', P = 'personal', R = 'remote', O = 'ops', W = 'worker', S = 'standing';

export const TOOL_MANIFEST = {
  // core
  read_rules: { group: 'core', kinds: [D, P, R], always: [D, P] },
  compact_conversation: { group: 'core', kinds: [D, P] },
  message_person: { group: 'core', kinds: [P], always: [P] },
  // ledger
  list_work: { group: 'ledger', kinds: [D, P, R], always: [D, P] },
  request_work: { group: 'ledger', kinds: [P], always: [P] },
  update_work: { group: 'ledger', kinds: [P], always: [P] },
  decide_work: { group: 'ledger', kinds: [D], always: [D] },
  conditional_decisions: { group: 'ledger', kinds: [P] },
  read_work: { group: 'ledger', kinds: [W] },
  // workers
  start_agent: { group: 'workers', kinds: [D, R], always: [D] },
  message_agent: { group: 'workers', kinds: [D, P, R], always: [D, P] },
  set_agent_title: { group: 'workers', kinds: [D, R], always: [D] },
  interrupt_agent: { group: 'workers', kinds: [D, R] },
  stop_agent: { group: 'workers', kinds: [D, R] },
  agent_transcript: { group: 'workers', kinds: [D, P, R], always: [P] },
  search_transcripts: { group: 'workers', kinds: [D, P, R] },
  // sandboxes
  list_sandboxes: { group: 'sandboxes', kinds: [D, P, R, O], always: [D, P, O] },
  create_sandbox: { group: 'sandboxes', kinds: [D, R], always: [D] },
  delete_sandbox: { group: 'sandboxes', kinds: [D, R] },
  list_branches: { group: 'sandboxes', kinds: [D, P, R], always: [D] },
  switch_branch: { group: 'sandboxes', kinds: [D, R, W] },
  unity: { group: 'sandboxes', kinds: [D, R, W] },
  // machines
  list_machines: { group: 'machines', kinds: [D, P, R, O], always: [D, P, O] },
  system_status: { group: 'machines', kinds: [D, P, R, O], always: [D, P, O] },
  add_machine: { group: 'machines', kinds: [D, R] },
  set_machine_label: { group: 'machines', kinds: [D, R] },
  machine_daemon: { group: 'machines', kinds: [D, R] },
  convert_machine: { group: 'machines', kinds: [D, R] },
  relocate_machines: { group: 'machines', kinds: [D, R] },
  machine_cleanup: { group: 'machines', kinds: [D, R] },
  cleanup_log: { group: 'machines', kinds: [D, R] },
  remove_machine: { group: 'machines', kinds: [D, R] },
  host_recovery: { group: 'machines', kinds: [D, R] },
  ops_worker: { group: 'machines', kinds: [P] },
  portal_logs: { group: 'machines', kinds: [W] },
  // timers
  wake_me: { group: 'timers', kinds: [D, P, R, O, W], always: [D, P, O] },
  set_timer: { group: 'timers', kinds: [D, P, R, O], always: [O] },
  list_timers: { group: 'timers', kinds: [D, P, R, O], always: [O] },
  update_timer: { group: 'timers', kinds: [D, P, R, O], always: [O] },
  cancel_timer: { group: 'timers', kinds: [D, P, R, O], always: [O] },
  set_heartbeat: { group: 'timers', kinds: [P, R] },
  cancel_wake: { group: 'timers', kinds: [W] },
  blocked_on: { group: 'timers', kinds: [W] },
  waiting_on_person: { group: 'timers', kinds: [W] },
  // ffbox
  ffbox_activity: { group: 'ffbox', kinds: [D, P, R] },
  send_to_ffbox: { group: 'ffbox', kinds: [D] },
  reply_to_ffbox: { group: 'ffbox', kinds: [P] },
  fetch_ffbox_report: { group: 'ffbox', kinds: [W] },
  fetch_discord_thread_files: { group: 'ffbox', kinds: [W] },
  // max
  max_activity: { group: 'max', kinds: [D, P, R] },
  post_as_max: { group: 'max', kinds: [W] },
  // spend
  spend_report: { group: 'spend', kinds: [D, P, R] },
  // admin
  set_app_config: { group: 'admin', kinds: [D, P, R] },
  request_app_update: { group: 'admin', kinds: [D, R] },
  republish_public: { group: 'admin', kinds: [D, R] },
  // standing
  list_standing_agents: { group: 'standing', kinds: [D, P, R] },
  create_standing_agent: { group: 'standing', kinds: [D, R] },
  update_standing_agent: { group: 'standing', kinds: [D, R] },
  run_standing_agent_now: { group: 'standing', kinds: [D, R] },
  stop_standing_agent_run: { group: 'standing', kinds: [D, R] },
  pause_standing_agent: { group: 'standing', kinds: [D, R] },
  resume_standing_agent: { group: 'standing', kinds: [D, R] },
  delete_standing_agent: { group: 'standing', kinds: [D, R] },
  list_delegation_requests: { group: 'standing', kinds: [D, P, R] },
  approve_delegation: { group: 'standing', kinds: [D, P, R] },
  reject_delegation: { group: 'standing', kinds: [D, R] },
  request_delegation: { group: 'standing', kinds: [S], always: [S] },
  my_delegations: { group: 'standing', kinds: [S], always: [S] },
  // review
  attach_review_file: { group: 'review', kinds: [D, P, R] },
  publish_review: { group: 'review', kinds: [W] },
  publish_attachment: { group: 'review', kinds: [W] },
  fetch_attachment: { group: 'review', kinds: [W] },
  // chat
  ask_orchestrator: { group: 'chat', kinds: [R] },
  orchestrator_transcript: { group: 'chat', kinds: [R] },
  orchestrator_send: { group: 'chat', kinds: [R] },
  orchestrator_inbox: { group: 'chat', kinds: [R] },
  orchestrator_attach: { group: 'chat', kinds: [R] },
  // retired (w575): sandbox labels are their names
  set_label: { group: 'core', kinds: [], retired: true },
} as const satisfies Record<string, ToolEntry>;

export type ManifestTool = keyof typeof TOOL_MANIFEST;

const entry = (name: string): ToolEntry | undefined => (Object.hasOwn(TOOL_MANIFEST, name) ? (TOOL_MANIFEST as Record<string, ToolEntry>)[name] : undefined);

/** Whether the manifest lists it. */
export const inManifest = (name: string): boolean => entry(name) !== undefined;

/** A kind's tools, in the manifest's order. */
export function toolsOf(kind: AgentKind): ManifestTool[] {
  return (Object.keys(TOOL_MANIFEST) as ManifestTool[]).filter((n) => entry(n)!.kinds.includes(kind));
}

/** Whether a kind's agent has the tool. */
export const hasTool = (kind: AgentKind, name: string): boolean => entry(name)?.kinds.includes(kind) ?? false;

/** Whether a kind carries the tool in every call rather than finding it with ToolSearch. */
export const alwaysLoaded = (kind: AgentKind, name: string): boolean => entry(name)?.always?.includes(kind) ?? false;

/** Its ToolSearch hint: a keyword search for `group_<group>` returns the whole group. */
export const searchHintOf = (name: string): string | undefined => {
  const e = entry(name);
  return e ? `group_${e.group}` : undefined;
};

/** The SDK's per-tool extras for a kind (`tool(name, description, schema, handler, extras)`). */
export function sdkExtras(kind: AgentKind, name: string): { alwaysLoad?: true; searchHint?: string } {
  const hint = searchHintOf(name);
  return { ...(alwaysLoaded(kind, name) ? { alwaysLoad: true as const } : {}), ...(hint ? { searchHint: hint } : {}) };
}

/** The same, as MCP `_meta` (Claude Code reads `anthropic/alwaysLoad` and `anthropic/searchHint`), for /mcp's tools. */
export function mcpMeta(kind: AgentKind, name: string): Record<string, unknown> | undefined {
  const x = sdkExtras(kind, name);
  const meta: Record<string, unknown> = { ...(x.alwaysLoad ? { 'anthropic/alwaysLoad': true } : {}), ...(x.searchHint ? { 'anthropic/searchHint': x.searchHint } : {}) };
  return Object.keys(meta).length ? meta : undefined;
}

/** The groups that hold a deferred tool of this kind, for its brief: `ledger, workers, …`. */
export function deferredGroups(kind: AgentKind): ToolGroup[] {
  const groups = new Set<ToolGroup>();
  for (const n of toolsOf(kind)) if (!alwaysLoaded(kind, n)) groups.add(entry(n)!.group);
  return (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((g) => groups.has(g));
}

/** One line for a brief: how to load a deferred tool, one or a whole group. */
export function deferredToolsLine(kind: AgentKind, which = 'The portal tools you use less are'): string {
  return `${which} deferred: their names are listed, and ToolSearch loads them before you call one: \`select:<name>[,<name>]\` for the ones you need, or \`group_<group>\` with max_results 20 for a whole group when you need several of it (${deferredGroups(kind).join(', ')}).`;
}
