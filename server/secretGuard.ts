import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * What orchestrators and standing agents may not read (w467, change 7 of docs/portal-on-ffbox-host.md): FF Factory's
 * own secrets and data. An orchestrator reads the repo and its own memory; a standing agent its folder, the repo and
 * GitHub. Neither has a reason to open config.json (the agents' Claude token, FFBox's connector token), a token or
 * API-key file, ~/.ssh (the keys machine deploys use), Claude's credentials folder, gh's token, or data/ (sessions,
 * transcripts, the ledger, other people's memory). A prompt injection relayed into one could otherwise read them and
 * pass them on in a tool call. This is a seatbelt like the other guards: the tools' own permission rules still apply.
 *
 * Paths follow the agent's platform (`platform`): Windows paths compare without case, `/c/x` (Git Bash) is `c:/x`,
 * UNC and device paths are refused; POSIX paths compare as they are. "~" is the agent's home.
 */
export interface SecretRules {
  /**
   * Files and folders not to read, nor search from above. A trailing "*" matches by prefix (config.json* covers
   * config.json.prev and config.json.1).
   */
  deny: string[];
  /** Folders inside those that may be read: an orchestrator's own memory folder, the attachment store. */
  allow: string[];
}

export interface ReadFs {
  /** Where a path really leads (links, junctions), or undefined when it does not exist. */
  realpath(p: string): string | undefined;
}

export const realReadFs: ReadFs = {
  realpath: (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return undefined;
    }
  },
};

export interface ReadCtx {
  platform: NodeJS.Platform;
  /** The agent's home, for "~". */
  home: string;
  /** Where relative paths start: the agent's working folder. */
  cwd: string;
  fsx: ReadFs;
}

type Key = { key: string; prefix: boolean };

/** `p` as an absolute path of the platform (home and Git Bash forms expanded), or undefined when empty. */
function absOf(p: string, c: ReadCtx): string | undefined {
  let s = p.trim().replace(/^["']|["']$/g, '');
  if (!s) return undefined;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = c.home + s.slice(1);
  if (c.platform === 'win32') {
    s = s.replace(/^\\\\\?\\(?=[a-zA-Z]:)/, '');
    if (/^[\\/][a-zA-Z](?:[\\/]|$)/.test(s)) s = `${s[1]}:${s.slice(2) || '/'}`;
    return path.win32.resolve(c.cwd, s);
  }
  return path.posix.resolve(c.cwd, s);
}

/** The form paths are compared in: forward slashes, no trailing slash, lower-case on Windows. */
function keyOf(abs: string, platform: NodeJS.Platform): string {
  const k = abs.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
  return platform === 'win32' ? k.toLowerCase() : k;
}

function ruleKeys(list: readonly string[], c: ReadCtx): Key[] {
  const out: Key[] = [];
  for (const raw of list) {
    const prefix = raw.endsWith('*');
    const abs = absOf(prefix ? raw.slice(0, -1) : raw, c);
    if (!abs) continue;
    out.push({ key: keyOf(abs, c.platform), prefix });
    // A rule names the place itself and where it really is (C:\Users\me\.ssh may be a junction).
    const real = c.fsx.realpath(abs);
    if (real) out.push({ key: keyOf(real, c.platform), prefix });
  }
  return out;
}

const under = (p: string, k: Key) => (k.prefix ? p.startsWith(k.key) : p === k.key || p.startsWith(k.key === '/' ? '/' : `${k.key}/`));
/** Whether a search from `p` reaches `k` (p is above it). */
const above = (p: string, k: Key) => p !== k.key && (p === '/' || /^[a-z]:\/?$/.test(p) ? true : k.key.startsWith(`${p}/`));

/**
 * Why reading `target` is refused, or undefined. `kind`: a file read only looks at the file; a search (Grep, Glob, a
 * recursive grep or find) also may not start above a denied path, since it would read it.
 */
export function readProblem(target: string, kind: 'file' | 'search', rules: SecretRules, c: ReadCtx): string | undefined {
  if (typeof target !== 'string') return undefined;
  if (c.platform === 'win32' && /^\s*[\\/]{2}/.test(target)) return `${target}: UNC and device paths are not read by FF Factory's orchestrators and standing agents`;
  const abs = absOf(target, c);
  if (!abs) return undefined;
  const forms = [keyOf(abs, c.platform)];
  const real = c.fsx.realpath(abs);
  if (real) forms.push(keyOf(real, c.platform));
  const deny = ruleKeys(rules.deny, c);
  const allow = ruleKeys(rules.allow, c);
  for (const p of forms) {
    const allowed = allow.some((a) => under(p, a));
    const hit = deny.find((d) => under(p, d));
    if (hit && !allowed) return `${target} is FF Factory's own (its config, secrets, keys, Claude's credentials or data/): orchestrators and standing agents do not read it. Ask a person, or the dispatcher, for what you need from it.`;
    if (kind === 'search') {
      const inside = deny.find((d) => !d.prefix && above(p, d) && !allow.some((a) => under(d.key, a)));
      const prefixed = deny.find((d) => d.prefix && p !== d.key && d.key.startsWith(p.endsWith('/') ? p : `${p}/`));
      const reach = inside ?? prefixed;
      if (reach && !allowed) return `A search from ${target} would read FF Factory's own files (${reach.key}${reach.prefix ? '*' : ''}): search a folder that does not hold them (the repo, your own folder).`;
    }
  }
  return undefined;
}

/** The longest part of a glob pattern before its first wildcard, as a folder ("" when it starts with one). */
export function globBase(pattern: string): string {
  const parts = pattern.replace(/\\/g, '/').split('/');
  const fixed: string[] = [];
  for (const seg of parts) {
    if (/[*?[\]{}]/.test(seg)) break;
    fixed.push(seg);
  }
  if (fixed.length === parts.length) fixed.pop();
  return fixed.join('/');
}

/** The paths a read tool call reads, and how (Read, NotebookRead and LS a file or folder; Grep and Glob a tree). */
export function readTargets(tool: string, input: Record<string, unknown>): { path: string; kind: 'file' | 'search' }[] {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return [{ path: str(input.file_path) ?? str(input.notebook_path) ?? '', kind: 'file' }];
    case 'LS':
      return [{ path: str(input.path) ?? '.', kind: 'file' }];
    case 'Grep':
      return [{ path: str(input.path) ?? '.', kind: 'search' }];
    case 'Glob': {
      const base = str(input.path) ?? '.';
      const fixed = globBase(str(input.pattern) ?? '');
      if (!fixed) return [{ path: base, kind: 'search' }];
      const abs = /^([a-zA-Z]:)?\//.test(fixed) || fixed.startsWith('~');
      return [{ path: abs ? fixed : `${base.replace(/[\\/]+$/, '')}/${fixed}`, kind: 'search' }];
    }
    default:
      return [];
  }
}

/** The PreToolUse hook: refuses Read, NotebookRead, LS, Grep and Glob calls readProblem refuses. Other tools pass. */
export function secretReadGuard(rules: SecretRules, cwd: string, platform: NodeJS.Platform = process.platform, fsx: ReadFs = realReadFs, home = os.homedir()): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    const c: ReadCtx = { platform, home, cwd: (input as { cwd?: string }).cwd || cwd, fsx };
    for (const t of readTargets(input.tool_name, args)) {
      const why = readProblem(t.path, t.kind, rules, c);
      if (why) return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
    }
    return {};
  };
}

/** Where an agent's own Claude, ssh and gh credentials are, as rules ("~" is expanded where the agent runs). */
export function homeSecrets(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  return [
    '~/.ssh',
    '~/.claude',
    '~/.claude.json*',
    '~/.config/gh',
    '~/.git-credentials',
    ...(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : []),
    ...(platform === 'win32' && env.APPDATA ? [path.win32.join(env.APPDATA, 'GitHub CLI')] : []),
  ];
}

/** Secret files config may name (part A of the portal VM, w464: claudeTokenFile; change 18: anthropicApiKeyFile). */
export const secretFilesOf = (cfg: object): (string | undefined)[] => {
  const c = cfg as { claudeTokenFile?: unknown; anthropicApiKeyFile?: unknown };
  return [c.claudeTokenFile, c.anthropicApiKeyFile].map((v) => (typeof v === 'string' ? v : undefined));
};

/**
 * The portal's secrets and data, as rules for agents that run on its own computer (orchestrators, and standing agents
 * of this host): config.json and its saved versions, data/, the secrets folder (the VM's /srv/fff/secrets, or one beside
 * the app), token and API-key files (config claudeTokenFile, anthropicApiKeyFile), FFBox's ffdiscord config and secrets
 * (FFBOX_CONFIG_DIR, FFBOX_SECRETS), and the home secrets (homeSecrets). `allow`: what such an agent may still read in
 * there. Each rule in both its Windows and its POSIX spelling, so the platform the agent runs on decides.
 */
export function portalSecretRules(o: {
  configFile: string;
  appRoot: string;
  dataDir: string;
  secretFiles?: readonly (string | undefined)[];
  allow?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): SecretRules {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const same = (a: string, b: string) => keyOf(P.resolve(a), platform) === keyOf(P.resolve(b), platform);
  const cfgDir = P.dirname(o.configFile);
  const files = (o.secretFiles ?? []).filter((f): f is string => !!f && !!f.trim());
  return {
    deny: [
      `${o.configFile}*`,
      `${P.join(o.appRoot, 'config.json')}*`,
      o.dataDir,
      P.join(o.appRoot, 'secrets'),
      ...(same(cfgDir, o.appRoot) ? [] : [P.join(P.dirname(cfgDir), 'secrets')]),
      ...files.map((f) => (P.basename(P.dirname(f)).toLowerCase() === 'secrets' ? P.dirname(f) : f)),
      ...(env.FFBOX_SECRETS ? [env.FFBOX_SECRETS] : []),
      ...(env.FFBOX_CONFIG_DIR ? [env.FFBOX_CONFIG_DIR] : []),
      ...homeSecrets(env, platform),
    ],
    allow: [...(o.allow ?? [])],
  };
}
