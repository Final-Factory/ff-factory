# Changelog

All notable changes to FF Factory are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0 a minor bump may break things.

Add your change under **[Unreleased]** in the same pull request. `npm run release -- minor` (or
`patch`, `major`, `X.Y.Z`) moves those notes under a new version, bumps `package.json` and
`web/package.json`, commits and tags `vX.Y.Z`.

## [Unreleased]

### Added

- **The ledger cleans itself up** (w304 and w306, asked by Lothsahn: about 45 finished requests had to be closed by
  hand). Each request is linked to the pull requests its workers open (a `Request: wNNN` line the worker brief asks
  for, a PR URL in a worker's report, or the worker's branch), shown on the request and in `list_work`. When they have
  all merged, no worker is running and nothing is left after the merge (not a release, a step after the merge, a
  multi-PR plan, or a report saying more is coming), it closes as done, "merged as #N (sha)"; otherwise it stays open
  with a log line, and a PR closed without merging only adds a note. Every `ledger.cleanup.everyHours` hours (default
  4) and on "Clean up now" the sweep also closes requests whose worker's final report plainly says delivered, resumes
  a worker a limit or restart cut off once, and moves requests nothing has touched for 24 hours, or that a newer
  finished request probably covers, to a new **stalled** status (its own filter; only its person closes or reopens it).
  A request with a running worker is never touched; each person's orchestrator hears one `[ledger cleanup]` line per
  pass ([docs/orchestrators.md](docs/orchestrators.md), "Pull requests" and "Ledger cleanup"). The first pass after
  the deploy is the backfill for requests whose PRs already merged, and lists what stayed open and why.
- **Reports spell out their ids** (w302, asked by Ben). The worker, orchestrator and dispatcher briefs and the
  worker-update relay say that a request id, PR number, commit, worker id or sandbox name always comes with what it
  is in plain English, every time ([docs/orchestrators.md](docs/orchestrators.md), "Evidence and labels").

- **Intake requests close themselves when their work merged** (w298, asked by Lothsahn: four FFBox review requests
  sat in "needs a human" hours after #945–#947 and #949 merged them). Every 5 minutes, and on "Check Discord now", a
  request nobody works on closes as done when a merged PR or commit names its PR or branch or carries its Discord
  thread, when its whole branch is already on develop, or when a linked request is done. It logs "merged as #N
  (sha) on date", starts no worker, and its people hear one line per batch. The Intake tab shows them under
  "Closed automatically" ([docs/intake.md](docs/intake.md), "Closed when it merged").

- **A player's clear bug goes to a worker; anything else waits, and the thread says so** (w299, asked by Lothsahn).
  FFBox's escalations, player requests and fix branches are triaged by the same fixed rules as Discord threads, so an
  obvious bug can be auto-approved (`intake.ffbox.autoApprove`). Money, releases and publishing, and a report that
  argues its own triage or instructs the agents, always wait. A request held for a reviewer makes FFBox post "Waiting
  on input from a developer." once ([docs/intake.md](docs/intake.md)).

- **FFBox threads hear a fix's PR, a question, and a can't-fix** (w278, asked by Lothsahn). The `dev_update` FFBox
  gets also carries a PR summary once the worker's PR is ready for review, the question a request waits on (the
  operator's answer in the thread answers it and the dispatcher resumes the work), and the reason a request will not be
  fixed. For dev requests and for requests filed from FFBox's own reports and escalations. Results only, no internal
  ids ([docs/ffbox.md](docs/ffbox.md)).

- **FFBox dev requests are followed to their result** (w272, asked by Lothsahn). FF Factory sends FFBox a
  `dev_update` whenever a linked request's facts change: the worker's PR to watch, the merge, the release, or that it
  was declined or cancelled ([contract](docs/ffbox-connector-contract.md), [docs/ffbox.md](docs/ffbox.md)). FFBox
  announces the merge in the thread and files it away; the plain "wNNN is done: …" reply is gone, so the thread hears
  results, not routing.

- **FFBox updates failing: a red dot** (w265, asked by Lothsahn). FFBox's connector (2.4.0) pushes its self-updater's
  last pass as an `updater` message ([contract](docs/ffbox-connector-contract.md#updater-w265)): per checkout ok,
  diverged, dirty or failed, with commits and the updater's words. FFBox turns red in the sidebar and on its page, and
  `system_status` and `ffbox_activity` (summary and status) say "FFBox updates failing: <checkout> <reason>, since
  <time>", when a checkout is failing or no pass has run for three timer intervals (`shared/updaterHealth.ts`).

- **FFBox dev requests: an operator's ffdev turn handed to FF Factory** (w240, asked by Lothsahn;
  [docs/ffbox.md](docs/ffbox.md#dev-requests), the wire in
  [docs/ffbox-connector-contract.md](docs/ffbox-connector-contract.md#dev-requests-an-operators-ffdev-turn-handed-to-ff-factory)).
  New connector messages `dev_request`, `dev_chunk`, `dev_message` and `dev_received`, answered `dev_ack`, `dev_filed`
  and `dev_reply`, all in `welcome.accepts`. A hand-over's files (at most 10, 200 MB each and `attachments.maxMB`,
  500 MB together) stream into the attachment store in base64 chunks of 45000 bytes and each SHA-256 is checked; the
  request is then filed at once as the request of the person its operator is (the FF Factory login of the
  same name as FFBox's `operators` block gives them; nothing to map), with no approval step, after the ledger check: identity keys, the meaning of its title
  and brief (w219's matcher), and the new `scope` of open broad requests (`request_work` takes `scope { threads,
  source, channel, since, until }` and records the threads a brief lists). Covered, already fixed, filed with
  candidates, or filed, each with the line FFBox posts and one `[from FFBox, <operator>]` line in the person's own
  orchestrator. The operator's follow-ups in that thread reach their orchestrator as `[from FFBox via Discord,
  <operator>]` (and a busy worker on it); the orchestrator answers with the new `reply_to_ffbox` tool, and a linked
  request finishing sends the thread one line, resent until FFBox confirms it. A repeated ref is answered the same way,
  across restarts. Config `providers.ffbox.devRequests` (`enabled` true, `perHour` 20, `maxFiles` 10, `maxRequestMB`
  500); both keys are an owner's to set with `set_app_config`. `ffbox_activity` `show: "dev_requests"` lists them and
  the status line counts them.

- **Attach saves, logs and bug reports to chat messages, and hand them to workers** (w228, asked by Lothsahn;
  [docs/attachments.md](docs/attachments.md)). The composer takes any file through the paperclip, paste or drop, in
  orchestrator, dispatcher and worker chats; images still go inline. Files upload in 8 MB chunks with a progress bar
  and resume after a dropped link; config `attachments.maxMB` (default 200) caps each one, `attachments.retentionDays`
  (default 30) says how long an unused one is kept, both settable with `set_app_config`. The server stores each file
  once by SHA-256 under `data/attachments/` and never opens, unpacks or runs it; downloads are always a file
  download. The agent's prompt lists each attachment as untrusted user data with its id, name, size, type, SHA-256 and
  where it is. `request_work`, `start_agent` (with a request's own files by itself) and `message_agent` take
  `attachments: [ids]`; a worker in a sandbox here gets a copy in `<sandbox>/Inbox/<id>-<name>` (a `.gitignore` of
  `*` keeps it out of git), and on a machine the daemon fetches it there over its token, resuming and checking the
  SHA-256, before the message goes on (daemon protocol 7; older daemons are refused attachments until redeployed).
  Workers get `fetch_attachment` and an Attachments section in their brief that says where the game loads saves from.

- **FF Factory's work for FFBox goes on `ffbox-f/*` branches** (w273; [docs/ffbox.md](docs/ffbox.md#how-work-leaves)).
  FFBox's containers keep `ffbox/<name>-<run id>`; for a dev request, and for a diagnosis or request FFBox filed that
  names no branch of its own to review, `create_sandbox` with the dispatcher's new `work_id` defaults the branch to
  `ffbox-f/<sandbox name>` (an explicit `branch` wins), and the worker rules the harness adds say to push and open the
  PR from `ffbox-f/<topic>` (renaming a `sandbox/<name>` branch first). Other work keeps `sandbox/<name>`. Reviews of an
  FFBox branch name nothing new, and `ffbox-f/*` is never filed back as a "Review and merge" request.

- **`set_app_config` sets the intake reviewers** (w270; [docs/intake.md](docs/intake.md#config)). Key `intake.reviewers`,
  a list of user ids (or one comma-separated string): the people who approve or decline intake requests and answer design
  questions. Each id must be an existing login, matched without regard to case; unknown ids are refused and nothing is
  written. An owner's setting only, behind the same "the person asked in their own words" guard as `intake.ffbox`; it
  applies at once and `null` removes it (the owner alone decides). Until now the list could be edited only in config.json
  on BEAST, so a second reviewer such as Lothsahn needed a hand edit.

- **`set_app_config` sets the FFBox intake** (w224; [docs/intake.md](docs/intake.md#config)). Key `intake.ffbox`, the
  whole block as the value: `enabled`, `branches`, `diagnoses`, `requests`, `boardCheck`, `escalations`, `repo`,
  `dailyCap`, `match.{high,medium}` (w219) and `autoApprove.{enabled,maxPerDay}`. An owner's setting only, behind the same "the person asked in
  their own words" guard as the other admin settings; unknown keys and wrong types are refused. It applies at once,
  and the connector's link stays up. Until now the ledger check could be switched on only by editing config.json on
  BEAST, so FFBox's `board_log` showed `not_asked: portal_takes_no_board_check`.

- **board_check matches a report to ledger work by meaning** (w219; [docs/intake.md](docs/intake.md)). FFBox sends the
  report's title and start (redacted) to a portal that takes `board_summary`. FF Factory compares their concepts with
  each request's title and brief: game phrases folded ("alt tab", "one spot"), stems, synonyms, a typo, weighted by
  rarity. No model sees the text. High band: `in_flight`/`done` as before. Medium: the new `maybe` (to a connector that
  takes it), and what FFBox files later from that conversation names the candidates. Bands are config
  `intake.ffbox.match`. Every decision is logged. On the fixtures, every real duplicate (the teapot, the alt-tab
  threads, the stacked enemies, the post-reset camps desyncs, the bug reporter drag) is high and every near-miss in the
  same system is low. "LEDGER CHECK OFF HERE" in FFBox's status line when FFBox asks and `intake.ffbox.boardCheck` is
  off, as it was for the w217 test.

- **FFBox's CPU, RAM and disk in the sidebar** (w218; [contract](docs/ffbox-connector-contract.md#metrics-protocol-2)).
  FFBox's connector pushes its load averages and core count, memory and swap in use, and each disk's free space (named
  by role, never by path) every 30 s. The sidebar shows FFBox among the computers with the machines' meters. CPU is
  load1 over the logical cores, shown above 100% when it is. The meters read stale after two minutes without an
  update, and "no metrics" for a connector that sends none. `system_status` has the numbers in FFBox's line.

- **Ask FFBox live for its config, its ledger exchanges, its status and one conversation** (w218;
  [docs/ffbox.md](docs/ffbox.md#asking-ffbox)). `ffbox_activity` gets `show: "config" | "board_log" | "status"`, and
  `show: "conversation"` with an `id`: one conversation's metadata and a page of its turns, with the messages and
  replies redacted on FFBox. Players appear by display name only.
  FF Factory sends a read-only `query` down the connector's open link and waits up to 10 s for the `query_result`. When
  FFBox is offline, does not offer the query or does not answer, the tool shows the last answer kept, labelled with
  its time. FFBox's host builds the answers: the config goes through an allowlist, with everything else
  `<redacted>`, and every answer is secret-scanned twice. Each answer is capped at one 64 KB frame, and FFBox answers
  30 a minute. A connector offers the queries in its hello (`accepts: ["query"]`, `queries: [...]`), so an older
  connector is never asked and an older portal never asks. Adding a query is a short, documented step in both repos.

### Changed

- **Nobody chats with the dispatcher** (w293, asked by Ben: Lothsahn was talking to it directly instead of to his
  orchestrator). The Dispatcher page's Conversation tab is a read-only log with a "Talk to your orchestrator" link where
  the input was, for every login including the owner. `POST /api/sessions/<dispatcher>/message` answers 403 "nobody
  chats with the dispatcher…" (voice mode used the same route); it is also refused inside `Agents.sendWithAttachments`.
  Harness messages (`[work request]`, `[work update]`, `[ledger]`, `[machines]`, intake, FFBox, `[wake_me]`) and the
  Intake tab's approve, decline and delegation approvals are unchanged. The dispatcher's destructive tools now run only
  for a request its person asked for in their own orchestrator ([docs/orchestrators.md](docs/orchestrators.md)).

- **A release is done when its patch notes are posted** (w280, asked by Lothsahn). The FFBox paragraph both
  orchestrators carry, the dispatcher's and orchestrators' brief rules and `docs/ffbox.md` say a requested release is
  done only when it is live on its Steam branch and its notes are posted once, as Max, in #dev-patch-notes; a release
  brief says "post the patch notes once live", and a landed build reported without the post link stays open.

- **The Steam release rule** (w277, asked by Lothsahn). The orchestrator prompt (`server/agents.ts`),
  `docs/ffbox.md` and `docs/ffbox-integration.md` say what FFBox's `SETLIVE` does: a version bump on develop goes
  live on Steam `development`, one on master on `pre-release`, and Ben or Lothsahn move the default branch by hand.

- **FFBox's link: no capability negotiation, and a frame that cannot be read says why** (w230;
  [contract](docs/ffbox-connector-contract.md#the-envelope-what-is-fatal-and-what-is-not)). On 2026-10-03 a test run
  rewrote FFBox's connector feed, its hello lost `queries`, and every live view answered `not_offered` for hours. Now
  nothing is gated on what the hello offers: `protocol`, `accepts` and `queries` are optional and only shown; any
  protocol number is welcomed (no more `4426`); the welcome's `accepts` is a static list, so changing the intake
  settings no longer closes the link; any well-formed query is sent and FFBox answers or says why not; `board` updates
  and `maybe` answers go to any connector. Unknown fields are ignored and an unknown message type is answered `error`
  `unsupported` (not counted). Only a frame that cannot be read is fatal (not JSON, not an object, no `type`, a field
  missing or of the wrong JSON type): closed `4400` with the place, e.g. `could not parse capacity.classes.0.free:
  expected number, received string`, logged with FFBox's commit and address and shown in the status line. Query
  failures carry FFBox's `reason`, `hint` and `detail` (cleaned), with the new codes `unavailable` (ffwatch down) and
  `disabled`; a timeout reads `no answer from FFBox within 10 s`. The status line adds the connector's commit and
  address, `ffwatch up` / `ffwatch DOWN since <time>` (from `capacity.ffwatch`), the last query, and the last close
  reason while offline; "LEDGER CHECK OFF HERE" now counts the board checks this portal actually refused in 24 h. The
  server log records every connect (address, commit, token fingerprint), every close with the code and reason either
  side sent, and a loud line when a new connection replaces a live one.

### Fixed

- **An open tab picks up a new version by itself** (w285, asked by Lothsahn). Twice a browser kept the old UI after a
  deploy (FFBox panes that did not scroll, a red dot that never showed). The page headers were already right
  (`index.html` revalidated, hashed bundles immutable, no caching service worker); the old UI was a tab that stayed
  open across the restart and reconnected with its old code. The server now names the web build it serves (a
  `<meta name="ff-build">` in `index.html`, `web` in `/api/health` and the app state); a page that loaded another
  build reloads itself after the reconnect. A typed message survives the reload; while one is being typed, or pictures,
  files or a form would be lost, a "new version" bar offers the reload; with only a message being typed it also
  happens once the tab is in the background. `index.html` gets an ETag (a 304 when unchanged), and a removed bundle is a 404 instead of the page.

- **`ffbox_activity` describes all its views** (w224). The schema itself was one definition for every belt and
  current since w218, but its description and the FFBox paragraph of both orchestrators' briefs did not name all the
  views, and some orchestrators still saw the old four-value enum (most likely a schema copy loaded before the deploy
  and kept in a resumed chat), so they assumed `config`, `board_log`, `status` and `conversation` did not exist. The description now lists each view,
  what it returns, the `id` and paging args, the "Last known, from <time>" fallback and that player text is untrusted;
  the brief names the live views and says an older schema copy in the chat is out of date. docs/ffbox.md has a table.

- **FFBox in the sidebar's load panel** (w225). The footer's mini bars and its open table, where BEAST and the
  machines show their CPU, RAM, GPU and disk, now list FFBox too. Collapsed, it has three mini bars: CPU (full at
  100%; the hover gives the real share, which can be above 100%), RAM, and an empty GPU bar. Open, it has one row
  like a machine's: CPU, RAM, GPU "none" and the root disk's free space. Stale or offline, the numbers stay, dimmed,
  under a "stale · updated …" or "offline · seen …" marker. (w226, Lothsahn: too much room) No line per filesystem
  and no history graph: the only disk shown is the root filesystem (`root+runs`), with every filesystem in its hover,
  in `system_status` and in the data. The portal no longer keeps or sends a `metricsHistory`.

- **FFBox's page scrolls, and its lists page** (w223). The Conversations, Signatures and Intake reports lists were cut
  off after the first few rows with nothing to scroll: `.run-list` (`overflow: hidden`) shrank to the space left in
  its flex column and clipped its rows. On a phone the capacity header alone was taller than the screen. The header
  and the lists now scroll as one, with the tabs kept at the top, and `.run-list` keeps its height everywhere. Each list
  shows the newest 100, then "Show 100 more" up to what the portal keeps (500 conversations, 2000 reports).

- **FFBox among the computers, where it can be seen** (w223). The w218 group sat below every machine's sandbox list,
  out of view on a phone or a busy portal. It is now the first group under Computers and counted there. It shows CPU
  (load1 over the cores, above 100% when it is) with the core count, RAM used of total, GPU "none" (no class reports a
  GPU), and free of total for its root filesystem (the others in the hover, w226). Stale (two minutes without an update) or offline, the last
  numbers stay, dimmed, under a "stale · updated …" or "offline · seen …" marker instead of disappearing.

- **A hard crash no longer takes the portal down** ([docs/self-recovery.md](docs/self-recovery.md#6-crash-safe-data-files)).
  On 2026-09-30 BEAST crashed while saving `data/state.json` and left it full of zero bytes; every start failed to
  parse it until someone restored it by hand. Data files are now fsynced before they replace the old one
  (`server/durable.ts`), keep three earlier versions (`.1` seconds old, `.2` up to a minute, `.3` one to eleven
  minutes), and a damaged file (empty, zeroed, cut off, failing its schema check) is moved aside and replaced by the
  newest good version at load. The restart summary, a push and the owner's orchestrator say what was restored and how
  much was lost. `state.json` is saved at most a second after a change even while agents are busy (a steady stream of
  changes could postpone the old save indefinitely), with the write and fsync off the main thread (about 12 ms of main
  thread per save at 7,265 sessions on BEAST). The same covers the ledger, intake, logins, API keys, machine tokens,
  config.json and the other data files; transcripts survive a torn last line; the orchestrators' memory is backed up
  every 10 minutes and healed at startup. The supervisor backs off at most a minute, and nothing starts on the sandbox
  drive before the host guard has seen it attached (it used to say "ok" for the first 5 s after a boot).

### Added

- **Evidence before action, and labels on the way up** (w208;
  [docs/orchestrators.md](docs/orchestrators.md#evidence-and-labels)). Every worker's brief now says: before anything
  that spends money, publishes, changes a live setting, releases, merges a simulation or player-visible change, or
  deletes, list what each choice rests on (measured, sourced or a guess) and settle your own guesses by research; ask
  the person only to confirm a money value, for what the rules reserve for them, or at a real fork. Reports label each
  number and recommendation and lead with the result. A person's orchestrator keeps those labels when it relays, does
  not call a fix done from a title or a tool verdict, sends a guess back to be researched, and brings its person
  decisions only for money, reserved actions and real forks. Briefs for consequential work list the decisions to
  settle. The orchestrators' memory brief says general lessons go to the harness repo by pull request. Prompt text
  only: no tool, setting or behaviour of the server changes.
- **Workers merge their own pull requests** (w208; the owner, 2026-10-02: "stop holding prs, just merge them"). Every
  worker's brief (`MERGE_RULES`) says to merge once verification is done and CI is green, and to hold a PR only for
  exceptional risk or a concrete timing reason, reporting which and when it will merge. Merges are no longer in the
  list of things reserved for the person, in the worker briefs or in a person's orchestrator's. Both orchestrators'
  briefs say done means merged. The standing agents' delegated tasks keep their rule (a pull request, never merged by
  the worker).
- **Escalations from Max** (w94; [docs/intake.md](docs/intake.md#escalations-from-max)): FFBox's host files the reports
  Max decides need a developer (bugs it did not or may not fix, design questions, escalations) with
  `POST /api/intake/ffbox` and a key minted `--scope ffbox`, which reaches nothing else. The ledger is checked and the
  request filed in one step (`in_flight` or `done` for a thread already there, `filed` otherwise, the same answer for a
  resent `ref`). Triage stays FF Factory's (a design question always needs a human; a bug by the fixed rules); Max's
  diagnosis and the player's report are fenced as untrusted; workers never post in the thread and put `Discord: <url>`
  in the PR. Off unless `intake.ffbox.escalations`.
- **Orchestrator memory in a private repository** (w208;
  [docs/orchestrators.md](docs/orchestrators.md#memory-in-a-private-repository)). When the memory root is a git
  repository of its own, each backup pass (startup and every 10 minutes) commits the Markdown files that changed and
  pushes them, only to an `origin` GitHub reports as private. A public remote, one that is not on GitHub or one whose
  visibility cannot be confirmed gets no push; a file holding what looks like a secret is left out of the commit; the
  app's own repository never gets memory commits. Switched on by running `git init` and `git remote add origin` in the
  memory root: no config key. The crash backup now leaves `.git` out.

### Changed

- **#bug-reports and dev_bug_reports belong to FFBox** ([docs/intake.md](docs/intake.md#ffbox-owns-bug-reports)). The
  intake never files work from them (config.json naming them, or their ids, is ignored), its worker rules for a thread
  there say not to post or close and to put `Discord: <thread url>` in the PR, and release follow-ups skip them. The
  Intake tab says which channels FFBox owns. `intake.discord.bugChannels` now defaults to none.

### Added

- **Nightly e2e regressions become ledger work** ([docs/intake.md](docs/intake.md#nightly-e2e-regressions)). The
  FinalFactory nightly lab posts each night to `POST /api/intake/nightly` with an API key minted `--scope nightly`
  (refused on `/mcp`). A new regression, a scenario still failing, or one flaky 3 nights running becomes a request
  (urgent when the failing code shipped in a release, high otherwise; brief: commit, scenario, oracle, ledger entry,
  links, release, reproduce-then-fix, Opus), or a line on the open request already on that scenario, a person's own
  included. Many in one night become one request. Off by default (`intake.nightly.enabled`); the Intake tab shows it.
- **Provider protocol 2: the ledger check both ways with FFBox** (w55; [docs/ffbox-connector-contract.md](docs/ffbox-connector-contract.md#protocol-2-the-ledger-check-both-ways)).
  The portal speaks protocols 1 and 2 and answers each connector in its own; `hello.accepts` and `welcome.accepts` say
  what each side takes. FFBox asks the ledger with exact keys (`board_check` by `discord:<thread id>`, `report:<id>`) before
  it starts a fix; every ledger request that names a Discord thread (link or bare id, older requests included) carries
  that key. A `board` match says what to watch while in flight (the worker's PR head branch and PR, or its sandbox
  branch, the repo, `develop`) and, once done, the release that carries the fix (`version`, null while unreleased) and
  `mergedIn`; answers that change are pushed again (`update: true`). `conversation.threadId` gives each `ffbox/*` PR's
  review request its thread, and the request closes when FFBox reports the PR merged or closed. FFBox's own conversation
  never matches itself.

- **Orchestrators remember** ([docs/orchestrators.md](docs/orchestrators.md#memory)). Every person's orchestrator
  and the dispatcher have a memory folder of their own (`data/orchestrator-memory/<person-id|dispatcher>`, config
  `orchestrator.memoryRoot`), Claude Code's auto memory pointed there: its `MEMORY.md` is loaded at every start. They
  can `Write`/`Edit` only Markdown files in their own folder, only in a turn their person started, and never a secret;
  the repo, config, the rest of `data/` and other orchestrators' memory stay read-only (a PreToolUse guard: `..`,
  links, junctions, Windows case, UNC and stream tricks are refused).

### Fixed

- **The web UI stays responsive at thousands of agents** (a portal with 7,200 sessions, 6,500 of them in one sandbox).
  Beside that sandbox, typing in the orchestrator's chat went from 71 ms at the 95th percentile (long tasks of up to
  150 ms, the page 64% busy with nothing typed) to 21 ms with no long tasks and 5.6% busy. Server events are applied
  once per frame; sessions are looked up by id instead of by scanning the list (`sessionIndex`); a place's agent tabs
  and picker list the live agents and the most recent past ones, with a "+N older" button for the rest; notices in a
  chat follow only the session they name; the progress bar animates `transform` rather than `left`, so a page at
  rest no longer lays itself out 60 times a second; live transcript events are kept only for chats on screen and the
  last few closed; the message draft is saved after typing pauses rather than on every key. The server gzips big
  JSON replies and the web bundle (`server/compress.ts`) and compresses big WebSocket messages. `web/perf/bench.ts`
  measures all of this at a real portal's scale, and CI holds the page to its budgets (`--check`).
- **A window title or command line with control characters no longer stops the Unity watch** on Windows machines
  ("Bad control character in string literal in JSON", LothDesktop). `scripts/unity-windows.ps1` and the daemon's
  process listing drop them before `ConvertTo-Json`, and `parsePsJson` escapes any that still come through and skips
  (and logs) an entry that cannot be read ([docs/unity-dialogs.md](docs/unity-dialogs.md)).

### Changed

- **No hourly or daily filing cap for people** ([docs/orchestrators.md](docs/orchestrators.md)): a person's own
  orchestrator files as many work requests as they ask for (the 3 filings between two messages of theirs still hold).
  The 10-an-hour and 40-a-day caps stay for automated sources (standing agents, the intake), per source in config
  `workLimits`.

### Added

- **Images and Mermaid diagrams inline in every conversation** (orchestrators, dispatcher, workers, standing agents).
  A markdown image `![alt](/absolute/path.png)` shows where it is in the message, at its own size up to the column's
  width, and a click opens it full size (click again for actual size, scrolled). PNG, JPEG, GIF, WebP and SVG, from the
  agent's sandbox, machine clone, standing agent folder or its own temp folder, through the guarded `/api/image`
  (machine files through the daemon, which now also allows the session's temp folder). `data:image/…;base64` URIs up
  to ~1.5 MB show too. The server copies each image into the transcript's store as the message arrives
  (`server/inlineImages.ts`), so the chat keeps it after the file or its sandbox is gone. SVGs are rebuilt from an
  allowlist (`shared/svg.ts`: no scripts, handlers, `foreignObject`, animation or external references), on the server
  for files and in the page for data URIs, and every served file carries a sandboxing CSP. ```` ```mermaid ````
  blocks render as diagrams (mermaid loaded only when one is shown, `securityLevel: 'strict'`, the dagre layout),
  with Source/Diagram and open-large buttons. The briefs tell agents how to show an image and that diagrams render.

- **The intake: Discord and FFBox into the work ledger** ([docs/intake.md](docs/intake.md)), every switch off by default
  (config `intake`). New #bug-reports threads (the in-game reporter's too) and trusted people's requests to Max in
  #dev-chat (trusted by Discord author id, config `intake.discord.trusted`) become ledger requests with the thread link,
  reporter, version and attachments, marked as players' text. A fixed-code triage classes each one: an obvious bug may be
  worked without a person when auto-approve is on; anything else **needs a human** and waits until a reviewer (config
  `intake.reviewers`) approves or declines it on the Dispatcher page's new Intake tab. Duplicates of open or finished
  work fold into the request they repeat; daily and per-reporter caps. Intake workers get fixed rules (untrusted input,
  posting limits, stop at design decisions) and end with FIX-LANDED, RESOLVED or DESIGN-QUESTION, which close the
  request or flag the question to the reviewers; a release follow-up tells reporters their fix is live. FFBox, later
  and optional: its fix branches and `request` messages become review requests, `board_check` lets it ask the ledger
  first, and `send_to_ffbox` hands it work once `providers.ffbox.sendWork` is on. `list_work` gains `source` and
  `status: needs_human`; the heartbeat gains an Intake line. Work started from the dashboard, over `/mcp` or for a
  delegation is recorded in the ledger too.

- **Claude plan usage is polled every 15 minutes** (config `usagePollMinutes`, 5 to 240, settable with
  `set_app_config`; [docs/accounts.md](docs/accounts.md#how-often)), on the portal and by each machine daemon, instead
  of every 5 minutes plus up to once a minute after rate-limit events. One poll at startup or connect; **Refresh
  usage** under the meters polls every account at once (here and on each connected machine); `system_status` polls
  only when the numbers are older than the interval. Each account still says "as of" when.
- **People message each other through their orchestrators** (`message_person`,
  [docs/orchestrators.md](docs/orchestrators.md)). A person's own orchestrator can send another person a message: it
  lands in that person's own chat as a `[person message]` from the sender, which their orchestrator shows them and
  never acts on by itself, and they answer the same way. It is unread (an amber count on the sidebar's Orchestrator
  row) until they open or write to their chat, sends them a push or in-page notification (a new "Messages from people"
  choice in Settings), and survives a restart. At most 3 messages to one person until they write to their own
  orchestrator, 2000 characters each; workers, standing agents, machine agents and the dispatcher cannot send one.
- **The portal's own host as a machine** ([docs/beast-machine.md](docs/beast-machine.md)). `add_machine local: true`
  runs a daemon on BEAST itself (no ssh, its own scheduled task, the portal's config as its settings) that owns BEAST's
  sandboxes, editors and workers, so the portal is the orchestrator only. `migrate_host_sandboxes` moves the existing
  sandboxes to it in place (folders, branches, Libraries, editors, agent history and session ids untouched) and back.
  BEAST's sandboxes are `beast/<name>`, bare names keep working, and the sidebar and Overview still show them under
  BEAST. Protocol 6: the `adopt`/`release` sandbox ops, and the pool's total agent cap, Library seed (block clone),
  below-normal editors and protected paths. The workers keep `claudeAccounts.workers`. Backlog step 2 (restarts that
  leave daemon agents running) is built behind `machines.keepAgentsOnRestart`, off.

- **An orchestrator for each person, and a dispatcher** ([docs/orchestrators.md](docs/orchestrators.md)). Each
  login gets their own orchestrator chat on the home page: only they write to it, it runs on their own Claude token
  when they have one, sees everything, follows up with their own workers, and files work requests. The shared chat
  becomes the **dispatcher**, keeping its conversation: it owns every tool that changes something and answers each
  request through the work ledger (start, merge, link, queue, ask, reject, done).
  - The ledger (`data/work.json`) checks each request against open and recent requests, live workers, open PRs on
    their branches, pending delegations and recent commits (specs, PRs, branches, ids, similar titles). A repeat of an
    open request returns it, and `start_agent` refuses a strong overlap without `override_duplicate`.
  - Worker updates go to the chats of the people the work is for; the dispatcher sees them in the ledger. Standing
    agents' delegation notices go to the person the run was for; restarts and host notices to the dispatcher.
  - Limits: 3 filings and 3 follow-ups per worker between two messages of a person, 10 requests an hour and 40 a
    day per person, 3 questions per request. The dispatcher's destructive tools run only for a request its person
    asked for in their own turn, or when the owner writes to it.
  - No interruptions: only its person writes to a chat (403 otherwise), only the owner to the dispatcher;
    notifications, in-page notices and the heartbeat are per person.
  - The sidebar lists the other people's chats (read only) and the Dispatcher; its page shows the requests and its
    conversation. Decisions arrive in your chat as notices that open the request.
- **docs/backlog.md**: the planned BEAST split (a portal plus a machine daemon owning BEAST's sandboxes, not before
  2026-09-30), then portal restarts that leave daemon agents running.

- **Every computer at a glance.** The sidebar groups sandboxes and agents by computer: BEAST, then each machine,
  each a collapsible group (remembered per browser) whose header has its CPU, RAM, GPU and disk and its sandbox and
  editor counts ("2/3 sandboxes · 1/2 editors"). Under it, one row per sandbox with its label, branch, Unity state and
  a **FREE** badge, its live agents (title, busy or idle, time since last activity; stopped ones as a count), and a
  machine's main-clone agents. A new **Overview** page (`#/overview`) shows the same as one card per computer. Machine
  sandboxes get their own page (`#/machine/lothdesktop/sandbox/sb1`): agents as tabs, the editor with start/stop and
  its log, git state and a branch switch, through new `/api/machines/<id>/sandboxes/<sb>/…` routes. The machine page
  now tabs only its main-clone agents and links its sandboxes.
- **Machine sandboxes** (docs/machines.md, "Machine sandboxes"). A Mac or Windows PC can now hold a pool of
  sandboxes like the host's: git worktrees of its main clone in its `sandbox_root`, each on its own branch,
  with a warm Library copied from the main clone (or another sandbox) and its own Unity editor, which the
  daemon starts, stops, watches for hangs and crashes, and stops after 2 hours without agent activity.
  `add_machine` (and a redeploy) takes `sandbox_root`, `max_sandboxes` (default 3), `max_agents_per_sandbox`
  (2), `max_unity` (2) and the disk guard's `disk_warn_gb` / `disk_critical_gb` (50 / 20), kept on the record
  and in `daemon.json`. The sandbox tools take a machine: `create_sandbox {machine}`, and `"<machine>/<name>"`
  in `set_sandbox_label`, `delete_sandbox`, `unity`, `start_agent` and `switch_branch`. The machine's disk
  guard refuses new sandboxes and editors when space is low and, when critical, stops idle editors and asks
  busy sandbox agents to checkpoint. Daemon protocol 5 (older daemons are redeployed as usual; sandbox
  commands are never sent to them).
- **Windows GPU numbers for any card.** Without `nvidia-smi` (an Intel or AMD GPU), the host and Windows
  daemons read Windows' GPU performance counters (`\GPU Engine(*)\Utilization Percentage`,
  `\GPU Adapter Memory(*)\Dedicated Usage`, or their CIM classes on a localized Windows) and the adapter's
  name and memory from the registry.
- **Continuous disk clean-up, on the host and every machine** (docs/self-recovery.md, "Continuous
  clean-up"). The host guard and each machine daemon now run a pass every hour, and every 15 minutes while
  free space is below a soft threshold (host: `warnFreeGB` + 40 = 120 GB, before the 80 GB block; machines:
  80 GB; `hostGuard.cleanup.everyMinutes` / `.softFreeGB` and `machines.cleanup.*`, per machine). Rules per
  platform cover what actually filled BEAST: Claude Code's `bash-edit-diff` snapshots and task output,
  Actions runner job folders, sandbox `Builds`, build archives in `ff-worker`, playtest sessions, crash
  dumps, old logs, the Unity GI and package caches, superseded Playwright browsers, Xcode DerivedData, old
  temp entries and, below the soft threshold, whole npm/NuGet/pip/uv caches; Unity Libraries of projects not
  opened for 30 days are reported and removed past 180. Repos, sandboxes, `.claude`, secrets,
  `ff-local-backups`, `~/torque`, audit artifacts, Steam and Unity installs, VHDX files and anything an agent
  is using are never removed (checked again before each removal; on Windows an entry in use is skipped
  whole). Each agent gets its own temp folder (`ffa-<session>`), removed after its session; the briefs tell
  workers to delete big scratch once reported. Each pass is logged (`cleanup-log.jsonl`) and shown in
  `system_status`, `list_machines` and the meters; the orchestrator hears only when a pass cannot get back
  above the soft threshold, with the biggest remaining consumers. New tool `machine_cleanup`.

### Changed

- **`list_sandboxes` is compact and grouped by computer**: this host, then each machine with sandboxes, each
  with its limits and free count; one line per sandbox with a **FREE** flag, and only its live agents (the
  number of stopped ones in brackets). It had grown past a million characters on BEAST by listing every agent a
  sandbox ever had. `list_machines` lists only live agents too. A machine's `max_agents` now counts the agents
  in its main clone (and its standing agents); its sandboxes' agents count separately.

- **Max, and FFBox at a glance** (docs/max.md). A Max page (`#/max`) shows what FF Factory's agents did as
  the Discord bot: every post, reply, question, edit, thread opened, renamed or closed, with its channel or
  thread, a Discord link, the first line, the session and where it ran. The ffdiscord CLI appends each one to
  the file in `FF_MAX_EVENTS`, which every agent now gets with `FF_SESSION_ID`; the server tails the host's
  file and each Mac's daemon forwards its own (`max_event`). The page also checks the bot token every
  15 minutes (`/users/@me`, the token read from the ffbox config's secrets.env and never copied or sent to
  the page), shows the last error (such as Missing Permissions on #dev-patch-notes), and, read-only, the
  newest messages in #bug-reports and #dev-chat with unread counts, as plain text. `max_activity` gives the
  orchestrator the same, marked as data to relay.
  - A compact **External** strip above the meters: `Max ok 20m · FFBox 7 free` (or `off`), each opening its page.
  - The FFBox page opens while FFBox is off and lists what it needs (the token, the switch, the connector,
    linking the contract); when connected, a **Signatures** tab groups intake reports by coarse signature
    (reports, events, senders, host+client pairs, trusted or not) under the numbers automatic
    investigations will be capped by: new today, past the trust bar, would start (of 20 a day), and the
    storm breaker. `ffbox_activity show: signatures` returns the same.

- **A machine's own folders** (docs/machines.md, "A machine's own folders"). `add_machine` (and the Add
  machine form) takes `app_dir` (the daemon's folder instead of `~/.ff-factory`, e.g.
  `D:\work\.ff-factory`), `unity_editor_root` (a folder of Unity versions), `unity_path` (the editor
  executable) and `temp_dir` (TMP/TEMP/TMPDIR of the agents), kept on the machine record and in
  `daemon.json`, and shown by `list_machines` and the machine page. The Mac and Windows deploys, the
  LaunchAgent and scheduled task, stop/restart/remove, the guard's protected folder, standing agents'
  folders and image routing follow `app_dir`. Unity is now also found where Unity Hub says, on both OSes: the
  editors it lists (`editors-v2.json`, `editors.json`) and its chosen install location
  (`secondaryInstallPath.json`, newly on a Mac too).

- **Claude account per role and machine** ([docs/accounts.md](docs/accounts.md)). Config
  `claudeAccounts.orchestrator` / `.workers` / `.standing` (`"token"`, the default, or `"login"`) picks
  whether this host's agents run on the host token or on this host's stored claude.ai login; a "login"
  process starts with no credential in its environment. `set_app_config` sets these and
  `machines.useHostClaudeEnv` (globally, or per machine with `machine:`; `"*"` names the rest), refusing
  "login" when no usable login is stored, and the server refuses malformed values at load. Sessions
  record the account their process started on, so the meters, `system_status` (a new per-role account
  line) and agent details show the account each agent actually runs on, including a Mac's login as that
  Mac's.

- **Windows machines** (docs/machines.md, "Windows machines"). A machine can be a Windows PC reached over
  ssh (Windows OpenSSH Server, cmd.exe or PowerShell as its shell), not only a Mac.
  - `add_machine` finds the OS over ssh. On Windows it probes node, git, Claude Code and the clone,
    unpacks the same code bundle into `%USERPROFILE%\.ff-factory\app`, runs `npm ci`, and registers the
    `FFFactoryDaemon` scheduled task: at the user's logon, in their session, not elevated, at normal
    priority, supervised and restarted. The scripts go through an encoded PowerShell bootstrap, so the
    same command works under either default shell.
  - The daemon on Windows keeps the PC awake with `SetThreadExecutionState` while agents run, and
    reports CPU, RAM, disk and an NVIDIA GPU. It manages the Unity editor (`Unity.exe`, the hang and
    crash watch; no dialog watch yet). The guard protects `node.exe`, `claude.exe` and the task, and
    the backup recipe uses tar, because Git Bash has no rsync.
  - The hello reports `platform`. `list_machines`, the sidebar and the machine page show Mac or
    Windows.
  - Machine ids given with capitals (`LothDesktop`) are stored lower-case and shown as typed.
  - `machine_daemon` (tool, and Restart/Start on the machine page) starts, stops or restarts a daemon
    on either OS. Like a redeploy, a stop or restart is refused while agents run unless forced, and a
    stopped daemon is not redeployed while it is offline.
  - The offline check runs `ssh <host> exit 0`: `true` is not a command in cmd.exe or PowerShell.

- **People: who asked, and whose account pays** (docs/identity.md). Logins have a display name and a
  role (`node server/user.ts <name> --name … --role owner|member`; the first login is the owner).
  - Every message records its author. In the shared orchestrator chat, each person's name shows above
    their message, and the model reads it as `[from <name>]`.
  - Workers (started by hand, by `start_agent`, or through an `/mcp` key bound with
    `node server/apikey.ts <key> --user <login>`), `message_agent` follow-ups, standing runs started by
    hand, and delegation approvals all carry the person as `requestedBy`. Agent tabs and details show it.
    The orchestrator acts for the latest person's message, or for another with `for_user`.
  - Scheduled and automatic work is attributed to config `systemPayer` (default: the owner).
  - A person's own Claude token (`userClaudeEnv`, write-only through `set_app_config`) is what the
    agents they ask for run on, here and on the Macs, and it is a usage account of its own.
  - The FFBox contract gains the phase 3 work messages (`submit`, `diagnose`, `stop`) with
    `requestedBy`: FFBox bills that person's account or refuses. They are specified, not sent yet.

- **FFBox, read-only (phase 1 of docs/ffbox-integration.md).** FFBox's connector dials out to
  `/provider` with a token (`node server/providerToken.ts` mints one; config keeps its SHA-256) and
  reports its container classes (network, model, tier, free slots), its conversations and the
  crash/desync reports ffintake files. A Providers card in the sidebar and an FFBox page show them,
  `system_status` has a line, and the orchestrator's `ffbox_activity` tool reads them as data. Off
  unless `providers.ffbox.enabled` (settable with `set_app_config`, like the write-only
  `providers.ffbox.token`). The connector's contract: docs/ffbox-connector-contract.md; a mock
  connector for tests and trials: `e2e/mockConnector.ts`.

- **Usage for every Claude account.** The usage meters now cover every account in use, each with
  its weekly, 5-hour and per-model limits: the agents' token ("host token …abcd", asked of the
  usage endpoint with that token alone), this host's own login and each Mac's own login
  (reported by its daemon). Logins are merged by email; each account says where it is used and which
  agents run on it, `system_status` lists them all, and an agent's details name its account.
- **Load of every machine.** The Mac daemons report CPU, RAM (Activity Monitor's Memory Used, with
  memory pressure), GPU (Apple Silicon: how busy it is; it shares the RAM) and disk every 15 s
  (machine protocol 4). The sidebar footer shows each computer as a name and three mini bars in the
  same space the host's numbers took, the open footer has a row per computer, and `system_status`
  has a line per machine.

### Changed

- **FFBox: the model depends on who asked** (Lothsahn, 2026-09-28; docs/ffbox-integration.md, rule
  4a). Operator work on FFBox, `ffdev` included, runs on the requesting operator's own Claude plan at
  full capability and is billed to them; GLM-5.3 Flash is for Discord work only. A `capacity` class
  may now list `models`, one `{ requester: operator|discord, model, tier }` per kind of requester
  (optional; `model` and `tier` stay). The FFBox page, `system_status` and `ffbox_activity` show what
  the connector reports.
- **The chat.** Tool calls and thinking between two messages fold into one line ("Used 3 tools:
  …") that opens to the calls; harness notices ([worker update], [heartbeat], [unity blocked], …)
  are one line each, with names instead of ids and amber when they need you. Replies show their
  time, duration and cost on hover instead of a rule after every turn; a divider marks a gap of more
  than 15 minutes; code blocks have Copy. "Jump to latest" shows whenever you are a screen from the
  bottom, each chat keeps its scroll position, and while a turn runs the primary button is Stop.
- **At a glance.** The sidebar starts with what needs you (permission requests, Unity stuck on a
  dialog, delegation requests) and shows every sandbox, Mac and standing agent as a two-line row with
  its state in words and colour; the host and plan meters fold into two lines. An idle agent is grey:
  colour means something is happening or wrong.
- **Pages.** One header row everywhere, phones included, with the state under the name and, on a
  phone, the agent picker in that line; a strip under it says what waits. The orchestrator's
  heartbeat, permission mode and new conversation are in its ⋯ menu. Names instead of slot ids.
- **Styles.** One type scale and spacing grid; dim text passes WCAG AA; fewer borders. A phone on its
  side gets a one-row composer.

### Fixed

- **Machine agents get the Unity MCP bridge of their own editor** ([docs/machines.md](docs/machines.md#machine-sandboxes),
  "Unity MCP"). Agents in a machine sandbox had none (Claude Code registers the server per project folder), and
  LothDesktop's main clone had none either, so they ran Unity from the command line. The daemon now gives each agent
  the machine's MCP-for-Unity server (`daemon.json` `unityMcpServer`, else the machine's own `~/.claude.json`
  entry), confined to its sandbox's or main clone's editor through its own `UNITY_MCP_STATUS_DIR`, as the host does.
- **The Unity dialog watch runs on Windows machines too**, with the same rules and safe answers as on the host ("Repair
  FMOD Libraries" Ignore, "Connection Lost" Retry, "Font Coverage" OK, ...), and machines close the **FMOD Setup
  Wizard** window without touching it. Each automatic answer is logged in the daemon log.
- **Worker updates named "A worker" in the chat.** Since updates carry "(requested by …)", the page could not
  read which worker one was about; it names the worker and links to it again.
- **A connected machine shown in error** (m5, 2026-09-29: "installed, but the daemon has not connected" while it
  was). The deploy looked for a link opened after the ssh install returned, but launchd starts the new daemon, and
  it connects, before that; it now counts from the start of the install step, or a hello naming the version
  installed. A daemon's hello clears an install or connection error, a failed redeploy while a daemon is still
  connected no longer marks the machine as in error, and a deploy cut short by a portal restart no longer stays
  "deploying" (which kept the offline watch from ever redeploying it).
- **A Mac redeploy could leave no daemon at all** (m3, 2026-09-29: "Bootstrap failed: 5: Input/output error").
  The install booted out the old LaunchAgent and bootstrapped the new one a second later, while the old one was
  still going; it now waits (up to 30 s) until the old one is gone and retries the bootstrap.
- **Redeploying M5's outdated daemon resumed 8 agents finished for hours** (2026-09-29, after #21). They were not in
  the daemon's memory any more, so no report ever cleared their portal-side turn mark, and each refused resume
  appended an error that moved their `lastActivityAt`, so the 6-hour rule and the boot clean-up saw them as recent.
  A dropped link now counts a worker as cut off only if its daemon reported it live on that link (every daemon
  version sends that), a refused start no longer counts as activity, and an agent stopped or interrupted on purpose
  is marked `stoppedOnPurpose` and never resumed (not by a dropped link, a link that already dropped, or a portal
  restart) until it is messaged again.
- **A dropped machine link resumed every old agent on it** (21 on M3 and M5, 2026-09-29). The daemon's session
  reports are JSON, which drops a cleared `turnOpenSince`, so the portal kept every finished turn marked open; the
  cut-off resume (#20) and a clean portal restart's resume file then treated them all as mid-turn. The portal now
  takes a missing `turnOpenSince` / `backgroundTasks` / `statusDetail` in a report as cleared, clears the marks of
  a machine's agents when its link drops, counts only workers active within 6 hours as cut off, and drops stale
  marks (idle over 6 hours) when it restores machine sessions at boot.

- **Machine agents cut off by a forced redeploy were not resumed** (docs/machines.md, "Sessions"). A daemon going
  down (`add_machine` with `force`, `machine_daemon restart`, a crash) stopped its agents as if on purpose, which
  cleared their mid-turn mark, and nothing resumed them when the new daemon connected; only a portal restart
  resumed agents. Now the daemon keeps the mark, and the portal resumes the workers that were mid-turn once the
  daemon is back without them (not after a network blip, not after `machine_daemon stop`).
- **Machine sandboxes seeded with a copied Library had stale script mappings** (docs/machines.md, "Warm Library"):
  missing URP renderer features, a player build crashing in the shader step, dropped FMOD settings. The first
  editor start after a Library copy now force-reimports the scripts under `Assets` once, through a
  self-deleting editor script git ignores.

- **Clean-up freed nothing while the disk filled.** It ran only below the critical level (40 GB), after the
  warn level (80 GB) had already stopped new work, and its rules did not cover what fills the disk
  (`host_recovery cleanup` freed 0 GB on BEAST at 75 GB free). It no longer reports every pass to the
  orchestrator. Checking a temp clone for local work no longer rewrites its `.git/index` (`git
  --no-optional-locks`), which had made every checked clone look freshly used, so none ever aged out.

- **Unity MCP calls could land in another sandbox's editor.** Every worker's MCP-for-Unity server
  discovered all editors on the machine, and when its pinned editor was restarting or reloading it
  reconnected to the next one it found (another sandbox's, or the live game's). Each sandbox's workers
  now run it with `UNITY_MCP_STATUS_DIR` pointing at `data/unity-mcp/<sandbox>`, where the sandbox
  poll keeps only that sandbox's live editor's status file and a port file for its own port (0 while
  it is down), so they can neither see nor fall back to another editor.
- **Restarts resumed the wrong workers.** After a crash, `SessionManager.restore` put the very
  session record it then marked "stopped" on the cut-off list, so the unclean-restart resume file
  saw every cut-off worker as stopped and reported "No worker sessions needed resuming". Agent
  processes that ended a moment before the server (a console close, a process-tree stop) were missed
  the same way. And a worker stopped on purpose was resumed after an update when it still had an
  unanswered message or had been drained. Whether a turn is open is now saved at once
  (`turnOpenSince`, `backgroundTasks`), kept for a minute when a process ends by itself, and cleared
  by a deliberate stop or interrupt; workers stopped on purpose are never resumed. Idle workers
  waiting on a background task (a background command or a watcher) are resumed too, told the
  restart ended it.
- **`wake_me` wakes were lost on a restart.** They lived only in timers, so an update or a crash
  forgot every pending wake and the idle workers (and the orchestrator) waiting on one never resumed.
  They are now kept in `data/wakes.json` and re-armed at startup; one that came due while the server
  was down fires at once, and one that cannot start its agent is retried for ten minutes.
- **A machine locked out by its own retries.** After 10 failed `/machine` upgrades from an address
  in 15 minutes, every refused retry was counted again, so a daemon retrying every ~36 s kept the
  lockout going forever and even its fixed token got 429 (the M5 after a half-failed reinstall).
  Refusals during a lockout are no longer counted, and a good machine token or API key always gets
  in and clears the address's record.
- **Plan usage stopped polling after one request never answered.** On BEAST the token's first
  request never settled, so the poll kept its in-flight mark and every later poll (the token's and
  this host's login) was skipped: the token said "not fetched yet" for hours and the host login
  kept its numbers from before the weekly reset. Every request now has the tracker's own 75 s
  deadline, a failure of any kind becomes "usage unknown: <reason>", and a poll older than the
  interval no longer blocks the next one.

- **The agents' token showed this host's login's usage.** Its request went through the CLI, which
  answers with the claude.ai login stored on the machine whatever token it is given. The token is
  now sent to the usage endpoint itself; a failure shows "usage unknown" with the reason, and
  numbers saved by the old request are dropped. While the endpoint rate-limits the token (429), its
  weekly and 5-hour numbers come from the rate-limit headers of a one-token Haiku request made with
  the same token. Each poll logs which credential it used and
  whether it answered.
- **Messages sent from another device now show up.** A page whose WebSocket had died silently (a
  laptop asleep, a phone suspending the tab, a dropped connection) kept it as if open and showed
  nothing new until a reload. The server now pings every 15 s and drops sockets that stop
  answering; a page that hears nothing for 45 s (checked on a timer and when it comes back into
  view) opens a new socket and refetches what it missed.

- iPad with a hardware keyboard, in Safari and Chrome: the message box is no longer a form field, so
  Chrome's AutoFill bar (passwords, cards, addresses) has nothing to attach to, and the app keeps its
  full height under the keyboard's bar instead of leaving an empty band. Focusing the box no longer
  shifts the page up; only the on-screen keyboard lifts the composer.
- The caret stays where it belongs when the page moves under it (a keyboard coming up or going away).
- iPad with a hardware keyboard: Enter sends and Shift+Enter makes a new line, as on a desktop.
  Phones and tablets typing on their own on-screen keyboard keep Enter for a new line.
- The details sheet and the settings dialog no longer scroll sideways on phones.

### Added

- `web/mock`: a mock backend with a busy day in every state, for working on the UI.
- `docs/ui-review.md`: the review, and what changed.
- E2E: iPad projects in Safari and in Chrome (its `CriOS` user agent on WebKit) for `e2e/ipad.spec.ts`.

## [0.1.0] - 2026-09-24

The first versioned release. It records what FF Factory already does, plus the engineering setup
that starts with it.

### Added

- **Versioning.** One semantic version in `package.json`, shown with the git commit in the sidebar
  footer, the settings sheet, the orchestrator's `system_status` tool and `GET /api/health`
  (`{ ok, version, sha }`). The `[app restarted]` summary says which version the app moved from and to.
- **CI and tests.** GitHub Actions run typechecks, the unit tests with coverage, the web build, a
  Playwright suite (desktop Chromium, Pixel-sized Chrome, iPhone-sized WebKit) against a server with
  a scripted fake agent, gitleaks, and a check that every new commit uses a noreply email.
- **Sandboxes.** A git worktree per work stream on its own branch, with a copy of a warm Unity
  `Library/` (a near-free block clone on a ReFS Dev Drive), its own Unity editor on the GPU, and the
  real git state (branch, dirty files, ahead/behind, open PR) in the sidebar.
- **Orchestrator.** A chat-first main page whose agent has tools to create, relabel and delete
  sandboxes, start and stop Unity, start, message, interrupt and stop workers, read transcripts,
  switch branches, check machine load and plan usage, and update or restart the app. The same tools
  are served over MCP at `/mcp` for other Claude Code sessions.
- **Worker agents.** Claude Agent SDK sessions per sandbox with live transcripts, interrupts,
  permission modes and Allow/Deny cards, and a guard hook that blocks pushes to the game repo's
  main branches, force pushes, protected paths and other editors' Unity instances.
- **Standing agents.** Long-lived agents with a charter, an interval, cron or manual schedule,
  per-run and per-day budgets, read-only tool groups by default, and delegation requests that the
  user approves.
- **Machines.** Macs added over ssh run a daemon that connects back to the portal and runs agents in
  the user's main clone, with the same session code and extra guard rules.
- **Voice.** A mic in every message box with local Whisper transcription primed with project words,
  and a hands-free voice mode that reads replies with local Kokoro TTS and supports barge-in.
- **Notifications.** Web Push per device with a toggle for each kind (permission waiting, turn
  finished, errors, standing-agent runs, delegations), including the iPhone Home Screen app.
- **Images.** Paste or attach images in any message box, see screenshots agents take or mention
  inline, and browse each sandbox's Screenshots gallery.
- **Search.** Full-text search over every transcript, filtered by sandbox, machine, agent and date.
- **Restart and auto-resume.** Restarts and updates drain busy agents, record what to resume, and
  bring the interrupted workers back afterwards with a summary for the orchestrator.
- **Unity watchdog.** Editors stuck on a dialog or a silent log are marked blocked and reported;
  known harmless dialogs are dismissed automatically.
- **Open source.** Published under the MIT license with a scripted republish that keeps private
  history and identities out of the public repo.

[Unreleased]: https://github.com/Final-Factory/ff-factory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Final-Factory/ff-factory/releases/tag/v0.1.0
