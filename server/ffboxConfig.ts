// One FFBox setting changed over the connector (w2672; lothsahn: "Give yourself a way to update ffbox settings over the
// tunnel"; w2835, lothsahn: "Please update ffbox's tunnel so you can change its settings yourself"): the orchestrator tool
// set_ffbox_config asks FFBox's `set_config` query, and FFBox does the rest. FFBox holds the list of keys it may change
// (its scripts/ffbox_settings.py SETTABLE table: every config.json setting but secrets, tokens, credential paths, operator
// identities and the paths and addresses it runs or sends to), each with its type check, writes only its
// ~/.config/ffbox/config.json, never secrets.env (lothsahn: "It should only change settings in settings.json, not the
// secrets in secrets.env"), keeps config.json.prev, logs who, why, old and new, applies a live key in place and answers
// the effective value read back. A key ffwatch reads only at start is written and FFBox restarts on its updater's next
// pass; FFBox refuses one while a release builds, so a release is never cut short. The checks here only fail fast with
// a sentence; FFBox answers `refused` with its own reason for anything they let through (docs/ffbox.md, "Changing an
// FFBox setting").
import { type ProviderManager } from './providers.ts';
import { clean } from './ffboxReports.ts';
import { redactSecrets } from './secrets.ts';

/** A dotted config.json key, as FFBox's set_config lists them (`fff.dev_requests`, `intake.auto.max_per_day`). */
export const FFBOX_KEY = /^[a-z][a-z0-9_]{0,40}(\.[a-z0-9_]{1,40}){0,3}$/;

/** Never sent: a key that names a secret, a token, a credential or an operator's identity. FFBox refuses these as well. */
const NEVER = /(^|\.)(operators|steam)(\.|$)|(^|[._])(token|token_env|key_name|account)$|secret|password|credential|api_key/;

/** The longest value text sent (a list of paths is the longest FFBox takes). */
export const FFBOX_VALUE_MAX = 400;

const CHANGE_ID = /^s[0-9a-f]{10}$/;

export type FfboxValue = number | string | boolean | null | string[];

export interface FfboxConfigInput {
  /** A dotted key FFBox lists; none (and no revert): the settable keys and their values now. */
  key?: string;
  /** The new value, of the key's kind: a number, a string, true or false, null, or a list of strings. */
  value?: FfboxValue;
  /** Why, in a few words: FFBox logs it with the change. */
  reason?: string;
  /** A change id FFBox answered (s + 10 hex): put its old value back. */
  revert?: string;
  /** Who asked, for FFBox's log. */
  by?: string;
}

/** The query's args out of a call, or a sentence saying what is wrong with it. */
export function ffboxConfigArgs(input: FfboxConfigInput): { args: Record<string, string> } | { error: string } {
  const key = String(input.key ?? '').trim();
  const revert = String(input.revert ?? '').trim();
  const by = clean(input.by ?? '', 120);
  const reason = clean(redactSecrets(String(input.reason ?? '').trim()), 200);
  if (!key && !revert) return { args: { by } };
  if (key && revert) return { error: 'give key and value, or revert alone (a change id), not both' };
  if (!reason) return { error: 'reason: say why, in a few words; FFBox logs it with the change' };
  if (revert) {
    if (!CHANGE_ID.test(revert)) return { error: 'revert: the change id FFBox answered (s and 10 hex digits)' };
    return { args: { revert, reason, by } };
  }
  if (!FFBOX_KEY.test(key) || NEVER.test(key)) {
    return { error: `key: FFBox's set_config changes only the settings it lists (call it with no key), never a secret, a token or an operator's identity (got ${JSON.stringify(clean(key, 64))}). Secrets (secrets.env) are a person's, by hand on the box.` };
  }
  const value = input.value;
  const ok = value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))
    || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
  if (!ok) return { error: "value: a number, a string, true or false, null, or a list of strings, of the key's kind (call it with no key for each key's kind)" };
  const text = JSON.stringify(value);
  if (text.length > FFBOX_VALUE_MAX) return { error: `value: at most ${FFBOX_VALUE_MAX} characters as JSON` };
  if (redactSecrets(text) !== text) return { error: 'value: it looks like a secret; FFBox never takes one' };
  return { args: { key, value: text, reason, by } };
}

/** Answers that mean FFBox did not take the request: asked once more. A timeout is not: the change may have been made. */
const AGAIN = new Set(['busy', 'not_ready', 'unavailable']);

const show = (v: unknown) => JSON.stringify(v ?? null);

/** A listed key's kind in a few words: `fraction 0 to 1`, `int 1 to 100`, `one of "prefer", "off"`, `bool`. */
function kindText(r: Record<string, unknown>): string {
  const kind = String(r.kind ?? '');
  const parts = [kind];
  if (Array.isArray(r.values)) parts.splice(0, 1, `one of ${(r.values as unknown[]).map(show).join(', ')}`);
  else if (r.min !== undefined || r.max !== undefined) parts.push(`${show(r.min)} to ${show(r.max)}`);
  if (r.nullable) parts.push('or null');
  return parts.join(' ');
}

/** Ask FFBox to change (or list) its settings. Throws an Error with a plain sentence when nothing was changed or it could not be told. */
export async function setFfboxConfig(providers: ProviderManager, input: FfboxConfigInput, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  const parsed = ffboxConfigArgs(input);
  if ('error' in parsed) throw new Error(parsed.error);
  let a = await providers.query('set_config', parsed.args);
  if (!a.live && AGAIN.has(a.error ?? '')) {
    await sleep(3_000);
    a = await providers.query('set_config', parsed.args);
  }
  const words = clean([a.reason, a.hint, a.detail].filter(Boolean).join('; '), 300);
  if (!a.live || !a.data) {
    if (a.error === 'timeout' || a.error === 'no_answer' || a.error === 'disconnected') {
      throw new Error(`FFBox did not answer (${a.error}${words ? `: ${words}` : ''}); the change may have been made. Call set_ffbox_config with no key to read the values now and the recent changes before you ask again.`);
    }
    if (a.error === 'unsupported') throw new Error("FFBox's connector does not offer set_config yet (an FFBox update brings it); nothing was changed.");
    throw new Error(`FFBox changed nothing: ${a.error ?? 'no answer'}${words ? ` (${words})` : ''}.`);
  }
  const d = a.data;
  if (Array.isArray(d.settable)) {
    const rows = (d.settable as Record<string, unknown>[]).map((r) => `- ${String(r.key)} = ${show(r.effective)} (${kindText(r)}; ${r.apply === 'restart' ? 'restarts FFBox' : 'live'}): ${clean(String(r.what ?? ''), 200)}`);
    const recent = Array.isArray(d.recent) ? (d.recent as Record<string, unknown>[]).map((r) => `- ${String(r.change)} ${String(r.at)}: ${String(r.key)} ${show(r.old)} -> ${show(r.new)} by ${clean(String(r.by ?? ''), 120)} (${clean(String(r.reason ?? ''), 200)})${r.revert_of ? `, reverting ${String(r.revert_of)}` : ''}`) : [];
    const left = Array.isArray(d.not_settable) ? [`Never settable here: ${clean((d.not_settable as unknown[]).map(String).join('; '), 600)}.`] : [];
    return [`FFBox's settable settings (in its config.json; "live" applies at once, "restarts FFBox" applies when its updater restarts it, refused while a release builds):`, ...rows, ...left, recent.length ? 'Recent changes:' : 'No changes yet.', ...recent].join('\n');
  }
  const how = d.restart
    ? `Written; ffwatch reads this key only at start, so it takes effect when FFBox restarts${d.restart_note ? ` (${clean(String(d.restart_note), 300)})` : ''}; effective now ${show(d.effective)}`
    : `Applied live, no restart; effective now ${show(d.effective)} (read back live)`;
  return `FFBox: ${String(d.key)} ${show(d.old)} -> ${show(d.new)}. ${how}. Change ${String(d.change)} at ${String(d.at)}${d.revert_of ? `, reverting ${String(d.revert_of)}` : ''}; the old file is FFBox's config.json.prev. To undo: set_ffbox_config revert "${String(d.change)}".`;
}
