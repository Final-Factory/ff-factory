# Changelog

All notable changes to FF Factory are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0 a minor bump may break things.

Add your change under **[Unreleased]** in the same pull request. `npm run release -- minor` (or
`patch`, `major`, `X.Y.Z`) moves those notes under a new version, bumps `package.json` and
`web/package.json`, commits and tags `vX.Y.Z`.

## [Unreleased]

### Fixed

- **A redeploy whose ssh step fails no longer locks the machine out** (w568, found in w513). `register` replaced the
  machine's token before the deploy's ssh step; when that failed, the machine kept its old token and its daemon's next
  reconnect was refused. The new token is now staged beside the current one (`next:<id>` in `machine-tokens.json`):
  both work until the machine's daemon connects with one of them, which then stays; a deploy that fails before its
  install step drops the staged one. Tests: a failed ssh step (the old daemon reconnects), a successful redeploy (the
  old token stops working once the new daemon has the new one), a failure during the install (the machine's next
  connection settles it).
- **A RAM-backed temp folder is no longer taken for the disk** (w566, Lothsahn: "Why are you reporting that fff-portal
  only has 1.9GB free when it has 101GB free?"). The clean-up measured the fullest of the home folder's, the temp
  folder's and `hostDiskPaths` volumes, and on the portal VM `/tmp` is a tmpfs of half the 4 GiB RAM (Ubuntu 26.04), so
  `system_status`, the dashboard and the "cannot free enough disk space" notice said 1.9 GB free, below the 60 GB soft
  threshold, and it ran its low-space mode every 15 minutes. Now the disk is the home folder's and the data folder's
  volumes (and `hostDiskPaths`; on a machine, the clone's and the sandboxes'); a tmpfs or ramfs never counts, and the
  temp folder is shown apart, labelled RAM or a disk volume of its own, unless it is on that disk. The host guard's warn
  and critical levels already measured only the data volume and `hostDiskPaths`.
- **The cut-over prints the exact FFBox commands that move its connector to the new portal** (w537). After the first
  cut-over FFBox stayed offline: its connector still dialled BEAST's old URL (answering 502), because `fff.url` is
  rendered into its unit by root on the FFBox host and the step was one line among others. `fffctl migrate --cut-over`
  now ends with the `sed` of the old URL to the new, the `06-services.sh --check` that must name only
  `fffconnector.service`, the `--install` and the check, each with what it should print; RUNBOOK section 5 has the same.
- **The portal VM reaches its machines over ssh again** (w537). The cut-over left the VM without the machines' ssh
  aliases and host keys, so every daemon redeploy failed on "Host key verification failed". `deploy/vm/guest/machines.ssh`
  lists the machines (alias, MagicDNS name, ssh user) with each ed25519 host key pinned (checked on two paths from
  BEAST); `fff-machine-ssh --fix` writes them into the portal account's `~/.ssh/config` (one managed block,
  `StrictHostKeyChecking yes`) and `known_hosts`, refusing a machine that shows another key, and `--check` reports each
  machine and prints the `authorized_keys` line for one that refuses the portal's key. The guest install runs it,
  `fffctl update` runs it when `machines.ssh` changes, and `deploy/vm/host/machine-ssh.sh --check|--fix` runs it in a
  VM from the host (RUNBOOK section 9).

### Removed

- **The portal no longer runs workers, sandboxes, Unity editors or standing agents itself; machine daemons do** (w510,
  asked by Lothsahn, 2026-10-06: "Let's just delete that and all the code around running portal processes directly
  (except those necessary for the orchestrator and dispatcher). The new model is the portal runs the orchestrator and
  dispatchers, and workers are run and installed separately. The same machine could run workers, but they'll always be
  under a different process." and "Yes, I expect we can never rollback BEAST, and that's OK."). The portal runs the
  orchestrators (people's own and the dispatcher), the web page, the ledger, intake, timers and the providers/FFBox
  connector. BEAST's sandboxes are its own daemon's (`add_machine local`, still supported); after the VM cut-over BEAST
  becomes an ssh machine (`convert_machine`, kept) and the daemons are re-pointed with `relocate_machines` (kept).
  `fffctl migrate` (w499) is kept. Portal-only mode (config `hostSandboxes: false`, w464) is the only mode.
  - Gone: `SandboxManager` (`server/sandboxes.ts` keeps only `slugify`, `branchProblem`, `normalizePurpose`,
    `withBaseRepoLock`, `pickEditorLog` and `pruneEditorLogs`); host worker sessions (`Agents.workerOptions`,
    `workerBrief`, `workerTools` with `mcp__sandbox__*` and `wait_for_unity`); the host Unity watch
    (`server/unityBlocked.ts`, the host parts of `watchdog.ts`, `unityHang.ts`, `unityMcp.ts`, `wake.ts`,
    `switchBranch.ts`); the "this host" place in the Capacity block and placement (`set_app_config placement.*` refuses
    "this host" and "host"); the "Unity editors running N/M; live agents N/M" line of `system_status`;
    `SessionManager`'s host limits (`limits.maxSessions`, `limits.maxIdleAgents`, `startGate`); `MachineManager.localGate`;
    the host guard's drive watch for the portal (`HostDeps.watchDrive`: the portal passes false and watches its data
    volume and `hostDiskPaths`; BEAST's daemon's guard owns its drive, unchanged); `host_recovery` actions `remount`,
    `trim`, `compact`, `selftest` and `reboot` (`cleanup` stays; `machine_daemon restart` makes the daemon's guard try
    the mount again); the portal's browser reaper wiring (the daemon reaps); `migrate_host_sandboxes` (to the machine
    and back), `server/hostMigration.ts`, `scripts/host-migration.ts` and the portal side of `adopt`/`release` (the
    daemon still answers protocol 6); the elevated server's refusal to start Unity (the elevation check and the hand-off
    to the Limited task stay, because the orchestrators' shells inherit the token); `supervise.ps1`'s wait for the
    sandbox drive at start; `ResumeFile.editors`; `AppState.sandboxes` and the `sandbox` / `sandbox_removed` events; the
    web host sandbox page (an old `#/sandbox/<id>` link opens that name on this host's own daemon).
  - **Standing agents** need a machine: `create_standing_agent` and `update_standing_agent` require one. One from before
    with none keeps its record and conversation but never runs (a manual run is refused, a scheduled one is recorded as
    skipped, with the reason), and `system_status` names it ("Standing agents with no machine …"); giving it a machine
    is the way out. Standing agents with a machine keep running (the portal-only mode of w464 skipped those too).
  - **Retired config keys** (`RETIRED_CONFIG_KEYS`, `server/config.ts`): `hostSandboxes`, `librarySeed`, `librarySeedGB`,
    `librarySeedCopy`, `limits.maxUnity`, `limits.maxSessions`, `limits.maxIdleAgents`, `limits.maxSandboxes`,
    `limits.minFreeGB`, `unity.editorPath`, `unity.extraArgs`, `unity.watchdog`, `unity.hang`, `unity.autoRestart`,
    `claudeAccounts.standing`. A config that sets one still loads; it is named once at startup and in `system_status`
    and ignored. `set_app_config` no longer takes `limits.maxUnity`, `limits.maxSandboxes`, `limits.maxSessions` or
    `claudeAccounts.standing`. Kept and still read: `sandboxRoot` (this host's own daemon's sandbox root, and the default
    parent of `review.root` and `standingRoot`; optional), `standingRoot`, `unity.idleStopMinutes` and `unity.mcpServer`
    (handed to that daemon), `limits.minFreeRamGB`, `hostGuard.*` and `hostDiskPaths`. `add_machine local` no longer
    takes limits or the Library seed from the config: pass `max_sandboxes`, `max_unity`, `library_seed` and the rest to
    `add_machine`. The VM migration (`server/vmMigration.ts`) leaves the retired keys out and no longer writes
    `hostSandboxes`.
  - **BEAST cannot go back to host sandboxes.** The rollback `migrate_host_sandboxes back` and the offline
    `node scripts/host-migration.ts back` are gone. The rollback to the BEAST portal after the VM cut-over (relocate back,
    then `convert_machine` to "local") still works.
  - Docs: [beast-machine.md](docs/beast-machine.md), [machines.md](docs/machines.md), [restart.md](docs/restart.md),
    [self-recovery.md](docs/self-recovery.md), [standing-agents.md](docs/standing-agents.md),
    [accounts.md](docs/accounts.md), [unity-lifecycle.md](docs/unity-lifecycle.md),
    [unity-dialogs.md](docs/unity-dialogs.md) and the README follow it; `docs/backlog.md` item 1 is done. Tests:
    `server/portalOnly.test.ts` and `server/unityBlocked.test.ts` are deleted with their code; the others follow the removal.

### Changed

- **The portal VM keeps `/tmp` on its disk** (w537). Ubuntu 26.04 mounts `/tmp` as a tmpfs of half the RAM: 1.9 GiB
  in the 4 GiB VM, with no swap, holding the agents' temp folders, and the portal's clean-up reported it as 1.9 GB of
  free disk on the first day after the cut-over. The guest install masks `tmp.mount` (systemd's way back to the disk;
  from the next boot), and the VM end-to-end test checks `/tmp` is on the root filesystem after the nightly reboot. A
  VM installed before: RUNBOOK section 8.
- **The nightly cold restart applies a size changed in `/etc/fff-vm/fff-vm.conf`** (w537, Lothsahn: "Can we make it do
  that during the update automatically?"). With the VM off, `fff-vm nightly` (and `--now`) defines the domain again
  from the settings, logs what changed, keeps libvirt's previous definition (`/etc/fff-vm/domain.libvirt-prev.xml`), and
  defines that one again with an alert if libvirt refuses the new one, the VM does not start with it, or the portal does
  not answer within 15 minutes; that size is not tried again until the settings change. `install.sh` and the nightly
  share the domain's template (`domain_xml`, `deploy/vm/host/lib.sh`); `install.sh` no longer redefines a running VM
  and says what the nightly will apply. `fff-vm status` shows the VM's real size and any change waiting. Fixed on the
  way: a redefinition of the existing domain was refused by libvirt ("domain 'fff-portal' already exists with uuid
  ..."), because the definition carried no uuid; it now carries the domain's. A host installed before this updates its
  scripts once (`install.sh --host-only --yes`, RUNBOOK section 7).
- **A machine with sandboxes takes workers in them only, whatever its `max_agents`** (w536, asked by Lothsahn: "Can't
  we get rid of this code so the settings doesn't matter?"). `start_agent` with such a machine alone is refused, naming
  its sandboxes, and its daemon refuses too. There `max_agents` caps only its standing agents. Only a machine without
  sandboxes (the m3, the m5 until their worker-root installs) still runs workers in its main clone; the rest of the
  main-clone code goes once they have roots ([docs/machines.md](docs/machines.md), "Limits").

- **The portal VM has 4 GiB of RAM, not 8** (w537, Lothsahn: "Change the VM to 4GB ram"). `fff-vm.conf.example`'s
  `VM_MEMORY_MB=4096`, so a rebuilt VM and CI's nested VM boot that size. Basis, measured from w442's 20-hour run on
  BEAST: the whole portal (the node server and every Claude process under it, summed per sample) peaked at 1,134 MB
  resident and 2,470 MB Windows private (p99 876 MB and 1,942 MB). The runbook's new section 7 says how to change the
  size of a running VM: the setting, `install.sh --host-only --yes`, `fff-vm nightly --now`, and what to check.

### Added

- **The token vault** (w512, [docs/vault.md](docs/vault.md); lothsahn: "store a list of claude tokens and any other
  tokens the workers need so that it can pass it out securely to the workers in the cluster at runtime").
  - The portal keeps Claude subscription tokens, a GitHub token and named secrets in `data/vault.json`, each value
    sealed with AES-256-GCM under a key outside the data folder (in the VM `/etc/fff/vault.key`, root only, handed to
    the portal as a systemd credential). A value is never shown back: listings give a fingerprint and its last four
    characters.
  - Owners add, rotate, grant and remove entries in Settings → Token vault, or with `sudo fffctl vault` (a value from a
    file or stdin, never the command line). Members get 403; no agent tool reaches it.
  - Each machine run gets what it is granted as environment in its launch spec: one Claude token, picked by plan
    headroom (the person's own first, nothing at 95% or more while another has room, sticky per session) on machines
    config `machines.claudeFromVault` names; `GH_TOKEN` with a git credential helper that reads it; any `*_TOKEN`
    variable such as `FFDISCORD_APP_TOKEN`. Nothing is written on the machine. Off until switched on per machine.
  - Machine credentials: `fffctl machine-credential issue <id> --out FILE` and `revoke <id>` (also in the dialog); a
    revoked machine's link drops within 20 s.
  - Redaction also covers GitHub tokens and every value the vault holds.
- **Whose tokens, and the tokens on the FFBox host** (w512, lothsahn 2026-10-06: "hand out my Claude and GitHub tokens
  for requests from my orchestrator and the same from Ben's"; [docs/vault.md](docs/vault.md) sections 10 and 11).
  - A worker run gets the Claude and GitHub tokens of the person its work is for, never another person's. Work nobody
    asked for by name runs on config `vault.unattributed`: intake and FFBox work on lothsahn's, the nightly lab and the
    nightly regression sentry on Ben's; FFBox work naming an operator on the operator's. Intake requests filed for
    nobody are marked `unattributed`.
  - Each person's tokens are kept on the FFBox host in `/etc/fff-vm/secrets/people/<user id>/` (root only), and
    `sudo fff-vm vault-sync` pushes them into the VM's vault over ssh's stdin (also run by the installer), refusing a
    classic GitHub token, and keeps the vault key's spare copy in `/etc/fff-vm/secrets/vault.key`.
  - `fffctl vault put` (idempotent) and `list --names`; the VM's daily backup leaves `data/vault.json` out.

### Changed

- **Standing agents' delegations are ordinary ledger requests** (w527, Ben: "please fix the delegations in ff factory
  so you can queue up regression fixes, ideally I would not have to even click anything though").
  - **Filed, not placed:** an approved delegation is filed for the agent's owner with its task verbatim, and the
    dispatcher queues, places and starts it like any request. The portal no longer looks for an `unused` sandbox
    itself (it only ever saw its own host's and BEAST's, never other machines' sandboxes), and nothing expires.
  - **No clicks for routine ones:** auto-approve files them at once within its per-run and per-day limits; the
    nightly regression sentry has it on by default. Spending money, publishing, settings, releases and master always
    wait for a person.
  - **For the rest:** Approve queues it without a free slot; Start now makes its request urgent; a person's own
    orchestrator can approve in their own words.
  - **Shown like any request:** `list_work`, the Requests tab ("from <agent>"), `my_delegations`; the same request
    again is that request. Today's four sentry requests link to w524, which started them by hand.

- **CI's Windows unit tests run on two runners** (w521, asked by Lothsahn). The same test files: the three slowest on
  one (with the typecheck, the web build and the named machine-sandbox step), every other file on the other.
- **`fffctl update` waits until the new release is verified, and says what is happening** (w517, Lothsahn: "sudo
  fffctl update just says it scheduled it. How do I know when it's done? I'd prefer it be a blocking operation").
  - **Stages shown:** the build (or "already up to date"), the drain (agents still busy, time left), the restart, the
    new code answering, then verified, or rolled back with the reason.
  - **Exit codes:** 0 when verified, 1 on a failed build or a rollback, 2 on a timeout, with the `journalctl` command
    for the details.
  - **Same machinery underneath:** `data/update.wanted`, `fff-update request`, the drain, `activate`, and fff-health's
    `verify`, followed from outside through the units, the journals, the status files and `/api/health`, so
    `request_app_update` works as before.
  - **Ctrl+C** stops the waiting, not the update. `--no-wait` keeps the old behaviour. `fffctl restart` shows the
    drain, and `fffctl rollback` waits until the portal answers with the release before.
  - **Progress lines:** on a terminal (PuTTY's defaults too) they are rewritten in place with `\r` and `ESC[K`, never
    moving the cursor; elsewhere a plain line at most every 30 s. The same for `fffctl migrate`, without the indent.
- **`fffctl migrate` compresses the copy** (w517, Lothsahn: "use zstd level 3 ... Don't error. Fallback to gzip or bz2
  or finally send uncompressed").
  - **Choice:** zstd level 3 through BEAST's own tar.exe (bsdtar 3.8.8, built with libzstd), else gzip, else bzip2,
    else none, whichever both sides take. It is tried once per run on a small file; a broken connection is retried
    and is never read as "unsupported". `--compress` picks one first.
  - **Output:** it says which it chose and why not a better one, and each part reports the bytes of files against the
    bytes over the wire.
  - **The guest install** adds `zstd` and `bzip2`.
  - **Measured on BEAST's route with 698 MB of real JSONL:** zstd 3 sent 210 MB (3.3x) in 2.1 s of BEAST's time;
    gzip 392 MB (1.8x) in 12.9 s; uncompressed 2.7 s. The zstd stream unpacked into all 77 entries.
- **No claude.ai connectors for the orchestrators and the dispatcher** (w516, Lothsahn: "Please do an update to disable
  the gmail, drive, and calendar tools", then "Disable claude docs"). Their 58 tools (Gmail 30, Google Drive 11, Google
  Calendar 9, Claude Docs 8) were about 41,300 input tokens in every orchestrator and dispatcher turn (measured: a
  person's orchestrator 65,496 → 24,199 tokens, the dispatcher 80,841 → 39,544). Workers and standing agents keep
  them. Config `claudeAiConnectors` sets it per role (docs/accounts.md, "claude.ai connectors").

### Fixed

- **On an Android phone the paperclip offers your photos** (w528, Ben: "when i'm on my phone i cant attach photos from
  my google photos or anything i can only select camera"). It opens a short menu: Photos and videos (Chrome's photo
  picker, with Gallery and Google Photos), Camera, or Files (saves, zips, logs). Android Chrome shows the photo picker
  only for an input of images and videos alone; the old any-file input got a Camera / Files chooser. iPhones, iPads and
  desktops keep the one picker they had; paste and drop are unchanged.

- **`fffctl migrate` copies from one snapshot on BEAST** (w508, Lothsahn's dry run on #134: "batch 2 of 8 broke off …
  tar: (null)", then his decision: "generate it all in one snapshot, and then tar and compress off a copy").
  - **Cause (measured on BEAST, its own sshd, tar.exe and PowerShell, with writers like the live portal's):** Windows
    tar stops at a file that grows or changes while it reads it. It prints `a <file>` and then `tar: (null)` on the same
    line (bsdtar prints the wrong archive's empty error), exits 1, and leaves the archive cut off in that file:
    | Live writer | tar stopped |
    |---|---|
    | an appended file | 15 of 15 times |
    | the server's redirected `server.out.log` | 5 of 5 |
    | a file rewritten in place | 2 of 5 |
    | a file replaced by rename (the portal's saves) | 0 of 5, but the writer's renames failed 6 times while tar held it |
  - **The fix:** before anything is read, `SNAP_PS` takes a VSS shadow copy of the volume (through a link in BEAST's
    temp folder; recorded at once so a run that dies has it removed by the next), or else a staged copy (robocopy,
    backup mode when elevated, after a free-space check), and says which. The listing, every stream, every retry and
    the files sent one by one all read from it. `DROP_PS` removes it at the end, on a failure and on Ctrl+C (link
    first, never what it points to). `--snapshot auto|vss|copy`.
  - BEAST's tar runs with `-v`. A file it still stops at is taken out of its stream and sent through PowerShell, and the
    stream goes on (measured on BEAST against real bsdtar with live writers: 3 files stopped at, 5 of 5 copied).
  - The progress line counts the bytes of the files unpacked and never goes back on a retry. OpenSSH's post-quantum
    warning about BEAST's 9.5 server is left out of BEAST's messages.
- **The ledger's PR states are fresh, and a DONE is not refused on a merged PR** (w515, Lothsahn: "How can we fix PR's
  having the wrong status?"). w443, w449, w454, w484 and w489 were each refused "PR #N is still open" seconds after
  their PR merged (#1087, #1080, #1089, #1092, #1095), and nothing looked again, so they sat in "Merged, follow-up
  pending" until a person closed them; w443 still listed #1087 open after that.
  - **Cause:** the 5-minute PR pass skipped every request with a running or waiting worker, which is exactly when its
    PR merges and its DONE comes, and every closed request, so their cached states froze. A refused DONE was never
    checked again.
  - **The fix:** a DONE on a request with an open PR reads that PR live (`gh pr view`) before deciding; gh failing says
    "couldn't verify PR #N" instead of "still open". The 5-minute pass now refreshes the states of every request's linked
    PRs (busy and closed ones too, by number beyond the 200-PR list, at most 30 a pass), a report saying a linked PR
    merged reads it live at once, and a DONE refused then closes the request once its PRs merged and nothing else is
    missing. The first pass after the deploy reads every PR the ledger holds as open and logs, for each merged request
    still open, why it stays open.
  - **Two rules made precise:** a release is a title that cuts, ships, names or posts one (w487's "Add a patch notes
    line" and w395's "the release pipeline" are not); a 2-peer check or paired audit is a step after the merge only
    where the brief puts it after the merge (w408 and w411 ran theirs before merging).

- **`fffctl migrate` copies from BEAST again, and says what it is doing** (w508, Lothsahn's dry run stopped at "tar:
  Unexpected EOF in archive" after a long silence).
  - **Cause (measured on BEAST through its own sshd):** OpenSSH for Windows 9.5p2, with cmd.exe as its shell, does
    not hand a command its stdin whole. `tar -T -` got part of its file list, garbled, and never its end: with 2,000
    names it packed 496 and then waited forever, so the archive never ended. Its process was still waiting 22 minutes
    later. A PowerShell script with its data gets through up to 128 KB, and not at 256 KB.
  - **The fix:** nothing large goes to BEAST on stdin any more (32 KB at most, refused before ssh otherwise). The
    listing keeps its file list on BEAST, and each stream of at most 2,000 files and 256 MB is named by line numbers,
    written to a list file there, and sent by `tar -T <file>` with ssh's stdin closed. Each stream is checked (the
    archive whole, BEAST's tar's exit code and its own messages, always shown) and tried again up to 3 times, and a
    stalled one is ended after 2 minutes.
  - Files tar on Windows cannot take (names outside its code page) come through PowerShell, which names a file it
    cannot open, or one that went, instead. The manifest names only files unpacked whole, written after each stream,
    so a stopped run is resumed by the next.
  - **Progress:**
    - "listing BEAST's files..." with the count and size;
    - a line every 5 s with files and bytes done, the rate and the time left;
    - each part's time;
    - the same in `--cut-over`.
  - Tests:
    - against the real route on BEAST: its own sshd.exe as a private loopback instance, its tar.exe and PowerShell
      5.1, on a synthetic folder of 20,007 files and 340 MB with a locked file, Unicode names, a path over 260
      characters and a file deleted mid-copy. 20,005 files arrive byte-identical, the locked one and the deleted one
      are named, and the next run copies 2;
    - in CI, the fake BEAST now gives tar no stdin, as BEAST does, and caps PowerShell's at 64 KB. A new test cuts
      streams (retried; then always, stopped with BEAST's message and resumed) and covers a name tar cannot take, an
      unreadable file and a vanished one.
### Changed

- **CI's Playwright tests run in three shards** (w521, asked by Lothsahn). The same tests split across three runners by
  file (`playwright test --shard`), the performance budgets in the first; rendering visual baselines still runs every
  test in one job, so the `linux-snapshots` artifact is whole.
- **Waiting says on what, and only means alive with something pending** (w509, asked by Lothsahn: "aren't waiting jobs
  waiting on tests or other things to run?"). A Waiting agent shows its running job by the description it gave it
  ("Waiting: CI on PR #1098 · check-in 06:10"), a queued message, or its check-in with its note's first words, and a job
  is told apart from a timer alone. A stopped agent is never Waiting ("Stopped (resumes at check-in tomorrow 00:08)"),
  an overdue check-in does not count, and times carry their day. Sandboxes are listed by status (Working, Waiting, Idle,
  then none live) on the Overview, the sidebar and in `list_sandboxes` ([docs/orchestrators.md](docs/orchestrators.md),
  "Agent states").

### Added

- **Orchestrators compact their conversations by themselves** (w535, Ben: "can you just compact yourself when youre
  starting to get full?"). After a turn, once the context passes 200,000 tokens (`orchestrator.compactAtTokens`) or a
  turn cost $1 or more with 100,000 tokens or more (`orchestrator.compactAtTurnUsd`), FF Factory runs Claude Code's
  `/compact` with a focus that keeps open requests, unanswered questions, decisions and ids; the dispatcher too. Only
  between turns, never ahead of an unanswered message; one chat line when it is done ("Compacted: 525,115 → 57,292
  tokens (automatically: …)") and no notification. The header shows each orchestrator's context and its last
  compaction; an orchestrator can ask for one itself (`compact_conversation`). Measured on a copy of Ben's orchestrator,
  a turn's cost went from $0.21 at 521k tokens to $0.10 at 70k. Details: docs/orchestrators.md, "Automatic compaction".
- **`/compact` compacts an orchestrator's conversation** (w518, asked by Lothsahn: a long conversation cost $20.54 for
  one short reply). `/compact` or `/compact <focus>` typed in your own chat, or Compact conversation in its menu, runs
  Claude Code's own /compact on that conversation instead of sending the text to the model; owners have the same button
  on the dispatcher's page. The chat says when it starts and, when it is done, the context measured before and after.
  Mid-turn it is refused with why; it leaves the `wake_me` check-in and timers alone, and messages arriving meanwhile
  are answered after it. `/clear` (or `/new`) opens the New conversation dialog. Details: docs/orchestrators.md,
  "Compacting a conversation".
- **The portal VM's CI runs only when a change needs it** (w505, part 2, asked by Lothsahn).
  - Until now every PR touching `server/agents.ts` (most of them) waited on three nested-VM jobs. Now a plan job picks
    them:
    - the representative job (a zvol on a 24.04 host) for a PR touching `deploy/vm`, `server/restart.ts`, the
      packages, or `server/index.ts`'s restart, drain, inbox or health code;
    - all three when the host scripts, the test or the workflow change, on every merge to main, and nightly;
    - none for any other PR.
  - One nightly job keeps the production timing.
  - The dry run's "changed nothing" checks on the firewall table and libvirt can fail now (a `!` under `set -e` never
    did).
  ([docs/portal-on-ffbox-host.md](docs/portal-on-ffbox-host.md), 10.3)
- **The portal VM's end-to-end jobs wait less, and pass on main** (w505, part 1, asked by Lothsahn). The test now sets its
  own short health, update-verify, stop and watch timers (`CI_TIMING=fast`, the default; `production` runs the shipped
  defaults), so the rollback, health-restart and hang scenarios take seconds instead of minutes; the shipped defaults
  are unchanged (`UPDATE_VERIFY_SEC`, new, is empty). The runs on main, which had failed since #108 because the
  checkout is main and `git branch -f main` refused, now pass.

- **`fffctl migrate`: the portal moves from BEAST into its VM with one command run in the VM** (w499, asked by Lothsahn:
  "I'd ideally like the new orchestrator to be able to connect to beast and just download everything directly"). It
  pulls BEAST's `config.json`, `data\` (without `data\tools` and the supervisor's files) and the conversations the
  orchestrators, the dispatcher and BEAST's standing agents resume (change 10, under their new folder names). It uses
  ssh with the portal's own key: `--key` prints the `from=` line to authorize on BEAST.
  - `--dry-run-copy` snapshots the VM's own portal, pulls (read-only on BEAST: it lists files and runs `tar`), and
    rewrites the copy for Linux. The rewrite covers the paths, `publicUrl`, BEAST from local to ssh, every machine's
    portal URL, the outside watch without BEAST's MAC, the token-file accounts, voice off, the portal-only mode, and
    BEAST's workers kept on their account. It then starts the copy with `FFSB_DRY_RUN=1` and the Funnel off, and
    checks it: health, no restored data, counts, and the dispatcher's conversation resuming on the token file. Run
    again, it copies only what changed.
  - `--rollback-dry-run` puts the VM's own portal back and wipes the copy and its secrets.
  - `--cut-over` asks for a typed `CUT OVER`, has BEAST's portal drain, relocate its daemons and hold, then stops it,
    disables its task, copies the rest, starts the VM's portal and checks the daemons' hellos. It rolls everything back
    by itself if the VM's portal does not come up, and leaves BEAST running if its code is too old to relocate.

  Secrets travel only over ssh; the pulled copy is root-only (0700) and the installed data `fff`'s (0600); no token is
  printed or put on a command line. `scripts/fff-migrate.ts`, `server/vmMigration.ts`, `deploy/vm/guest/fff-migrate`;
  `deploy/vm/RUNBOOK.md` sections 4 and 5. Tests:
  - `server/vmMigration.test.ts`: the rewrites;
  - `scripts/fff-migrate.test.ts`: end to end against a synthetic BEAST through a fake ssh that runs BEAST's
    PowerShell under pwsh and its tar as tar, with real portals on both sides and a real daemon moved at the cut-over
    (Linux CI);
  - the VM end-to-end: `fffctl migrate --key` in a real guest.
- **The old portal sends its daemons to the new one at the cut-over** (w499): `restart.request` takes `relocate: "<portal
  base URL>"`. Once the drain is done the server relocates every connected machine daemon there (as
  `relocate_machines` does), writes each one's outcome to `data/relocate.result.json`, and only then writes `drain.done`
  and holds (or stops). A URL that is not a portal base URL refuses the whole request, with the reason in the result
  file. `MachineManager.relocateAll`, which `relocate_machines` now uses too. The VM's `fffctl migrate --cut-over` writes
  this request to BEAST's portal over ssh, so the daemons move while the old portal still answers their acks. Tests:
  `server/restart.test.ts` (order, refusals, a failing relocate) and `server/relocate.test.ts` (a real daemon moved by
  such a request).
- **FFBox shows a player's report fixed once its fix ships** (w502, asked by Lothsahn). A finished request that claims
  a crash or desync report (its subjects, a report its title names, an intake diagnosis that joined it, or a
  `Report: <id>` line in its merged PR) now tells FFBox `report_fixed` with the PR and the release once the fix is
  merged and released; FFBox records it on the report and marks its diagnosis FIXED, and posts nothing. `update_work`
  takes `subjects` to add reports a request turned out to fix. Once, at start-up: w414 is linked to the two Build 76
  crash reports PR #1064 fixed, and finished requests that only mention reports are listed for Lothsahn
  (`node scripts/report-sweep.ts <data copy>` lists the same). Workers put `Report: <id>` in fix PRs
  ([docs/intake.md](docs/intake.md), "Players' reports a request fixed").

- **A dry-run switch, `FFSB_DRY_RUN=1`** (w499, change 17 of docs/portal-on-ffbox-host.md): a portal started with it
  runs on a copy of another portal's data and acts on nothing outside itself, so the VM can load BEAST's copy and be
  checked while BEAST's portal keeps running. Off: wakes and the orchestrator heartbeat, timers (loaded to show, never
  due), standing runs and Run now, intake polls and the ledger sweep, web push (the test push too), the FFBox connector
  link (503), Discord (Max), every machine daemon link (503), deploys, redeploys, daemon start/stop/restart, removing a
  machine, relocate, the offline and outdated redeploys with their ssh probes, the outside watch, the orchestrator
  memory's git push, the usage poll, everything the resume after a start would do (resumes, restart notes, the pending
  update), the orchestrator inbox, the copied send queue, `republish_public`, and starting any Claude process but an
  orchestrator a person writes to. Config `claudeEnv` and `userClaudeEnv` are ignored (in memory; the file keeps them),
  and `set_app_config` refuses to set them. `/api/health` answers `dryRun: true`, the log starts with a `DRY RUN` line,
  and every page shows a red bar that cannot be dismissed. `server/dryRun.ts`; tests in `server/dryRun.test.ts` (each
  part, plus the real server booted on copied-looking data) and `e2e/banner.spec.ts`.
- **The portal VM installs with one command, and asks for what it needs** (w498, asked by Lothsahn).
  `sudo deploy/vm/host/install.sh` now installs the host side and then the portal inside the VM, and sets it up:
  - Lothsahn's subscription token, the Tailscale join with the Funnel, GitHub and the base clone;
  - config.json (`ownerName`, `publicUrl`, the orchestrators and the dispatcher on the token file);
  - the backups.

  It asks first, before changing anything, for the ZFS dataset and its mountpoint, the time zone, the ssh key, the
  ntfy URL, the owner name, the tokens and the backup target. It checks each answer and stores it in `/etc/fff-vm`
  (secrets root-only in `/etc/fff-vm/secrets`), so a re-run or `--rebuild-vm` asks nothing it knows. Without a
  terminal or with `--yes`, a missing answer stops it with the list and nothing changed. It ends with the few lines
  only a person can add, such as the deploy key's `from=` line for each machine.
  ([deploy/vm/RUNBOOK.md](deploy/vm/RUNBOOK.md))

- **The portal in its own VM on the FFBox host: design and install scripts** (w441, Lothsahn's request to make w439,
  the container design, a VM). The portal moves into a KVM/QEMU VM that libvirt manages. It has its own isolated
  network: NAT out to the internet only, with an nftables table that keeps it away from the host, FFBox's containers
  and the LAN, and everything on the host but root away from it. Tailscale and Funnel run inside it. `deploy/vm/host`
  installs it (idempotent, `--dry-run`, refusing anything not its own) with hang detection, a watchdog device, and a
  nightly drain, cold restart and snapshot. `deploy/vm/guest` sets up the portal inside, with `fffctl`. An updater
  (`fff-update`) builds the new code beside the running server, switches at the drain's restart and rolls back by
  itself, so `request_app_update` works under systemd: `server/restart.ts` `systemdSupervised` and
  `writeUpdateWanted`. Lothsahn's decisions so far are in the doc's table: his subscription token (`claude
  setup-token`) for the orchestrators and the dispatcher, stored in the VM's `secrets/` (`fffctl claude-token`), which
  FF Factory passes to those sessions only once code change 18 is in; BEAST's Dev Drive recovery moves into BEAST's
  daemon; the guest is Ubuntu 26.04 on a zvol, on a 24.04 or 26.04 host; no standing agents run in the VM. There is
  also a read-only footprint measurement for BEAST (`deploy/vm/measure`) and sizing with its basis. CI
  (`vm-scripts.yml`) lints the scripts and runs them end to end in a nested VM, with qcow2 and with a zvol
  ([docs/portal-on-ffbox-host.md](docs/portal-on-ffbox-host.md)).
- **Design: the portal in its own container on the FFBox host** (w439, the request for this design, asked by
  Lothsahn). Design only, nothing deployed: a rootless Podman pod under its own Unix account on FFBox's Linux host,
  Tailscale inside the pod and nothing published on the host, so FFBox and FF Factory share no account, file, daemon,
  network or secret; the isolation options compared, the image, volumes, secrets and backups, container-native
  restarts and updates with rollback, reachability, the Claude account for the orchestrators and the dispatcher, the
  code changes with file:line and size, the migration with a dry run, cut-over and rollback, and the decisions left
  for Lothsahn and Ben ([docs/portal-on-ffbox-host.md](docs/portal-on-ffbox-host.md)).
- **Every Unity process counts toward a machine's editor limit, and launches wait in a queue for a slot** (w469, asked
  by Lothsahn: "Can we just account for every unity editor process that's running?"). LothDesktop reached 63 of 64 GB
  with one interactive editor and three `-batchmode` builds while its limit of 3 counted one. `max_unity` now counts
  every top-level Unity process on the machine (sandbox editors, the owner's own, batch builds and test runs, peer-run
  editors, editors scripts start), not AssetImportWorkers, bcl.exe, the ILPP runner or game players. `unity start`
  takes a slot by the same rule (a restart keeps its own). Every other launch goes through `unity-slot run [--count N]
  -- <command>` (on every daemon agent's PATH; the game repo's scripts use `scripts/unity_slot.py`): all its slots at
  once or it waits; holders first, then oldest first; no two runs ever deadlock; a crashed or silent holder's slots are
  freed within 90 s; nothing is granted above 85% RAM. Unity started outside the gate still counts, and the
  orchestrator hears when a machine goes over and comes back; nothing is ever stopped. `list_sandboxes`,
  `system_status`, the dashboard and `unity status` say "editors 4 of 3: 1 interactive, 3 batch"
  ([docs/unity-lifecycle.md](docs/unity-lifecycle.md), "Unity slots").

- **Agents show Working, Waiting, Idle or Stopped** (w475, asked by Lothsahn). Waiting: between turns but due back, on a
  `wake_me` check-in, a background task or a message queued for it, shown in violet with what it waits on and when
  ("Waiting: check-in at 23:12"). Idle means available. Agents are listed Working, Waiting, Idle, Stopped, the most recent
  first in each, in the Overview, the sidebar, agent tabs, `list_sandboxes` and `list_machines`. A Waiting worker's
  sandbox is not free, the dispatcher gives it no new work but its own, its request shows Waiting instead of Stalled,
  and the ledger cleanup leaves it alone ([docs/orchestrators.md](docs/orchestrators.md), "Agent states").

- **BEAST's daemon guards BEAST's sandbox drive itself** (w466, asked by Lothsahn; change 4 of
  docs/portal-on-ffbox-host.md, decided as D11). The Dev Drive watch, the remount through `ffsb-helper-mount` with its
  retries, then the editors restarted and the interrupted agents resumed, the disk levels and the headless-browser
  reaper run in the portal's own host's daemon (`machine/hostGuard.ts`, the same `HostHealthMonitor`). So they stay
  with BEAST when the portal moves to its VM. While the daemon's hello says its guard runs, the portal's own guard
  leaves the drive to it. Its reports reach the dispatcher as `[host beast] …`, and new sandbox agents and editors on
  BEAST wait with the reason while the drive is gone (docs/self-recovery.md, "On BEAST's daemon").

- **The "tokenfile" account** (w464, asked by Lothsahn; docs/portal-on-ffbox-host.md change 18). `claudeAccounts`
  `.orchestrator`, `.dispatcher` and `.standing` take `"tokenfile"`: those roles run on the OAuth token in the file config
  `claudeTokenFile` names, read at each session start into that process alone with every other Claude credential
  removed, over any person's own token. Refused for workers; never in `claudeEnv`, never sent to a machine, never shown.
  The meters poll it as its own account ([docs/accounts.md](docs/accounts.md), "The token file").

- **A machine can take agents in its sandboxes only** (w477, asked by Lothsahn). `add_machine` takes `max_agents: 0`
  (the Add machine form too). Such a machine never runs an agent in its main clone: `start_agent` with the machine
  alone is refused before any record is made, naming its sandboxes; a standing agent cannot be assigned to it; a
  standing agent's delegated worker never goes to its main clone; and the Capacity block and "Next new game-repo work"
  never suggest it. Its daemon refuses such an agent too. Meant for BEAST and LothDesktop, whose main clones are
  their owners' own ([docs/machines.md](docs/machines.md), "Limits").

- **`claudeAccounts.dispatcher`** (w464, asked by Lothsahn; docs/portal-on-ffbox-host.md change 6). The dispatcher's own
  account (`"token"` or `"login"`, set with `set_app_config`). Once set, the dispatcher runs on it instead of the system
  payer's own token; unset, nothing changes. system_status names it apart only when set ([docs/accounts.md](docs/accounts.md)).

- **Portal-only mode** (w464, asked by Lothsahn; part A of moving the portal into a VM on the FFBox host, w441). With
  config `hostSandboxes: false` this host holds no sandboxes: it leaves capacity, placement and `list_sandboxes`,
  `create_sandbox` here is refused with the reason, `sandboxRoot` and `unity` may be left out, the host guard watches
  the data volume instead of a sandbox drive, `host_recovery` runs only `cleanup`, and no standing agent runs
  (README, "Portal-only mode").

- **BEAST stays the same machine when the portal leaves it** (w466, asked by Lothsahn; change 3 of
  docs/portal-on-ffbox-host.md). `convert_machine {machine, to: "ssh" | "local", ssh_host, portal_url, redeploy?}`
  turns the portal's own host as a machine into one reached over ssh, or back. Only the record changes: its token,
  sandboxes, agents and pool settings stay, its daemon stays connected, and its agents run on. Its later ssh
  redeploys keep the Unity MCP server and idle stop it had from the portal's config. A test runs the whole Windows
  deploy over ssh from a Linux portal against a fake ssh and scp (docs/machines.md, "Moving the portal").
- **Daemons follow the portal to a new URL without a redeploy** (w466, asked by Lothsahn; change 9 of
  docs/portal-on-ffbox-host.md). `relocate_machines {url, machines?}` sends connected daemons the portal's new base
  URL. Each keeps it in its `daemon.json`, drops the link and dials it, with its agents running on and its token
  unchanged. If the new URL has not answered after 10 minutes, it tries the old one too, every other time, so a move
  that never comes up does not strand it. The sending portal does not redeploy a machine that is away. Protocol 8: older
  daemons are redeployed once idle, as after any update (docs/machines.md, "Moving the portal").

- **Stale build and run output is cleaned up by itself on every computer** (w459, asked by Ben). Until now a person
  asked for each clean-up of player builds (w451 freed 42 GB on LothDesktop after its D: hit the guard). The
  continuous clean-up, on this host's guard and on every machine's daemon, now also removes, once a day and whenever
  space is low: builds and e2e runs named after requests that are closed in the ledger, player builds of one commit
  past 2 days, e2e runs past 14 days, the nightly lab's builds beyond its newest two, and a stopped editor's Temp and
  old logs. Only these folders of a sandbox or a clone are looked at, nothing changed within a day goes, nothing
  holding a git repo goes, and what it cannot attribute is listed for a person, never removed. `machine_cleanup` and
  `host_recovery` "cleanup" take `dry_run`; `cleanup_log` shows each computer's passes in full (every removal with its
  size and why); the dashboard's clean-up line counts what was kept for a person. Settings:
  `hostGuard.cleanup.staleOutput`, `machines.cleanup.staleOutput` (mode on, dry-run or off, and the ages)
  ([docs/self-recovery.md](docs/self-recovery.md), "Stale build and run output").

- **Workers keep running through a portal restart or update** (w424, asked by Lothsahn: "Can't we make it restart while
  the workers are going?"). BEAST's sandboxes moved to its own machine daemon, and `machines.keepAgentsOnRestart` is
  on. A restart drains and stops only the portal's own agents (orchestrators, standing agents). Workers on BEAST and
  the other machines go on, and their events while the portal is down are replayed when their daemon reconnects.
  Tested on BEAST before it went on (docs/restart.md, "Agents on machines"). Until a daemon reconnects, its agents show
  "was running when the portal stopped; not heard from its daemon since (it may still be running there)" rather than a
  bare `stopped`. A machine without load numbers yet is no longer said to run a daemon from before protocol 4 unless
  it does.
- **Workers hand files to each other, on any computer** (w447, asked by Ben). A save made on BEAST had to reach three
  LothDesktop workers, and only a person with ssh could move it. A worker now calls `publish_attachment` with a file in
  its working folder or temp folder; it answers an `att_` id, which its orchestrator passes on with `attachments: [id]`
  like a person's file. On a machine the daemon sends the bytes over its own machine token (`PUT
  /machine/attachments/uploads/<id>`, resumable, SHA-256 checked), so no new keys are needed between machines. Orchestrators
  and the dispatcher make an id of a review-folder file with `attach_review_file`. The size cap is `attachments.maxMB`;
  the uploader is recorded ([docs/attachments.md](docs/attachments.md), "Agents' files").

- **FFBox conversations open in FF Factory** (w426, asked by Ben). FFBox's links (the FFBox page's conversations,
  the ledger's "on FFBox", the intake brief) went to its address on Lothsahn's home network
  (https://192.168.51.10:8787/conversation/684), which opens nowhere else. A conversation now opens on FF Factory's
  FFBox page, read through the connector's `conversation` query: its turns, the messages each answered, the agent's
  last words and FFBox's replies, checked and cleaned on the server and shown as plain text. FFBox's own page stays
  as the second link, "on Loth's network" ([docs/ffbox.md](docs/ffbox.md)).

- **A recorded placement preference** (w428, asked by Ben). Config `placement.prefer` (computers in order, e.g.
  `["lothdesktop", "m5", "m3"]`) and `placement.avoid` (computer to reason, e.g. `{ "beast": "BEAST unstable,
  2026-10-05" }`), both settable with `set_app_config` and cleared with null. The Capacity block's "Next new game-repo
  work" line follows them: the first preferred computer with room, then the rest by room, an avoided one only when
  nothing else has room. Main-clone machines (the m5, the m3) are candidates now, with their backup rule named
  ([docs/machines.md](docs/machines.md), "Placing work").

- **Pick several request states at once** (w418 follow-up, asked by Lothsahn). The state chips on the Dispatcher's
  Requests tab, and now on the Intake tab's ledger list, toggle independently (e.g. Stalled and Merged, follow-up
  pending), with "All" and "Clear", and the choice survives a reload. `list_work` takes `state` as one state or a list.

- **`DONE: wNNN`, a wrap-up on switching, and a follow-up on merged requests** (w419, asked by Lothsahn). A worker ends
  its report with `DONE: w342` when every step of a request is finished, post-merge steps included, and the ledger closes
  it with the report as the note; it is refused back to the worker, saying what is missing, while a PR is open or a
  step after the merge is not covered. The dispatcher's message moving a worker to another request first asks it to
  wrap up the ones it was on. The cleanup asks a merged request's worker "Is it done?" after 6 quiet hours, at most once
  a day, and stalls it as follow-up unconfirmed when no worker is left ([docs/orchestrators.md](docs/orchestrators.md),
  "Ledger cleanup"). `scripts/ledger-dry-run.ts` shows what it would do on a copy of `data/`.

- **What each request is doing now** (w418, asked by Lothsahn). Beside its status, every open or stalled request shows a
  live state derived from its workers: Working, Waiting on input (and on whom), Queued, Merged with a follow-up pending
  (which step), or Stalled (and why), as soon as it is true. A worker on several requests counts only on the one it was
  last given (requests now record `links`). `list_work` shows it on each line, ends with the counts and takes `state`;
  the Dispatcher page has a button per state with its count. The cleanup and the stored status are unchanged
  ([docs/orchestrators.md](docs/orchestrators.md), "What a request is doing now").

### Fixed

- **A worker's brief is never lost** (w496, asked by Ben). Workers started while LothDesktop's daemon was outdated got
  only the dispatcher's later nudge: the brief had been written to the transcript only. `start_agent`'s first prompt
  now waits in the send queue whatever would refuse it (an outdated or offline daemon, the host guard) and goes first;
  a queued message leaves the queue only once delivered, retried for up to 24 hours instead of dropped on the first
  error. Every worker started for a request also gets the request as filed: title, brief, constraints, related ids and
  its people's notes ([docs/orchestrators.md](docs/orchestrators.md#agent-limits-and-idle-workers)).

- **A thread Max escalated hears when its fix merges** (w480, asked by Lothsahn). FFBox watches board ref
  `conv-<conversation>` after an escalation, but the ledger left a conversation's own request out of that
  conversation's check, so the answer was always `clear` and no merge notice ever came: w436 (#ask-assistant, range
  rings darkening the screen) closed as already fixed by #1076 in Build 78, and the player was never told. The intake
  now follows the escalated request itself and pushes FFBox its standing, and a done answer names the PR that merged the
  fix and its release ("Fixed in PR #1076, coming in version 78"), looked up for an auto-closed or "already fixed by
  #N" request too. Board watches are kept in `data/intake.json` across restarts. Once, at the first start, escalated
  requests closed done in the last 14 days are followed again (`node scripts/escalation-catchup.ts <data copy>` lists
  them). Workers put the report's own Discord link in a fix PR, a message's link for a message in a channel, and write
  `RESOLVED: already fixed by PR #N`. The `maybe` candidates of a board check, saved but never read back at start,
  are read back too.

- **Orchestrators and standing agents no longer read FF Factory's secrets** (w467, part C of the portal VM). Read,
  Glob, Grep and a standing agent's shell are refused for config.json, data/ (an orchestrator's own memory and the
  attachment store excepted), the secrets folder and token files, ~/.ssh, Claude's and gh's credentials, on Windows and
  POSIX paths alike, and a search may not start above them ([docs/orchestrators.md](docs/orchestrators.md)). A
  standing agent's shell now also recognises absolute POSIX paths into the base clone and the sandboxes.
- **The base clone the orchestrators read follows origin/develop** (w467): fetched and moved every 15 minutes under
  the base-repo lock (config `repo.refreshMinutes`, 0 off), so they no longer read old code.
- **A config with Windows paths is refused off Windows** (w467): on Linux `path.resolve("C:/ffsb")` is a folder
  inside the app, which the portal would have used quietly.
- **Placement notes name the review folder where the portal runs** (w467), not `F:\ffsb\_review` and "ssh to the M5
  from BEAST", which also showed up garbled in the dispatcher's prompt (`\f` read as a form feed); the restart
  summary names the VM's update log (`journalctl -u fff-update`) under systemd.

- **The outside watchdog watches BEAST's tailnet URL again** (w424, asked by Lothsahn). With no `publicUrl` in
  config.json, the watch took the first machine's `portal_url`; since `add_machine beast local` that is BEAST's own
  daemon, at `http://127.0.0.1:8790`, so the m5 checked its own loopback and pinged itself. It now skips the local machine
  and any loopback address (`watchedPortalUrl`), and the local machine is never the default watcher.
- **A request with several workers closes on the last one's DONE** (w434, asked by Ben). One worker's `DONE: w428`
  (after only its hardware read) closed the request while another worker's PR was unpushed. Each DONE now records that
  worker's part; the request closes once every worker on it has said DONE, ended, or moved on to newer work, and the
  last one ending closes it on the latest DONE's report ([docs/orchestrators.md](docs/orchestrators.md)).

- **`republish_public` works from BEAST** (w434). Its scan for this machine's own names stopped on "BEAST", which 69
  files name on purpose; the portal's machine ids are now public names, its other names (user, tailnet, Funnel host, ssh
  keys) are still checked. A comment naming BEAST in `scripts/common.ps1` is gone, and `server/republish.test.ts` injects
  the machine's names, so it no longer depends on the runner's hostname, and checks that the guard stops a private name.

- **A person's orchestrator follows up on any worker their request is on** (w431, asked by Ben). `message_agent` from a
  personal orchestrator was refused for a worker someone else started once the person's linked request was stalled
  (w426) or done (w427, w428, w430). It now counts every request of the person the worker is on that is open, stalled
  or closed in the last 7 days, and the message says which on an `[about w426 "title"]` line. Workers with no request
  of the person stay refused; the 3-per-worker limit is unchanged.

- **The ledger cleanup reads the end of a worker's report, and a PR can be one step of a request** (w424, asked by
  Lothsahn after w424 was closed twice, on #99 and #100, while its worker's reports ended "w424: still open: …"). A
  worker's `lastResult` kept only the first 1200 characters of a long report, so the cleanup's "more is coming" check
  never saw the line workers end with; it now keeps the first 400 and the last 800 (`reportClip`). A PR whose
  description says `Part of: w424` is linked like `Request: w424`, but its merge leaves the request open until a
  `Request:` PR merges or the worker reports `DONE: w424`; workers' briefs say when to use it.
- **A hard reset cannot leave a sandbox half-moved, or make a daemon forget its sandboxes** (w424, asked by Lothsahn;
  BEAST hard-resets on WHEA errors). A machine daemon's `sandboxes.json` was written in place without an fsync and read
  as empty when damaged, so the portal would have dropped that machine's sandbox labels and agents; it is now written
  and read like the portal's own files (`server/durable.ts`). `migrate_host_sandboxes` writes each sandbox's records to
  disk at once, moves them back before the daemon releases the folder (a reset in between leaves it held by both, not
  by neither), and a second run finishes a move a reset cut off in either direction, which before was refused both
  ways ("already has a sandbox"). A release the daemon refuses puts the records back on the machine.
- **`add_machine` local works on BEAST** (w424, asked by Lothsahn). The Windows probe died with "You cannot call a method
  on a null-valued expression" on the first git repo without an `origin` remote under the home folder or a drive's top:
  Windows PowerShell casts a pipeline with no output to `$null`, and `.Trim()` threw. It now reads git's and node's
  answers as `"$(...)"`, and a deploy that knows its clone (BEAST's base clone, or `repo_path`) searches for none.
- **An elevated app says when nobody is signed in** (w424). After an unattended reboot the `ffsb-server` task cannot run
  until its user signs in to the desktop, so an app started by hand from an administrator shell (ssh) stayed elevated
  with a banner that said "run scripts/restart.ps1 (from any shell)", which cannot work then. The server no longer
  hands off to a task that cannot start (that restart cut off every agent for nothing), the banner says to sign in and
  then run `restart.cmd` as administrator, and `restart.ps1` logs the same when the task does not start.
- **A worker in a machine sandbox can switch its own branch again** (w422, asked by Lothsahn). `switch_branch` from
  a worker on LothDesktop or BEAST was refused with "1 agent(s) are mid-turn in sandbox …" when that worker was the
  only agent there (w421 five times, w401 six times on 2026-10-05): the portal left the caller out of its check, but
  the daemon's second check counted every live agent not idle, the caller included. The daemon now gets the caller's
  session id and leaves it out too; other agents mid-turn still refuse the switch, named by title on both sides; and
  a "running" left by an agent whose process is gone no longer counts, and the portal sets it back to stopped
  ([docs/machines.md](docs/machines.md)). Reaches each machine at its next daemon deploy.
- **`ffbox_activity show signatures` says what FFBox really does with reports** (w412). It said automatic
  investigations were "not built yet (phase 4)" and counted how many "would start" under FF Factory's own 20-a-day
  plan, while FFBox has diagnosed every crash and desync report by itself since 2026-10-04. It now asks FFBox live: its
  `intake.auto` (on or off, settle time, daily cap, who pays) and `intake.fff_handoff` from `config`, the intake
  conversations of the last 24 h, and each report of the last 24 h with the conversation that diagnosed it from
  `reports`; when FFBox cannot answer it says unknown instead of asserting. The unbuilt budget (`IntakeBudget`, the
  "would start today" meter) is gone from `/api/providers/ffbox/signatures` and the FFBox page, which now says FFBox
  diagnoses the reports. The orchestrators' FFBox guidance and `fetch_ffbox_report` say so too
  ([docs/ffbox.md](docs/ffbox.md), "Crash and desync intake").

### Added

- **Game work is spread between the computers by room** (w416, asked by Lothsahn). `list_sandboxes` and
  `system_status` start with a Capacity block: each computer's live agents against its limit, free sandboxes, RAM and
  editors, BUSY or ROOM n%, and which computer the next new game-repo work goes to (most room; about even: fewer live
  agents, then taking turns). `start_agent` and `create_sandbox` add a note when they put new work elsewhere. The
  dispatcher's prompt spreads game-repo work between BEAST and LothDesktop, not only when BEAST is full, and keeps on
  BEAST only what needs it ([docs/machines.md](docs/machines.md), "Placing work").

- **Owners close each other's requests when asked** (w402, asked by Lothsahn). A person with the owner role can have
  their orchestrator close or reopen another person's request (`update_work`), only in a turn they started with their
  own message and with a note saying why; the log names who and whose, and the request's people are told. Members keep
  their own requests only; notes and priorities on someone else's request stay its people's
  ([docs/orchestrators.md](docs/orchestrators.md)).

- **FFBox files its finished intake diagnoses into the ledger** (w361, docs/intake.md "Intake diagnoses from FFBox").
  `POST /api/intake/ffbox` takes a Discord-less body with `source: "intake"` (report facts, root cause, verdict,
  findings as untrusted data, the PR if one was pushed, up to 40 files with their fetch locators). It joins ledger work
  only on an exact key (a report id, the desync group, FFBox's own PR or branch, among requests from reports); a shared
  signature is only a maybe; `done` only for a fix released after the report's game version. A desync with a PR or a
  found cause goes under the desync PR policy (w358), anything else by the w299 triage; answers `filed`, `held`,
  `in_flight`, `done`, `skipped`. Caps, dedupe and idempotency as for Max's escalations.

- **FFBox desync PRs follow Lothsahn's standing policy** (w358, docs/intake.md "FFBox desync PRs"). A desync diagnosis
  or its `ffbox/*` PR is approved at once (triage `ffbox-desync`, `intake.ffbox.desync`, default on, 10 a day) into a
  review-and-merge request whose worker classifies it first: report generation only (test, merge); a game desync fix (a
  failing-first test and a 2-peer built-player check, merge); capture during play (tick and frame time before and after
  on the biggest save: under 1% merges, above ends with `PERF-ESCALATION`, which puts the request back in the intake for
  a developer with the PR left open). Caps and duplicate checks unchanged. The dispatcher's prompt carries the rule.

### Fixed

- **Every message to an agent names its sender** (w389, asked by Ben). A person typing in a worker's chat reached it
  with no sender line, and the worker's prompt called the portal owner "the user", so a worker wrote "Release hold
  lifted (Ben, …)" into PR #1024 for a message Lothsahn sent. Now every person's message reads `[from <name>]` in
  every kind of session, an orchestrator's `[from the orchestrator, for <name>]`, an unknown sender says so, and the
  resume after a restart names each unanswered message's sender. Prompts name the owner only as who runs the portal and
  tell agents to attribute decisions only to a named sender ([docs/identity.md](docs/identity.md#every-message-names-its-sender-w389)).

- **Idle workers no longer block new work** (w384, asked by Lothsahn). A follow-up to an idle worker was refused "already
  6 agents running (limits.maxSessions)" while six idle workers held every slot. The agent limits (`limits.maxSessions`,
  a machine's `max_agents`, `max_sandbox_agents`, `max_agents_per_sandbox`) now count agents mid-turn only; a message
  that finds every slot busy is queued and delivered when one frees instead of refused. Idle processes past
  `limits.maxSessions` + `limits.maxIdleAgents` (6) are stopped oldest first, and idle workers whose request closed or
  moved on, or idle an hour, are stopped by a reaper; never one mid-turn, with a pending wake_me or a dirty sandbox, and
  a message resumes any of them with their history ([docs/orchestrators.md](docs/orchestrators.md#agent-limits-and-idle-workers)).

- **A person's close is final** (w370, asked by Lothsahn). The ledger cleanup's re-check reopened w50 a minute after
  Lothsahn closed it by hand: its old automatic-close mark from #1002 had survived a hand reopen made before #83 and the
  hand close. Any close or reopen not made by the cleanup (a person's, the dispatcher's, a worker's marker, the intake's)
  now clears the mark and the loose PR links, and the re-check skips a request whose log shows such a close after its own.

- **The ledger cleanup's full pass runs** (w363, asked by Lothsahn). It never had: due 10 minutes after each start, it found
  the 5-minute pull-request pass still running and skipped for `everyHours`, so `lastRunAt` was never written and no
  finished, cut-off, superseded or idle request was ever closed, resumed or stalled. It now waits for the running pass.
  A report like "fully merged to develop, so I'm idle", "is fixed and merged into develop" or "nothing is open or
  pending" counts as delivered, and a turn that ended on "You've hit your session/weekly limit" counts as cut off by a
  limit. Each action and each full pass is a line in the server log.

- **The ledger's re-check of automatic closes says what it did** (w340, reopened by Lothsahn). After the f4ce1cd deploy it
  ran at 05:30 and reopened 42 wrongly closed requests (w312 among them), but wrote nothing to the server log, so it looked
  as if it had not run; w50 and w128 had been reopened by hand a minute before. Each reopen is now a
  `ledger cleanup: reopened <id>` line, the first pass after a start logs how many closes it checked, and a request
  reopened by hand no longer says "closed automatically". The w343 detach's two wrong removals (w197's partner report,
  w313's report fixed by #983) are given back once at start-up, as subjects.

- **No GitHub link in a public Discord thread** (w352, asked by Lothsahn: linking the PR "exposes which github we use.
  I would like that to remain private."). FF Factory's PR-up summary ends "Waiting on review. PR #N." with no link, and
  GitHub links, repo names and ffbox branch names in the PR's TL;DR or evidence line are taken out (`withoutRepo`).
  FFBox (ffbox d8bd8b5) does the same to every public post, and its own agents post as before w351.
  And Max no longer says "Waiting on input from a developer." anywhere on Discord (ffbox 054483b): a
  request FF Factory holds (`held`, `approval: pending`) is recorded by FFBox and silent; FF Factory still sends
  the flag for FFBox's record.

- **"DESIGN-QUESTION: none" is not a question** (w355, asked by Lothsahn). w349's worker ended two turns with
  "DESIGN-QUESTION: none — waiting on CI for PR #1018", which made w349 a design question for Ben and Lothsahn and sent
  both an [intake question]. A marker whose text is empty, none, n/a, no, -, or starts with none, no question, nothing or
  waiting on is ignored (`noQuestion`); the worker rules say to use it only for a real decision and to end a turn still
  in progress with no marker ([docs/intake.md](docs/intake.md)).

- **A request claims only the threads and reports it is the work for** (w343, asked by Lothsahn). FFBox's ledger check
  held five new desync reports (conversations 640-644) on w331, a Steam lobby request, and answered "done" for the
  ten reports w312 (a fetch request) had listed. w331 had no report keys: its title, "<@…> Please diagnose this", was
  one concept, and the text match let the report's "diagnose" and "diagnosis" both count against it, scoring 1. The
  matcher now pairs concepts one to one, folds near-duplicates and caps coverage, and diagnose/investigate say nothing
  about which bug it is. w312's keys came from its brief: a filing now takes thread and report keys only from its title
  and the new `request_work` `subjects` (and an explicit scope), never from its brief, related ids, notes or worker
  reports. Every start detaches such report keys from people's requests, backed up and logged on each
  ([docs/intake.md](docs/intake.md)).

- **The cleanup links a PR to a request only on strong evidence** (w340, asked by Lothsahn: it closed w339 on #988, an
  earlier request's PR that merged before w339 existed, while w339's worker was still working). A PR is a request's
  only by its `Request: wNNN` line, because the request's own worker opened it (`gh pr create`) after the request was filed,
  or because its head is the request's branch. Never from related ids or PR numbers in a brief or report, from a merge
  before the request was filed, or from a worker or sandbox shared with another request. Automatic closes made on the old
  rules are checked again and reopened when their PR no longer qualifies
  ([docs/orchestrators.md](docs/orchestrators.md), "Pull requests").

- **A broad request's close is no longer posted as a thread's result** (w317). A thread joined to a broad request (a
  scope over a window, a source, a channel or several threads) hears nothing from it; a narrower request for the
  thread takes its link (and, at start-up, every link a broad request holds), so the thread's own fix is its result.
  Ids are taken out of FFBox's text as whole words, never from inside a path ("specs/-discord-triage").

### Added

- **Orchestrator timers** (w362, asked by Lothsahn: "give yourself the ability to set timers in the FF Factory harness
  itself, so you don't have to keep reminding yourself to do things in the chat"). Personal orchestrators and the
  dispatcher get `set_timer`, `list_timers`, `update_timer` and `cancel_timer`: standing jobs, once at a time, every N
  minutes (at least 5) or daily at HH:MM in a time zone, with optional jitter, until, max_fires and skip_if_busy. Kept in
  `data/timers.json` with the crash-safe writer, untouched by a person's message (unlike `wake_me`, which stays as it
  was). A fire is delivered as `[timer <id> "<title>"] <note>` after the current turn, never dropped; fires that pile up,
  and those missed while FF Factory was down, are coalesced into one message with the counts. Caps: 20 active timers per
  orchestrator, and 96 timer messages per orchestrator a day (past that, fires wait). A timer's turn carries no one's
  authority. Each chat's header has a Timers button (yours, and the dispatcher's for owners) with pause, resume and
  cancel. [docs/orchestrators.md](docs/orchestrators.md#timers)

- **publish_review: review media without ssh** (w309, asked by Lothsahn). Workers on any machine publish stills, clips and
  notes into `review.root/<topic>/` on the portal's computer (default `<sandboxRoot>/_review`, `F:\ffsb\_review` on
  BEAST) with one tool call. A machine's daemon sends the files over HTTP with its own token, in resumable chunks
  checked by SHA-256. Names are made safe, nothing is overwritten (`name-2.ext`), and only images, video,
  md/txt/json and zip are taken, within `review.maxFileMB` (200), `review.maxCallMB` (500) and `review.maxFiles` (40).
  The answer is the paths, which show inline in reports ([docs/review.md](docs/review.md)).

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
- **Your own requests first on the Dispatcher page** (w307, asked by Lothsahn). The Requests list keeps its order by
  status (question, new, queued, active, then closed) and, for open ones, by priority; within one status and priority
  the logged-in person's requests (any where they are one of the people) come before everyone else's, then the order
  as before. Each login sees its own first, and its rows say "yours" ([shared/workOrder.ts](shared/workOrder.ts)).

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

- **An approved request no longer says "needs a human"** (w319, asked by Lothsahn: w233 still showed it after Ben approved
  it). The Intake and Requests tabs, `list_work`'s one-line summary and the item detail say "approved by <who> <time>",
  "declined by <who> <time>" or "closed: merged as #N" once a request is decided or auto-closed; "needs a human" shows
  only while it waits. The triage reason from filing stays as "Triage at filing" and in the log. Applies to existing
  requests too ([docs/intake.md](docs/intake.md), "Approval, caps and auto-approve").

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

- **The restart report names workers waiting on a wake_me** (w311, asked by Lothsahn). After the d60dcf1b deploy,
  f6b32781 (w283, lothdesktop/pr-fix) was on neither the resumed nor the could-not-resume list. It was between turns,
  with a 21-minute `wake_me` that survived the restart and fired on time, but nothing said so. The `[app restarted]`
  report now lists such workers with where they are and when their wake fires ([docs/restart.md](docs/restart.md)).

- **Unity's blocking dialogs no longer wait for a person** (w294, asked by Ben). mp-r2's editor sat on "The open
  scene(s) have been modified externally" after its worker's `git merge origin/develop` staged `main.unity`, and FF
  Factory asked for someone at the desktop. Now a dialog the watchdog does not press itself goes to the sandbox's
  agents with the exact call, the new `unity` action `answer_dialog` (Reload for that one, never Ignore), or a restart;
  the dispatcher answers when no agent is there. Only an administrator, licence or project-version dialog and an editor
  out of automatic restarts still ask a person (and only those send the "Unity editor stuck" notification).
  `switch_branch` now refuses, before touching git, whenever it cannot check the open scenes (unsaved edits unless
  `discard_scene_edits`, play mode, an editor starting or blocked, no bridge answer) instead of switching and leaving
  Unity to ask ([docs/unity-dialogs.md](docs/unity-dialogs.md#who-answers)).

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
