// Token shapes and credential variable names, with no imports (w1584): what server/secrets.ts redacts by shape, and what
// scripts/testEnv.ts takes out of a test run's environment. Kept import-free so a test process can load it before
// anything else, and so the portal, the daemons and the scrub tool (server/scrubSecrets.ts) all mask one way.

const lastFour = (m: string) => m.slice(-4);

/** A Claude Code OAuth token (`claude setup-token`). */
export const OAUTH_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;
const OAUTH_TOKEN_ANYWHERE = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/g;
/** An Anthropic API key, and any other sk-ant- credential (admin keys, w1584). */
const API_KEY_ANYWHERE = /sk-ant-api\d\d-[A-Za-z0-9_-]{40,}/g;
const OTHER_ANTHROPIC_ANYWHERE = /sk-ant-[a-z]+\d*-[A-Za-z0-9_-]{30,}/g;

/** A provider connector token (server/providerProtocol.ts, PROVIDER_TOKEN). */
const PROVIDER_TOKEN_ANYWHERE = /ffpv1_[A-Za-z0-9_-]{43}/g;

/** A Discord bot token: base64 user id, timestamp, HMAC (three dot-separated parts). */
const DISCORD_TOKEN_ANYWHERE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-])/g;
/**
 * The value of a Discord token variable (`DISCORD_TOKEN=…`, `FFDISCORD_APP_TOKEN: "…"`), whatever it looks
 * like. The value stops at whitespace, a quote, a backslash (a JSON escape) or a separator, so redacting the
 * serialized JSON of an event cannot break it.
 */
const DISCORD_ASSIGNMENT = /\b((?:FF)?DISCORD(?:_APP)?_TOKEN)(\s*[=:]\s*\\?["']?)([^\s"'\\&;,]{8,})/g;

/**
 * What the orchestration worker's shell could meet in the portal VM (w597): a machine's /machine credential
 * (ffm_<id>_<secret>), a Tailscale key, an age identity and a private key block.
 */
const MACHINE_TOKEN_ANYWHERE = /(ffm_[A-Za-z0-9.-]{1,64}_)[A-Za-z0-9_-]{32,}/g;
/** The portal's own API key (Auth.createApiKey: ffsb_ and 43 base64url characters), for /mcp (w1415: fffctl apikey). */
const PORTAL_KEY_ANYWHERE = /ffsb_[A-Za-z0-9_-]{40,}/g;
const TAILSCALE_KEY_ANYWHERE = /tskey-[a-z]+-[A-Za-z0-9-]{16,}/g;
const AGE_KEY_ANYWHERE = /AGE-SECRET-KEY-1[0-9A-Z]{50,}/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
/** A private key block cut off before its END line (a clipped tool result, w1584): the key lines that follow BEGIN. */
const PRIVATE_KEY_HEAD = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----(?:(?:\\[rn]|\s)*[A-Za-z0-9+/=:,-]+)*/g;

/**
 * A GitHub token (classic, OAuth, app installation, user-to-server, refresh or fine-grained), the vault's kind github
 * (w512). No look-behind (w1584): a token at the start of a line in a JSON-escaped event (`\nghp_…`) or after a terminal
 * colour code (`ESC[32mghp_…`) has a letter before it, and the old `(?<![A-Za-z0-9_])` let both through.
 */
const GITHUB_TOKEN_ANYWHERE = /(gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}/g;

/** Whether `text` may hold a token this module redacts by shape (a cheap check before the regexes). */
export const maybeTokenShape = (text: string) =>
  /sk-ant-|ffpv1_|ffm_|ffsb_|tskey-|AGE-SECRET-KEY-|PRIVATE KEY-----|DISCORD|\.[A-Za-z0-9_-]{6}\.|gh[pousr]_|github_pat_/.test(text);

/**
 * `text` with every token shape masked to its last four characters: `github_pat_[redacted …yVC9]`,
 * `sk-ant-oat01-[redacted …abcd]`, `[redacted Discord token …abcd]`, `[redacted OPENSSH private key]`. Masking is
 * idempotent: a masked form is never masked again.
 */
export function redactTokenShapes(text: string): string {
  if (!maybeTokenShape(text)) return text;
  return text
    .replace(OAUTH_TOKEN_ANYWHERE, (m) => `sk-ant-oat01-[redacted …${lastFour(m)}]`)
    .replace(MACHINE_TOKEN_ANYWHERE, (m, prefix: string) => `${prefix}[redacted …${lastFour(m)}]`)
    .replace(API_KEY_ANYWHERE, (m) => `sk-ant-api-[redacted …${lastFour(m)}]`)
    .replace(OTHER_ANTHROPIC_ANYWHERE, (m) => `sk-ant-[redacted …${lastFour(m)}]`)
    .replace(PORTAL_KEY_ANYWHERE, (m) => `ffsb_[redacted …${lastFour(m)}]`)
    .replace(TAILSCALE_KEY_ANYWHERE, (m) => `tskey-[redacted …${lastFour(m)}]`)
    .replace(AGE_KEY_ANYWHERE, () => 'AGE-SECRET-KEY-[redacted]')
    .replace(PRIVATE_KEY_BLOCK, (_m, kind: string) => `[redacted ${kind}private key]`)
    .replace(PRIVATE_KEY_HEAD, (_m, kind: string) => `[redacted ${kind}private key]`)
    .replace(PROVIDER_TOKEN_ANYWHERE, (m) => `ffpv1_[redacted …${lastFour(m)}]`)
    .replace(GITHUB_TOKEN_ANYWHERE, (m, prefix: string) => `${prefix}[redacted …${lastFour(m)}]`)
    .replace(DISCORD_ASSIGNMENT, (_m, name: string, sep: string, value: string) => (value.startsWith('[redacted') ? _m : `${name}${sep}[redacted …${lastFour(value)}]`))
    .replace(DISCORD_TOKEN_ANYWHERE, (m) => `[redacted Discord token …${lastFour(m)}]`);
}

/**
 * Environment variables that carry a credential, by name: what the portal and the daemons hand a run (the vault's Claude
 * and GitHub tokens as CLAUDE_CODE_OAUTH_TOKEN and GH_TOKEN, a GitHub App's installation token as GH_TOKEN, and env-kind
 * entries, whose names must end in _TOKEN, _KEY, _SECRET or _PASSWORD: server/vault.ts envNameProblem), and what a
 * person's shell may hold (GITHUB_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_REFRESH_TOKEN).
 */
export const SECRET_ENV = /_(?:TOKEN|KEY|SECRET|PASSWORD|PAT)$/;

/** The names in `env` that carry a credential: by name (SECRET_ENV), or by a value shaped like a token. */
export function secretEnvNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => {
    const v = env[k];
    return SECRET_ENV.test(k) || (typeof v === 'string' && v.length >= 20 && redactTokenShapes(v) !== v);
  });
}
