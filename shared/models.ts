// A Claude model id in words (w1358): "claude-opus-5-5" is "Opus 5.5", for the conversation headers. The full id stays
// in the chip's hover. Shared so the server's tests and the web read one mapping.

const FAMILIES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', mythos: 'Mythos' };

/**
 * The words for a model id: the family and its version ("Opus 5.5", "Haiku 4.5", "Fable 5.1", "Sonnet 3.5" for the old
 * "claude-3-5-sonnet-20241022" order), "Opus 5.5 (1M)" for a 1M-context id, and just the family for an alias the CLI takes
 * ("opus", "sonnet[1m]"). Cloud-provider prefixes ("us.anthropic.", "anthropic/") and a date or "-v1:0" suffix are ignored.
 * An id it does not know comes back as it is; no id, as undefined.
 */
export function modelName(id: string | undefined | null): string | undefined {
  const raw = (id ?? '').trim();
  if (!raw) return undefined;
  const million = /\[1m\]$/i.test(raw);
  const lower = raw.replace(/\[1m\]$/i, '').toLowerCase();
  const suffix = million ? ' (1M)' : '';
  // claude-<family>-<major>[-<minor>][-date]  (the date is 8 digits, so a one-digit or two-digit part is a version)
  const m = /(?:^|[./])claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?(?![\d])/.exec(lower);
  if (m) return `${FAMILIES[m[1]]} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}${suffix}`;
  // claude-<major>[-<minor>]-<family>[-date]: the 3.x naming
  const old = /(?:^|[./])claude-(\d{1,2})(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?![a-z])/.exec(lower);
  if (old) return `${FAMILIES[old[3]]} ${old[1]}${old[2] !== undefined ? `.${old[2]}` : ''}${suffix}`;
  // an alias: "opus", "sonnet", "haiku", "fable"
  if (FAMILIES[lower]) return `${FAMILIES[lower]}${suffix}`;
  return raw;
}

/** "<synthetic>" is Claude Code's placeholder for a message no model wrote (an error, a stopped turn): not a model. */
export const isRealModelId = (id: string | undefined | null): id is string => !!id && !id.startsWith('<') && id !== 'unknown';

/**
 * The model a conversation's header shows (w1358). `active` is the model its last turn ran on, from that turn's own reply
 * (the same per-call model the spend tracking counts); `configured` is the model it was started with, shown (marked) only
 * until a turn has run. Neither: nothing.
 */
export function modelGlance(s: { activeModel?: string; model?: string }): { name: string; id: string; configured: boolean } | undefined {
  if (isRealModelId(s.activeModel)) return { name: modelName(s.activeModel)!, id: s.activeModel, configured: false };
  if (isRealModelId(s.model)) return { name: modelName(s.model)!, id: s.model, configured: true };
  return undefined;
}
