# UI review, 2026-09-24

A review of the web app as a user sees it, with the orchestrator chat first, then the at-a-glance
view of sandboxes, machines and agents, then phones. Findings are ranked by how much they get in
the way of that use. The plan for each is under it; the changes that landed are listed at the end.

## How it was looked at

The app ran against the mock backend in `web/mock/` (`npm --prefix web run build`, then
`PORT=8797 MOCK_FROZEN=1 npm --prefix web run mock`; any username, password `mock`). Its
scenario is a busy day: seven sandboxes (working, waiting for a permission, Unity blocked on a
dialog, idle, unused, creating, failed), two Macs (one online with a worker, one offline), three
standing agents with runs and delegation requests, and a long orchestrator conversation with tool
calls, harness notices, tables, code and images. `MOCK_SCENARIO=fresh` is the first-run state.

Screenshots were taken with Playwright at 1440×900 and 1920×1080 (Edge), 360×780 (Edge, Android),
390×844 and 430×932 (WebKit, iPhone) and 844×390 landscape (WebKit), 24 states each. They are on
the host under `F:\ffsb\agent-mcp\Logs\ui-review\before\<size>\<state>.png`, with
`<size>` one of `d1440 d1920 p360 p390 p430 land`. The names below are relative to that folder.

## Findings

### 1. The sidebar hides the sandboxes (high)

At 1440×900 the sandbox list starts 525 px down and shows one and a half sandboxes
(`d1440/orch.png`). Above it sit the brand, two nav rows, five system meters and three plan
meters. Each sandbox card is about 160 px: label, `slot: agent-mcp`, branch and git summary, a
Unity chip, then one row per agent with its session id. On a phone the drawer shows two and a half
cards per screen (`p390/drawer.png`).

The card's dot is the sandbox's provisioning status, which is green for every ready sandbox. What
the sandbox is doing (an agent working, one waiting for Ben, Unity stuck) is spread over the chip,
the agent dots and a badge, so "Play the tutorial…" reads green while its editor is blocked.

Plan: two-line rows. First line: a state dot and the label. Second line: the state in words, the
active agent's name (left out when it repeats the label) and Unity when it matters. The state is
worked out from the agents and the editor, most urgent first. Meters fold into a one-line footer
that opens on a tap. One `+` per section; the second "New sandbox" button goes.

### 2. "Needs you" undercounts and names one thing (high)

The count is permission requests plus delegation requests. A Unity editor stuck on a dialog is not
counted, although it cannot continue without someone at the desktop. The sidebar box names only
the first item ("2 waiting on you · Honest co-op client (BEAST) · Bash").

Plan: an attention list at the top of the sidebar with every item on its own row: the permission
(agent, tool, command), the blocked editor (sandbox, dialog title) and the delegation (agent,
title). One tap goes to the place. The tab title and the phone's bell use the same count.

### 3. Tool calls crowd out the conversation (high)

Every tool call is a full-width bordered row in monospace. A typical orchestrator turn is two or
three of them before a one-line reply (`d1440/orch.png`); a worker's transcript is mostly tool rows
(`d1440/sandbox-working.png`). On a phone they are cut to `sandboxes · agent_transcript session=…`
(`p360/orch.png`).

Plan: each run of tool calls and thinking between two replies becomes one collapsed line, "Used 3
tools: list sandboxes, list standing agents, list delegation requests", which opens to today's
rows. A failed call shows in that line. Screenshots a tool returned stay visible under it. While a
turn runs, the line names the tool in flight.

### 4. Harness notices read like log lines (high)

`[worker update]`, `[heartbeat]`, `[unity blocked]`, `[auto-delegation]`, `[standing agent]` and
`[wake_me]` messages are shown folded like thinking, in dim italics, with the raw text as the
preview: `agent "Lighting pass (AAA space look)" (session s-light-1) in sandbox agent-mcp finished a
turn…` (`d1440/orch-history.png`). The label wraps to two lines on phones ("Worker / update",
`p390/orch-history.png`). `[unity blocked]` and `[auto-delegation]` get the label "Worker update".
Nothing sets apart the notices that need Ben: a worker waiting for permission, a blocked editor, a
delegation request.

Plan: one compact row per notice with an icon for its kind, a one-line summary that uses names
("Lighting pass (AAA space look) finished a turn"), the time and a link to the sandbox or agent. The
ones that need Ben are amber. Expanding shows the full text. The parsing lives in
`shared/notices.ts` with tests.

### 5. Per-turn metadata in the reading flow (medium)

A rule with "Done · 3 turns · $0.14 · 16s" closes every turn, and the header shows the model id,
the session's running cost and the last activity (`d1440/orch.png`). None of it helps read the
conversation.

Plan: no rule after a turn that ended normally; failures, budget stops and interrupts keep theirs.
The reply's time, duration and cost show on hover. Model, cost and turn count move to the chat's
menu.

### 6. Phones: two header rows and truncated names (high)

The orchestrator on a phone has the top bar plus a second row that holds a status dot, the
heartbeat select and the permission-mode select (`p390/orch.png`). On a sandbox page the one header
row holds both the label and the agent picker, so both are cut: "Lighting pas…" next to "Lighting
pass (AA" (`p390/sandbox-working.png`), "Play the tutor…" next to "Tutoria" and a red "Unity" pill
(`p390/sandbox-blocked.png`). In landscape the two header rows and the composer leave about 170 px
for the conversation (`land/orch.png`).

Plan: one header row. The orchestrator's heartbeat, permission mode and "new conversation" go into
a `⋯` menu in the top bar. The sandbox header gets the label on its first line and the agent (with
its state) as a tappable second line; a permission wait or a blocked editor shows as a strip under
the header that says what is wrong. The composer uses one row when the screen is short.

### 7. The details sheet scrolls sideways on phones (high)

The Unity dialog text contains a long path that does not wrap, so the sheet scrolls horizontally
and "Stop Unity" is cut off (`p390/sandbox-details.png`). The sheet shows the sandbox label twice.
A blocked editor is amber in the sheet and red in the header.

Plan: wrap long tokens; one title; one colour per state everywhere.

### 8. Missing chat idioms (medium)

- Code blocks have no copy button.
- Replies have no time; user bubbles always show one. There are no day or time separators, so a
  morning's messages and last night's look the same.
- "Jump to latest" appears only when new content arrives while you are scrolled up, not when you
  scroll up yourself.
- Opening a sandbox and coming back puts the chat at the bottom; on phones it is re-mounted.
- On desktop the composer is not focused when the page opens.
- The placeholder carries keyboard help ("Enter to send, Shift+Enter or Ctrl+Enter…").
- Stop is a separate red pill beside the primary button.

Plan: copy buttons; times on hover and a divider when more than 15 minutes pass; the pill whenever
you are more than a screen from the bottom, saying "New messages" when there are some; scroll
position kept per chat; focus on load on desktop only; a short placeholder; while a turn runs and
the box is empty, the primary button is Stop, with voice mode still one tap away.

### 9. Contrast (medium)

`--text-3` (#687686) is used for timestamps, meta, placeholders, section heads and thinking. It is
4.17:1 on the page, 3.85:1 on panels, 3.62:1 in the composer and 3.33:1 in the user bubble. WCAG AA
asks 4.5:1 for text this size (11 to 12.5 px).

Plan: lighter `--text-3` and `--text-2` that pass 4.5:1 on every surface, keeping the difference
between the two.

### 10. Type and spacing drift (medium)

The stylesheet uses twelve font sizes between 10.5 and 17 px and spacing values from 2 to 7 px in
most combinations. Almost every container has a border, and states are drawn with dots, chips,
pills and badges that differ per page.

Plan: tokens for a 4 px spacing grid and a seven-step type scale (11, 12, 13, 14, 15, 17, 22 px);
fewer borders, one status component (dot plus words) and one badge.

### 11. Ids where names should be (medium)

Session ids next to agent names in the sidebar, `slot: …` on every card, "(slot sb-5)" in dialog
titles, search hits labelled `slot agent-mcp`. The labels-as-names change made the label the name;
these places did not follow.

Plan: names everywhere; ids in the details sheet and tooltips.

### 12. Smaller things (low)

- The settings dialog scrolls sideways on phones (`p390/settings.png`).
- Search filters take half a phone screen and the date inputs have no visible label
  (`p390/search.png`).
- Sign out sits next to settings in the sidebar header, one tap from a mistake.
- Connection state is a 7 px dot; a lost connection deserves words.
- An unused sandbox's page offers only "New agent" (`p390/sandbox-unused.png`).
- A failed sandbox shows the raw git error with no next step (`d1440/sandbox-error.png`).

## What works and stays

Voice mode (one big word, the orb, tap anywhere to end) suits the car. Permission cards are clear
and their buttons are thumb-sized on phones. Details live in a sheet, labels are names, drafts are
kept per chat, Enter and Shift+Enter behave as expected, and the lightbox pages through images.

## What changed

All twelve findings were acted on; see the commits from "Harness notices, parsed for the page" to
"E2E: new visual baselines". The after screenshots are in `…\Logs\ui-review\after\` with the same
names as the before ones, and `…\Logs\ui-review\interact\` has the states a click leads to (the ⋯
menu, an opened tool line and notice, a reply streaming, "New messages", a live permission request,
the phone's bell opening the drawer, "Unity is stuck" opening the details, voice mode).

| | Before | After |
|---|---|---|
| Orchestrator, desktop | `before\d1440\orch.png`, `orch-history.png` | `after\d1440\orch.png`, `orch-history.png` |
| Orchestrator, phone | `before\p390\orch.png`, `land\orch.png` | `after\p390\orch.png`, `land\orch.png` |
| Sidebar | `before\d1440\orch.png` (left), `p390\drawer.png` | `after\d1440\orch.png` (left), `p390\drawer.png` |
| Sandbox page, desktop | `before\d1440\sandbox-working.png` | `after\d1440\sandbox-working.png` |
| Sandbox page, phone | `before\p390\sandbox-working.png`, `sandbox-details.png` | `after\p390\sandbox-working.png`, `sandbox-details.png` |

Not redesigned: the standing agent's page (only its facts line and names changed).

`web/mock/server.ts` also serves the new build for these screenshots; the E2E suite
(`npm run test:e2e`) follows the new layout, and its Linux baselines were re-rendered by CI.

## iPad with a hardware keyboard (added during the work)

Ben's report: focusing a composer in Safari on an iPad with a hardware keyboard floats the AutoFill
bar (passwords, cards, contacts) at the bottom and shifts the whole page up, header off screen.

- The message boxes now tell Safari and password managers they are free text: `autocomplete="off"`,
  `autocorrect="on"`, `autocapitalize="sentences"`, no `name` or `id`, not inside a `<form>`, and
  the 1Password, LastPass and Bitwarden ignore hints. Once signed in, the page has no password or
  username field at all.
- `web/src/viewport.ts` keeps the page fixed to the visual viewport, so a bar or keyboard only
  lifts the composer. After every focus change or viewport event it now follows the viewport frame
  by frame for a second, because Safari does not always fire an event for the last step of its pan;
  and it no longer scrolls the document back with `window.scrollTo`, which fought Safari's scroll
  into view.
- `e2e/ipad.spec.ts` runs on WebKit as an iPad Pro 11 with a stand-in `visualViewport` that moves
  the way Safari's does. Its case "a viewport change that comes without an event" fails on the old
  `viewport.ts` with the header 60 px above the screen, which matches the report, and passes now.

What only a real iPad can show: whether Safari still draws the AutoFill bar for a `<textarea>` with
these attributes, and whether its pan comes as the stand-in assumes. If the bar still appears, the
next step is a `contenteditable` composer (which Safari does not offer AutoFill for, as ChatGPT and
Claude on the web use), keeping paste, Enter and Shift+Enter, voice and drafts.

Enter with a hardware keyboard: it used to make a new line on any touch screen. It now follows the
keyboard in use (`onScreenKeyboard()` in `web/src/viewport.ts`): an on-screen keyboard takes more
than 150 px off the bottom of the screen, measured under the layout (iOS) and against the height
before a field took the focus (Android, whose keyboard resizes the layout). With an iPad's hardware
keyboard (only the shortcut bar, about 60 px, or nothing) Enter sends and Shift or Ctrl+Enter makes a
new line; with a phone's or tablet's own keyboard Enter makes a new line and the Send button sends.
Two iPad tests cover both; the hardware one fails on the old rule. The iPad's floating keyboard takes
no height, so there Enter sends too.
