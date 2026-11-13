// Which model a worker starts on (w2010, lothsahn, 2026-10-24: "workers should be opus medium thinking", then "if the
// dispatcher is confident the task is small, it can start a sonnet worker directly"). Every worker starts on config
// defaultModel (opus) at worker.effort (medium); an orchestrator that names another model says why in model_reason, and
// the reason goes into the request's log and the start reply. docs/orchestrators.md "Which model a worker starts on".

/** What start_agent says when an orchestrator names another model with no reason. */
export const MODEL_REASON_HELP =
  'model_reason is required with a model other than the default: "small: <why you are sure the task is small>" (one or two named files, a mechanical or contained change with done-criteria in the brief, no simulation, determinism, netcode or save state, no design question, no investigation), or "asked: <the person\'s words naming the model>". Otherwise leave model out: workers start on the default.';

/**
 * Whether config models admit a model (w5): an entry of the list, or a full Claude id ("claude-fable-5-2",
 * "claude-opus-5-5[1m]") of a family the list names by its alias, so a model Anthropic releases can be picked by its id
 * as soon as the bundled Claude Code knows it, without a config edit.
 */
export function modelAllowed(models: string[], model: string): boolean {
  if (models.includes(model)) return true;
  const family = /^claude-(opus|sonnet|haiku|fable|mythos)-\d{1,2}(?:-\d{1,2})?(?:\[1m\])?$/.exec(model)?.[1];
  return !!family && models.includes(family);
}

/** What a model parameter's description says it takes. */
export const modelChoices = (cfg: { models: string[]; defaultModel: string }) =>
  `One of ${cfg.models.join(', ')} or their full ids. Default ${cfg.defaultModel}.`;

/** At most this many characters of a reason are kept in the log. */
export const MODEL_REASON_MAX = 200;

/**
 * The model a start names and the words its log line carries (" on sonnet (small: one doc file)"), or throws: an unknown
 * model, or an orchestrator naming a non-default model without a reason. A person (from "human") needs no reason: naming
 * the model is their explicit choice.
 */
export function workerModelChoice(
  cfg: { models: string[]; defaultModel: string },
  a: { model?: string; model_reason?: string },
  from: 'human' | 'orchestrator',
): { model?: string; note: string } {
  const model = a.model?.trim().toLowerCase() || undefined;
  if (!model || model === cfg.defaultModel) return { model, note: '' };
  if (!modelAllowed(cfg.models, model)) throw new Error(`model must be one of ${cfg.models.join(', ')} or a full id of one of those families (default ${cfg.defaultModel})`);
  const reason = a.model_reason?.replace(/\s+/g, ' ').trim().slice(0, MODEL_REASON_MAX);
  if (from === 'orchestrator' && !reason) throw new Error(MODEL_REASON_HELP);
  return { model, note: ` on ${model}${reason ? ` (${reason})` : ''}` };
}
