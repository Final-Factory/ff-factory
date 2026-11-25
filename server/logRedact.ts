import { redactSecrets } from './secrets.ts';

/**
 * The redactor for log lines (w920, w5525): portal_logs (server/portalLogs.ts), the portal's own journal output
 * (server/journalRedact.ts: every console call and stdout or stderr write) and `fffctl logs` (server/redactLogsCli.ts) all
 * mask one way. redactSecrets (server/secrets.ts) masks the vault's values and every token shape of the shared set
 * (shared/secretShapes.ts: JWTs, AWS keys, Slack tokens, Bearer credentials and passwords in URLs among them since w5526);
 * then the forms only a log line is likely to carry, too broad for transcripts of code (`token: string` there is a type):
 * Authorization and cookie headers, a Basic credential, a token in a query string, `password=…`/`token: …` assignments and a
 * Tailscale login link. The same families FFBox redacts before its logs view picks lines (docs/ffbox.md, `logs`). Paths,
 * URLs, addresses, commits and ids stay.
 */
const MASK = '[redacted]';
const SECRET_KEY = '(?:x-api-key|x-auth-token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|session[-_]?token|client[-_]?secret|secret|passwd|password|token|credential|credentials)';
const REDACTIONS: [RegExp, (...m: string[]) => string][] = [
  // Authorization: Bearer abc / Proxy-Authorization / "authorization":"Basic …" (the scheme stays, the value goes)
  [/\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|bot|digest)\s+)?([^\s"',;}]+)/gi, (m, k, sep, scheme, value) => (value.startsWith('[redacted') ? m : `${k}${sep}${scheme ? `${scheme} ` : ''}${MASK}`)],
  // a Basic credential anywhere (Bearer is the shared set's)
  [/\b(basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} ${MASK}`],
  // Cookie and Set-Cookie: the rest of the line
  [/\b((?:set-)?cookie)(["']?\s*[:=]\s*)[^\r\n]*/gi, (_m, k, sep) => `${k}${sep}${MASK}`],
  // a Tailscale login link (tailscaled prints one when the node needs a login): whoever opens it first logs the node in
  [/(https?:\/\/login\.tailscale\.com\/a\/)[A-Za-z0-9]+/gi, (_m, base) => `${base}${MASK}`],
  // ?token=…&key=… in a URL
  [/([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|sig|signature|auth|secret|client_secret|password)=)[^&\s"']+/gi, (_m, k) => `${k}${MASK}`],
  // password=…, "token": "…", x-api-key: …
  [new RegExp(`\\b(${SECRET_KEY})(["']?\\s*[:=]\\s*["']?)(?!\\[redacted)([^\\s"',;&}\\]]{6,})`, 'gi'), (_m, k, sep) => `${k}${sep}${MASK}`],
  // any Anthropic key shape the shared set does not name (sid, ort …)
  [/sk-ant-[a-z]{3}\d\d-[A-Za-z0-9_-]{20,}/g, () => 'sk-ant-[redacted]'],
];

/** A line that still holds one of these after redaction is left out (a regex that missed it): FFBox's `withheld_lines`. */
const STILL_SECRET =
  /sk-ant-[a-z]{3}\d\d-[\w-]{10,}|\bgh[pousr]_\w{20,}|github_pat_\w{20,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY|AGE-SECRET-KEY-1[0-9A-Z]{20,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}|ffpv1_[\w-]{20,}|\bffm_[\w.-]+_[\w-]{32,}|tskey-[a-z]+-[\w-]{16,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;

/** Cheap first look: a line with none of these words or characters needs only redactSecrets. */
const MAYBE_LOG_FORM = /authorization|basic|cookie|tailscale|[?&][a-z_]+=|secret|passw|token|credential|api[-_]?key|sk-ant-/i;

/** `text` with its secrets masked: redactSecrets (the vault's values, the shared token shapes), then the header, query and assignment forms. */
export function redactLogText(text: string): string {
  let out = redactSecrets(text);
  if (!MAYBE_LOG_FORM.test(out)) return out;
  for (const [re, fn] of REDACTIONS) out = out.replace(re, fn as never);
  return out;
}

export const stillLooksSecret = (line: string) => STILL_SECRET.test(line);

/** What stands in for a line that still looked like a secret after redaction. */
export const WITHHELD_LINE = '[line withheld: it still looked like a secret after redaction]';

/** Each line of `text` redacted, and a line that still looks like a secret withheld: what reaches the journal and `fffctl logs`. */
export function redactLogLines(text: string): string {
  const out = redactLogText(text);
  if (!STILL_SECRET.test(out)) return out;
  return out
    .split('\n')
    .map((l) => (STILL_SECRET.test(l) ? WITHHELD_LINE : l))
    .join('\n');
}

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
/** Longer than any private key in PEM (an RSA 8192 key is about 100 lines): a BEGIN with no END stops hiding after this. */
const KEY_MAX_LINES = 200;
export const KEY_LINE_WITHHELD = '[private key line withheld]';

/**
 * A redactor for one line at a time (`fffctl logs`, server/redactLogsCli.ts). The journal keeps each line of a multi-line
 * write as its own entry, so a private key printed as PEM arrives as a BEGIN line, body lines and an END line: from a
 * BEGIN line to its END, every line is withheld, body and END included. Every other line goes through redactLogLines.
 */
export function lineRedactor(): (line: string) => string {
  let inKey = 0;
  return (line: string) => {
    if (inKey) {
      inKey = KEY_END.test(line) || inKey >= KEY_MAX_LINES ? 0 : inKey + 1;
      return KEY_LINE_WITHHELD;
    }
    if (KEY_BEGIN.test(line) && !KEY_END.test(line)) {
      inKey = 1;
      return KEY_LINE_WITHHELD;
    }
    return redactLogLines(line);
  };
}
