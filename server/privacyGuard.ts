import fs from 'node:fs';
import path from 'node:path';
import { SHELL_PAYLOAD_FLAGS, statements, unquote, verbOf, words } from './rootFence.ts';
import { readTargets } from './secretGuard.ts';

/**
 * Privacy guards for sandbox workers (w17, Ben: "add some security measures to prevent people from snooping in people's
 * computers or invading anyone privacy. this should apply to all factories"). A worker runs as the machine person's own
 * account, so the operating system lets it reach everything that person can: the whole desktop, their browsers, mail and
 * chat apps, credentials, other factories' folders on the same computer, the other machines their ssh keys open. These
 * refusals keep a worker to its own work:
 *
 *   - capture: no whole-desktop screenshot or recording, which shows a person's other windows (chat, mail, browser). One
 *     window (`screencapture -l <id>`, ffmpeg `gdigrab -i title=`, `gfxcapture=hwnd=`, `x11grab -window_id`), a region
 *     (`-R`, `-video_size`), a private Xvfb display, and the in-app captures (the game's own frames, Unity's
 *     ScreenCapture, record_clip) pass.
 *   - camera, microphone and clipboard: no recording from a camera or microphone, no reading the clipboard.
 *   - personal files: no read, search or shell command naming a person's own folders (Desktop, Documents, Downloads,
 *     pictures, cloud drives), browser profiles, mail, messages and chat apps, keychains and credential stores, shell
 *     histories, another user's home folder, or another factory's install folder on the same computer.
 *   - remote access: no ssh, scp, sftp, rsync to a host, PowerShell remoting, psexec, RDP or VNC to another computer
 *     (`ssh -T git@github.com` passes). A step on another computer goes through FF Factory (request_pair, the
 *     orchestrator), as the rules already say.
 *   - listening: no server bound to every interface (`python -m http.server` without `--bind 127.0.0.1`, `--host 0.0.0.0`,
 *     `nc -l`), which would serve the sandbox to the whole network.
 *
 * Like the rest of server/guard.ts this is a seatbelt over the tool calls an agent makes, not a security boundary: a script
 * file can still do what its command line does not show. Folders inside `allow` (the sandbox, the temp folder, the worker
 * install, the skills, the protected and granted folders) are never refused here; their own rules apply.
 */
export interface PrivacyContext {
  /** A Windows machine: drive letters and Git Bash's /c/... spellings. */
  win: boolean;
  /** The worker's home folder (the machine person's). */
  home: string;
  /** The command's working directory, for relative paths. */
  cwd?: string;
  /** Folders that are always fine to name (own sandbox, temp, install folder, skills, protected and granted paths). */
  allow: string[];
  /** Other factories' install folders on this computer (factoryInstalls). */
  installs: string[];
}

const REFUSED = 'Refused by the privacy guard (w17):';

const n = (p: string) => path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '').toLowerCase() || '/';
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');

/** A home-relative path (after the home folder, starting with "/") that is a person's own data, with what it is. */
const PERSONAL: [RegExp, string][] = [
  [/^\/(?:desktop|documents|downloads|pictures|movies|music|videos|onedrive[^/]*|dropbox|google drive|icloud drive[^/]*)(?:\/|$)/, 'a personal folder'],
  [/^\/library\/(?:mobile documents|cloudstorage|photos)(?:\/|$)/, 'a personal folder (cloud drive or photos)'],
  [/^\/library\/(?:mail|messages|safari|cookies|calendars|addressbook|accounts|suggestions|application support\/addressbook|application support\/callhistorydb)(?:\/|$)/, "a person's mail, messages, contacts or browser data"],
  [/^\/library\/keychains(?:\/|$)/, 'a keychain'],
  [
    /^\/library\/containers\/(?:com\.apple\.(?:mail|ichat|notes|safari|photos|messages)|com\.tinyspeck\.slackmacgap|net\.whatsapp\.whatsapp|ru\.keepcoder\.telegram|com\.microsoft\.outlook|com\.microsoft\.teams[^/]*)(?:\/|$)/,
    "a person's mail, messages or chat app",
  ],
  [/^\/library\/group containers\/[^/]*(?:notes|messages|whatsapp|telegram|office|slack|discord)[^/]*(?:\/|$)/, "a person's mail, messages or chat app"],
  [
    /^\/library\/application support\/(?:google\/chrome|chromium|bravesoftware|microsoft edge|firefox|arc|vivaldi|com\.operasoftware\.opera[^/]*|mozilla|thunderbird)(?:\/|$)/,
    'a browser or mail profile',
  ],
  [
    /^\/library\/application support\/(?:discord[^/]*|slack|signal|telegram desktop|whatsapp|microsoft\/teams|microsoft teams[^/]*|teams|zoom\.us|skype|messenger)(?:\/|$)/,
    'a chat app',
  ],
  [/^\/library\/application support\/(?:1password[^/]*|bitwarden|keepassxc|lastpass|dashlane)(?:\/|$)/, 'a password manager'],
  [
    /^\/appdata\/(?:local|roaming)\/(?:google\/chrome|chromium|bravesoftware|microsoft\/edge|mozilla|opera software|vivaldi|thunderbird|microsoft\/outlook|packages\/microsoft\.windowscommunicationsapps[^/]*)(?:\/|$)/,
    'a browser or mail profile',
  ],
  [
    /^\/appdata\/(?:local|roaming)\/(?:discord[^/]*|slack|signal|telegram desktop|whatsapp|microsoft\/teams|zoom|skype|packages\/[^/]*(?:whatsapp|telegram|discord|teams|skype)[^/]*)(?:\/|$)/,
    'a chat app',
  ],
  [/^\/appdata\/(?:local|roaming)\/(?:microsoft\/(?:credentials|protect|vault)|1password|bitwarden|keepass[^/]*|github cli)(?:\/|$)/, 'a credential store'],
  [/^\/appdata\/roaming\/microsoft\/windows\/(?:powershell\/psreadline|recent)(?:\/|$)/, "a person's shell history or recent files"],
  [/^\/\.(?:ssh|gnupg|aws|azure|kube|password-store|netrc|git-credentials|docker\/config\.json|local\/share\/keyrings)(?:\/|$)/, 'a credential store'],
  [/^\/\.config\/(?:gh|google-chrome|chromium|brave[^/]*|discord|slack|signal|mozilla|thunderbird|evolution)(?:\/|$)/, 'a credential store, browser or chat app'],
  [/^\/\.(?:mozilla|thunderbird)(?:\/|$)/, 'a browser or mail profile'],
  [/^\/\.(?:zsh_history|bash_history|python_history|node_repl_history|psql_history|mysql_history|zsh_sessions|local\/share\/fish\/fish_history|lesshst|viminfo)(?:\/|$)/, "a person's shell history"],
];

/** Users' folders that are not a person's (macOS /Users/Shared, Windows Public and Default). */
const SHARED_HOMES = new Set(['shared', 'public', 'default', 'default user', 'all users', 'guest']);

/** What `p` (absolute, any spelling) is of someone else's, or undefined when it is fine to name. */
export function privatePath(p: string, ctx: PrivacyContext): string | undefined {
  const abs = n(p);
  if (ctx.allow.some((a) => a && inside(abs, n(a)))) return undefined;
  for (const i of ctx.installs) if (inside(abs, n(i))) return `another factory's install folder (${i})`;
  if (inside(abs, '/library/keychains')) return 'the system keychain';
  const home = n(ctx.home);
  const m = /^((?:[a-z]:)?\/(?:users|home))\/([^/]+)(\/.*)?$/.exec(abs);
  const own = abs === home || abs.startsWith(home + '/');
  if (m && !own && !SHARED_HOMES.has(m[2]) && n(`${m[1]}/${m[2]}`) !== home) return `another user's home folder (${m[1]}/${m[2]})`;
  if (!own) return undefined;
  const rest = abs.slice(home.length);
  for (const [re, what] of PERSONAL) if (re.test(rest)) return what;
  return undefined;
}

const readRefusal = (target: string, what: string) =>
  `${REFUSED} ${target} is ${what}, which is a person's own, not your work. Work only in your sandbox, your temp folder ($TMPDIR) and the worker install folder; never open a person's own files, apps or credentials. If your task really needs something from there, ask your orchestrator, who asks the person.`;

/** Resolves a path as a tool or a shell names it: "~", $HOME and the Windows profile variables, relative to cwd. */
export function resolveNamed(raw: string, ctx: PrivacyContext): string | undefined {
  let p = unquote(raw).trim();
  if (!p) return undefined;
  const home = ctx.home.replace(/\\/g, '/').replace(/\/+$/, '');
  const known: [RegExp, string][] = [
    [/^(?:~|\$home|\$\{home\}|\$env:userprofile|\$env:home|%userprofile%)(?=$|[\\/])/i, home],
    [/^(?:\$env:localappdata|%localappdata%|\$\{?localappdata\}?)(?=$|[\\/])/i, `${home}/AppData/Local`],
    [/^(?:\$env:appdata|%appdata%|\$\{?appdata\}?)(?=$|[\\/])/i, `${home}/AppData/Roaming`],
  ];
  for (const [re, to] of known) if (re.test(p)) p = p.replace(re, to);
  if (/[$`]|%[^%\s]+%/.test(p)) return undefined;
  p = p.replace(/\\/g, '/');
  if (ctx.win) p = p.replace(/^\/cygdrive\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/')) return n(p);
  if (!ctx.cwd || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return undefined;
  return n(`${ctx.cwd}/${p}`);
}

/** Read, LS, Grep, Glob and NotebookRead of a person's own files, another user's or another factory's folder. */
export function checkPrivacyRead(tool: string, args: Record<string, unknown>, ctx: PrivacyContext): string | undefined {
  for (const t of readTargets(tool, args)) {
    if (!t.path) continue;
    const abs = resolveNamed(t.path, ctx);
    const what = abs && privatePath(abs, ctx);
    if (what) return readRefusal(t.path, what);
  }
  return undefined;
}

// ---------------------------------------------------------------- shell commands

/** Words that run the next word as the program (`sudo x`, `timeout 30 x`, `& "C:/ffmpeg.exe"`). */
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'exec', 'command', 'time', 'nice', 'caffeinate', '&', '.', 'xargs', 'start', 'start-process', 'saps', 'npx', 'pnpx', 'bunx', 'uvx']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd', 'wsl']);

/** A statement's program and its arguments (unquoted), past assignments and wrappers. */
function program(st: string[]): { verb: string; args: string[] } | undefined {
  let i = 0;
  while (i < st.length) {
    const w = unquote(st[i]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    const v = verbOf(st[i]);
    if (WRAPPERS.has(v)) {
      i++;
      while (i < st.length && /^-/.test(unquote(st[i])) && v !== '&') i++;
      continue;
    }
    if (v === 'timeout' || v === 'gtimeout') {
      i++;
      while (i < st.length && (/^-/.test(unquote(st[i])) || /^\d+[smhd]?$/.test(unquote(st[i])))) i++;
      continue;
    }
    return { verb: v, args: st.slice(i + 1).map(unquote) };
  }
  return undefined;
}

const has = (args: string[], re: RegExp) => args.some((a) => re.test(a));
const valueOf = (args: string[], flag: RegExp) => {
  const k = args.findIndex((a) => flag.test(a));
  return k >= 0 ? args[k + 1] : undefined;
};

const CAPTURE_HELP =
  'Capture only your own app\'s window: macOS `screencapture -x -o -l <window id>`, Windows ffmpeg `-f gdigrab -i title="<window title>"` or `gfxcapture=hwnd=<n>`, the in-app captures (Unity ScreenCapture, the game\'s /v1/screenshot) or record_clip, which records one window. A whole desktop shows a person\'s other windows (chat, mail, browser).';

function captureRefusal(what: string): string {
  return `${REFUSED} ${what} captures the whole desktop. ${CAPTURE_HELP}`;
}

/** A whole-desktop grab, or camera or microphone recording, in one statement. */
function checkCaptureStatement(verb: string, args: string[]): string | undefined {
  switch (verb) {
    case 'screencapture':
      // -l <id>: one window; -R x,y,w,h: a region. Anything else (-x path, -D n, -v, -c, -i) is a whole display.
      return has(args, /^-[a-zA-Z]*[lR]/) ? undefined : captureRefusal('`screencapture` without -l <window id> or -R <region>');
    case 'ffmpeg':
    case 'ffprobe':
    case 'ffplay': {
      const formats = args.flatMap((a, k) => (a === '-f' && args[k + 1] ? [args[k + 1].toLowerCase()] : []));
      if (formats.includes('avfoundation')) return `${REFUSED} ffmpeg's avfoundation input records a whole display, a camera or a microphone on macOS. ${CAPTURE_HELP}`;
      const device = formats.find((f) => ['dshow', 'v4l2', 'video4linux2', 'alsa', 'pulse', 'openal', 'jack', 'sndio', 'oss', 'kmsgrab'].includes(f));
      if (device) return `${REFUSED} ffmpeg's ${device} input records a camera, a microphone or a whole screen. Never record a person's camera or microphone.`;
      const input = (valueOf(args, /^-i$/) ?? '').toLowerCase();
      const sized = has(args, /^-video_size$|^-s$/);
      if (formats.includes('gdigrab') && input === 'desktop' && !sized) return captureRefusal('ffmpeg `gdigrab -i desktop` without -video_size (a region)');
      if (formats.includes('x11grab') && !sized && !has(args, /^-window_id$/) && /^[^:]*:[01](?:\.\d+)?$/.test(input)) return captureRefusal(`ffmpeg \`x11grab -i ${input}\` (the person's display) without -window_id or -video_size`);
      const filters = args.join(' ').toLowerCase();
      if (/\bddagrab\b/.test(filters) && !/\bddagrab\b[^\s,;]*video_size=/.test(filters.replace(/ddagrab=([^\s]*)/g, 'ddagrab$1')) && !/video_size=/.test(filters)) return captureRefusal('ffmpeg `ddagrab` without video_size (a region)');
      if (/\bgfxcapture\b/.test(filters) && /monitor/.test(filters)) return captureRefusal('ffmpeg `gfxcapture` of a monitor');
      return undefined;
    }
    case 'import':
      return has(args, /^root$/i) && has(args, /^-window$/) ? captureRefusal('ImageMagick `import -window root`') : undefined;
    case 'xwd':
      return has(args, /^-root$/) ? captureRefusal('`xwd -root`') : undefined;
    case 'scrot':
    case 'spectacle':
      return has(args, /^-u$|^--focused$|^-a$|^--activewindow$|^-s$|^--select$/) ? undefined : captureRefusal(`\`${verb}\``);
    case 'gnome-screenshot':
      return has(args, /^-w$|^--window$/) ? undefined : captureRefusal('`gnome-screenshot` without -w');
    case 'grim':
    case 'maim':
      return has(args, /^-g$|^--geometry$|^-i$|^--window$/) ? undefined : captureRefusal(`\`${verb}\` without a window or region`);
    case 'nircmd':
    case 'nircmdc':
      return has(args, /^savescreenshot(?:full)?$/i) ? captureRefusal(`\`${verb} ${args.find((a) => /^savescreenshot/i.test(a))}\``) : undefined;
    case 'imagesnap':
    case 'videosnap':
    case 'fswebcam':
      return `${REFUSED} \`${verb}\` takes a picture or video from a camera. Never record a person's camera.`;
    case 'arecord':
    case 'rec':
      return `${REFUSED} \`${verb}\` records from a microphone. Never record a person's microphone.`;
    case 'sox':
      return args.includes('-d') && args.indexOf('-d') < args.length - 1 ? `${REFUSED} \`sox -d\` records from a microphone. Never record a person's microphone.` : undefined;
    case 'pbpaste':
    case 'wl-paste':
    case 'get-clipboard':
    case 'gcb':
      return clipboardRefusal(verb);
    case 'xclip':
      return has(args, /^-o(?:ut)?$/) ? clipboardRefusal('xclip -o') : undefined;
    case 'xsel':
      return has(args, /^-o$|^--output$/) ? clipboardRefusal('xsel -o') : undefined;
  }
  return undefined;
}

function clipboardRefusal(what: string): string {
  return `${REFUSED} \`${what}\` reads the clipboard, which holds whatever the person last copied (passwords, messages). Never read a person's clipboard; pass data through files in $TMPDIR.`;
}

/** Captures spelled inside code a command runs inline (python -c, PowerShell, osascript, swift). */
const INLINE_CAPTURES: [RegExp, (m: RegExpExecArray) => string | undefined][] = [
  [/imagegrab\.grab\(([^)]*)\)/g, (m) => (/bbox|xdisplay/.test(m[1]) ? undefined : captureRefusal('PIL `ImageGrab.grab()` without bbox')) ],
  [/pyautogui\.screenshot\(([^)]*)\)/g, (m) => (/region/.test(m[1]) ? undefined : captureRefusal('`pyautogui.screenshot()` without region'))],
  [/(?:^|[^\w.])(?:import mss|from mss|mss\.mss\(|mss\(\)\.grab)/g, () => captureRefusal('`mss`')],
  [/copyfromscreen[\s\S]*?(?:primaryscreen|virtualscreen|allscreens|screen\]::bounds)|(?:primaryscreen|virtualscreen|allscreens)[\s\S]*?copyfromscreen/g, () => captureRefusal('`CopyFromScreen` of the screen bounds')],
  [/cgdisplaycreateimage|cgwindowlistcreateimage\([^)]*(?:infinite|null)|sccontentfilter\(\s*display:/g, () => captureRefusal('a CoreGraphics or ScreenCaptureKit display capture')],
  [/clipboard\]::get(?:text|image|data|filedroplist)|nspasteboard\.general/g, () => clipboardRefusal('the clipboard API')],
];

const REMOTE_VERBS = new Set(['ssh', 'scp', 'sftp', 'mosh', 'telnet', 'rsh', 'rlogin', 'sshpass', 'psexec', 'psexec64', 'paexec', 'winrs', 'mstsc', 'vncviewer', 'enter-pssession', 'etsn', 'new-pssession', 'nsn']);
const GITHUB_SSH = /^(?:[\w.-]+@)?(?:ssh\.)?github\.com$/i;

function remoteRefusal(what: string): string {
  return `${REFUSED} ${what} opens another computer. A worker works on its own machine only: a step on another computer goes through FF Factory (request_pair for a two-machine check (legs: 1 when one computer runs both sides), publish_attachment to hand over a file, or your orchestrator for the ops worker), never through ssh, remoting or a remote desktop.`;
}

function checkRemoteStatement(verb: string, args: string[]): string | undefined {
  if (verb === 'ssh') {
    if (has(args, /^-V$/)) return undefined;
    const VALUE = /^-[bcDEeFIiJLlmOopQRSWw]$/;
    const host = args.find((a, k) => !a.startsWith('-') && !(k > 0 && VALUE.test(args[k - 1])));
    if (host && GITHUB_SSH.test(host)) return undefined;
    return remoteRefusal(`\`ssh${host ? ` ${host}` : ''}\``);
  }
  if (REMOTE_VERBS.has(verb)) return remoteRefusal(`\`${verb}\``);
  if ((verb === 'invoke-command' || verb === 'icm') && has(args, /^-(?:computername|cn|session|hostname|vmname)$/i)) return remoteRefusal('`Invoke-Command -ComputerName`');
  if (verb === 'tailscale' && args[0] === 'ssh') return remoteRefusal('`tailscale ssh`');
  if (verb === 'rsync' && (has(args, /^-e$|^--rsh/) || args.some((a) => /^(?:[\w.-]+@)?[\w.-]+::?[^/\\]?/.test(a) && !/^[a-zA-Z]:[\\/]/.test(a)))) return remoteRefusal('`rsync` to another host');
  if (verb === 'open' && has(args, /^(?:vnc|ssh|rdp|smb|afp|sftp):\/\//i)) return remoteRefusal(`\`open ${args.find((a) => /:\/\//.test(a))}\``);
  return undefined;
}

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])(?::\d+)?$/i;
const EVERY_INTERFACE = /^(?:0\.0\.0\.0|::|\[::\])(?::\d+)?$/;
/** `*` means every interface only after a long flag (`--host *`); after a short one it is a shell glob (`ls -a *`). */
const EVERY_INTERFACE_LONG = /^(?:0\.0\.0\.0|::|\[::\]|\*)(?::\d+)?$/;

function listenRefusal(what: string): string {
  return `${REFUSED} ${what} listens on every network interface, so every computer on the network (and the tailnet) can read what it serves. Bind to 127.0.0.1: \`python3 -m http.server --bind 127.0.0.1 8000\`, \`--host 127.0.0.1\`.`;
}

function checkListenStatement(verb: string, args: string[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const m = /^(--host|--bind|--listen|--address|-b|-a|-S|-H)(?:=(.*))?$/.exec(args[k]);
    if (!m) continue;
    const v = m[2] ?? args[k + 1] ?? '';
    if ((m[1].startsWith('--') ? EVERY_INTERFACE_LONG : EVERY_INTERFACE).test(v)) return listenRefusal(`\`${m[1]} ${v}\``);
  }
  if (/^python[\d.]*$|^py$/.test(verb)) {
    const mod = valueOf(args, /^-m$/);
    if (mod === 'http.server' || mod === 'SimpleHTTPServer') {
      const bind = valueOf(args, /^--bind$|^-b$/);
      if (!bind || !LOOPBACK.test(bind)) return listenRefusal(`\`python -m ${mod}\` without --bind 127.0.0.1`);
    }
  }
  if (verb === 'http-server' && !args.some((a, k) => /^-a$/.test(a) && LOOPBACK.test(args[k + 1] ?? ''))) return listenRefusal('`http-server` without -a 127.0.0.1');
  if ((verb === 'nc' || verb === 'ncat' || verb === 'netcat') && has(args, /^-[a-zA-Z]*l/) && !args.some((a) => LOOPBACK.test(a))) return listenRefusal(`\`${verb} -l\` without 127.0.0.1`);
  return undefined;
}

/** Absolute paths a command names, with "~", $HOME and the profile variables spelled out (for privatePath). */
function namedPaths(cmd: string, ctx: PrivacyContext): string[] {
  const out: string[] = [];
  const all = statements(cmd);
  // A climb out of the working folder (`ls ../../../Desktop`) resolves against it, unless the command changes folder first.
  const moves = all.some((st) => st.some((raw) => /^(?:cd|pushd|popd|set-location|sl|chdir)$/.test(verbOf(words(raw)[0] ?? ''))));
  for (const st of all) {
    for (const raw of st) {
      for (const w of words(raw)) {
        // A path may follow a flag or a name (`--file=~/x`, `if=/Users/x`) or sit in quotes of a longer word.
        const word = unquote(w);
        for (const part of [word, ...word.split(/[=,;]/).slice(1), ...(/^-\w+:(.+)$/.exec(word)?.slice(1) ?? [])]) {
          const p = resolveNamed(part, { ...ctx, cwd: !moves && /^\.\.(?:[\\/]|$)/.test(part) ? ctx.cwd : undefined });
          if (p) out.push(p);
        }
        for (const m of word.matchAll(/(?:~|\$home|\$\{home\}|\$env:userprofile|%userprofile%|\$env:appdata|%appdata%|\$env:localappdata|%localappdata%|(?:[a-zA-Z]:)?[\\/](?:users|home)[\\/])[^\s"'`;|&<>()=,]*/gi)) {
          const p = resolveNamed(m[0], { ...ctx, cwd: undefined });
          if (p) out.push(p);
        }
      }
    }
  }
  return [...new Set(out)];
}

/** Commands run by a shell's -c payload (`bash -c "..."`, `powershell -Command "..."`), judged as their own command. */
function payloads(st: string[]): string[] {
  const out: string[] = [];
  const v = verbOf(st[0] ?? '');
  if (!SHELLS.has(v)) return out;
  for (let k = 1; k < st.length - 1; k++) if (SHELL_PAYLOAD_FLAGS.has(unquote(st[k]).toLowerCase())) out.push(unquote(st[k + 1]));
  return out;
}

/**
 * The privacy guard's verdict on a Bash or PowerShell command: a refusal, or undefined. `cmd` should already have commit
 * messages and PR bodies taken out (withoutTextArgs), so text that only mentions a tool is not judged.
 */
export function checkPrivacyShell(cmd: string, ctx: PrivacyContext, depth = 0): string | undefined {
  const flat = cmd.replace(/\\/g, '/').toLowerCase();
  for (const [re, verdict] of INLINE_CAPTURES) {
    re.lastIndex = 0;
    for (const m of flat.matchAll(re)) {
      const why = verdict(m);
      if (why) return why;
    }
  }
  for (const st of statements(cmd)) {
    const ws = st.flatMap(words);
    const prog = program(ws);
    if (!prog) continue;
    const why = checkCaptureStatement(prog.verb, prog.args) ?? checkRemoteStatement(prog.verb, prog.args) ?? checkListenStatement(prog.verb, prog.args);
    if (why) return why;
    if (depth < 2) for (const inner of payloads(ws)) {
      const deeper = checkPrivacyShell(inner, ctx, depth + 1);
      if (deeper) return deeper;
    }
  }
  for (const p of namedPaths(cmd, ctx)) {
    const what = privatePath(p, ctx);
    if (what) return readRefusal(p, what);
  }
  return undefined;
}

// ---------------------------------------------------------------- other factories on this computer

/** Whether a folder is an FF Factory install (a daemon's config, or a secrets folder beside an app, daemon or worker folder). */
function isInstall(dir: string, exists: (p: string) => boolean): boolean {
  if (exists(path.join(dir, 'daemon.json')) || exists(path.join(dir, 'root.json'))) return true;
  return exists(path.join(dir, 'secrets')) && ['app', 'daemon', 'worker', 'sandboxes'].some((d) => exists(path.join(dir, d)));
}

/**
 * The other factories' install folders on this computer (w17): FF Factory installs among the home folder's own folders
 * and the folders beside this worker's install, other than the one this worker runs from (the install that holds its
 * worker root, or is held by it). Several factories' installs can sit side by side in one home folder.
 */
export function factoryInstalls(opts: { home: string; workerRoot?: string; list?: (dir: string) => string[]; exists?: (p: string) => boolean }): string[] {
  const exists = opts.exists ?? fs.existsSync;
  const list =
    opts.list ??
    ((dir: string) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
      } catch {
        return [];
      }
    });
  const root = opts.workerRoot ? n(opts.workerRoot) : undefined;
  const places = [opts.home, ...(opts.workerRoot ? [path.dirname(opts.workerRoot), path.dirname(path.dirname(opts.workerRoot))] : [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const place of places) {
    for (const dir of list(place)) {
      const k = n(dir);
      if (seen.has(k)) continue;
      seen.add(k);
      if (root && (inside(root, k) || inside(k, root))) continue;
      if (isInstall(dir, exists)) out.push(dir);
    }
  }
  return out;
}
