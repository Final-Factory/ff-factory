# What a worker reads before it does anything: the base context, part by part (w1479)

lothsahn, 2026-10-18: "Parallel to that, can we analyze the base instructions to figure out why they're so long?"

**TL;DR:** a fresh worker's first model call on beast is now **53.5k tokens** (measured), of which the brief is about 4.0k, so
the base is about **49.5k** (it was 56.2k before w1469's trims). Five parts make up 89% of it: CLAUDE.md about 13.0k, the
tool definitions 11.6k (PowerShell alone 4.3k), FF Factory's worker prompt 9.8k, the skill listing 7.3k and the agent listing
2.6k. Real duplicates within a part are few (the no-decision PRs below remove about 0.2k, and the ci-release guard they
restore adds about 0.1k back). Most of the size is rules every call carries for
rare cases, plus Claude Code features workers never use. The decision list at the end would take the base to about 32k
(estimated, arithmetic below).

## How it was measured (repeat it this way)

Claude Code's own transcripts (`~/.claude/projects/<cwd>/<session>.jsonl`) hold everything a call carried:
- the `prompt_snapshot` attachment: `systemPrompt` (its blocks) and `tools` (each definition, as sent);
- the first user message's attachments: `instructions` (CLAUDE.md), `skill_listing`, `agent_listing_delta`,
  `deferred_tools_delta`, `mcp_instructions_delta`, `session_context`, `environment` and the others;
- per call, `usage`: `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` (exact, the API's).

Token counts per part come from **cache boundaries** (exact), not from a tokenizer:
- A worker's first call reads a prefix that is cached across all sessions: the tools plus the static system block. It is
  **12,137 tokens** after ff-factory #425, against 17,275 before (sessions 671ed9bf and e1ac20aa, 2026-10-18, measured). The
  difference, **5,138 tokens**, is the three tools #425 removed (22,485 characters, so 4.38 characters a token for tool schemas).
- A second worker started in the same sandbox and branch reads the first one's prefix up to the end of the system prompt:
  **23,637 tokens** (session f3f999a3 reading 671ed9bf's, measured). So the system prompt after the static block, Claude Code's
  dynamic sections plus FF Factory's worker prompt, is 23,637 − 12,137 = **11,500 tokens** (32,957 characters, 2.87 a token).
- The rest of the first call, **29,872 tokens**, is the first message: CLAUDE.md, the listings, the reminders and the brief
  (about 77k characters, 2.58 a token).
- Inside each of those three parts, a section's tokens are its measured characters at that part's ratio (estimated).

Use and non-use come from counting `tool_use` blocks and `Skill` / `Agent` inputs in beast's worker transcripts of
2026-10-11..18: 303 transcript files, 35,705 Bash calls (measured).

## The ranked table

Tokens are per model call; a worker makes about 209 calls a session (w1469, measured). "Every call?" says whether a worker
needs the text in front of it on every call, or only in the case named.

| # | Section | Tokens | What it is for | Every call? | Verdict | Rests on |
|---|---|---|---|---|---|---|
| 1 | **CLAUDE.md** (game repo, 33,488 chars; no nested CLAUDE.md, no @-includes: `git ls-tree -r HEAD` and `grep '@'`) | 12,980 | the repo's binding rules for every agent: Claude Code, Codex, interactive and workers | part | **shorten / move to on-demand** (D8) | section sizes below; w1469's lever 4 "reading CLAUDE.md in sections" (lothsahn, 2026-10-18) |
| 1a | └ Build & Test | 4,057 | editor channel, compile ritual, tests, video for visuals, shader usage, UI gate and layout rules, player slots, CI, merge gate, releases | no: UI (2,765 chars), visual (922), shader (554), releases (1,127), player launch (718) are per-task | move the per-task bullets to their skills, a one-line pointer each | the skills already hold the procedures: unity-ui, watch-video, evidence-gate, ci-release |
| 1b | └ Architecture | 1,565 | assemblies, determinism, sim vs presentation, trunk | mostly yes (simulation work) | keep; the trunk bullet deduped (FinalFactory #1926) | |
| 1c | └ Delegation agents | 1,242 | when and to whom to delegate | yes (Claude part); no (Codex part, 341) | move the Codex bullet to `Documentation/Agent-Delegation.md` | Claude Code workers never use Codex dispatch |
| 1d | └ Shared agent guidance | 1,141 | single source, skills repo, lessons, plugin names, handoffs | lessons yes; plugin naming (390) and handoffs (329) no | move those two to publish-skills / handoff | handoffs: a worker gets a fresh session per request (server/work.ts `handoverNote`) |
| 1e | └ Command execution and approvals | 787 | run commands yourself; temp files; Codex config | Codex bullet (452) never for Claude | move the Codex bullet beside `.codex/config.toml`'s docs | |
| 1f | └ the rest (multiplayer, toggles, saves, evidence, Ben, specs, key files, Discord, modding) | 3,970 | hard rules | mostly; specs block (445) and modding (187) are per-task | keep; specs block to the speckit skills | |
| 2 | **Tool definitions**, loaded (12 tools, 49,391 chars) | 11,573 | Claude Code's own tools | part | | |
| 2a | └ PowerShell | 4,329 | a second shell on Windows | no: 226 calls against Bash's 35,705 (0.6%) | **drop for workers** (D2) | measured counts; the probe below: with it off Bash's own text shrinks 250 chars, nothing grows |
| 2b | └ ReportFindings | 687 | the code-review report tool | no: 0 calls | **drop for workers** (D4) | measured |
| 2c | └ Agent, Bash, Grep, Skill, ToolSearch, Read, ListAgents, Edit, Write, Glob | 6,557 | the working tools | yes (Glob: 15 calls; keep, it is small) | keep | |
| 3 | **FF Factory's worker prompt** (`server/agents.ts` `machineSandboxBrief`, 27,984 chars) | 9,751 | how a worker lives in FF Factory | part | shorten, move rare parts on-demand (D6) | sections below |
| 3a | └ Disk space (`DISK_HYGIENE`) | 1,723 | temp folder, what the harness removes, the one free delete | the core yes; the clean-up-request rules (~1,950 chars: w1379, w1387, ff-leftovers folders) only on a clean-up request | move the clean-up-request half on-demand | about 1 request in 100 is a clean-up (guess) |
| 3b | └ header bullets (sandbox, worktree, title, account, two GitHub lines, protected, machine steps, tools) | 1,496 | identity and limits | yes | the two GitHub lines deduped (this PR) | |
| 3c | └ Attachments | 583 | Inbox files; saves folder per OS | the save-path paragraph (~800 chars) only when loading a save | move it to drive-game, where loading a save is | |
| 3d | └ Discord | 577 | FFBox owns the channels; Discord:/Report: lines; post_as_max | the PR lines only on a bug fix | dedupe against CLAUDE.md (D7): keep the message-link form, the `Report:` line and the two tool names | quoted below |
| 3e | └ Git | 573 | branches, trunk, merge | yes | deduped (this PR) | |
| 3f | └ Waiting on CI / other / person / later | 1,502 | which wait tool, and never poll | yes (most turns end in a wait) | keep; the CI line deduped (this PR) | |
| 3g | └ Unity | 692 | its editor, slots, pinning | yes when the task uses Unity; clear_batch detail is rare | keep the core; clear_batch to the tool's description | the `unity` tool text already says it |
| 3h | └ Shell steps, Processes, Evidence, Your PRs, Reporting, Ledger, Portal logs | 2,605 | | yes, except game_data.py (Shell steps, ~460 chars: tests that touch saves or settings) and portal logs (264: the tool text says it) | keep; Shell steps' repeat of Disk space removed (this PR) | |
| 4 | **Skill listing** (48 skills, 18,738 chars) | 7,263 | which skill to load | part | | |
| 4a | └ Claude Code's bundled skills (dataviz, claude-api, code-review, simplify, update-config, loop, schedule, workflow-authoring, run, plugin-authoring, keybindings-help, fewer-permission-prompts, init, security-review) | 2,558 | Claude Code's own | no: **0 invocations** | **hide from workers** (D1) | measured counts; `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` removes them (probe) |
| 4b | └ ff-speckit (10 skills) | 535 | the spec flow | no: 2 invocations in 303 sessions | hide (D1) | lothsahn already chose "no ff-speckit for workers" (w1469, 2026-10-18); not built yet |
| 4c | └ synced user skills (code-review-sonnet, unity-mcp-skill) | 410 | | no: 0; code-review-sonnet needs Workflow, which #425 took away | hide (D1) | |
| 4d | └ ff-agents (22 skills) | 3,760 | the project's skills | yes, but handoff, resumeFromHandoff, honest-coop-play, massdriver-visual-e2e, mp-beta-deploy, steam-upload (2,514 chars) had 0 uses | hide those six from workers (D10) | measured |
| 5 | **Agent listing** (15 roles, 6,591 chars) | 2,555 | which subagent to spawn | part | | |
| 5a | └ built-in claude, Explore, Plan, statusline-setup | 444 | Claude Code's own | no: 0 spawns (ff-agents:Explore shadows Explore) | hide (D5) | measured: 108 spawns, 62 of them code-analyst |
| 6 | **Brief** (the first message's text) | 3,963 | the request | yes | shorten the harness parts (D9) | |
| 6a | └ "The request as filed" | 1,277 | the person's own words, when the dispatcher's brief paraphrases | only when the brief does not quote them | add only when the brief does not hold the person's quote | w1479's brief quotes lothsahn and repeats the goal |
| 6b | └ Request/DONE/Learned rules (`requestLineRule`, `doneRule`) | 675 | how to link a PR and close | yes | dedupe with CLAUDE.md "Before every DONE" (D9) | quoted below |
| 6c | └ Handover | 511 | fresh session, related requests | yes | keep | |
| 7 | **Claude Code's system prompt** (sys blocks 0 and 2..10) | 2,333 | Claude Code's behaviour | part | | |
| 7a | └ # Memory | 731 | Claude Code's auto memory | no: CLAUDE.md overrides it ("This overrides any default memory-saving behavior, including a harness instruction to write memory files"), and beast's memory folders are empty | **turn off for workers** (D3) | probe: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` removes the section |
| 7b | └ ultrareview guidance, WebSearch mode, models, pronouns, actions, context | 1,038 | Claude Code's | ultrareview (232) never applies to a worker | keep (Claude Code's own; no switch found) | |
| 8 | UnityMCP server instructions | 803 | the bridge's own usage notes | when the task uses Unity | keep (they come from the mcp-for-unity package) | |
| 9 | Deferred tool names (81: 37 UnityMCP, 15 machine, 29 Claude Code) | 770 | names to ToolSearch | yes | keep; Cron*, Enter/ExitWorktree, Enter/ExitPlanMode, DesignSync, PushNotification, RemoteTrigger, NotebookEdit, LSP had 0 calls (about 120 tokens) | measured |
| 10 | gitStatus, email, attribution, environment, model, bypass note, date, headers | ~1,540 | Claude Code's context | yes | keep | remainder of the measured 29,872 |
| 11 | **Per-turn reminders** (in the history, not the base) | ~20 a call each, piling up | `total_tokens` countdown on every call (16,709 of 16,995 calls), "hasn't heard from you" (1,449), file-change notes | no | **off for workers** (w2002): `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off`, the switch Claude Code 2.1.284 reads first (its modes: off, infinite, fixed, countdown, padded-countdown; the default counts down from 15,000,000) | w1469's 62 sessions, measured; the switch read from the CLI and probed |
| 12 | **CLAUDE.md re-injected** into the history | ~13k each time | Claude Code re-sends CLAUDE.md when it changes on disk (a merge, a branch switch) or after a compaction | | a shorter CLAUDE.md shrinks each one | 55 re-injections in 62 sessions, 12 of 29 recent ones identical to the last (w1469's `instr.py`, measured) |

## Duplicated text

Within one part, removed by the no-decision PRs (each rule stays, said once):
- Worker prompt, Shell steps: "Never delete in $TMPDIR to reuse a folder: a new `$TMPDIR/<leg>-<timestamp>` per leg (Disk space above). If a delete
  does end up in a longer command, the session answers it itself only when its every path is written out under $TMPDIR." Disk
  space already says: "never delete in your temp folder to reuse a folder for the next test leg; give every leg a new one" and "a
  delete whose every path is written out under $TMPDIR is answered by the session itself with no approval, alone or inside a
  longer command".
- Worker prompt, Your pull requests: "the game repo's master takes changes only through your pull request (`gh pr create --base
  master`, then `gh pr merge <n> --merge`), never a direct push (w1137: master is the one trunk, develop is retired)". Git: "master
  takes no direct push ... open a PR into master (`gh pr create --base master`), and merge it (`gh pr merge <n> --merge`)".
- Worker prompt, Waiting on CI: "in the game repo, green is its required `Test in editmode` check, and the whole suite runs after
  the merge in the master batch". Your pull requests: "In the game repo that is its required `Test in editmode` check ...; the whole
  suite runs after the merge in the master batch".
- Worker prompt, the two GitHub lines: "this run's gh and git push use <token> from the vault" and "your gh and git push act as the
  token <token> from the vault (GH_TOKEN)"; "Never print a token" and "Never print it".
- CLAUDE.md: the master-trunk bullet restated "Merge your own PR", "Master takes changes only through a PR" and the toggle
  section's heading; "Merge your own PR" restated Releases' "a release to players is Ben or Lothsahn moving them by hand"
  (FinalFactory #1926).
- ci-release's description restated CLAUDE.md's Releases bullet word for word ("A version bump merged into master IS a dev build",
  "Nothing sets `pre-release` or the default branch") (final-factory-agents #244).

Across parts (each worker reads both; removing one copy is a decision, D7 and D9):
- **Discord.** Worker prompt (w1640): "#bug-reports and dev_bug_reports belong to FFBox: read their threads and download their
  files freely; never react, rename or close there or post with `ffdiscord`. When your work calls for a word to a reporter
  (asking for their save), post it through FFBox with `post_as_max` channel `conversation`." CLAUDE.md: "Agents outside an
  FFBox turn read their threads and download files, and never post, reply, react, rename or close there (`ffdiscord` refuses
  them" (the game repo's copy follows w1640 in its own PR). Worker: "When you merge
  or land an `ffbox/*` branch or PR (a `review/*` rebase included), never post a "fixed" or "merged" notice to the reporter, in any
  channel or as Max: FFBox sees the merge and posts it itself." CLAUDE.md: "Merging or landing an `ffbox/*` branch or PR (a
  `review/*` rebase included) is never followed by a "fixed" or "merged" post, in any channel FFBox watches or as Max: FFBox sees the
  merge and posts it itself." Both carry the `Discord: https://discord.com/channels/<guild id>/<thread id>` line rule. (About 245
  tokens twice; tests pin the worker copy: `intakeFlow.test.ts:208`.)
- **Evidence.** Worker: "Before anything that spends money, publishes or sends something outside, changes a live setting, releases,
  merges a simulation or player-visible change, or deletes, and before you report a fix as done: ... what each rests on: measured
  ..., sourced ..., or a guess." CLAUDE.md: "Before anything that spends money, publishes, changes a live setting, releases, merges a
  simulation or player-visible change, or deletes, and before reporting a fix as done: say what each choice or claim rests on
  (measured, sourced or guess)". Both: "Ask ... only to confirm a money value, for what the rules already reserve ..., or at a real
  fork." The evidence-gate skill's description says it a third time.
- **Merge your own PR.** Worker MERGE_RULES: "Never stop at an open PR waiting for the user. Hold one only for exceptional risk or a
  concrete timing reason, and say in your report which it is and when it will merge." CLAUDE.md: "Don't stop at an open PR waiting
  for him. Hold one only for exceptional risk or a concrete timing reason, and say which it is and when it will merge."
- **Temp files.** Worker Disk space: "Leave it there: do not clean up after yourself (lothsahn, 2026-10-10, w913: "Random clean up
  commands take a lot of approvals")". CLAUDE.md: "Leave temp files in `$TMPDIR`; the harness removes them (lothsahn, 2026-10-10,
  w913: "Random clean up commands take a lot of approvals")". The CLAUDE.md bullet speaks of FF Factory's own sweep, so it is a
  worker rule in the file every agent reads.
- **DONE and Learned.** Brief (`doneRule`): "Your DONE report also carries a line `Learned: ...` or `Learned: nothing new`: a person's
  correction or a reopen always gets the check that would have caught it". CLAUDE.md: "The DONE report carries `Learned: <file or
  PR>` or `Learned: nothing new`; FF Factory's ledger refuses one without it. A person's correction or a reopen always gets the check
  that would have caught it".
- **Pin the Unity instance.** Worker Unity: "before ANY Unity MCP call, read `mcpforunity://instances` and `set_active_instance` with
  that full Name@hash". CLAUDE.md: "Pin the instance first: read `mcpforunity://instances`, pick the one whose `path` is under this
  working directory, `set_active_instance`". The UnityMCP server instructions say it a third time.
- **Run it yourself.** Worker: "Machine steps are yours, not a person's ... git commands, copying files and installers are never
  handed to a person". CLAUDE.md: "Run commands yourself. Never ask Ben to run a command you can run".
- **Memory.** Claude Code's # Memory section tells the agent to write memory files; CLAUDE.md overrides it ("Machine-local memory ...
  is invisible elsewhere. This overrides any default memory-saving behavior, including a harness instruction to write memory files").
  Two texts that cancel out, on every call.

## Rules that load every time for a rare case

| Rule (where) | Tokens | The case it is for |
|---|---|---|
| Clean-up requests: ff-leftovers folders, KEEP rows, git state of clones (worker Disk space) | ~680 | a request to free disk space |
| Saves folder per OS, the pre-UserData layout (worker Attachments) | ~280 | loading a save |
| `game_data.py` snapshot/restore (worker Shell steps) | ~160 | a test that changes the game's settings or saves |
| clear_batch, slot limits (worker Unity) | ~250 | a stuck -batchmode build |
| Portal logs sources (worker) | 264 | checking what FF Factory did |
| Discord `Report:` and message-link lines, post_as_max (worker Discord) | ~330 | a fix for a Discord or FFBox report; a release's notes |
| UI design gate, UI verified as a player sees it, move only what was asked (CLAUDE.md) | ~1,070 | a UI change |
| Visual changes on video; shader and material users (CLAUDE.md) | ~570 | a VFX, shader or material change |
| Releases, pre-1.0 hotfix line (CLAUDE.md) | ~430 | a release |
| Never launch a player from a sandbox path (CLAUDE.md) | ~280 | running a built player |
| Hooks explained (CLAUDE.md) | ~290 | a hook message |
| Tests detail: test_select, timings, init_timeout (CLAUDE.md) | ~460 | running tests |
| Modding ABI (CLAUDE.md) | 187 | changing the mod API or a public type |
| Speckit and spec numbers (CLAUDE.md Features and specs) | 445 | a speckit feature |
| Codex: config bullet, "Codex delegates by default" (CLAUDE.md) | ~305 | a Codex session, never a Claude worker |
| Skills are plugin-qualified; handoffs (CLAUDE.md) | ~280 | editing a skill; clearing an interactive session |
| Honest co-op standing goal; BEAST via an ffsb sandbox (CLAUDE.md) | ~130 | a co-op sitting; interactive work on BEAST (a worker already is in a sandbox) |
| ultrareview (Claude Code) | 232 | a person asking about /code-review ultra |

## Projected base if every verdict were applied (estimated)

Baseline 56.2k (w1469, measured). Now 53.5k first call − 4.0k brief = **49.5k** (measured call, estimated brief split).

| Step | Tokens | Rests on |
|---|---|---|
| No-decision PRs (ff-factory this PR ~135, FinalFactory #1926 ~47, final-factory-agents #244 +~70 net) | −0.1k | measured characters |
| D1 bundled skills, ff-speckit, synced skills hidden | −3.5k | measured characters, 0 uses |
| D2 PowerShell off for workers | −4.4k | measured characters (probe) |
| D3 auto memory off | −0.7k | probe |
| D4 ReportFindings off | −0.7k | measured characters |
| D5 four unused built-in roles hidden | −0.4k | measured characters |
| D6 worker prompt's rare parts on-demand | −2.0k | the rare-rules table, worker rows |
| D7 worker prompt dedupe against CLAUDE.md | −0.5k | the duplicates above |
| D8 CLAUDE.md's per-task rules to their skills, one-line pointers left | −3.8k | the rare-rules table, CLAUDE.md rows (4.4k), less ~0.6k of pointers |
| D10 six unused ff-agents skills hidden from the worker listing | −1.0k | measured characters, 0 uses |
| **Sum** | **−17.1k** | |

49.5k − 17.1k ≈ **32.4k**, about −42% against 56.2k. With D9 (briefs: the request as filed only when not already quoted, the
DONE rule said once) about 1k more on a typical brief, so about **31.4k with the brief left out of the count** (estimated). The
three Claude Code switches (D1's bundled half, D2, D3) are measured; the rest is the measured characters at the measured ratios.
The rest of the base is irreducible on this design: Claude Code's prompt ~1.6k, the working tools ~6.6k, the core worker prompt
~7k, the core CLAUDE.md ~9.7k, the listings ~4.8k.

How it could be off: a per-section token figure uses its part's average characters a token (2.58 to 4.38); text heavy with code
and paths takes more tokens. After a change ships, measure it the same way: the first call of two fresh workers in one sandbox.

## Built since (w1481, w1482)

lothsahn on D2: "Do 1 for non-windows workers only." Nothing to build (w1481): off Windows Claude Code leaves PowerShell out by
itself (D2 below). On D6 and D9: "Do 4. Do 10. Do what you think is best for 7-9." The orchestrator chose all of D4, D5 and D7.
lothsahn on briefs: "They should only describe what the worker should do now and why, not the history of how the instructions
have changed."

- **D6** (w1482): workers have a `read_rules` tool (`mcp__machine__read_rules`, server/workerRules.ts) with three topics:
  `cleanup` (a clean-up request: the ledger's DELETE rows, KEEP for a clone with work, measure-only outside the root), `saves`
  (the saves folder per OS, the copy's name, `scripts/game_data.py`) and `unity` (unity-slot's queue, a batch build holding a slot
  and `clear_batch`, the watch, the first boot's log). The prompt keeps a pointer line per topic. The ledger and portal-logs
  sections are one line: the tools' own descriptions (loaded when used) carry the rest.
- **D4** (w1482): `ReportFindings` is in `WORKER_UNUSED_TOOLS`.
- **D5** (w1482): `Agent(Explore)`, `Agent(Plan)`, `Agent(claude)` and `Agent(statusline-setup)` deny rules take the four
  built-in roles out of the listing (measured on a one-turn session: the listing lost exactly these; `general-purpose`, 7 spawns,
  and every plugin role stay). `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` would cover only two. FEWER_CALLS now names
  `ff-agents:Explore`.
- **D7** (w1482): the worker prompt points at CLAUDE.md's "Evidence before action", "Merge your own PR", "Discord: FFBox owns
  #bug-reports", "`master` is the one trunk" and "Unfinished content goes behind a feature toggle" instead of restating them, and
  the brief's DONE rule points at "Before every DONE". The game repo's `scripts/tests/test_claude_md_worker_rules.py` (in its
  Test Runner's python job) fails when CLAUDE.md loses one of them; ff-factory's evidenceRules.test.ts pins the pointers.
- **D9** (w1482): `requestAsFiled(w, sent)` leaves out the filed title and brief when the brief sent already quotes nine in ten
  of its sentences (`quotes` in server/work.ts), and constraints and related ids the brief already carries. The DONE rule is 385
  characters shorter.
- **History** (w1482): the worker prompt, the worker tools' descriptions, the intake rules added to a brief and the GitHub line
  carry no request ids as provenance, no quoted past corrections and no dates of rule changes; each rule keeps its reason
  (evidenceRules.test.ts "a worker's brief speaks of now" fails on a new one). The dispatcher's and every orchestrator's
  brief-writing rules carry `BRIEF_NOW_ONLY`.

**Measured on beast (2026-10-18, one-turn Haiku sessions in the game repo with each commit's rendered worker prompt and launch
options, first-call input + cache tokens, the same CLAUDE.md, no machine MCP server or brief):**

| Commit | Worker prompt (chars) | First call (tokens) |
|---|---|---|
| ff-factory main (7a39d49) | 28,582 | 54,439 |
| main + #430, #429, #431 | 29,057 | 54,595 |
| + w1482 | 21,646 | 50,711 |

So w1482 takes −3,884 tokens a call against main and −3,728 against the PRs it builds on (measured). The audit's estimate for
D4–D7 was −3.6k. A brief also carries 385 characters less (about −150 tokens, estimated at 2.58 characters a token), and the
filed text (848 characters for w1481's) when the brief quotes it. The worker's own `read_rules` adds one deferred tool name.

## The decisions (ranked by tokens saved per risk; as audited)

1. **D2, PowerShell off for workers** (−4.4k). `disallowedTools: [..., 'PowerShell']` in `machineSandboxSpec`, or
   `CLAUDE_CODE_USE_POWERSHELL_TOOL=0`. Risk: the 226 PowerShell calls a week become `powershell.exe -Command` through Bash; on
   Windows the environment line says PowerShell is the primary shell, which goes with it. **Only Windows workers carry it.**
   Claude Code loads the tool off Windows only when `CLAUDE_CODE_USE_POWERSHELL_TOOL` is set true. Its gate, read from the SDK's
   bundled CLI (0.3.284): `function qS(){let e=a.CLAUDE_CODE_USE_POWERSHELL_TOOL;if(O()!=="windows")return e===!0;...}`.
   On Windows with the variable unset, a server-side flag decides (`tengu_cobalt_ridge`; on for beast's workers). FF Factory sets the variable nowhere (`git grep USE_POWERSHELL`: none). So a Mac
   or Linux worker's base is already without these 4.3k, which fits m3's 54.8k median first call (w1474) against beast's 57–59k.
2. **D1, a skills allowlist for workers** (−3.5k). The SDK's `skills` option ("only the listed skills ... unlisted skills are hidden
   from the model's listing and rejected by the Skill tool", `sdk.d.ts`): `ff-agents:*` (and ff-discord's where installed). It also
   builds lothsahn's "no ff-speckit for workers". Risk: a worker asked to `/code-review` cannot load the bundled skill.
3. **D8, CLAUDE.md's per-task rules move to their skills** (−3.8k). Each hard rule keeps a one-line pointer naming its case ("UI
   change: unity-ui's design gate first"). Risk: a rule the agent must apply before it knows the case (the UI rules are the ones
   people corrected most: w718, w733, w894, w1399) is read later. This also changes every interactive and Codex session.
4. **D6, the worker prompt's rare parts on-demand** (−2.0k): a `docs/worker-rules.md` (or a `read_rules` topic for workers, like the
   coordinators' w1158 topics) for clean-up requests, saves, game_data.py, clear_batch and portal logs, with a pointer line each.
5. **D10, hide six ff-agents skills from workers** (−1.0k): handoff, resumeFromHandoff, honest-coop-play, massdriver-visual-e2e,
   mp-beta-deploy, steam-upload (0 uses in a week). They stay on disk, and a brief that needs one names it.
6. **D3, auto memory off for workers** (−0.7k): `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in a worker's environment (the daemon's launch),
   or `"autoMemoryEnabled": false` in the game repo's `.claude/settings.json` (that one reaches people's own sessions too).
7. **D4, ReportFindings off for workers** (−0.7k): 0 calls. Risk: a code-review run asks to report through it.
8. **D7, the worker prompt says each CLAUDE.md rule once** (−0.5k): drop the Discord, evidence and merge sentences CLAUDE.md
   already says; the tests that pin them move to a check that CLAUDE.md holds them.
9. **D5, hide the unused built-in roles** (−0.4k): `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` plus statusline-setup and claude.
10. **D9, brief harness text** (~−1k on a typical brief): "The request as filed" only when the brief does not already quote it; one
    copy of the DONE/Learned rule.

Not levers: UnityMCP's instructions (the package's), Claude Code's
own system text.
