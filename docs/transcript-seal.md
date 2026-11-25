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
3. **Per-conversation write access, on Linux, behind a switch** (w5702, `machine/transcriptLock.ts`; daemon.json
   `transcriptLock: "on"`, set remotely with `ops_worker` `machine_update` `transcript_lock on|off`; off by default). Landlock
   grants a folder's rights to everything below it and the write lock opens the whole Claude home, so no rule can take
   `projects` back. With the switch on, the daemon moves the project folders from `<root>/claude/projects` into
   `<root>/transcripts` and leaves a link `projects -> ../transcripts`; `transcripts` is a root folder the lock does not
   open. Switching on must not cut off a claude already running (w5718's review of #1231): agent hosts outlive the daemon
   restart the switch causes, each keeps the Landlock rules it started with, and Landlock binds a rule to an inode, so one
   locked on `<root>/claude` alone is refused its own transcript once it lives in `transcripts` (measured). So with the
   switch off, `transcripts` is made ahead and opened whole to every locked worker, and the move goes into that same
   folder (its inode kept) one project folder at a time; and the daemon holds the move back while any running sandbox
   host's `place.json` does not say `transcriptsHeld` (`hostsWithoutTranscripts`: hosts older than w5702), trying again at
   each later sandbox start. Both are in the live test `live w5718` of `server/transcriptLock.test.ts`. The spawner
   (`machine/writeLock.ts` `writeLockSpawner`) then adds `--rw` for this conversation's `<id>.jsonl` (in any project folder)
   and its `<id>/` folder. A new conversation's file cannot be made ahead (below), so the host leaves a dangling link
   `<id>.jsonl -> <id>/.new.jsonl` in the cwd's project folder: Claude Code's "already in use" check is a stat that follows
   the link and finds nothing, the CLI's first write makes the file inside its own folder, and when that claude exits the
   host moves the file over the link (`finishNewTranscripts`). A worker writes the Claude home, so it can remove the link;
   the host repairs it before every locked spawn and keeps what replaced it in `transcripts/.replaced-<time>`, and the seal
   still refuses a resume from a planted copy. Measured on biscuit, 2026-11-25, Claude Code 2.1.299 and a mock API: a new
   conversation, a resume, `/compact` and a resume after it all exited 0 inside the lock (the file grew 115,303 to 240,285
   bytes, one `compact_boundary`); append, truncate, plant, rename, delete, a hard link or move into its own folder, a new
   project folder and `memory/` were all refused (`server/transcriptLock.test.ts`, the live test). The secret scrubbers
   walk the linked folder and `secretGuard` keeps the real folder as the Claude home's (`homeSecrets`). Recovery with
   nobody at the machine: `transcript_lock off` opens `transcripts` to workers again (the link stays, which Claude Code
   follows), and `worker_fence off` lifts the whole lock.

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

- **Windows per-conversation access**: there the fence still lets a worker write any transcript in `<root>/claude`; the
  seal makes an edited one fail to resume, but the write itself is not refused (`projects` labelled Medium with each
  conversation's file and folder labelled Low, a follow-up). Linux too while its switch is off (the default until a
  machine is turned on after the w5702 review).
- **A live conversation's own worker** can still edit its own transcript (it must write it). An edit to what was already
  hashed fails the next resume; an edit to the tail between the CLI's write and the turn's seal is sealed as written.
- **Medium and standing agents** run on their own Claude home, `<root>/claude-medium`, read-only to workers on every OS
  (w5543/w5565); the seal covers them as well.
