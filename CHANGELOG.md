# Changelog

All notable changes to FF Factory are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0 a minor bump may break things.

Add your change under **[Unreleased]** in the same pull request. `npm run release -- minor` (or
`patch`, `major`, `X.Y.Z`) moves those notes under a new version, bumps `package.json` and
`web/package.json`, commits and tags `vX.Y.Z`.

## [Unreleased]

### Changed

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
