import { createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { POST_TARGETS } from '../shared/ffboxPost.ts';
import { z } from 'zod';
import { WAIT_LINE_CHARS } from '../shared/waitSummary.ts';
import os from 'node:os';
import path from 'node:path';
import { sandboxGuard } from './guard.ts';
import { editorBenchGateFor, GATE_HOOK_TIMEOUT_S } from '../machine/editorBenchGate.ts';
import { foreignTimedHold, ownTimedHold, readTimedAsk } from '../machine/benchLock.ts';
import { personHoldReason } from '../machine/personPlay.ts';
import { closedRefusalFor } from '../machine/benchTurn.ts';
import { standingGuard } from './standingGuard.ts';
import { publicIdentityEnv } from './publicGit.ts';
import { usageEnv } from './usage.ts';
import type { StandingToolGroup } from '../shared/types.ts';
import { WORK_LIVE_STATES, type WorkLiveState } from '../shared/workState.ts';
import type { SecretRules } from './secretGuard.ts';
import { WORKER_RULE_TOPICS } from './workerRules.ts';
import { DESCRIPTION_CHARS, LABEL_INPUT_CHARS, MAX_OPTIONS, MEDIA_CHARS, MIN_OPTIONS } from '../shared/ask.ts';
import { CARD_QUESTION_CHARS, MAX_ASKS } from '../shared/questionCard.ts';
import { rangedNumber } from './forgiving.ts';

/**
 * Questions for a person as their card asks them (w1597, Ben: "just ask the question clearly, give me the option selections
 * and thats it"): waiting_on_person's and decide_work ask's. Checked again by shared/questionCard.ts checkAsks. `bare`: no
 * field descriptions, for a tool whose own description says it (the dispatcher's always-loaded tools have a budget, w1158).
 */
export const questionsShape = (bare = false) => {
  const d = (s: string) => (bare ? undefined : s);
  // Bare, the limits are checkAsks' alone (each one here is schema text the model reads in every call).
  const str = (max: number, min = 0, what?: string) => {
    if (bare) return z.string();
    const t = z.string().min(min).max(max);
    return what ? t.describe(what) : t;
  };
  const words = d('ONE plain question, readable without opening anything; no file paths, PR lists or ids. A still: ![what](<absolute path>).');
  const label = d('A full-sentence answer in their voice, sent as their words; never just "Yes". Over 90 characters it is shortened and the full text goes in its description.');
  const desc = d('One line: what it means.');
  const rec = d('true on the ONE you recommend.');
  const options = z.array(
    z.object({
      label: str(LABEL_INPUT_CHARS, 1, label),
      description: str(DESCRIPTION_CHARS + MEDIA_CHARS, 0, desc).optional(),
      recommended: rec ? z.boolean().optional().describe(rec) : z.boolean().optional(),
    }),
  );
  const asks = z.array(z.object({ question: str(CARD_QUESTION_CHARS + MEDIA_CHARS, 1, words), options: bare ? options : options.min(MIN_OPTIONS).max(MAX_OPTIONS) }));
  return bare ? asks : asks.min(1).max(MAX_ASKS);
};

/** A stdio MCP server the agent process starts (on a machine: the daemon's Unity MCP server, machine/unityMcp.ts). */
export interface StdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Everything needed to start an agent process, as plain data: the portal builds it and a machine daemon
 * turns it into SDK options (docs/machines.md). Hooks and MCP servers are functions, so they cannot
 * cross the wire; the spec names them and buildOptions() rebuilds them where the process runs.
 */
export interface LaunchSpec {
  cwd: string;
  /** A machine sandbox (docs/machines.md): the daemon checks cwd is its folder and gives the guard its editor state. */
  sandbox?: string;
  model?: string;
  effort?: Options['effort'];
  settingSources: NonNullable<Options['settingSources']>;
  /** Appended to the claude_code system prompt. */
  append: string;
  /** Restrict the built-in tools (undefined: all). */
  tools?: string[];
  disallowedTools?: string[];
  /** Claude Code settings on top of the machine's own (the SDK's `settings`, the CLI's --settings): w1480's plugins a worker starts without. An older daemon ignores it. */
  settings?: Record<string, unknown>;
  /** Only the MCP servers named here (plus `mcp`); false loads the user's own too. */
  strictMcp: boolean;
  /**
   * Give the agent the machine's Unity MCP server as "UnityMCP", confined to its place's editor (the sandbox's, else
   * the main clone's): the daemon fills in `stdioMcp` from it (machine/unityMcp.ts). An older daemon ignores it.
   */
  unityMcp?: boolean;
  /** Stdio MCP servers the process starts, by name (the daemon's, never the portal's: commands are the machine's). */
  stdioMcp?: Record<string, StdioServer>;
  /** An in-process MCP server whose tool calls are answered by `handlers` (on a machine: the portal). */
  mcp?: {
    server: string;
    /** alwaysLoad and searchHint: from server/toolManifest.ts (w1163); an older daemon ignores them. */
    tools: { name: CatalogTool; description: string; alwaysLoad?: boolean; searchHint?: string }[];
  };
  maxBudgetUsd?: number;
  guard: {
    /** Unity instance prefix (project folder name) and the agent's own folder. */
    id: string;
    ownPath: string;
    protectedPaths: string[];
    gameRepos: string[];
    denyToolPrefixes?: string[];
    /** `secrets`: what it may not read (server/secretGuard.ts); the home secrets are added where it runs. */
    standing?: { folder: string; groups: StandingToolGroup[]; offLimits: string[]; secrets?: SecretRules };
    /** Public repos and their commit identity (config publicGitIdentity). */
    publicIdentity?: { repos: string[]; name?: string; email?: string };
    /** The machine's worker install folder (w896): the guard refuses a delete outside it. An older daemon ignores it. */
    workerRoot?: string;
    /**
     * w936: the machine's main clone, when a request this worker serves was granted work there (mainCloneAccess): the guard
     * then judges commands naming it one by one (server/mainCloneGuard.ts). An older daemon ignores it and refuses them all.
     */
    mainClone?: { path: string; requests: string[] };
  };
  env?: Record<string, string>;
  /**
   * The variables of `env` whose values are secrets (w1688): what the vault granted the run, whatever each is called. The
   * daemon and the agent host mask those values in everything they write or send (server/secrets.ts addSecretEnv); an older
   * daemon goes by the names alone (SECRET_ENV).
   */
  secretEnv?: string[];
  /**
   * Run on the computer's stored claude.ai login (docs/accounts.md): credentials in the process environment it
   * starts from are dropped (usage.ts AUTH_ENV), so only a token in `env` (a person's own) can override the login.
   */
  login?: boolean;
  /** Commit as this identity in clones of these public repos ("owner/name"), via publicIdentityEnv on the machine. */
  publicGit?: { name: string; email: string; repos: string[] };
  claudeExecutable?: string;
  /** Created before the process starts: `cwd` itself, and these files (relative to cwd) when missing. */
  init?: { files?: Record<string, string> };
}

/** A request's live state (shared/workState.ts), as read_work takes it. */
const LIVE_STATE = z.enum(WORK_LIVE_STATES as unknown as [WorkLiveState, ...WorkLiveState[]]);

/** The tools a spec can ask for, with their input schemas. Descriptions come with the spec. */
export const CATALOG = {
  /** Retired (w575): sandbox labels are their names. Listed in no spec; kept so workers started before it get an answer. */
  set_label: { purpose: z.string().describe('Retired: labels no longer change.') },
  request_delegation: {
    title: z.string().describe('Short label, e.g. "Fix null ref in BeltSystem (Discord #412)".'),
    task: z.string().describe('The full brief for the worker.'),
  },
  my_delegations: {},
  wake_me: {
    minutes: z.number().int().min(1).max(1440).describe('How long until you are messaged again.'),
    note: z.string().describe('What to check or do when you wake: this comes back to you word for word.'),
  },
  /** w754: cancel the worker's own pending wake_me check-in (it has one at a time). */
  cancel_wake: {},
  /** docs/orchestrators.md, "Waiting, Queued, Blocked" (w754): the worker says its request waits only on other requests or pull requests. */
  blocked_on: {
    requests: z.array(z.string().max(16)).max(6).optional().describe('Requests ("w727") that must close as done first. A request often closes later than its pull request merges: to wait for a merge, name the pull request in prs.'),
    reports: z.array(z.string().max(16)).max(6).optional().describe('Requests ("w1761") whose worker must report first: files, stills or results it makes for you (w1841). Clears when its report carries them (its worker is told to mark that report "For <your request>:"; a still-open progress report does not, w1869), or when the request closes.'),
    prs: z.array(z.string().max(200)).max(6).optional().describe('Pull requests that must MERGE first: "owner/repo#123" or the github.com link.'),
    head: z.string().max(64).optional().describe('With a ci: pull request (w907): the commit you just pushed (git rev-parse HEAD). FF Factory refuses the wait when the pull request\'s head is another commit (your push did not land) or the pull request conflicts with its base (CI cannot run).'),
    deploys: z.array(z.string().max(40)).max(2).optional().describe('Deploys that must happen first (w890): "portal" for a portal deploy, or a machine id for that machine\'s daemon update. It clears when a different commit runs there; you are resumed then, in any free sandbox, for the check that comes after it.'),
    what: z.string().min(1).max(200).describe('What you wait for, in a line ("w727 PR #1291 and w752 fix merged into master").'),
    request: z.string().max(16).optional().describe('The request ("w750") that waits, when you serve several; default: the one you are on.'),
  },
  /** w1945 (docs/machines.md, "Pair runs"): a check that needs several computers at once, filed as one request; the worker waits on its report. */
  request_pair: {
    what: z.string().min(1).max(100).describe('The run in one line: "MP-lowore-pin-pair on PR #2340".'),
    brief: z.string().min(1).max(6000).describe('What the legs run, as a worker needs it: the branch or commit, the scenario or steps for the host and the clients, what passes (counts, ranges), and where the result goes (a PR comment). Each leg is a new worker that knows nothing else.'),
    legs: z.number().int().min(2).max(4).optional().describe('Computers it needs at once, one worker on each (default 2: a host and a client).'),
    cross_os: z.string().max(300).optional().describe('Only when the change can behave differently across OSes (w1692: float or math-library use in the simulation, Burst or IL2CPP codegen, platform APIs or paths, the desync hash, a desync seen only across OSes): why. Without it the legs go on computers that are not Macs; with it a Mac may host, never a client.'),
    timed: z.boolean().optional().describe('A leg takes timing measurements (exclusive bench tickets): no leg goes on a computer that takes no timed runs (m5).'),
    request: z.string().max(16).optional().describe('The request ("w665") it is for, when you serve several; default: the one you are on.'),
  },
  /** w1969 (docs/machines.md, "Where a timed leg runs"): asked before an exclusive bench ticket; the portal says here or hands the leg to a small computer. */
  timed_place: {
    what: z.string().min(1).max(100).describe('The timed leg in one line: "RoundRobin belt output A/B on PR #2347".'),
    brief: z.string().max(6000).optional().describe('What the leg runs, as a new worker on another computer needs it: the branch and the commit of each side, the save, the script and its settings (probe_ab_win.sh rounds), what to report. Needed when it is handed off.'),
    platform: z.enum(['windows', 'mac', 'any']).optional().describe('The OS the leg needs (default any: both sides run on one computer, whichever OS).'),
    same_machine: z.string().max(300).optional().describe('Only when its numbers must come from this computer (a side of the A/B already ran here, the brief names it): why. It then runs here.'),
    via: z.enum(['leg', 'timed_run']).optional().describe('timed_run: a Windows player A/B that a play-only computer can time (w1946), when one is up; default leg.'),
    request: z.string().max(16).optional().describe('The request ("w1891") it is for, when you serve several; default: the one you are on.'),
  },
  /** w1945: a leg of a pair run tells the other legs' workers something. */
  message_pair: {
    text: z.string().min(1).max(4000).describe('What the other legs need to know: "host listens at 100.74.97.12:7890 on commit 1a2b3c4", "client joined at heartbeat 812", "my leg failed: <why>".'),
  },
  /** docs/orchestrators.md, "Waiting, Queued, Blocked" (w691): the worker says only a person can move it on. */
  waiting_on_person: {
    who: z.string().min(1).max(120).describe('Whose action it waits on: a name ("Ben"), several separated by commas, or "a reviewer".'),
    what: z.string().min(1).max(400).describe('What they must do, in a line ("reboot the m3 and log in: FileVault asks for a password").'),
    questions: questionsShape().describe(`What their card on the dashboard asks: ONE question per decision (several decisions: one each, at most ${MAX_ASKS}, shown one at a time), each with 2 to 4 full-sentence answers as buttons, your pick marked recommended, each answer's description saying what it does and costs (time, spend, risk). An action ("reboot the m3") is a question too: "Have you rebooted the m3 and logged in?" with "Done: the m3 is back" / "Not today". Stills and clips go in as ![what](<path>) previews, by the path publish_review answers (a path on your own machine shows on no card); pull requests, ids and report text stay in your report.`),
    about: z.string().min(1).max(WAIT_LINE_CHARS).describe('What the request is, in ONE plain line for someone who has read nothing about it ("The station brakes to a stop after Disable Transit, where today it stops dead"); not the title, no ids or paths.'),
    after: z.string().min(1).max(WAIT_LINE_CHARS).describe('What happens once they answer ("I merge the fix and it ships in the next dev build"; "I build the picked look and bring you its clip").'),
    request: z.string().max(16).optional().describe('The request ("w665") it is about, when you serve several; default: all of them.'),
  },
  unity: {
    action: z.enum(['status', 'start', 'stop', 'restart', 'clear_batch']),
    force: z.boolean().optional().describe('stop/restart: kill the editor at once instead of asking it to quit first (a frozen editor ignores that).'),
  },
  live_view: {
    action: z.enum(['start', 'stop', 'status', 'knobs', 'stage', 'restage']),
    materials: z.array(z.string()).optional().describe('start: the materials whose shader properties are the knobs, as the game names them (e.g. ["VfxComet"]).'),
    fps: z.number().optional().describe('start: frames a second, 1-30 (default 15).'),
    width: z.number().optional().describe('start: frame width in px, 320-1920 (default 960).'),
    stage: z
      .array(
        z.object({
          load: z.string().optional().describe('The save name to load (game.loadsolo); first step only.'),
          ffauto: z.string().optional().describe('A game command ("ui.hide|true", "camera.focus|x|z|distance").'),
          csharp: z.string().optional().describe('C# for the editor bridge.'),
          until: z.string().optional().describe('csharp: text its answer must contain before the next step.'),
          timeoutS: z.number().min(1).max(300).optional().describe('csharp with until: seconds to wait (default 30).'),
        }),
      )
      .max(20)
      .optional()
      .describe('start, stage: the recipe that sets the view up again without your turn. One key per step: { "load": "<save name>" } first if any, then { "ffauto": "<command>" } or { "csharp": "<C# for the editor bridge>", "until"?: "<text its answer must contain>", "timeoutS"?: 1-300 }.'),
  },
  /** An urgent release's build on BEAST, else LothDesktop (w1606, w1628; the urgent lane's only since w1639, server/buildPlans.ts): coming, start, done. */
  build_plan: {
    action: z.enum(['coming', 'start', 'done', 'status']),
    release: z.boolean().optional().describe('coming, start: true for an urgent release\'s build (a quick or urgent release, w1639), the only kind build_plan plans: a normal release is FFBox\'s and builds nothing here. Your own player build needs no plan: build where you are.'),
    minutes: z.number().int().min(0).max(240).optional().describe('coming: lead time in minutes until the build starts (0: now).'),
    what: z.string().max(160).optional().describe('coming: what it builds ("Windows player for the w1475 clip").'),
  },
  /**
   * w1946 (docs/machines.md, "A play-only timing machine"). On a machine the daemon reads and sends the builds itself: the
   * portal plans (which pieces it lacks) and hands the run to a play-only computer; the worker hears the result in a message.
   */
  timed_run: {
    builds: z
      .array(
        z.object({
          name: z.string().max(24).describe('The variant name in the table, e.g. "base" or "fix" (letters, digits, - and _).'),
          path: z.string().max(400).describe('The built Windows player folder (finalfactory.exe beside finalfactory_Data), in your sandbox, your temp folder or the worker install of this computer.'),
          args: z.array(z.string().max(64)).max(8).optional().describe('Its own -ff switches after the fixed arguments (e.g. ["-ffNoHangWatchdog"]); one build may be listed twice with different switches.'),
        }),
      )
      .min(1)
      .max(4)
      .describe('The players to compare: usually two, the build before your change and the build with it, each built where you are.'),
    save: z.string().max(400).describe('The save every leg loads (.zip, at most 64 MB), copied into your working folder or temp folder.'),
    rounds: z.number().int().min(1).max(20).optional().describe('Rounds (default 4; even, so each variant runs first as often). Each round runs every variant once, the order reversed on even rounds.'),
    sample_s: z.number().int().min(5).max(300).optional().describe('Seconds the perf probe samples each leg (default 20).'),
    settle_s: z.number().int().min(5).max(300).optional().describe('Seconds after the save is ready before the sample (default 25).'),
    res: z.enum(['1920x1080', '1280x720', '1280x800', '2560x1440']).optional().describe('Window size (default 1920x1080).'),
    machine: z.string().max(40).optional().describe('A play-only machine by id; default the online one with the fewest runs ahead.'),
  },
  switch_branch: {
    branch: z.string().describe('The branch to switch to, e.g. "spec-098-belts".'),
    create_from: z.string().optional().describe('Base for a branch that exists neither here nor on origin. Default origin/master.'),
  },
  /** docs/review.md. On a machine the daemon sends the files itself: the portal gives the plan, the daemon uploads. */
  publish_review: {
    topic: z.string().describe('A short folder name for what is reviewed, e.g. "w283-enemy-attacks".'),
    files: z.array(z.string()).min(1).describe('Paths of the stills, clips and notes on this computer (absolute, or relative to your working folder).'),
    note: z.string().optional().describe('A few lines for the reviewer: what each file shows. Saved beside them as note.md.'),
  },
  /** docs/attachments.md. On a machine the daemon answers it itself: the portal gives the record, the daemon fetches the file. */
  fetch_attachment: {
    id: z.string().describe('The attachment id, e.g. "att_k2m9x0q7p3a1" (from an [attachments] list).'),
  },
  /**
   * docs/attachments.md, "Agents' files". On a machine the daemon sends the file itself: the portal checks the size and
   * opens an upload bound to that machine, the daemon sends the bytes, the portal checks the SHA-256 and makes the id.
   */
  publish_attachment: {
    file: z.string().describe('The file to hand on (a save, a log, a zip, any file): its path on this computer, absolute or relative to your working folder. It must be in your working folder or your own temp folder (TMP).'),
  },
  /** docs/ffbox.md, "Players' reports". On a machine the portal fetches the report from FFBox and the daemon the files. */
  fetch_ffbox_report: {
    id: z.string().max(64).describe('The FFBox report id, e.g. "20261003T101500Z-desync-3a9f01c2d4".'),
    file: z.string().max(260).optional().describe('One file inside the zip, exactly as the report lists it (e.g. "logs/Player.log"). Default: the whole zip.'),
    diagnosis: z.string().max(120).optional().describe('Instead of the zip: one file FFBox\'s diagnosis of the report kept, by its name (e.g. "summary.md"); list_ffbox_files what "diagnosis" lists them.'),
    run: z.number().int().min(1).optional().describe('With diagnosis: which diagnosis run (default the newest that kept the file).'),
  },
  /** docs/ffbox.md, "Release symbols and diagnosis files" (w1542). The portal asks FFBox; nothing on the machine is read. */
  list_ffbox_files: {
    what: z.enum(['symbols', 'reports', 'diagnosis']).describe('symbols: the release symbol store (every version, or with version its files). reports: players\' crash, desync and hang reports. diagnosis (needs id): the files FFBox\'s diagnosis of one report kept.'),
    version: z.string().max(64).optional().describe('symbols: one release\'s files, e.g. "1.0.0.0". reports: that game version exactly.'),
    commit: z.string().max(40).optional().describe('symbols: the builds made from this commit (7 to 40 hex digits).'),
    name: z.string().max(128).optional().describe('symbols: files whose name holds this, any case (e.g. "burst"); searches every version without version.'),
    platform: z.string().max(64).optional().describe('symbols: WindowsPlayer, OSXPlayer or LinuxPlayer. reports: the platform, any case.'),
    app: z.string().max(16).optional().describe('symbols: main or demo.'),
    id: z.string().max(64).optional().describe('reports: only this report. diagnosis, required: the report id, e.g. 20261003T101500Z-crash-3a9f01c2d4.'),
    kind: z.enum(['any', 'crash', 'desync', 'hang']).optional().describe('reports only (default any).'),
    since: z.string().max(40).optional().describe('reports only: received from this ISO time with a zone.'),
    until: z.string().max(40).optional().describe('reports only: received up to this ISO time with a zone.'),
    limit: rangedNumber(1, 500, 'How many (symbols default 200, reports default 20); a page also stops at about 40 KB.').optional(),
    offset: rangedNumber(0, 100000, 'Skip this many, for the next page (the answer says it).').optional(),
  },
  /** docs/ffbox.md, "Release symbols and diagnosis files" (w1542). The portal fetches the parts from FFBox; the daemon the file. */
  fetch_ffbox_symbols: {
    file: z.string().max(128).describe('The symbol file\'s name as list_ffbox_files lists it, e.g. "lib_burst_generated.pdb", "UnityPlayer_Win64_x64_mono.pdb", "lib_burst_generated.sym", "UnityPlayer.dll".'),
    version: z.string().max(32).optional().describe('The release, e.g. "1.0.0.0". Give this or commit.'),
    commit: z.string().max(40).optional().describe('The build commit instead of the version (7 to 40 hex digits).'),
    platform: z.string().max(16).optional().describe('WindowsPlayer, OSXPlayer or LinuxPlayer, when the name is in more than one build.'),
    app: z.string().max(16).optional().describe('main or demo, when the name is in both.'),
    id: z.string().max(48).optional().describe('The debug id or code id, as list_ffbox_files lists it, when the name is in more than one build.'),
  },
  /** docs/ffbox.md, "Symbols of an urgent-lane build" (w1639). The portal sends the published archives to FFBox; nothing on the machine is read. */
  file_ffbox_symbols: {
    version: z.string().max(32).describe('The release, e.g. "1.0.0.3".'),
    entries: z
      .array(
        z.object({
          app: z.enum(['main', 'demo']),
          platform: z.enum(['WindowsPlayer', 'OSXPlayer', 'LinuxPlayer']),
          attachment: z.string().max(20).describe('The archive\'s attachment id from publish_attachment (att_...).'),
        }),
      )
      .max(6)
      .optional()
      .describe('One per build to file, as urgent_release.py lists them. Leave it out to see how an upload of this version stands.'),
  },
  /** docs/ffbox.md, "Bug threads' files". On a machine the portal fetches the files from FFBox and the daemon puts them in the Inbox. */
  fetch_discord_thread_files: {
    thread: z.string().max(200).describe('The Discord thread: its URL, e.g. "https://discord.com/channels/530867164866150410/1558176042089447425" (a message link in it works), or its id.'),
    file: z.string().max(260).optional().describe('One file of the thread by its name, e.g. "BugReport_20261009_185502.zip". Default: every file of the thread.'),
    sha256: z.string().max(64).optional().describe('One file by its SHA-256 (from an earlier answer), for when the thread has two files of one name.'),
  },
  /** docs/ffbox.md, "Posting as Max" (w901). FFBox posts; the daemon reads `file` on the machine and sends its content as text. */
  post_as_max: {
    channel: z.enum(POST_TARGETS).describe('Where to post. dev_patch_notes: a release\'s patch notes. dev_chat: the developers\' chat. agent_testing: a test channel. conversation: a conversation FFBox holds (a #bug-reports or dev_bug_reports thread, an #ask-assistant conversation), named by conversation or thread.'),
    text: z.string().max(2000).optional().describe('The message, at most 2000 characters. Give this or file.'),
    file: z.string().max(260).optional().describe('A file on this computer in your working folder or your own temp folder (TMP) whose content is the message (at most 16 KB and 2000 characters), e.g. Temp/post-0.50.0.94.md. Give this or text.'),
    skip_lines: z.number().int().min(0).max(20).optional().describe('With file: leave out its first N lines (a release-notes file starts with two lines that are not the post: skip_lines 2).'),
    thread: z.string().max(200).optional().describe("A Discord thread id of that channel; with channel conversation, the conversation's Discord thread (its id or URL)."),
    conversation: z.string().max(20).optional().describe("With channel conversation: FFBox's conversation id (ffbox_activity and FFBox's messages name it)."),
    key: z.string().max(80).optional().describe('The dedupe key: a message with the same key in the same place is posted once, and a repeat answers the first one\'s link. Required for dev_patch_notes: the release\'s version, e.g. 0.50.0.94.'),
  },
  /** docs/orchestrators.md, "Workers read the ledger" (w642). Read-only: the portal answers from the ledger (server/workRead.ts). */
  /** A worker's rules most tasks do not need (w1482, server/workerRules.ts). */
  read_rules: { topic: z.enum(WORKER_RULE_TOPICS).describe('cleanup, saves or unity: the topic your prompt names.') },
  read_work: {
    id: z.string().max(16).optional().describe('One request in full, e.g. "w631": yours, one yours names, or (with a ledger-read grant) any open or stalled one.'),
    all: z.boolean().optional().describe("List the ledger's open and stalled requests, not only yours and the ones they name. Needs a ledger-read grant on one of your open requests."),
    status: z.enum(['open', 'stalled', 'open_and_stalled', 'any']).optional().describe('Default: any for your own list, open_and_stalled with all (any is refused there).'),
    state: z
      .union([LIVE_STATE, z.array(LIVE_STATE).min(1).max(WORK_LIVE_STATES.length)])
      .optional()
      .describe('Only requests in these live states: working (mid-turn, or between turns with its own work going), waiting (on input: a person must act), queued (capacity only), blocked (on a thing: another request, a deploy, a machine, a usage limit, a lock, a time, CI), paused (its worker set it aside for another request), followup (merged, follow-up pending), stalled.'),
    person: z.string().max(64).optional().describe('Only the requests of this person (user id or display name).'),
    offset: rangedNumber(0, undefined, 'Skip this many matching requests (the next page).').optional(),
    limit: rangedNumber(1, 50, 'Requests per page, default 20; a page also stops at 40,000 characters.').optional(),
  },
  /** docs/portal-logs.md (w920). Read-only: the portal answers from a fixed list of sources (server/portalLogs.ts). */
  portal_logs: {
    source: z.string().max(40).optional().describe('What to read (journal, portal, updater, health, cleanup, update_result, update_verified, update_prepared, update_verifying, machine_rollout, auto_deploy, unit_watchdog, coordinator_context, bench_hours). Absent: the list of sources and what is there now.'),
    machine: z.string().max(41).optional().describe('cleanup and bench_hours: a machine id ("lothdesktop", "m5"); absent: the portal host\'s own passes (cleanup) or every machine (bench_hours).'),
    since: z.string().max(40).optional().describe('journal, cleanup and bench_hours: an ISO time with a zone, e.g. 2026-10-10T18:50:00Z. The journal defaults to the last hour.'),
    until: z.string().max(40).optional().describe('journal, cleanup and bench_hours: an ISO time with a zone. Default: now.'),
    grep: z.string().max(200).optional().describe('Only lines containing this text, any case.'),
    regex: z.string().max(100).optional().describe('Only lines matching this pattern, any case (no quantified group, backreference or lookaround).'),
    limit: rangedNumber(1, 2000, 'Lines per page, default 200; a page also stops at 48,000 characters.').optional(),
    offset: rangedNumber(0, undefined, 'Matching lines to skip (the next page: the answer says which offset).').optional(),
  },
} satisfies Record<string, z.ZodRawShape>;

export type CatalogTool = keyof typeof CATALOG;
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

/** The spec's public-repo identity as git env (public-identity.gitconfig in the machine daemon's folder, FF_APP_DIR). */
function publicGitEnvFor(spec: LaunchSpec, baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  if (!spec.publicGit?.repos.length) return {};
  try {
    return publicIdentityEnv(spec.publicGit, spec.publicGit.repos, path.join(baseEnv.FF_APP_DIR || path.join(os.homedir(), '.ff-factory'), 'public-identity.gitconfig'), baseEnv);
  } catch (e) {
    console.warn('public git identity:', (e as Error).message);
    return {};
  }
}

/**
 * The git credential helper for a run the token vault gave a GitHub token (docs/vault.md, w512): for https://github.com
 * only, the helpers git would otherwise use are cleared (an empty value resets the list) and one reads GH_TOKEN from the
 * environment when git asks. So git pushes as that token whatever helper the machine has (a keyring, Git Credential
 * Manager), and the token is never written to any config. Command-scope config entries (GIT_CONFIG_*), appended after
 * the ones already in `prior` (the public identity's).
 */
export const GITHUB_HELPER = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f';
export function githubCredentialEnv(prior: Record<string, string | undefined>): Record<string, string> {
  const n = Number(prior.GIT_CONFIG_COUNT ?? 0) || 0;
  // A run with GitHub Apps (w1519, machine/ghApp.ts): its daemon's helper, which answers by repository, so git must send the
  // repository's path (useHttpPath); it answers GH_TOKEN for every repository no app covers.
  const app = prior.FF_GH_APP_HELPER;
  return {
    [`GIT_CONFIG_KEY_${n}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n + 1}`]: app || GITHUB_HELPER,
    ...(app ? { [`GIT_CONFIG_KEY_${n + 2}`]: 'credential.https://github.com.useHttpPath', [`GIT_CONFIG_VALUE_${n + 2}`]: 'true' } : {}),
    GIT_CONFIG_COUNT: String(n + (app ? 3 : 2)),
  };
}

/**
 * SDK options for a spec. `handlers` answers the spec's MCP tools; `processEnv` is the environment to start from (without its
 * credentials for spec.login); `editorRunning`, for a machine sandbox, says whether its editor is up (raw branch switches are
 * refused then).
 */
export function buildOptions(spec: LaunchSpec, handlers: Partial<Record<CatalogTool, ToolHandler>>, processEnv: NodeJS.ProcessEnv = process.env, editorRunning?: () => boolean): Options {
  const baseEnv = spec.login ? usageEnv(processEnv) : processEnv;
  const g = spec.guard;
  // Git fails fast instead of waiting on a credential prompt nobody will answer.
  const agentEnv = (() => {
    const env: Record<string, string | undefined> = { MCP_TIMEOUT: '120000', ...baseEnv, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...publicGitEnvFor(spec, baseEnv), ...spec.env };
    // A vault GitHub token (GH_TOKEN): gh reads it itself; git gets a helper that reads it (githubCredentialEnv).
    return spec.env?.GH_TOKEN ? { ...env, ...githubCredentialEnv(env) } : env;
  })();
  const hooks = [
    sandboxGuard({
      sandboxId: g.id,
      sandboxPath: g.ownPath,
      protectedPaths: g.protectedPaths,
      gameRepos: g.gameRepos,
      denyToolPrefixes: g.denyToolPrefixes,
      publicIdentity: g.publicIdentity,
      workerRoot: g.workerRoot,
      mainClone: g.mainClone,
      editorRunning,
      // The shell's own variables, so `cd $TMPDIR/ffbox && git push origin HEAD:master` is read where it goes (w1132).
      env: agentEnv,
      // w1750: no player or screen grab beside another worker's timed run; the worker's own session passes.
      ...(g.workerRoot ? { benchBusy: () => foreignTimedHold(g.workerRoot, agentEnv.FF_SESSION_ID) } : {}),
      // w1894: no player or screen grab while a person plays the game on this machine.
      ...(g.workerRoot ? { personBusy: () => personHoldReason(g.workerRoot) } : {}),
      // w1829: no Unity MCP call into an editor another worker's timed run closed; it says why and when it comes back.
      ...(g.workerRoot ? { benchClosed: () => closedRefusalFor(g.workerRoot, g.id) } : {}),
      // w1923: no timing measurement (an editor snippet reading a clock, a Performance test, a profiler capture) without an
      // exclusive bench ticket of the worker's own session.
      ...(g.workerRoot ? { timingHold: () => ownTimedHold(g.workerRoot, agentEnv.FF_SESSION_ID), session: agentEnv.FF_SESSION_ID, host: os.hostname().split('.')[0].toLowerCase() } : {}),
      // w1969: on a big computer, no exclusive timing ticket before the worker asked timed_place where its leg runs.
      ...(g.workerRoot ? { timedAsk: () => readTimedAsk(g.workerRoot, agentEnv.FF_SESSION_ID) } : {}),
    }),
    ...(g.standing ? [standingGuard(g.standing)] : []),
  ];
  // w1628: a sandbox's editor compiles, imports and runs tests only in its turn in the machine's bench queue, never
  // beside a timed leg (machine/editorBenchGate.ts). Its own matcher, so it may wait longer than a plain hook. Its tickets
  // carry the worker's session, so they queue at its request's priority (w1628).
  const editorGate = editorRunning && g.workerRoot ? editorBenchGateFor({ sandboxId: g.id, sandboxPath: g.ownPath, root: g.workerRoot, ...(agentEnv.FF_SESSION_ID ? { env: { ...process.env, FF_SESSION_ID: agentEnv.FF_SESSION_ID } } : {}) }) : undefined;
  const mcpServers: NonNullable<Options['mcpServers']> = {};
  for (const [name, srv] of Object.entries(spec.stdioMcp ?? {})) mcpServers[name] = { type: 'stdio', command: srv.command, args: srv.args, ...(srv.env ? { env: srv.env } : {}) };
  if (spec.mcp) {
    mcpServers[spec.mcp.server] = createSdkMcpServer({
      name: spec.mcp.server,
      version: '1.0.0',
      // A tool this code does not know (a newer portal talking to an older daemon) is left out, not fatal.
      tools: spec.mcp.tools.filter((t) => (t.name in CATALOG ? true : (console.warn(`launch: no tool "${t.name}" in this version; left out`), false))).map((t) =>
        tool(t.name, t.description, CATALOG[t.name], async (args: Record<string, unknown>) => {
          const h = handlers[t.name];
          try {
            if (!h) throw new Error(`${t.name} is not available here`);
            return { content: [{ type: 'text' as const, text: await h(args) }] };
          } catch (e) {
            return { content: [{ type: 'text' as const, text: `ERROR: ${(e as Error).message}` }], isError: true };
          }
        }, { ...(t.alwaysLoad ? { alwaysLoad: true } : {}), ...(t.searchHint ? { searchHint: t.searchHint } : {}) }),
      ),
    });
  }
  return {
    cwd: spec.cwd,
    model: spec.model,
    effort: spec.effort,
    settingSources: spec.settingSources,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.append },
    ...(spec.tools ? { tools: spec.tools } : {}),
    ...(spec.disallowedTools ? { disallowedTools: spec.disallowedTools } : {}),
    ...(spec.settings ? { settings: spec.settings } : {}),
    strictMcpConfig: spec.strictMcp,
    mcpServers,
    ...(spec.maxBudgetUsd !== undefined ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
    hooks: { PreToolUse: [{ hooks }, ...(editorGate ? [{ matcher: 'mcp__UnityMCP__.*', hooks: [editorGate.hook], timeout: GATE_HOOK_TIMEOUT_S }] : [])] },
    env: agentEnv,
    ...(spec.claudeExecutable ? { pathToClaudeCodeExecutable: spec.claudeExecutable } : {}),
  };
}
