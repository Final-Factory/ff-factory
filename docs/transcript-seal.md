# Transcripts are read-only to workers (w5563)

Asked by lothsahn (item 34 of the rogue-worker audit, w5451): "transcripts are read-only to workers". A conversation resumes
from Claude Code's own transcript, `<CLAUDE_CONFIG_DIR>/projects/<slug>/<session id>.jsonl` (server/sessions.ts
`launchResumed`). A worker's fence lets it write the whole worker root, and its agents' Claude home `<root>/claude` is in it
(measured on BEAST for the w5451 audit), so a planted or edited transcript would steer the agent that resumes it. Two layers
close that:

1. **The seal, on every OS** (`server/transcriptSeal.ts`). The host that runs a conversation (the agent host on a machine,
   the portal for its own sessions) hashes what the CLI appends as it appends it, and records the length and that sha256 at
   the end of each turn and once the CLI process has exited (`final`). The record lives where no worker can write:
   `<appDir>/transcript-seals/<session id>.json` beside `meters/` in the daemon's folder, or `<data>/transcript-seals` on
   the portal. Before a process resumes the conversation the file must still start with the sealed bytes, and a final seal
   must not have grown. Otherwise the conversation is **not resumed**: the process starts a fresh conversation, its first
   message says why (`SEAL_REFUSED_NOTE`), the ledger's transcript gets an error line naming the file and the reason, and the
   file is kept as it is. Because the hash runs over what the host read as the CLI appended, an edit to the part already
   hashed, even mid-conversation, shows at the next resume.
2. **Per-conversation write access, on macOS** (`server/workerFence.ts` `ownTranscriptRules`). The Seatbelt profile takes
   write back from `<CLAUDE_CONFIG_DIR>/projects` and allows only this process's own conversation in it: `<id>.jsonl` in any
   project folder and its `<id>/` folder (tool results, subagents). A write to another conversation's transcript, a planted
   new one, a delete or a rename is refused with EPERM. AgentSession passes `sessionId` to every new conversation so the
   fence knows its id before the CLI writes; the host makes the cwd's project folder first, outside the fence.

## What Claude Code does with its transcript (measured on m5, 2026-11-25, Claude Code 2.1.x, a mock API)

- It only appends, in place: a 152,106-byte transcript kept its first 152,106 bytes (same sha256) through a resume and a
  `/compact` that took it to 304,320, and kept the same inode through a later `/compact` and resume (304,320 to 455,326).
- A resume from another cwd appends to the file where it is (`projects/<the first cwd's slug>/<id>.jsonl`).
- It makes `projects/<slug>/memory/`. With that folder unmakeable and the project folder read-only (only its own
  `<id>.jsonl` and `<id>/` writable), a resume and a new conversation both ran normally.
- A new conversation's file must not exist first: a pre-made empty `<id>.jsonl` makes the CLI refuse the id ("Session ID ...
  is already in use"). So the Linux and Windows fences cannot be given the new file ahead of time.

FF Factory itself writes into a transcript in one place: the tool-schema refresh before a resume (`server/keptTools.ts`,
w2626), same length, in place. The seal is checked before it and the hash taken again after it.

## The cases at resume

| Transcript against its seal | What happens |
|---|---|
| No seal (a conversation from before w5563, or untouched for `SEAL_DAYS`, 90) | resumes; hashed from then on |
| As sealed | resumes |
| Longer, seal not final (the host ended before the CLI, say a daemon restart mid-turn) | resumes with the tail; the ledger says how many bytes |
| Longer, seal final (written after the process had ended) | fresh conversation |
| First `size` bytes changed, shorter, or the file gone | fresh conversation |

The final seal waits for the CLI's pid to be gone (up to 30 s after the stream ends; still running then: an ordinary seal).
The pid comes from the SDK's `onProcessSpawned` hook (in its code, not its types; `transcriptSeal.test.ts` fails when an SDK
update drops it) or from a custom spawner's child (the fence, the Linux write lock). A process run by the ops worker's
spawner reports no pid, so its seals are never final: a line appended after it ended resumes as a tail.

## What it does not cover yet

- **Linux per-conversation access**: there the write lock still lets a worker write any transcript in `<root>/claude`; the
  seal makes an edited one fail to resume, but the write itself is not refused. Landlock rights are inherited by every path
  beneath a rule, so `projects` must leave the folders a worker may create in (a `projects` link into a folder outside
  `--rw-children`, with per-conversation `--rw` rules). Handed up as a follow-up.
- **Windows, while a conversation runs**: with `workerTranscriptLabels` on (below), another *live* conversation's own file
  and folder are Low, and every worker is the same user at the same level, so a Low worker can write them until that
  claude exits; the seal fails such an edit at its next resume. With the switch off (the default), every transcript in
  `<root>\claude` is open to every Low worker, as on Linux.
- **A live conversation's own worker** can still edit its own transcript (it must write it). An edit to what was already
  hashed fails the next resume; an edit to the tail between the CLI's write and the turn's seal is sealed as written.
- **Medium and standing agents** run on their own Claude home, `<root>/claude-medium`, read-only to workers on every OS
  (w5543/w5565); the seal covers them as well.

## Windows: transcript labels (w5703)

`daemon.json` `workerTranscriptLabels: true`, with the Low fence on (`workerIntegrity: "low"`), labels
`<CLAUDE_CONFIG_DIR>\projects` Medium (no-write-up), with each project folder and each transcript and conversation folder in
them. A Low worker is then refused when it writes, plants, renames or deletes a transcript there, makes a new folder in a
project folder, or moves `projects` itself aside. Code: `server/transcriptLabels.ts`.

Two things the first CI run on the Windows runner showed (w5703):

- `icacls <folder> /setintegritylevel (OI)(CI)medium` without `/T` labels only that folder. What is already inside keeps
  its own label, and after the root's `labelLow` that is an explicit Low. So the lock labels every entry itself (folders
  with `/T`).
- A Low process renamed the Medium `projects` from inside the Low `claude`: it had delete-child on `claude` through the
  account's Full grant. The lock adds a deny entry for delete-child (`/deny <account>:(DC)`, this folder only) on `claude`,
  on `projects` and on each project folder; the agent host adds it to a project folder it makes. Files still delete and
  rename through their own DELETE right, so Claude Code's own writes in `claude` (its settings file's replace) are not
  affected.

- **The daemon** (`lowTranscripts` in `machine/daemon.ts`, once per start): if `projects` has no explicit Medium label yet,
  it first labels Low every transcript and conversation folder written in the last 3 days. Agents outlive the daemon
  (w605), so a conversation running at that moment keeps appending. It then labels `projects`, each project folder and
  everything else in them Medium, and denies delete-child as above. A Low copy
  of node tries to make a file in `projects` and in a project folder. The expected result is a refusal ("transcript labels:
  self-test at Low"). A write that went through is logged as a `WARNING` and changes nothing else (warn-only).
- **The agent host** (`lowTranscriptSpawner`, used by `server/launch.ts` when the spec says `transcriptLabels`): before
  claude starts, it makes the conversation's `<id>\` folder and labels it and what is in it `(OI)(CI)low` (`/T`). On a resume it also labels the
  existing `<id>.jsonl` (found in any project folder) `low`. When the last process of that conversation exits, both go back
  to Medium. A label that fails is logged, and the process still starts.
- **A new conversation's file**: Claude Code refuses `--session-id <id>` when `<id>.jsonl` already exists ("Session ID ...
  is already in use"). It also refuses an empty or stub file for `--resume` ("No conversation found"). So the file cannot be
  made ahead. The spawner passes the SDK's control lines through and holds the first user message until the CLI has
  answered `initialize`, by which point the start-up check is done. It then makes the empty file, labels it Low and passes
  the message on; the CLI appends to that file. If no answer comes in 60 s, it makes the file anyway and logs that.
  Measured on BEAST with Claude Code 2.1.x against a mock API, with the project folder refusing new files and folders,
  these all ran: a new conversation, a planted file (refused), a resume, a real /compact (the first bytes unchanged), and a
  resume after it. `memory\` was not made, and nothing failed because of it.
- **The way back** needs nobody at the machine: set `workerTranscriptLabels` to false (or remove it) and restart the
  daemon. At start, if `projects` still has the explicit Medium label, the daemon removes the deny entries and labels it
  and everything in it `(OI)(CI)low` with `/T` ("transcript labels: off; labelled ... Low again").
- **A host that dies before its claude** leaves that conversation Low until its next process ends.
- **Tests**: `server/transcriptLabels.test.ts`. Its real-label leg runs on the Windows CI runner (`.github/windows-tests.txt`)
  and is skipped where the test process itself runs at Low, since a fenced worker cannot set a Medium label.
