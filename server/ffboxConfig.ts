// One FFBox setting changed over the connector (w2672; lothsahn: "Give yourself a way to update ffbox settings over the
// tunnel"): the orchestrator tool set_ffbox_config asks FFBox's `set_config` query, and FFBox does the rest. FFBox holds
// the list of keys it may change (its scripts/ffbox_settings.py LIVE table: today the two subscription holds), writes only
// its ~/.config/ffbox/config.json, never secrets.env (lothsahn: "It should only change settings in settings.json, not the
// secrets in secrets.env"), keeps config.json.prev, logs who, why, old and new, applies the value live (no restart, so a
// release build is never cut short) and answers the effective value read back. The checks here only fail fast with a
// sentence; FFBox answers `refused` with its own reason for anything they let through (docs/ffbox.md, "Changing an FFBox
// setting").
import { type ProviderManager } from './providers.ts';
import { clean } from './ffboxReports.ts';
import { redactSecrets } from './secrets.ts';

/** The keys FFBox's set_config takes (its ffbox_settings.LIVE). FFBox is the authority; this list only names them early. */
export const FFBOX_SETTABLE_KEYS = ['subscription.new_conversation_hold_pct', 'subscription.review_hold_pct'] as const;

const CHANGE_ID = /^s[0-9a-f]{10}$/;

export interface FfboxConfigInput {
  /** A dotted key of FFBOX_SETTABLE_KEYS; none (and no revert): the settable keys and their values now. */
  key?: string;
  /** The new value: a number from 0 to 1, or null. */
  value?: number | null;
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
  if (!(FFBOX_SETTABLE_KEYS as readonly string[]).includes(key)) {
    return { error: `key: FFBox's set_config changes only ${FFBOX_SETTABLE_KEYS.join(', ')} (got ${JSON.stringify(clean(key, 64))}). Secrets (secrets.env) and other settings are a person's, by hand on the box.` };
  }
  const value = input.value;
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) {
    return { error: 'value: a number from 0 to 1 (a share of the Claude window), or null (never waits)' };
  }
  return { args: { key, value: JSON.stringify(value), reason, by } };
}

/** Answers that mean FFBox did not take the request: asked once more. A timeout is not: the change may have been made. */
const AGAIN = new Set(['busy', 'not_ready', 'unavailable']);

const show = (v: unknown) => JSON.stringify(v ?? null);

/** Ask FFBox to change (or list) its live settings. Throws an Error with a plain sentence when nothing was changed or it could not be told. */
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
    const rows = (d.settable as Record<string, unknown>[]).map((r) => `- ${String(r.key)} = ${show(r.effective)} (${String(r.kind)} ${show(r.min)} to ${show(r.max)}): ${clean(String(r.what ?? ''), 200)}`);
    const recent = Array.isArray(d.recent) ? (d.recent as Record<string, unknown>[]).map((r) => `- ${String(r.change)} ${String(r.at)}: ${String(r.key)} ${show(r.old)} -> ${show(r.new)} by ${clean(String(r.by ?? ''), 120)} (${clean(String(r.reason ?? ''), 200)})${r.revert_of ? `, reverting ${String(r.revert_of)}` : ''}`) : [];
    return [`FFBox's settable settings (in its config.json, applied live):`, ...rows, recent.length ? 'Recent changes:' : 'No changes yet.', ...recent].join('\n');
  }
  return `FFBox: ${String(d.key)} ${show(d.old)} -> ${show(d.new)}; effective now ${show(d.effective)} (read back live), change ${String(d.change)} at ${String(d.at)}${d.revert_of ? `, reverting ${String(d.revert_of)}` : ''}. Applied live, no restart; the old file is FFBox's config.json.prev. To undo: set_ffbox_config revert "${String(d.change)}".`;
}
