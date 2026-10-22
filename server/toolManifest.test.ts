import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCoordinators } from '../scripts/coordinatorContext.ts';
import { USER_ASKED_TOOLS, beltFor } from './belts.ts';
import { CATALOG } from './launch.ts';
import { AGENT_KINDS, TOOL_GROUPS, TOOL_MANIFEST, alwaysLoaded, deferredGroups, deferredToolsLine, mcpMeta, toolsOf, type AgentKind, type ToolEntry } from './toolManifest.ts';
import type { Agents } from './agents.ts';
import type { Requester, SessionInfo } from '../shared/types.ts';

/**
 * The tool manifest (w1163, server/toolManifest.ts, docs/tool-manifest.md): every MCP tool FF Factory gives an agent, its
 * group, which kinds have it and which carry it in every call. These tests fail on a tool registered but not listed, on a
 * tool loaded in every call that the manifest does not say so for, and on a kind that lost a tool it had before w1163.
 */

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const M = TOOL_MANIFEST as Record<string, ToolEntry>;

/**
 * Each kind's tools as the server built them before the manifest (measured on PR #364's head, 2026-10-12, with
 * scripts/coordinatorContext.ts's world): the manifest must give every kind exactly these, no tool or gate lost. A
 * change to a belt edits the manifest and this list together.
 */
const BEFORE: Record<AgentKind, string[]> = {
  dispatcher:
    'add_machine agent_transcript approve_delegation attach_review_file build_plan cancel_timer cleanup_log compact_conversation convert_machine create_sandbox create_standing_agent decide_work delete_sandbox delete_standing_agent ffbox_activity host_recovery interrupt_agent list_branches list_delegation_requests list_machines list_sandboxes list_standing_agents list_timers list_work machine_cleanup machine_daemon max_activity message_agent pause_standing_agent read_rules reject_delegation relocate_machines remove_machine republish_public request_app_update resume_standing_agent run_standing_agent_now search_transcripts send_to_ffbox set_agent_title set_app_config set_machine_label set_timer spend_report start_agent stop_agent stop_standing_agent_run switch_branch system_status unity update_standing_agent update_timer wake_me'.split(' '),
  personal:
    'agent_transcript approve_delegation ask_person attach_review_file cancel_timer compact_conversation conditional_decisions ffbox_activity list_branches list_delegation_requests list_machines list_sandboxes list_standing_agents list_timers list_work max_activity message_agent message_person ops_worker post_as_max read_rules reply_to_ffbox request_work search_transcripts set_app_config set_heartbeat set_pool set_timer spend_report system_status update_timer update_work wake_me'.split(' '),
  remote:
    'add_machine agent_transcript approve_delegation ask_orchestrator attach_review_file cancel_timer cleanup_log convert_machine create_sandbox create_standing_agent delete_sandbox delete_standing_agent ffbox_activity host_recovery interrupt_agent list_branches list_delegation_requests list_machines list_sandboxes list_standing_agents list_timers list_work machine_cleanup machine_daemon max_activity message_agent orchestrator_attach orchestrator_inbox orchestrator_send orchestrator_transcript pause_standing_agent read_rules reject_delegation relocate_machines remove_machine republish_public request_app_update resume_standing_agent run_standing_agent_now search_transcripts set_agent_title set_app_config set_heartbeat set_pool set_machine_label set_timer spend_report start_agent stop_agent stop_standing_agent_run switch_branch system_status unity update_standing_agent update_timer wake_me'.split(' '),
  ops: 'cancel_timer list_machines list_sandboxes list_timers set_timer system_status update_timer wake_me'.split(' '),
  worker: 'blocked_on build_plan cancel_wake fetch_attachment fetch_discord_thread_files fetch_ffbox_report fetch_ffbox_symbols file_ffbox_symbols list_ffbox_files live_view portal_logs post_as_max publish_attachment publish_review read_rules read_work switch_branch unity waiting_on_person wake_me'.split(' '),
  standing: ['my_delegations', 'request_delegation'],
};

/**
 * What each kind carries in every call, chosen by measured use (docs/tool-manifest.md "Why these"). Pinned here so that a
 * tool cannot become always-loaded by accident: adding one edits the manifest, this list and the doc's numbers.
 */
const ALWAYS: Record<AgentKind, string[]> = {
  dispatcher: ['agent_transcript', 'decide_work', 'interrupt_agent', 'list_machines', 'list_sandboxes', 'list_work', 'message_agent', 'read_rules', 'search_transcripts', 'start_agent', 'stop_agent', 'switch_branch', 'system_status', 'unity', 'wake_me'],
  personal: ['agent_transcript', 'ask_person', 'list_machines', 'list_work', 'max_activity', 'message_agent', 'message_person', 'read_rules', 'request_work', 'search_transcripts', 'system_status', 'update_work', 'wake_me'],
  remote: [],
  // No ToolSearch in these processes: Claude Code sends every tool in full, so the manifest says so.
  ops: BEFORE.ops,
  worker: [],
  standing: BEFORE.standing,
};

/** Each kind's tool names as the server builds them now, and the coordinators' SDK definitions. */
function built(agents: Agents, kinds: [string, SessionInfo][]) {
  const info = (k: string) => kinds.find(([name]) => name.startsWith(k))![1];
  const remote = [...beltFor('remote', agents.toolSpecs('human', agents.fixedActor(BEN), { role: 'remote', owner: BEN })), ...agents.remoteToolSpecs('test', BEN, { who: BEN, keyName: 'test', bound: true } as never)];
  return {
    names: {
      dispatcher: agents.orchestratorBelt(info('dispatcher')).map((t) => t.name),
      personal: agents.orchestratorBelt(info('owner (Ben)')).map((t) => t.name),
      remote: remote.map((t) => t.name),
      ops: beltFor('ops', agents.toolSpecs('orchestrator', agents.dispatcherActor, { role: 'ops', sessionId: 'ops-worker' })).map((t) => t.name),
    } as Record<'dispatcher' | 'personal' | 'remote' | 'ops', string[]>,
    every: [...agents.toolSpecs().map((t) => t.name), ...remote.map((t) => t.name), ...Object.keys(CATALOG)],
    defs: { dispatcher: agents.orchestratorToolDefs(info('dispatcher')), personal: agents.orchestratorToolDefs(info('owner (Ben)')) },
    options: { dispatcher: agents.orchestratorOptions(info('dispatcher')), personal: agents.orchestratorOptions(info('owner (Ben)')), ops: agents.opsOptions({ ...info('dispatcher'), requestedBy: BEN }) },
  };
}

const sorted = (a: Iterable<string>) => [...a].sort();

test('w1163: every tool the server registers is in the manifest, and the manifest lists none that nothing registers', async () => {
  await withCoordinators((agents, kinds) => {
    const b = built(agents, kinds);
    for (const name of new Set(b.every)) assert.ok(Object.hasOwn(M, name), `${name} is registered but not in server/toolManifest.ts: give it a group and its kinds`);
    for (const [name, e] of Object.entries(M)) {
      assert.ok(e.retired || e.kinds.length > 0, `${name}: a tool with no kind is retired`);
      assert.ok(Object.hasOwn(TOOL_GROUPS, e.group), `${name}: its group ${e.group} is a group`);
      for (const k of e.always ?? []) assert.ok(e.kinds.includes(k), `${name}: always-loaded for ${k}, which does not have it`);
    }
    // The coordinators' and /mcp's tools come from Agents.toolSpecs, the workers' and standing agents' from CATALOG.
    for (const name of [...toolsOf('worker'), ...toolsOf('standing')]) assert.ok(name in CATALOG, `${name}: a worker's or standing agent's tool needs a CATALOG schema (server/launch.ts)`);
    for (const name of ['dispatcher', 'personal', 'remote', 'ops'] as const) for (const t of toolsOf(name)) assert.ok(b.every.includes(t), `${t}: listed for ${name} but registered nowhere`);
  });
});

test('w1163: each kind still has every tool it had before the manifest, and only those', async () => {
  await withCoordinators((agents, kinds) => {
    const b = built(agents, kinds);
    for (const k of AGENT_KINDS) assert.deepEqual(sorted(toolsOf(k)), sorted(BEFORE[k]), `the manifest's ${k} tools`);
    for (const k of ['dispatcher', 'personal', 'remote', 'ops'] as const) assert.deepEqual(sorted(b.names[k]), sorted(BEFORE[k]), `${k}: the tools the server builds`);
    // The gates stay: the dispatcher's user-asked tools still take the work_id their guard reads, a person's own tools stay theirs.
    const disp = agents.orchestratorBelt(kinds.find(([n]) => n === 'dispatcher')![1]);
    for (const t of disp.filter((x) => USER_ASKED_TOOLS.has(x.name))) assert.ok('work_id' in t.schema, `${t.name}: still gated on who asked (work_id)`);
    for (const t of ['request_work', 'update_work', 'conditional_decisions', 'message_person', 'reply_to_ffbox', 'ops_worker', 'set_heartbeat']) assert.ok(!b.names.dispatcher.includes(t), `the dispatcher has no ${t}`);
    for (const t of ['decide_work', 'send_to_ffbox', 'compact_conversation']) assert.ok(!b.names.remote.includes(t), `an /mcp key has no ${t}`);
  });
});

test('w1163: only the manifest makes a tool load in every call, and every tool carries its group as ToolSearch hint', async () => {
  for (const k of AGENT_KINDS) assert.deepEqual(sorted(toolsOf(k).filter((t) => alwaysLoaded(k, t))), sorted(ALWAYS[k]), `${k}: the always-loaded set changed; update docs/tool-manifest.md with the measurement behind it`);
  await withCoordinators((agents, kinds) => {
    const b = built(agents, kinds);
    for (const role of ['dispatcher', 'personal'] as const) {
      for (const d of b.defs[role]) {
        assert.equal(!!d._meta?.['anthropic/alwaysLoad'], alwaysLoaded(role, d.name), `${role}: ${d.name} loads in every call only if the manifest says so`);
        assert.equal(d._meta?.['anthropic/searchHint'], `group_${M[d.name].group}`, `${role}: ${d.name}'s hint`);
      }
      const o = b.options[role] as { tools: string[] };
      assert.ok(o.tools.includes('ToolSearch'), `${role}: has deferred tools, so it needs ToolSearch`);
    }
    // No ToolSearch for the ops worker: then the manifest must say all of its tools load in every call.
    assert.ok(!(b.options.ops as { tools: string[] }).tools.includes('ToolSearch'));
    for (const t of b.names.ops) assert.ok(alwaysLoaded('ops', t), `ops: ${t}`);
    for (const t of b.names.remote) assert.deepEqual(mcpMeta('remote', t), { 'anthropic/searchHint': `group_${M[t].group}` }, `remote: ${t} is deferred, with its hint`);
  });
});

test('w1163: each brief names the groups it can load, and only groups that hold a deferred tool of its kind', () => {
  assert.deepEqual(deferredGroups('ops'), [], 'the ops worker defers nothing');
  for (const k of ['dispatcher', 'personal', 'worker'] as const) {
    const line = deferredToolsLine(k);
    assert.match(line, /`select:<name>\[,<name>\]`/);
    assert.match(line, /`group_<group>` with max_results 20/);
    for (const g of deferredGroups(k)) assert.ok(toolsOf(k).some((t) => M[t].group === g && !alwaysLoaded(k, t)), `${k}: ${g}`);
  }
  assert.ok(!deferredGroups('personal').includes('chat'), "a person's orchestrator has no chat tools");
});

test('w1163: the dispatcher and a person\'s orchestrator say how to load a deferred tool or a group', async () => {
  await withCoordinators((agents, kinds) => {
    for (const [kind, info] of kinds) {
      const prompt = (agents.orchestratorOptions(info) as { systemPrompt: { append: string } }).systemPrompt.append;
      assert.ok(prompt.includes(deferredToolsLine(kind === 'dispatcher' ? 'dispatcher' : 'personal')), kind);
    }
  });
});
