// What FFBox does with players' crash and desync reports by itself (w412). Since 2026-10-04 FFBox diagnoses every
// report as it arrives (its config intake.auto; ffbox scripts/ffwatch.py Watcher.intake_auto_pass, config.md
// "intake"): a report waits settle_minutes, then a crash gets its own diagnosis and a desync joins its play session's,
// at most max_per_day started or queued in any 24 hours. FF Factory starts none of them. This reads FFBox's own
// answers (the live `config` and `reports` queries, and the conversations the connector pushed) and says what it
// cannot know instead of asserting it.
import type { ProviderConversation } from '../shared/types.ts';
import type { QueryAnswer } from './providers.ts';
import { redactSecrets } from './secrets.ts';

const DAY = 24 * 3600_000;

/** One line of FFBox's text: control characters out, secrets redacted, cut. */
const clean = (v: unknown, max: number) =>
  redactSecrets(String(v ?? ''))
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim()
    .slice(0, max);

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const word = (v: unknown) => (typeof v === 'string' && v && v !== '<redacted>' ? clean(v, 40) : undefined);

/** FFBox's intake.auto and intake.fff_handoff, from its `config` answer's `effective` block (defaults merged there). */
export interface AutoIntakeSettings {
  enabled?: boolean;
  /** The operator who pays; null bills FFBox's model.default. */
  by?: string | null;
  settleMinutes?: number;
  maxPerDay?: number;
  crashPool?: string;
  desyncPool?: string;
  handoff?: { enabled?: boolean; operator?: string | null };
}

/** The settings, or undefined when the answer has no intake.auto block (an older FFBox, or a config without it). */
export function autoIntakeSettings(data: Record<string, unknown> | undefined): AutoIntakeSettings | undefined {
  const intake = obj(obj(obj(data)?.effective)?.intake);
  const auto = obj(intake?.auto);
  if (!intake || !auto) return undefined;
  const handoff = obj(intake.fff_handoff);
  return {
    enabled: typeof auto.enabled === 'boolean' ? auto.enabled : undefined,
    by: auto.by === null ? null : word(auto.by),
    settleMinutes: num(auto.settle_minutes),
    maxPerDay: num(auto.max_per_day),
    crashPool: word(intake.crash_pool),
    desyncPool: word(intake.desync_pool),
    ...(handoff ? { handoff: { enabled: typeof handoff.enabled === 'boolean' ? handoff.enabled : undefined, operator: handoff.operator === null ? null : word(handoff.operator) } } : {}),
  };
}

interface ReportRow {
  id?: string;
  kind?: string;
  received_at?: string;
  game_version?: string;
  platform?: string;
  side?: string;
  conversation?: number;
}

/**
 * The automatic-diagnosis lines of ffbox_activity show "signatures": FFBox's settings (live, or last known and said
 * so), the intake conversations it opened in the last 24 h, and each report of the last 24 h with the conversation
 * that diagnosed it. `config` and `reports` are FFBox's answers to those queries (reports asked with since = 24 h ago).
 */
export function describeAutoIntake(config: QueryAnswer, reports: QueryAnswer, conversations: ProviderConversation[], now: number, limit = 30): string[] {
  const out: string[] = [];
  const s = config.data ? autoIntakeSettings(config.data) : undefined;
  const from = config.live
    ? `FFBox's live config (written there ${config.at ?? 'at an unknown time'})`
    : `FFBox's config as last known from ${config.receivedAt ?? 'an unknown time'} (it could not answer now: ${clean(config.error ?? 'no answer', 60)})`;
  const settle = s?.settleMinutes;
  if (!config.data) {
    out.push(`Automatic diagnosis: unknown here. FFBox's config query failed (${clean(config.error ?? 'no answer', 60)}) and no earlier answer is kept. FFBox has diagnosed reports by itself since 2026-10-04 when its intake.auto is on: ask show "config" again before saying nothing will look at a report.`);
  } else if (!s || s.enabled === undefined) {
    out.push(`Automatic diagnosis: unknown here. ${from} has no intake.auto block this view can read; show "config" has it all.`);
  } else if (!s.enabled) {
    out.push(`Automatic diagnosis: OFF, per ${from} (intake.auto.enabled false). FFBox diagnoses a report only when an operator clicks it on its /intake page.`);
  } else {
    const handoff = s.handoff?.enabled === undefined ? 'not stated' : s.handoff.enabled ? `on${s.handoff.operator ? ` (as ${s.handoff.operator})` : ''}` : 'off';
    out.push(
      `Automatic diagnosis: ON, per ${from}. FFBox diagnoses every new crash and desync report itself, ${settle === undefined ? 'after a settle time this answer does not give' : `about ${settle} min after it arrives`} (intake.auto, billed to ${s.by ?? "FFBox's model.default"}): a crash in its own ${s.crashPool ?? '?'} conversation, a desync with the rest of its play session in ${s.desyncPool ?? '?'}; at most ${s.maxPerDay ?? '?'} started or queued in any 24 h. Desync fixes that push a branch are handed to FF Factory to test and merge (intake.fff_handoff): ${handoff}. FF Factory starts none of these.`,
    );
  }
  const recent = conversations.filter((c) => c.source === 'intake' && now - Date.parse(c.createdAt) < DAY);
  const states = new Map<string, number>();
  for (const c of recent) states.set(c.state, (states.get(c.state) ?? 0) + 1);
  out.push(
    `Intake conversations FFBox opened in the last 24 h: ${recent.length}${recent.length ? ` (${[...states].map(([k, v]) => `${v} ${k}`).join(', ')}; ids ${recent.slice(0, 20).map((c) => c.id).join(', ')})` : ''}, operators' clicks on /intake included. FFBox does not send its own count against max_per_day.`,
  );
  if (!reports.data) {
    out.push(`Reports of the last 24 h and their diagnoses: unknown here, FFBox's reports query failed (${clean(reports.error ?? 'no answer', 60)}).`);
    return out;
  }
  const d = reports.data as { reports?: unknown[]; next_offset?: number };
  const rows = (Array.isArray(d.reports) ? d.reports : []).map(obj).filter((r): r is Record<string, unknown> => !!r) as ReportRow[];
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const diagnosed = rows.filter((r) => typeof r.conversation === 'number').length;
  out.push(
    `Reports received in the last 24 h${reports.live ? '' : ` (last known from ${reports.receivedAt ?? 'an unknown time'})`}: ${rows.length}${d.next_offset !== undefined ? '+ (more than one page; show "reports" with offset for the rest)' : ''}, ${diagnosed} with a diagnosis conversation of their own. A desync that joined its play session's diagnosis shows none: FFBox links a conversation to its lead report only.`,
  );
  for (const r of rows.slice(0, limit)) {
    const head = `- ${clean(r.id, 64)} ${clean(r.kind, 10)} ${clean(r.game_version, 64)} ${clean(r.platform, 64)}${r.side ? ` from the ${clean(r.side, 10)}` : ''}`;
    if (typeof r.conversation === 'number') {
      const c = byId.get(String(r.conversation));
      out.push(`${head}: diagnosed in FFBox conversation ${r.conversation}${c ? ` (${c.state}${c.verdict ? ` ${clean(c.verdict, 40)}` : ''}${c.pr ? `, PR #${c.pr.number} ${c.pr.state}` : ''})` : ''}`);
      continue;
    }
    const age = r.received_at ? (now - Date.parse(r.received_at)) / 60_000 : NaN;
    const settling = s?.enabled && settle !== undefined && age >= 0 && age < settle;
    out.push(`${head}: no conversation of its own yet${Number.isFinite(age) ? ` (received ${Math.round(age)} min ago${settling ? ', still inside the settle time' : ''})` : ''}`);
  }
  return out;
}
