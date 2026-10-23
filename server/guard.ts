import { execFileSync } from 'node:child_process';
import { repoIsPublic } from './publicGit.ts';
import { checkOffDriveScan, checkOutsideRootDelete } from './rootFence.ts';
import { headBranch, isUrgentBranch } from './releaseHandBack.ts';
import { checkMainCloneShell, flatten, normPath, pathSpellings, spellingsRegex, type MainCloneGrant } from './mainCloneGuard.ts';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * A PreToolUse hook that runs even in bypassPermissions mode (canUseTool does not).
 *
 * This is a SEATBELT, not a security boundary: it catches the mistakes a well-meaning agent makes
 * (pushing to master, killing the wrong Unity, editing the live checkout) by pattern-matching tool
 * input. A determined or prompt-injected agent can get around it (a script file, execute_code in
 * its own editor, a junction). The real boundaries are GitHub branch rules and, if ever needed, a
 * separate low-privilege Windows account for sandboxes. Keep the rules simple and legible.
 *
 * Rules:
 *   - git, every repo: no force pushes (--force-with-lease is allowed), no remote branch deletion,
 *     no --mirror/--all, no `gh` calls that rewrite refs/branches.
 *   - git, the game repo only (config repo.url / repo.basePath): master is its one trunk (w1137, 2026-10-12; develop is
 *     retired) and takes changes only through a pull request: no pushes to master/main, no pushes to develop and no PRs
 *     into develop, opened, retargeted or merged (w1166: `gh pr merge` and `gh api .../pulls/<n>/merge` read the PR's
 *     base, `prBase`; `gh api .../pulls -f base=develop` is refused). A PR into master (`gh pr create --base master`, then `gh pr merge`) is the normal flow; the game
 *     repo has no main, so a PR's `--base main` is not judged. The target is read from the push's remote (`git remote -v` in the command's
 *     directory, following `cd` and `git -C`, through the variables the worker's shell has: $TMPDIR, $HOME, ~) or
 *     gh's -R/--repo/GH_REPO; when it cannot be determined, it counts as the game repo, and the refusal says why
 *     and what it saw. Other repos' master/main are fair game: Final-Factory/ffbox is pushed straight to master by
 *     design (docs/ffbox.md; w1132), the repo read from the remote's URL, never from a folder's name. Pushing your own branch and
 *     merging your PR into master is the normal, encouraged flow. (GitHub itself also refuses force pushes, deletion
 *     and direct pushes to master: branch protection requires a PR and green CI, the game repo's `Test in editmode` check since w1180.)
 *   - repository settings: `gh repo delete` never. `gh repo rename|create|edit|archive|unarchive` and
 *     writes to `.../private-vulnerability-reporting` only for repos other than the game repo (so an
 *     agent can publish or retire the app's own repos when the user asks); the target comes from
 *     -R/--repo/GH_REPO, the repository argument, or the directory's remotes, and when it cannot be
 *     determined it counts as the game repo.
 *   - processes: no killing Unity, node, claude or PowerShell by hand, no shutdown/restart.
 *   - files: no writes to, or shell commands naming, a protected path (the live co-op checkout, this
 *     server's own directory).
 *   - the machine's main clone (a person's own project folder) is a protected path like the others, except for a worker whose
 *     request was granted work there (opts.mainClone, WorkItem.mainCloneAccess, w936): its shell commands that name the
 *     clone must be one of a short list (quit its editor through the bridge, back up with stash/branch/patch, git fetch,
 *     checkout/switch, ff-only merge, reopen Unity), see server/mainCloneGuard.ts. Write and Edit stay refused.
 *   - disk: on a machine with a worker install (opts.workerRoot), no rm / rmdir / del / rd / Remove-Item / find -delete that
 *     names a path outside the install folder (server/rootFence.ts; w896, lothsahn: "in general we should only be clearing
 *     data in the install folder for the worker"). Inside it, the worker's own temp and its own save copy in the game's saves
 *     folder (`<TMPDIR's name>-<name>`, w1505) stay allowed. On a Windows machine, no du / find / tree / ff-leftovers check /
 *     Get-ChildItem -Recurse / dir /s either that scans a path off the install folder's drive, C: above all (checkOffDriveScan;
 *     w1755, lothsahn: "You need to only look at v:.  Stop messing with my c:").
 *   - Unity MCP: refused until the session pins its own editor ("<id>@<hash>"), and never another.
 *   - batch Unity (w1628): `Unity -batchmode` started straight from the shell is refused; under `unity-slot run`,
 *     `ff_unity_slot` or `build_player.sh` it takes a Unity slot and a bench ticket (checkRawUnityBatch).
 *   - public repos (config publicGitIdentity, default this app's own repo, and any other GitHub repo that
 *     GitHub reports as public, server/publicGit.ts): a push is refused when a commit it would publish has
 *     an author or committer email that is neither a GitHub noreply address nor the configured public
 *     email, so nobody's private address ends up in public history.
 *   - release branches (w1856): no commit, merge, cherry-pick, revert, am, pull or rebase in a sandbox on urgent/<v>, the
 *     urgent release lane's pointer at the commit it builds (checkReleaseBranchCommit, server/releaseHandBack.ts).
 *   - branch switches: while the sandbox's editor runs, no `git switch` / `git checkout <branch>` in the
 *     sandbox (Unity would stop on "The open scene(s) have been modified externally"); the worker's
 *     switch_branch tool does it safely. `git checkout -- <paths>` and `git restore` stay allowed.
 */
export function sandboxGuard(opts: {
  sandboxId: string;
  sandboxPath: string;
  protectedPaths: string[];
  /** URLs or paths that name the game repo, whose master/main takes no direct push and whose develop is retired. Empty: every repo counts. */
  gameRepos?: string[];
  remotes?: RemoteResolver;
  /** A PR's base, for a merge into the retired develop (w1166). Default: gh. */
  prBase?: PrBaseResolver;
  /** The environment of the worker's shell: `cd $TMPDIR/ffbox` and `git -C ~/x` are followed through it (w1132). Absent: variables are not followed. */
  env?: Record<string, string | undefined>;
  /** Tool name prefixes to refuse, e.g. "mcp__ffsb__" (the portal's own MCP, which would let an agent launch agents). */
  denyToolPrefixes?: string[];
  /** Whether the sandbox's Unity editor is up right now: raw branch switches are refused then (checkEditorSwitch). */
  editorRunning?: () => boolean;
  /** Public repos whose pushes must carry only public commit identities (checkShell's identity rule). */
  publicIdentity?: PublicIdentity;
  /** The machine's worker install folder (root.json's root): deleting outside it is refused (checkOutsideRootDelete). Absent: not checked. */
  workerRoot?: string;
  /**
   * w936: a machine's main clone this worker's request explicitly asked for work in (server/mainCloneGuard.ts). Shell
   * commands naming it are then judged one by one against a short allowed list (quit its editor, back up, git fetch and
   * checkout, reopen Unity) instead of refused whole; Write and Edit there, and every other protected path, stay refused.
   */
  mainClone?: MainCloneGrant;
  /**
   * w1750: while another worker's timed run holds this machine's bench lock, its "bench lock held by ..." line, else
   * undefined (machine/benchLock.ts foreignTimedHold). A player started by its slot path or an ffmpeg screen grab is
   * refused then (checkBenchBusyLaunch). Absent: not checked.
   */
  benchBusy?: () => string | undefined;
  /**
   * w1829: while another worker's timed run keeps this sandbox's editor closed, the refusal for a Unity MCP call into it
   * (machine/benchTurn.ts closedRefusalFor), else undefined. Absent: not checked.
   */
  benchClosed?: () => string | undefined;
}): HookCallback {
  // Drive-letter paths are normalised textually so the guard behaves the same on any host OS.
  const norm = (p: string) => (/^[a-zA-Z]:[\\/]/.test(p) ? p : path.resolve(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const own = norm(opts.sandboxPath);
  const protectedPaths = opts.protectedPaths.map(norm).filter((p) => !own.startsWith(p + '/') && own !== p);
  const home = norm(os.homedir());
  // Every way a shell command might spell a protected path.
  const spellings = protectedPaths.flatMap((p) => pathSpellings(p, home));
  // w936: the granted main clone's spellings, matched as whole paths (`/repo` is not `/repo-live`).
  const cloneGrant = opts.mainClone && !own.startsWith(normPath(opts.mainClone.path) + '/') ? opts.mainClone : undefined;
  const cloneSpellings = cloneGrant ? pathSpellings(normPath(cloneGrant.path), home) : [];
  const cloneNames = cloneGrant ? spellingsRegex(cloneSpellings) : undefined;
  const unityPrefix = `${opts.sandboxId.toLowerCase()}@`;
  // w1505: the session's save copies are named after its own temp folder (`ffa-<session>`, TMPDIR of its shell).
  const tmpName = path.basename((opts.env?.TMPDIR ?? '').replace(/\\/g, '/').replace(/\/+$/, ''));
  const saveTag = /^ffa-./i.test(tmpName) ? tmpName : undefined;
  let pinned = false;

  const deny = (reason: string) => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
  });

  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = input.tool_name;
    const args = (input.tool_input ?? {}) as Record<string, unknown>;

    const banned = opts.denyToolPrefixes?.find((p) => tool.toLowerCase().startsWith(p.toLowerCase()));
    if (banned) return deny(`${tool} is not available to this agent (${banned}* is the portal's own control channel).`);

    if (tool === 'Bash' || tool === 'PowerShell') {
      const cmd = String(args.command ?? '');
      const reason =
        checkShell(cmd, { cwd: input.cwd || opts.sandboxPath, gameRepos: opts.gameRepos ?? [], remotes: opts.remotes ?? gitRemotes, prBase: opts.prBase ?? ghPrBase, publicIdentity: opts.publicIdentity, env: opts.env }) ??
        (opts.editorRunning?.() ? checkEditorSwitch(cmd, input.cwd || opts.sandboxPath, opts.sandboxPath) : undefined) ??
        checkReleaseBranchCommit(cmd, input.cwd || opts.sandboxPath, opts.sandboxPath) ??
        checkPlayerLaunch(cmd, opts.sandboxId) ??
        (opts.benchBusy ? checkBenchBusyLaunch(cmd, opts.benchBusy) : undefined) ??
        checkRawUnityBatch(cmd) ??
        (opts.workerRoot ? checkOutsideRootDelete(cmd, { root: opts.workerRoot, cwd: input.cwd || opts.sandboxPath, allow: [opts.sandboxPath], saveTag }) : undefined) ??
        (opts.workerRoot ? checkOffDriveScan(cmd, { root: opts.workerRoot, cwd: input.cwd || opts.sandboxPath, allow: [opts.sandboxPath] }) : undefined);
      if (reason) return deny(reason);
      let flat = flatten(cmd);
      if (cloneGrant && cloneNames) {
        // The granted clone: each command naming it must be an allowed form. What is left, with the clone's own name taken
        // out, is still checked against every protected path (a path that merely starts with the clone's is not the clone).
        cloneNames.lastIndex = 0;
        if (cloneNames.test(flat)) {
          const why = checkMainCloneShell(cmd, { ...cloneGrant, sandbox: opts.sandboxPath }, cloneSpellings);
          if (why) return deny(why);
          cloneNames.lastIndex = 0;
          flat = flat.replace(cloneNames, ' ');
        }
        cloneNames.lastIndex = 0;
      }
      for (const s of spellings) {
        if (flat.includes(s)) return deny(`${s} is a protected path (the live co-op checkout or this server). Work only inside ${opts.sandboxPath}.`);
      }
    }

    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      const target = String(args.file_path ?? args.notebook_path ?? '');
      if (target) {
        const t = norm(target);
        for (const p of protectedPaths) {
          if (t === p || t.startsWith(p + '/')) return deny(`${target} is inside protected path ${p}.`);
        }
      }
    }

    if (tool.toLowerCase().startsWith('mcp__unitymcp__')) {
      const closed = opts.benchClosed?.();
      if (closed) return deny(closed);
      const explain =
        `This sandbox's Unity editor is the instance named "${opts.sandboxId}@<hash>" (project path ${opts.sandboxPath}). ` +
        `Other editors on this machine belong to other sandboxes or to the live co-op game — never target them. ` +
        `Read mcpforunity://instances, then call set_active_instance with the full "Name@hash" whose name starts with "${opts.sandboxId}@".`;
      const isPin = tool.endsWith('__set_active_instance');
      const target = isPin ? args.instance : args.unity_instance;
      if (typeof target === 'string' && target) {
        // Name@hash only: a bare hash prefix or port number cannot be checked against the sandbox.
        if (!target.toLowerCase().startsWith(unityPrefix)) return deny(explain);
        if (isPin) pinned = true;
      } else if (!pinned) {
        // Unpinned, the bridge routes to whichever editor happens to be the only one connected —
        // possibly the co-op game's. Refuse until this session has pinned its own editor.
        return deny(`Pin your editor first. ${explain}`);
      }
    }
    return {};
  };
}

const PROTECTED_BRANCH = /^(?:refs\/heads\/)?(?:master|main)$/i;
/** w1137: the game repo's develop branch is retired; master is the one trunk. */
const RETIRED_BRANCH = /^(?:refs\/heads\/)?develop$/i;
const DEVELOP_RETIRED = 'develop is retired (w1137, 2026-10-12): master is the one trunk; push your own branch and open a PR into master (`gh pr create --base master`), then merge it when CI is green (the required `Test in editmode` check; the whole suite runs after the merge).';
const MASTER_BY_PR = 'master takes changes only through a pull request: push your own branch, open a PR into master (`gh pr create --base master`), and merge it when CI is green (the game repo\'s required `Test in editmode` check; the whole suite runs after the merge).';

/** A built Final Factory player (or server) binary: finalfactory.exe, a finalfactory .app bundle or the binary inside one, a Linux build's finalfactory.x86_64. */
const PLAYER_BINARY = /(?:^|[\\/])finalfactory(?:\.exe|\.x86_64|\.app(?:[\\/]contents[\\/]macos[\\/]finalfactory)?)$/i;
/**
 * A player slot (scripts/nightly/player_slots.py): <slot root>/slotK/player/finalfactory.exe or .app on a lab machine's
 * pool, <slot root>/slotK-P/player/... on a worker root install, where sandbox slotK owns slotK-0 and slotK-1 (w576).
 * The nightly lab's slotnightly-0 and -1 are gone (w1099: the nightly run plays from its sandbox's pair).
 */
const SLOT_PLAYER = /[\\/]slot(\d+)(?:-([01]))?[\\/]player[\\/]finalfactory(?:\.exe|\.x86_64|\.app)(?:[\\/]|$)/i;
/** Words that start the next word as a program: a call operator, a launcher, or an environment prefix. */
const LAUNCHERS = new Set(['&', '.', 'exec', 'nohup', 'time', 'env', 'start', 'start-process', 'saps', 'open', 'invoke-item', 'ii', 'cmd', 'cmd.exe', '/c', '/k']);

/**
 * w513 (lothsahn): a built player runs only from a player slot, never from a build, sandbox, branch, session or temp
 * folder: Windows Firewall keys its rules on the exe's path, so every new path prompts and stalls an unattended run,
 * and BEAST had collected rules for 163 such paths (docs/worker-root.md 2.5). A shell command that starts
 * finalfactory.exe (or a finalfactory .app) by a path outside a slot is refused, with the slot launcher to use
 * instead. Only the program position of a simple command counts (after a call operator, `start`, `Start-Process`,
 * `open`, `nohup`, `env` and VAR=value prefixes): copying, listing or hashing a build is fine. Exported for tests.
 */
export function checkPlayerLaunch(cmd: string, sandbox?: string): string | undefined {
  const own = /^slot(\d+)$/i.exec(sandbox ?? '')?.[1];
  for (const seg of cmd.split(/&&|\|\||[;|\n]|&(?=\s|$)/)) {
    const words = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (const word of words) {
      const w = word.replace(/^["']|["']$/g, '');
      const lower = w.toLowerCase();
      if (LAUNCHERS.has(lower) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^-/.test(w) || w === '""' || w === '') continue;
      // The program word: a player outside a slot is refused; anything else ends this simple command.
      const isPlayer = PLAYER_BINARY.test(w.replace(/[\\/]+$/, ''));
      const slot = SLOT_PLAYER.exec(w + '/');
      // A sandbox's pair is its own (w576): sandbox slotK starts players only from slotK-0 and slotK-1.
      if (isPlayer && slot?.[2] !== undefined && own !== undefined && slot[1] !== own) {
        return (
          `Refused: ${w} is sandbox slot${slot[1]}'s player folder; this is sandbox slot${own}, whose players run only from ` +
          `slot${own}-0 and slot${own}-1. Start it with \`python scripts/nightly/player_slots.py launch <exe or build folder> -- <args>\`, ` +
          "which picks this sandbox's pair (`--peer 1` for the second peer)."
        );
      }
      if (isPlayer && !slot) {
        return (
          `Refused: ${w} would start a built player outside a player slot. Players run only from the fixed slot paths ` +
          '(<slot root>/slotK/player/), which Windows Firewall allows once per machine; any other path raises the firewall ' +
          'prompt and stalls the run. Start it with `python scripts/nightly/player_slots.py launch <exe or build folder> -- <args>` ' +
          '(`--detach` returns at once), `"${FF_LAUNCH[@]}" <exe> -- <args>` in bash after sourcing scripts/nightly/player_launch.sh, ' +
          'or slot_path() in Python.'
        );
      }
      break;
    }
  }
  return undefined;
}

/** ffmpeg's screen and window grabbers (Windows gdigrab, ddagrab, gfxcapture; Linux x11grab; macOS avfoundation). */
const SCREEN_GRAB = /(?:^|[\s=,;'"])(?:gdigrab|ddagrab|gfxcapture|x11grab|avfoundation)(?:[\s=,;:'"]|$)/i;
const FFMPEG_BINARY = /(?:^|[\\/])ffmpeg(?:\.exe)?$/i;

/**
 * w1750 (lothsahn, 2026-10-22: "Why is the game player running if the worker has an exclusive lock on beast?"): while
 * another worker's timed run holds this machine's bench lock, a shell command that starts a built player by its slot
 * path or grabs the screen with ffmpeg is refused, with who holds it and until when (`busy`, machine/benchLock.ts
 * foreignTimedHold), so the work moves to another machine or waits. The game repo's player_slots.py launch and the
 * ff-agents record_clip check the same lock themselves (and can wait, --bench-wait), so they pass here. `busy` is read
 * only for a command that would start one. Exported for tests.
 */
export function checkBenchBusyLaunch(cmd: string, busy: () => string | undefined): string | undefined {
  for (const seg of cmd.split(/&&|\|\||[;|\n]|&(?=\s|$)/)) {
    const words = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    let underTimeout = false; // `timeout [-s TERM] 30 <program>`: the program is past its signal and duration
    for (const word of words) {
      const w = word.replace(/^["']|["']$/g, '');
      const lower = w.toLowerCase();
      if (LAUNCHERS.has(lower) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^-/.test(w) || w === '""' || w === '') continue;
      if (lower === 'timeout' || lower === 'gtimeout') {
        underTimeout = true;
        continue;
      }
      if (underTimeout && (/^\d+(?:\.\d+)?[smhd]?$/.test(w) || /^(?:SIG)?[A-Z]+$/.test(w))) continue;
      const bare = w.replace(/[\\/]+$/, '');
      const what = PLAYER_BINARY.test(bare) ? 'a game player' : FFMPEG_BINARY.test(bare) && SCREEN_GRAB.test(seg) ? 'a screen capture' : undefined;
      if (what) {
        const held = busy();
        if (held) {
          return (
            `Refused (w1750): ${held}. ${what[0].toUpperCase()}${what.slice(1)} does not start on this machine while another ` +
            "worker's timed run holds its bench lock: it would spoil the run's numbers. Move the work to another machine, or " +
            'wait for the lock: `python scripts/nightly/player_slots.py launch --bench-wait <seconds> <exe> -- <args>` (and ' +
            '`record_clip`, which checks it too) waits up to that long and starts when it ends. ' +
            '`python scripts/bench/bench_queue.py status` shows the queue.'
          );
        }
      }
      break;
    }
  }
  return undefined;
}

/** A Unity editor binary named in the program position: Unity.exe, a path ending in /Unity, the binary inside Unity.app. */
const UNITY_BINARY = /(?:^|[\\/])unity(?:\.exe)?$|unity\.app[\\/]contents[\\/]macos[\\/]unity$/i;
/** A variable holding one ("$UNITY", "${UNITY_EXE}", "$UNITY_PATH"): its value cannot be read, its name says it. */
const UNITY_VARIABLE = /^\$\{?[A-Za-z0-9_]*unity[A-Za-z0-9_]*\}?$/i;

/**
 * w1628 (lothsahn: "Won't builds use a ton of cpu and invalidate runs?"): a batch Unity (`-batchmode`) started straight
 * from the shell takes no Unity slot and no bench ticket, so it can compile beside another sandbox's timed leg. Under
 * `unity-slot run`, the game repo's `ff_unity_slot`, `unity_slot.py run` or `build_player.sh` it takes both: their word
 * is the program, so they pass. Only the program position of a simple command counts. Exported for tests.
 */
export function checkRawUnityBatch(cmd: string): string | undefined {
  for (const seg of cmd.split(/&&|\|\||[;|\n]|&(?=\s|$)/)) {
    const batch = /(?:^|\s)-batchmode(?:\s|$)/i.test(seg);
    // w1860 (lothsahn: "builds or any compute intensive job needs a lock"): an editor opened on a project straight from the
    // shell takes no ticket either, and runs beside a timed leg until the turn closes it
    if (!batch && !/(?:^|\s)-projectpath(?:\s|$)/i.test(seg)) continue;
    const words = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (const word of words) {
      const w = word.replace(/^["']|["']$/g, '');
      const lower = w.toLowerCase();
      if (LAUNCHERS.has(lower) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^-/.test(w) || w === '""' || w === '') continue;
      if (UNITY_BINARY.test(w.replace(/[\\/]+$/, '')) || UNITY_VARIABLE.test(w)) {
        if (!batch)
          return (
            `Refused (w1860): ${w} -projectPath started straight from the shell opens an editor with no Unity slot and no ` +
            "bench ticket, beside other sandboxes' timed legs. Start your sandbox's editor with mcp__machine__unity " +
            '(action start: it takes a slot and a shared ticket, held while the editor runs), or for a second editor of ' +
            'a peer run, `unity-slot run --count 2 --label "<what>" -- <the same command>`.'
          );
        return (
          `Refused (w1628): ${w} -batchmode started straight from the shell takes no Unity slot and no bench ticket, so it ` +
          "can compile beside another sandbox's timed bench leg and spoil its numbers. Run it as " +
          '`unity-slot run --label "<what>" -- <the same command>` (or the game repo\'s `ff_unity_slot`, ' +
          '`python scripts/unity_slot.py run` or `scripts/nightly/build_player.sh`): it waits for a slot, then for its ' +
          'turn in the bench queue, and never runs beside a timed leg.'
        );
      }
      break;
    }
  }
  return undefined;
}

/**
 * Why a shell command is refused while the sandbox's editor runs, or undefined. Exported for tests. A branch
 * switch under a running editor rewrites open scene files and Unity stops on its "modified externally"
 * question; mcp__sandbox__switch_branch parks the scenes first. Only commands aimed at the sandbox (or at a
 * directory that cannot be told) count.
 */
export function checkEditorSwitch(cmd: string, cwd: string | undefined, sandboxPath: string): string | undefined {
  const inside = (d: string | undefined) => {
    if (!d) return true;
    const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return n(d) === n(sandboxPath) || n(d).startsWith(n(sandboxPath) + '/');
  };
  let dir = cwd;
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const raw = seg
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/^["']|["']$/g, ''));
    const lower = raw.map((w) => w.toLowerCase());
    if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(lower[0] ?? '')) dir = resolveDir(dir, raw[1]);
    const g = lower.findIndex((w) => w === 'git' || w.endsWith('/git') || w.endsWith('git.exe'));
    if (g < 0) continue;
    let gitDir = dir;
    let i = g + 1;
    while (i < raw.length && raw[i].startsWith('-')) {
      if (raw[i] === '-C') gitDir = resolveDir(gitDir, raw[i + 1]);
      i += raw[i] === '-C' || raw[i] === '-c' ? 2 : 1;
    }
    const sub = lower[i];
    const rest = lower.slice(i + 1);
    if (sub !== 'switch' && sub !== 'checkout') continue;
    if (rest.some((w) => w === '-h' || w === '--help')) continue;
    if (sub === 'checkout' && rest.some((w) => w === '--' || w === '-p' || w === '--patch')) continue; // paths, not a branch
    if (!inside(gitDir)) continue;
    return `git ${sub} to another branch is blocked while this sandbox's Unity editor is running: Unity would stop on "The open scene(s) have been modified externally". Use mcp__machine__switch_branch instead (it checks the editor and switches safely). To restore files, use git restore <path> or git checkout -- <path>.`;
  }
  return undefined;
}

/** The git commands that put a commit on the branch checked out (w1856). */
const COMMITTING = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'am', 'pull', 'rebase']);

/**
 * Why a shell command is refused because it would commit on urgent/<v> in the sandbox, or undefined (w1856). urgent/<v> is
 * the urgent release lane's pointer at the commit it builds (the ci-release skill's urgent-release.md): nobody commits on
 * it, and after 1.0.0.12 a worker that found BEAST's slot1 left on urgent/1.0.0.12 committed its work there. `branchOf`
 * reads the branch checked out in a folder (releaseHandBack.headBranch). Exported for tests.
 */
export function checkReleaseBranchCommit(cmd: string, cwd: string | undefined, sandboxPath: string, branchOf: (dir: string) => string | undefined = headBranch): string | undefined {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const inside = (d: string | undefined) => !d || n(d) === n(sandboxPath) || n(d).startsWith(n(sandboxPath) + '/');
  let dir = cwd;
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const raw = seg
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/^["']|["']$/g, ''));
    const lower = raw.map((w) => w.toLowerCase());
    if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(lower[0] ?? '')) dir = resolveDir(dir, raw[1]);
    const g = lower.findIndex((w) => w === 'git' || w.endsWith('/git') || w.endsWith('git.exe'));
    if (g < 0) continue;
    let gitDir = dir;
    let i = g + 1;
    while (i < raw.length && raw[i].startsWith('-')) {
      if (raw[i] === '-C') gitDir = resolveDir(gitDir, raw[i + 1]);
      i += raw[i] === '-C' || raw[i] === '-c' ? 2 : 1;
    }
    const sub = lower[i];
    if (!sub || !COMMITTING.has(sub)) continue;
    if (lower.slice(i + 1).some((w) => w === '-h' || w === '--help' || w === '--abort')) continue;
    if (!inside(gitDir)) continue;
    const branch = branchOf(sandboxPath);
    if (!isUrgentBranch(branch)) continue;
    return `git ${sub} is blocked here: this sandbox is on ${branch}, the urgent release lane's pointer at the commit it builds, which nobody commits on (w1856). A release build left the sandbox on it. Put your work on your own branch first: mcp__machine__switch_branch with your branch (create_from origin/master for new work; it refuses uncommitted changes, so with the editor stopped \`git switch -c <your-branch>\` takes them along instead).`;
  }
  return undefined;
}

/** A repo's remotes (name -> push URL), or undefined when `dir` is not a readable git repo. */
export type RemoteResolver = (dir: string) => Map<string, string> | undefined;

export const gitRemotes: RemoteResolver = (dir) => {
  try {
    const out = execFileSync('git', ['-C', dir, 'remote', '-v'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const m = new Map<string, string>();
    for (const line of out.split('\n')) {
      const [name, url, kind] = line.trim().split(/\s+/);
      if (name && url && kind === '(push)') m.set(name, url);
    }
    return m;
  } catch {
    return undefined;
  }
};

/** One spelling per repo: "github.com/owner/name" for every GitHub URL form and gh's OWNER/REPO, else the normalised URL or path. */
export function repoKey(url: string): string {
  const u = url.trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/, '');
  const gh = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[:/](.+)$/.exec(u);
  if (gh) return `github.com/${gh[1]}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) return `github.com/${u}`;
  return u;
}

/**
 * The base branch of a pull request (`pr`: its number, URL or branch; absent: the current branch's), in `repo` (gh's -R)
 * or the repo of `dir`, or undefined when it cannot be read.
 */
export type PrBaseResolver = (pr: string | undefined, repo: string | undefined, dir: string | undefined) => string | undefined;

/** PrBaseResolver through gh (`gh pr view --json baseRefName`); a failure (offline, no such PR) reads as unknown. */
export const ghPrBase: PrBaseResolver = (pr, repo, dir) => {
  try {
    const out = execFileSync('gh', ['pr', 'view', ...(pr ? [pr] : []), ...(repo ? ['-R', repo] : []), '--json', 'baseRefName', '-q', '.baseRefName'], { cwd: dir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
};

export interface ShellContext {
  cwd?: string;
  gameRepos: string[];
  remotes: RemoteResolver;
  /** w1166: reads a PR's base for `gh pr merge` and `gh api .../pulls/<n>/merge`, so a merge into the retired develop is refused. Absent: not checked. */
  prBase?: PrBaseResolver;
  publicIdentity?: PublicIdentity;
  /** The worker shell's environment, for `cd $TMPDIR/x`. */
  env?: Record<string, string | undefined>;
}

/** Repos whose history is public, and the identity commits to them should carry (config publicGitIdentity). */
export interface PublicIdentity {
  repos: string[];
  name?: string;
  email?: string;
  /** Author and committer emails of the commits a push from `dir` to `remote` would publish. Default: git log. */
  pushedEmails?: (dir: string, remote: string, srcs: string[]) => string[] | undefined;
  /** Whether GitHub reports a repo ("github.com/owner/name") as public. Default: repoIsPublic (gh, cached). */
  isPublic?: (key: string) => boolean | undefined;
}

export const isNoreplyEmail = (email: string) => /@users\.noreply\.github\.com$/i.test(email.trim());

/** The emails on commits reachable from `srcs` that `remote` does not have yet (by its tracking refs). */
export const gitPushedEmails = (dir: string, remote: string, srcs: string[]): string[] | undefined => {
  try {
    const not = /[/:\\]/.test(remote) ? '--remotes' : `--remotes=${remote}`;
    const out = execFileSync('git', ['-C', dir, 'log', '--format=%ae%n%ce', ...srcs, '--not', not, '--'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
  } catch {
    return undefined;
  }
};

/** Why a push to a public repo is refused (a commit with a private email), or undefined. */
function checkPublicIdentity(ctx: ShellContext | undefined, remote: string, srcs: string[], dir: string | undefined): string | undefined {
  const pub = ctx?.publicIdentity;
  if (!pub || !dir) return undefined;
  const url = ctx!.remotes(dir)?.get(remote) ?? (/[/:\\]/.test(remote) ? remote : undefined);
  if (!url) return undefined;
  const target = repoKey(url);
  const listed = pub.repos.some((r) => repoKey(r) === target);
  if (!listed && !/^github\.com\/[\w.-]+\/[\w.-]+$/i.test(target)) return undefined;
  const emails = (pub.pushedEmails ?? gitPushedEmails)(dir, remote, srcs);
  const bad = (emails ?? []).filter((e) => !isNoreplyEmail(e) && e.toLowerCase() !== pub.email?.trim().toLowerCase());
  if (!bad.length) return undefined;
  // Only now ask GitHub (cached): most pushes carry no private email at all.
  if (!listed && (pub.isPublic ?? repoIsPublic)(target) !== true) return undefined;
  const name = pub.name ?? '<your name>';
  const email = pub.email ?? '<id>+<login>@users.noreply.github.com';
  return `This push publishes commits with the email(s) ${bad.join(', ')} to ${target}, whose history is public. Commit as the public identity instead: in this clone run git config user.name "${name}" and git config user.email "${email}", then rewrite your unpushed commits with git rebase -r @{u} --exec "git commit --amend --no-edit --reset-author" and push again.`;
}

type ShellEnv = Record<string, string | undefined>;

/**
 * `p` with the variables the worker's shell has filled in ($VAR, ${VAR}, $env:VAR, %VAR%, a leading ~), or undefined when one is
 * unset or the text runs a command ($(...), backticks). Names match without regard to case (Windows). Exported for tests.
 */
export function expandVars(p: string, env: ShellEnv | undefined): string | undefined {
  if (!/[$~%`]/.test(p)) return p;
  if (!env || /`|\$\(/.test(p)) return undefined;
  const get = (name: string) => env[Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ''] || undefined;
  let bad = false;
  const val = (name: string) => get(name) ?? ((bad = true), '');
  let q = p.replace(/^~(?=[\\/]|$)/, () => get('HOME') ?? get('USERPROFILE') ?? ((bad = true), ''));
  q = q.replace(/\$\{(\w+)\}|\$env:(\w+)|\$(\w+)|%(\w+)%/gi, (_m, a, b, c, d) => val(a ?? b ?? c ?? d));
  return bad || /[$`]|^~/.test(q) ? undefined : q;
}

/** Where a `cd` / `git -C` argument lands, or undefined when that cannot be known from the text. */
function resolveDir(base: string | undefined, p: string | undefined, env?: ShellEnv): string | undefined {
  if (!p || p.startsWith('-')) return undefined;
  const e = expandVars(p, env);
  if (e === undefined) return undefined;
  const q = /^\/[a-zA-Z]\//.test(e) ? `${e[1]}:${e.slice(2)}` : e; // Git Bash /c/x -> c:/x
  if (/^[a-zA-Z]:[\\/]/.test(q) || q.startsWith('/')) return q;
  return base ? path.join(base, q) : undefined;
}

/** A URL without its credentials, for a message ("https://user:token@host/x" -> "https://host/x"). */
const plainUrl = (u: string) => u.replace(/^([a-z+]+:\/\/)[^@/]*@/i, '$1');

/**
 * Where a push to `remote` (a remote name in `dir`, or a URL) goes, for the master/main rule: whether it is the game repo, and what
 * the guard saw. Unknown counts as the game repo (`known: false`), and `saw` then says why it could not tell. `lost` is the text of a
 * `cd` / `git -C` target that could not be followed.
 */
function pushTarget(ctx: ShellContext | undefined, remote: string | undefined, dir: string | undefined, lost?: string): { game: boolean; known: boolean; saw: string } {
  const unknown = (saw: string) => ({ game: true, known: false, saw });
  if (!ctx?.gameRepos.length) return unknown('no game repo is configured here, so every master/main push counts as the game repo\'s');
  if (!remote) return unknown('the push names no remote before the branch (write `git push <remote> <branch>`)');
  const game = new Set(ctx.gameRepos.map(repoKey));
  if (/[/:\\]/.test(remote)) {
    const key = repoKey(plainUrl(remote));
    return { game: game.has(key), known: true, saw: `it pushes to ${key}` };
  }
  if (!dir) return unknown(`remote ${remote} could not be read: the directory it runs in could not be followed${lost ? ` (\`${lost}\` has a variable the shell does not have, or runs a command)` : ' (no directory is known for it)'}`);
  const remotes = ctx.remotes(dir);
  if (!remotes) return unknown(`remote ${remote} could not be read: ${dir} is not a git repo`);
  const url = remotes.get(remote);
  if (!url) return unknown(`remote ${remote} could not be read: ${dir} has remotes ${[...remotes].map(([n, u]) => `${n}=${plainUrl(u)}`).join(', ') || '(none)'}`);
  const key = repoKey(plainUrl(url));
  return { game: game.has(key), known: true, saw: `remote ${remote} of ${dir} is ${key}` };
}

const PUSH_AIM = 'The shell returns to your sandbox after every command: to push another repo (Final-Factory/ffbox master is pushed straight, docs/ffbox.md), name its clone in the same command, `cd <clone> && git push origin HEAD:master` (a path, or one under $TMPDIR), or push to its URL.';

/** Whether a gh command run in `dir` (or aimed at `repo` by -R/GH_REPO) is about the game repo. Unknown counts as yes. */
function ghIsGameRepo(ctx: ShellContext | undefined, repo: string | undefined, dir: string | undefined): boolean {
  if (!ctx?.gameRepos.length) return true;
  const game = new Set(ctx.gameRepos.map(repoKey));
  if (repo) return game.has(repoKey(repo));
  const remotes = dir ? ctx.remotes(dir) : undefined;
  if (!remotes?.size) return true;
  return [...remotes.values()].some((u) => game.has(repoKey(u)));
}

const retiredMerge = (pr: string | undefined) =>
  `This PR${pr ? ` (${pr})` : ''} targets the Final Factory game repo's develop, which is retired (w1137, 2026-10-12), so merging it is blocked (w1166). Retarget it to master first (\`gh pr edit ${pr ?? '<n>'} --base master\`), merge origin/master into its branch and push, let CI run, then merge it.`;

/** gh pr merge flags that take a value, so the word after them is not the PR. Case matters: -r is --rebase, -R the repo. */
const GH_PR_MERGE_VALUE_FLAGS = new Set(['-R', '--repo', '-t', '--subject', '-b', '--body', '-F', '--body-file', '-A', '--author-email', '--match-head-commit']);

/**
 * The PR argument of `gh pr merge [<number> | <url> | <branch>] ...` in one simple command, if any (none: the current
 * branch's PR). Quoted values are one word here (`--subject "w1147: labels" 1579`).
 */
function ghPrMergeArgument(seg: string): string | undefined {
  const words = (seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((w) => w.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
  const at = words.findIndex((w, i) => w.toLowerCase() === 'merge' && words[i - 1]?.toLowerCase() === 'pr');
  if (at < 0) return undefined;
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('-')) {
      if (!w.includes('=') && GH_PR_MERGE_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    return w;
  }
  return undefined;
}

/** gh repo flags that take a value, so the word after them is not the repository argument. */
const GH_REPO_VALUE_FLAGS = new Set(['-r', '--repo', '-d', '--description', '-h', '--homepage', '--visibility', '--default-branch', '--add-topic', '--remove-topic', '-t', '--team', '-p', '--template', '-g', '--gitignore', '-l', '--license', '-s', '--source', '--remote']);

/** The repository argument of `gh repo <sub> [<repository>] ...` (words after the subcommand), if any. */
function ghRepoArgument(raw: string[]): string | undefined {
  for (let i = 3; i < raw.length; i++) {
    const w = raw[i];
    if (w.startsWith('-')) {
      if (!w.includes('=') && GH_REPO_VALUE_FLAGS.has(w.toLowerCase())) i++;
      continue;
    }
    return w;
  }
  return undefined;
}

/**
 * Why a shell command is refused, or undefined. Exported for tests. Without a context, or with no
 * game repo configured, every master/main push or PR counts as the game repo's.
 */
export function checkShell(cmd: string, ctx?: ShellContext): string | undefined {
  let dir = ctx?.cwd;
  // The text of the last `cd` / `git -C` target that could not be followed, for the refusal's reason.
  let lost: string | undefined;
  // The worker's shell variables, plus the plain `NAME=value` assignments seen earlier in this command.
  const env: ShellEnv = { ...ctx?.env };
  const move = (base: string | undefined, p: string | undefined) => {
    const d = resolveDir(base, p, env);
    lost = d === undefined ? p : undefined;
    return d;
  };
  // Judge each simple command separately: `cd x && git push -f` must not hide behind the `cd`.
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    const raw = words.map((w) => w.replace(/^["']|["']$/g, ''));
    const lower = raw.map((w) => w.toLowerCase());
    if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(lower[0] ?? '')) dir = move(dir, raw[1]);
    const assign = words.length === 1 ? /^(?:export\s+)?(\w+)=(.*)$/.exec(words[0]) : null;
    if (assign) {
      const v = expandVars(assign[2].replace(/^["']|["']$/g, ''), env);
      if (v === undefined) delete env[assign[1]];
      else env[assign[1]] = v;
    }

    const pushAt = lower.findIndex((w, i) => w === 'push' && lower.slice(0, i).some((x) => x === 'git' || x.endsWith('/git') || x.endsWith('git.exe')));
    if (pushAt >= 0) {
      // The repo this push goes to: `git -C <dir>` or the tracked cwd, and the remote when a refspec follows it.
      let pushDir = dir;
      let pushLost = dir === undefined ? lost : undefined;
      for (let i = 0; i < pushAt; i++) {
        if (raw[i] === '-C') {
          pushDir = move(pushDir, raw[i + 1]);
          pushLost = lost;
        }
        if (lower[i].startsWith('--git-dir') || lower[i].startsWith('--work-tree')) {
          pushDir = undefined;
          pushLost = raw[i];
        }
      }
      const positionals = raw.slice(pushAt + 1).filter((w) => !w.startsWith('-'));
      const remote = positionals.length >= 2 ? positionals[0] : undefined;
      const srcs = positionals.slice(1).map((r) => (r.includes(':') ? r.slice(0, r.indexOf(':')) : r).replace(/^\+/, '')).filter(Boolean);
      const identity = checkPublicIdentity(ctx, positionals[0] ?? 'origin', srcs.length ? srcs : ['HEAD'], pushDir);
      if (identity) return identity;
      for (const w of lower.slice(pushAt + 1)) {
        if (w === '--force' || w.startsWith('--force=') || (/^-[a-z]+$/.test(w) && w.includes('f'))) {
          return 'Force pushes are blocked in sandboxes. Use --force-with-lease on your own branch if you must rewrite it.';
        }
        if (w === '--delete' || (/^-[a-z]+$/.test(w) && w.includes('d')) || w.startsWith(':')) {
          return 'Deleting remote branches is blocked in sandboxes.';
        }
        if (w === '--mirror' || w === '--all' || w === '--prune') return `git push ${w} is blocked in sandboxes; push your own branch.`;
        if (w.startsWith('+')) return 'Force pushes (+refspec) are blocked in sandboxes.';
        if (!w.startsWith('-')) {
          const dst = w.includes(':') ? w.slice(w.indexOf(':') + 1) : w;
          const retired = RETIRED_BRANCH.test(dst);
          if (PROTECTED_BRANCH.test(dst) || retired) {
            const target = pushTarget(ctx, remote, pushDir, pushLost);
            if (target.game) {
              const fix = retired ? DEVELOP_RETIRED : MASTER_BY_PR;
              return target.known
                ? `Pushing to the Final Factory game repo's ${retired ? 'develop' : 'master/main'} is blocked: ${target.saw}. ${fix} ${PUSH_AIM}`
                : `This push's target repo could not be determined (${target.saw}), so it counts as the Final Factory game repo's, where pushing to ${retired ? 'develop' : 'master/main'} is blocked. ${fix} ${PUSH_AIM}`;
            }
          }
        }
      }
    }

    // `GH_REPO=x gh ...`: look past leading environment assignments.
    const envEnd = lower.findIndex((w) => !/^\w+=/.test(w));
    const ghRepoEnv = raw.slice(0, Math.max(envEnd, 0)).find((w) => /^gh_repo=/i.test(w))?.slice('GH_REPO='.length);
    if (envEnd > 0) {
      raw.splice(0, envEnd);
      lower.splice(0, envEnd);
    }
    if (lower[0] === 'gh' || lower[0]?.endsWith('/gh') || lower[0] === 'gh.exe') {
      const sub = lower.slice(1, 3).join(' ');
      const rAt = lower.findIndex((w) => w === '-r' || w === '--repo');
      const repoFlag = rAt >= 0 ? raw[rAt + 1] : (raw.find((w) => w.toLowerCase().startsWith('--repo='))?.slice('--repo='.length) ?? ghRepoEnv);
      if (sub === 'repo delete') return "gh repo delete is blocked: deleting a repository is the user's call, done by hand.";
      if (['repo rename', 'repo create', 'repo edit', 'repo archive', 'repo unarchive'].includes(sub)) {
        // rename's argument is the NEW name: its target is -R or the directory's repo. create's is the repo it makes.
        const arg = sub === 'repo rename' ? undefined : ghRepoArgument(raw);
        if (sub === 'repo create' && !arg) return 'gh repo create without a repository name is blocked: name the repo (owner/name) so it is clearly not the game repo.';
        if (ghIsGameRepo(ctx, repoFlag ?? arg, dir)) return `gh ${sub} on the Final Factory game repo (or a repo that could not be determined) is the user's call, not an agent's.`;
      }
      // w1137: a PR into the game repo's master is the normal flow (it has no main, so --base main is not judged);
      // develop is retired, so a PR into it is refused.
      if ((sub === 'pr create' || sub === 'pr edit') && lower.some((w, i) => w === '--base=develop' || w === '--base=refs/heads/develop' || ((w === '--base' || w === '-b') && RETIRED_BRANCH.test(lower[i + 1] ?? '')))) {
        // Unknown counts as the game repo; say so, and how to name the repo (w1112: a clone reached through a variable was refused as the game's).
        if (ghIsGameRepo(ctx, repoFlag, dir)) return `PRs into the Final Factory game repo's develop are blocked (or this PR's repo could not be determined: a cd to a path with a variable is not followed). ${DEVELOP_RETIRED} For another repo, name it: gh pr create -R <owner>/<repo> ...`;
      }
      // w1166: a PR opened into develop before it was retired (or by a session on older code) is not merged there: #1579
      // merged into develop at 23:20 UTC on 2026-10-12, after the last sweep into master, and had to be carried over again.
      if (sub === 'pr merge' && ctx?.prBase && ghIsGameRepo(ctx, repoFlag, dir)) {
        const pr = ghPrMergeArgument(seg);
        const base = ctx.prBase(pr, repoFlag, dir);
        if (base && RETIRED_BRANCH.test(base)) return retiredMerge(pr);
      }
      if (lower[1] === 'api') {
        const method = lower.find((w, i) => (lower[i - 1] === '-x' || lower[i - 1] === '--method') && !!w)?.toUpperCase();
        const writes = (method && method !== 'GET') || lower.some((w) => w === '-f' || w === '--field' || w === '--raw-field' || w === '--input');
        if (writes && lower.some((w) => /\/git\/refs|\/branches|\/protection|\/merges|\/rulesets/.test(w))) {
          return 'Rewriting branches or refs through the GitHub API is blocked in sandboxes.';
        }
        // w1166: the API's ways to open, retarget or merge a PR into the retired develop, as gh pr create/edit/merge are.
        const pulls = raw.map((w) => /(?:^|\/)repos\/([^/\s]+\/[^/\s]+)\/pulls(?:\/(\d+)(\/merge)?)?\/?$/i.exec(w)).find(Boolean);
        // gh fills {owner}/{repo} from the directory's repo.
        const apiRepo = pulls?.[1].includes('{') ? undefined : pulls?.[1];
        if (writes && pulls && ghIsGameRepo(ctx, apiRepo, dir)) {
          const intoDevelop = lower.some((w, i) => ['-f', '--field', '--raw-field'].includes(lower[i - 1] ?? '') && /^base=(?:refs\/heads\/)?develop$/.test(w));
          if (intoDevelop && !pulls[3]) return `PRs into the Final Factory game repo's develop are blocked. ${DEVELOP_RETIRED}`;
          if (pulls[3] && ctx?.prBase) {
            const base = ctx.prBase(pulls[2], apiRepo, dir);
            if (base && RETIRED_BRANCH.test(base)) return retiredMerge(pulls[2]);
          }
        }
        const pvr = lower.map((w) => /(?:^|\/)repos\/([^/\s]+\/[^/\s]+)\/private-vulnerability-reporting/.exec(w)?.[1]).find(Boolean);
        if (pvr && method && method !== 'GET' && ghIsGameRepo(ctx, pvr, dir)) return "Changing the game repo's security settings is the user's call, not an agent's.";
      }
    }

    if (lower.some((w) => ['shutdown', 'shutdown.exe', 'restart-computer', 'stop-computer'].includes(w))) {
      return 'Shutting down or restarting the machine is blocked.';
    }
  }
  // Process kills are judged on the whole command: `Get-Process Unity | Stop-Process` splits the
  // target and the kill across a pipe.
  const all = cmd.toLowerCase().split(/[\s|;&]+/);
  const killer = all.some((w) => ['taskkill', 'taskkill.exe', 'stop-process', 'kill', 'pkill', 'killall', 'spps'].includes(w));
  // The FF Factory daemon's LaunchAgent and scheduled task, for every agent: on a machine, and in the sandboxes of the
  // portal's own host, whose daemon runs beside the portal (docs/beast-machine.md).
  const lc = cmd.toLowerCase();
  if (/launchctl\s+(bootout|unload|remove|kill|disable)\b[^;&|]*com\.fffactory/.test(lc)) return "Unloading the FF Factory daemon's LaunchAgent is blocked.";
  // A Linux PC's systemd user service (server/machineDeployLinux.ts); `status` and `show` stay allowed.
  if (/systemctl\s+[^;&|]*\b(stop|disable|kill|mask|restart|edit|revert|reload|try-restart|reload-or-restart|isolate)\b[^;&|]*fffactory/.test(lc)) return "Stopping, disabling or changing the FF Factory daemon's systemd service is blocked.";
  if (/loginctl\s+[^;&|]*(disable-linger|terminate-user|kill-user)\b/.test(lc)) return "Ending this user's systemd manager (which runs the FF Factory daemon) is blocked.";
  if (/\brm\b[^;&|]*systemd\/user\/[^;&|\s]*fffactory/.test(lc)) return "Removing the FF Factory daemon's systemd service is blocked.";
  if (/schtasks(\.exe)?\s+[^;&|]*\/(end|delete|change)\b[^;&|]*fffactory|schtasks(\.exe)?\s+[^;&|]*fffactory[^;&|]*\/(end|delete|change)\b/.test(lc)) return "Ending, changing or deleting the FF Factory daemon's scheduled task is blocked.";
  if (/(stop|disable|unregister|set)-scheduledtask\b[^;&]*fffactory|fffactory[^;&]*\|\s*(stop|disable|unregister|set)-scheduledtask\b/.test(lc)) return "Ending, changing or deleting the FF Factory daemon's scheduled task is blocked.";
  if (killer && all.some((w) => /unity|node|claude|powershell|pwsh|tailscale|supervise/.test(w))) {
    return 'Killing Unity, node, claude or PowerShell processes by hand is blocked: other sandboxes and the live co-op game share this machine. Use mcp__machine__unity (action restart; force: true for a frozen editor) to stop or restart your own editor.';
  }
  return undefined;
}
