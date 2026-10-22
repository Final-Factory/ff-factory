# The tool manifest (w1163)

**TL;DR:** `server/toolManifest.ts` lists every MCP tool FF Factory gives an agent, with its group, the kinds of agent that
have it, and the kinds that carry it in every call. The server builds each kind's tool list from it. A tool not carried in
every call is deferred: Claude Code lists its name, and `ToolSearch` loads it when needed, one tool (`select:<name>`) or a
whole group (`group_<group>`). Only the most used tools are carried in every call, chosen from measured use (below).

lothsahn, w1163: "Can we make a manifest for all tools, grouping them in reasonable groups, allowing you and the workers and
dispatcher to load the ones they need?  Only load the very most frequently used tools all the time?"

## What it holds

One entry per tool (`TOOL_MANIFEST`): `group`, `kinds` (who has it) and `always` (who carries it in every call). The kinds:

| Kind | Who | Its tools are built by | Deferral |
|---|---|---|---|
| `dispatcher` | the dispatcher | `beltFor('dispatcher')` (`server/belts.ts`), `Agents.orchestratorToolDefs` | `ToolSearch` on |
| `personal` | a person's own orchestrator | `beltFor('personal')`, `Agents.orchestratorToolDefs` | `ToolSearch` on |
| `remote` | a person's own Claude Code on `/mcp` | `beltFor('remote')` + `remoteToolSpecs` (`server/mcp.ts`) | the client's Claude Code decides; every tool is sent deferrable, with its hint |
| `ops` | the orchestration worker | `beltFor('ops')`, `Agents.opsOptions` | no `ToolSearch`: all 8 tools in every call |
| `worker` | a worker in a machine sandbox | `Agents.workerTools` → the launch spec's `machine` server (`server/launch.ts` `CATALOG`) | Claude Code's default (`ToolSearch` on) |
| `standing` | a standing agent with `delegate` | `StandingAgents.spec` | no `ToolSearch`: both tools in every call |

The groups (`TOOL_GROUPS`), picked from what the tools are used for together:

| Group | Tools |
|---|---|
| `core` | `read_rules`, `compact_conversation`, `message_person`, `ask_person` |
| `ledger` | `list_work`, `request_work`, `update_work`, `decide_work`, `conditional_decisions`, `read_work` |
| `workers` | `start_agent`, `message_agent`, `set_agent_title`, `interrupt_agent`, `stop_agent`, `agent_transcript`, `search_transcripts` |
| `sandboxes` | `list_sandboxes`, `create_sandbox`, `delete_sandbox`, `list_branches`, `switch_branch`, `unity`, `live_view` |
| `machines` | `list_machines`, `system_status`, `add_machine`, `set_machine_label`, `machine_daemon`, `convert_machine`, `relocate_machines`, `machine_cleanup`, `cleanup_log`, `remove_machine`, `host_recovery`, `ops_worker`, `portal_logs`, `build_plan` |
| `timers` | `wake_me`, `set_timer`, `list_timers`, `update_timer`, `cancel_timer`, `set_heartbeat`, `cancel_wake`, `blocked_on`, `waiting_on_person` |
| `ffbox` | `ffbox_activity`, `send_to_ffbox`, `reply_to_ffbox`, `fetch_ffbox_report`, `fetch_discord_thread_files`, `list_ffbox_files`, `fetch_ffbox_symbols` |
| `max` | `max_activity`, `post_as_max` |
| `spend` | `spend_report` |
| `admin` | `set_app_config`, `set_pool`, `request_app_update`, `republish_public` |
| `standing` | the standing-agent and delegation tools, `request_delegation`, `my_delegations` |
| `review` | `attach_review_file`, `publish_review`, `publish_attachment`, `fetch_attachment` |
| `chat` | `/mcp`'s `ask_orchestrator`, `orchestrator_transcript`, `orchestrator_send`, `orchestrator_inbox`, `orchestrator_attach` |

`set_label` is listed as retired (w575): in `CATALOG` so an old worker gets an answer, given to no kind.

## Loading a deferred tool: one, or a group

Both work with the Agent SDK as it is (0.3.284), no tool of our own:

- **One tool**: `ToolSearch` `select:<name>[,<name>]`, as since w1158.
- **A group**: every tool's `searchHint` is `group_<group>` (the SDK's `tool(…, { searchHint })`, sent as
  `_meta["anthropic/searchHint"]`; `/mcp` sends the same `_meta`). Claude Code's keyword search matches a query word
  against a tool's name, description and hint (read in the bundled CLI: name parts score 12, a hint 4, the description
  2), and `group_ledger` appears in no name or description, so `ToolSearch` `group_ledger` with `max_results 20` returns
  exactly that group. The default `max_results` is 5, too few for the larger groups; each brief says 20.

Each brief has one line (`deferredToolsLine`) naming both ways and the groups that hold a deferred tool of its kind.

Which one to use is the agent's call: `select:` for the tool or two it needs, a group when it needs several of one. A
group load carries the group's other tools until the next compaction. On workers' sessions (measured, below) a group
load would have cost about 8% less than single loads (119M against 130M token-equivalents, simulated), which is within
the guesses' error, so neither is preferred.

## Why these are carried in every call

### The model

Carrying a tool costs its definition in every API call. Deferring it costs, in each compaction window where it is used,
one extra API call (the lookup reads the whole context again) plus its definition for the rest of that window. Inputs:

- **Calls per tool**, measured: the coordinators' lifetime transcripts in `/srv/fff/data/transcripts`, counted by
  lothsahn's orchestrator on 2026-10-12 (dispatcher `f8862ae9`: 8,055 portal tool calls; lothsahn's `204dd77f`: 3,920;
  Ben's `303d4711`: 2,874); workers' Claude Code session files on BEAST (`~/.claude/projects/F--ffw-sandboxes-*`), last 8
  days: 179 sessions, 35,356 API calls.
- **Definition sizes**, measured in characters (`scripts/coordinatorContext.ts`); tokens are characters / 2.9, the ratio
  w1158 measured on the API.
- **Guesses**: a coordinator makes about 30 portal tool calls and 40 API calls per compaction window (compactAtTokens
  80k), and a lookup reads about 50k tokens; an output token costs about 50 cache-read tokens (list prices). The choice
  was checked at half and double those (15/20/40k and 60/80/60k): the tools below are the ones carried in all three.
  `read_rules` (new in w1158, no counts yet) is kept: each brief sends the coordinator to it.

### Dispatcher (share of its 8,055 portal calls, measured)

| Carried | Share | | Deferred | Share |
|---|---|---|---|---|
| `message_agent` | 22.6% | | `set_app_config` (4,266 tokens) | 1.5% |
| `start_agent` | 14.5% | | `ffbox_activity` (2,959 tokens) | 0.6% |
| `agent_transcript` | 12.6% | | `create_sandbox` | 0.5% |
| `decide_work` | 9.9% | | `set_timer`, `list_timers`, `update_timer`, `cancel_timer` | 1.1% together |
| `stop_agent` | 8.0% | | `delete_sandbox` | 0.1% |
| `list_work` | 4.0% | | `list_branches`, `set_agent_title` and the rest | among ~630 calls not counted one by one |
| `list_sandboxes` | 4.0% | | | |
| `wake_me` | 3.2% | | | |
| `switch_branch` | 2.9% | | | |
| `unity` | 1.9% | | | |
| `list_machines` | 1.4% | | | |
| `system_status` | 1.3% | | | |
| `search_transcripts` | 1.1% | | | |
| `interrupt_agent` | 0.5% | | | |
| `read_rules` | (no counts) | | | |

Against w1158's set: `agent_transcript`, `stop_agent`, `switch_branch`, `unity`, `search_transcripts` and
`interrupt_agent` added; `create_sandbox`, `list_branches` and `set_agent_title` deferred.

### A person's orchestrator (lothsahn's and Ben's together, 6,794 portal calls, measured)

| Carried | Share | | Deferred | Share |
|---|---|---|---|---|
| `message_agent` | 17.2% | | `ffbox_activity` (2,959 tokens) | 9.7% |
| `update_work` | 16.7% | | `ops_worker` (2,682 tokens) | 2.5% |
| `request_work` | 15.9% | | `reply_to_ffbox` | ~1.4% |
| `list_work` | 10.7% | | `list_sandboxes` | 1.1% |
| `agent_transcript` | 8.7% | | `set_timer` and the timers | 0.7% together |
| `search_transcripts` | 8.0% | | `spend_report`, `conditional_decisions` and the rest | among ~575 calls not counted one by one |
| `wake_me` | 1.4% | | | |
| `message_person` | ~1.4% | | | |
| `ask_person` (w1397) | no counts yet | | | |
| `max_activity` | ~1.4% | | | |
| `list_machines` | 1.2% | | | |
| `system_status` | 1.1% | | | |
| `read_rules` | (no counts) | | | |

`ask_person` is new (w1397): it is carried because the orchestrator's brief tells it to ask EVERY question to its person through it, so a deferred schema would cost a ToolSearch before each question; no call counts exist, the choice is a guess until they do.

`reply_to_ffbox`, `message_person` and `max_activity` were counted together (286 calls); the split in thirds is a guess.
`ffbox_activity` is the one close call: the model carries it in all three settings, but its calls are mostly lothsahn's
(530 of 662) and come in runs, so it is used in fewer windows than the model assumes, and it is the biggest tool after
`set_app_config`; it stays deferred until the transcripts after this change show how often it is looked up. `list_sandboxes`
is carried only at the larger setting, so it is deferred.

### Workers (BEAST, 179 sessions, measured)

Sessions that used each tool: `wake_me` 70%, `unity` 69%, `read_work` 62%, `publish_review` 48%, `blocked_on` 41%,
`switch_branch` 26%, every other under 9%. Workers already load their tools with `ToolSearch` (259 lookups) and mostly
several at once, Unity's own tools among them, so carrying any of ours saves few lookups: counting only the real
`select:` lookups a set would have made unnecessary, `wake_me` alone saves 3.4M token-equivalents and costs 6.4M; the six
most used save 16.3M and cost 105M. So workers carry none: every `machine` tool stays deferred, as before.

A worker's first call is 56.6k input tokens (median; 54.7k-59.6k p10-p90, measured), mostly Claude Code's preset, the
game repo's CLAUDE.md, the worker brief and the plugin skills' list; the `machine` tools were already deferred.

## The tests

`server/toolManifest.test.ts`:

- every tool `Agents.toolSpecs`, `remoteToolSpecs` and `CATALOG` register is in the manifest, and every tool the manifest
  gives a kind is registered;
- each kind gets exactly the tools it had before the manifest (`BEFORE`, the belts as built on w1158's head), and the gates
  hold (the dispatcher's user-asked tools still take `work_id`; the person-only tools stay off the dispatcher and `/mcp`);
- the always-carried set of each kind equals `ALWAYS` (pinned: a change edits the manifest, the test and this page's
  numbers), each coordinator tool's `_meta` says `alwaysLoad` only when the manifest does, every tool carries its group
  hint, and a kind with deferred tools has `ToolSearch` while one without it (ops) carries all of its tools.

The worker spec (`orchestrators.test.ts`) and the standing spec (`standing.test.ts`) are checked against the manifest
too. `server/coordinatorContext.test.ts` keeps w1158's size budget (always-carried tools at most 24,000 characters; the dispatcher's are 23,436).

## Changing it

- **A new tool**: add its entry (group, kinds) in the same change; the test fails until you do. A tool not in the manifest
  is the dispatcher's alone (`beltFor`), which is the safe way round.
- **Carrying a tool in every call**: only with counts (calls per kind, its size) that pass the model above; update
  `ALWAYS` in the test and the tables here.
- **Re-measuring**: count `"name":"mcp__sandboxes__<tool>","input"` lines per coordinator transcript (Grep with
  `output_mode: count`), and the `ToolSearch` lookups per deferred tool once this change has run a while: a deferred tool
  looked up in most compaction windows belongs in the carried set.
