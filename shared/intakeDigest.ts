// What an intake request is about, in plain words, filed with it (w3602, lothsahn, 2026-11-08, on w3596's card: "I don't
// know what this means, what I'm approving, or anything... There's just approve or decline. What am I approving?").
//
// FFBox's diagnosis or turn summary (or a player's own report) is cut down at filing to the parts a reviewer decides from:
// what the player hit, the cause, the fix, the tests and what nobody could check. It is kept on the request's source
// (WorkSource.digest), so the Intake card, the Waiting on input card, read_work and list_work all read the same words. The
// words are FFBox's or the player's: shown as plain text, labelled as theirs, never acted on. No imports from the page or the
// server: `node --test` loads it.
import type { ProviderConversationView, WorkDigest, WorkItem, WorkSource } from './types.ts';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Markdown and control characters out, one line: the card shows the words as plain text. */
export function plainLine(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(?:#+|[-*+]|\d+\.)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first `n` sentences of a text, at most `max` characters; a dot inside a word ("Screen.SetResolution", "1.0.0.16") ends none. */
function sentences(s: string, n: number, max: number): string {
  const parts = s.match(/(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+(?=\s|$)|$)/g) ?? [s];
  return clip(parts.slice(0, n).join('').trim(), max);
}

/** The text after a heading or a bold lead ("**What I changed**", "## Fix", "Root cause:") up to the next one. */
function section(lines: string[], head: RegExp): string[] | undefined {
  const at = lines.findIndex((l) => head.test(plainLine(l)));
  if (at < 0) return undefined;
  const isHead = (l: string) => /^\s*(?:#+\s|\*\*[^*]+\*\*\s*[:.]?\s*$)/.test(l);
  const out: string[] = [];
  // The heading's own line may carry the text ("**What I can't prove here.** This container has no ...").
  const rest = plainLine(lines[at]).replace(head, '').replace(/^[\s:.)-]+/, '');
  if (rest) out.push(rest);
  for (const l of lines.slice(at + 1)) {
    if (isHead(l)) break;
    if (l.trim()) out.push(l);
  }
  return out;
}

const CAUSE = /^root cause\s*[:-]\s*/i;
const FIX_HEAD = /^(?:what i changed|what (?:the|this) (?:fix|branch) (?:changes|does)|the fix|fix)\b[^:]*?(?:\([^)]*\))?\s*[:.]?/i;
const UNVERIFIED_HEAD = /^(?:what i (?:can['’]t|cannot|could not|couldn['’]t) (?:prove|check|verify)(?: here)?|not verified|unverified|what is unverified)\b\s*[:.]?/i;

/** The tests a text reports ("16351/16361 passed, 0 failed"): the run with the most tests (the whole suite). */
export function testsIn(text: string): WorkDigest['tests'] | undefined {
  let best: WorkDigest['tests'];
  for (const m of text.matchAll(/(\d[\d,]*)\s*(?:\/|of)\s*(\d[\d,]*)\s+(?:tests?\s+)?passed(?:,\s*(\d[\d,]*)\s+failed)?/gi)) {
    const n = (x?: string) => (x === undefined ? undefined : Number(x.replace(/,/g, '')));
    const run = n(m[2])!;
    if (!best || run > (best.run ?? 0)) best = { passed: n(m[1]), run, ...(m[3] !== undefined ? { failed: n(m[3]) } : {}) };
  }
  if (best && best.failed === undefined && best.run !== undefined && best.passed !== undefined) best.failed = best.run - best.passed;
  if (best && /\bcompiled\b/i.test(text) && !/\b(?:not|never|didn['’]t|did not) compiled?\b/i.test(text)) best.compiled = true;
  return best;
}

/**
 * The digest of FFBox's own summary (its turn's last words, or a diagnosis's findings), with its run's verification when
 * the connector gave it. Undefined when the text holds nothing to show.
 */
export function digestFromFfbox(text: string, at: string, o: { hit?: string; verification?: { ran?: boolean; compiled?: boolean; testsRun?: number; testsPassed?: number; testsFailed?: number } } = {}): WorkDigest | undefined {
  const lines = text.split(/\r?\n/);
  const causeLine = lines.map(plainLine).find((l) => CAUSE.test(l));
  const cause = causeLine ? sentences(causeLine.replace(CAUSE, ''), 2, 320) : undefined;
  const fixLines = section(lines, FIX_HEAD);
  // The first point of what it changed, its "Fix:" label dropped.
  const fixFirst = fixLines?.map(plainLine).find((l) => l && !/^\(?\w+ commits?\)?:?$/i.test(l));
  const fix = fixFirst ? sentences(fixFirst.replace(/^(?:fix|the fix|change)\s*:\s*/i, ''), 2, 320) : undefined;
  const unv = section(lines, UNVERIFIED_HEAD);
  const unverified = unv?.length ? sentences(unv.map(plainLine).join(' '), 2, 300) : undefined;
  const v = o.verification;
  const fromRun = v && (v.testsRun !== undefined || v.compiled !== undefined) ? { ...(v.compiled !== undefined ? { compiled: v.compiled } : {}), ...(v.testsRun !== undefined ? { run: v.testsRun } : {}), ...(v.testsPassed !== undefined ? { passed: v.testsPassed } : {}), ...(v.testsFailed !== undefined ? { failed: v.testsFailed } : {}) } : undefined;
  // The run's own numbers win over the words; the words fill what the run did not give.
  const said = testsIn(text);
  const tests = fromRun || said ? { ...said, ...fromRun } : undefined;
  const lead = !cause && !fix ? lines.map(plainLine).filter((l) => l && !/^(?:hang|crash|desync) \d{8}T/i.test(l)).join(' ') : '';
  const d: WorkDigest = {
    by: 'FFBox',
    at,
    ...(o.hit ? { hit: o.hit } : {}),
    ...(cause ? { cause } : {}),
    ...(fix ? { fix } : {}),
    ...(tests ? { tests } : {}),
    ...(unverified ? { unverified } : {}),
    ...(lead ? { text: sentences(lead, 3, 400) } : {}),
  };
  return d.cause || d.fix || d.tests || d.unverified || d.text ? d : undefined;
}

/** A player's own report from Discord: their first lines, labelled as theirs. */
export function digestFromPlayer(title: string, text: string, at: string): WorkDigest | undefined {
  const words = plainLine([title, ...text.split(/\r?\n/)].map(plainLine).filter(Boolean).join('. ').replace(/\.\s*\./g, '.'));
  return words ? { by: 'the player', at, text: clip(words, 400) } : undefined;
}

const KINDS: Record<string, string> = { hang: 'a freeze (hang)', crash: 'a crash', desync: 'a multiplayer desync' };

/** What the player hit, from the report's facts: "a freeze (hang) on LinuxPlayer, game 1.0.0.16". */
export function hitOf(kind: string | undefined, platform?: string, version?: string): string | undefined {
  const what = kind ? KINDS[kind] : undefined;
  if (!what) return undefined;
  return `${what}${platform ? ` on ${platform}` : ''}${version ? `, game ${version}` : ''}`;
}

/** The kind of the lead report from its id ("20261025T073811Z-hang-25862e0e5a" → hang). */
export const reportKind = (id: string | undefined) => (id ? /-(hang|crash|desync)-/.exec(id)?.[1] : undefined);

/** The tests in words: "compiled; 16349 of 16361 tests passed, 2 failed". */
export function testsText(t: NonNullable<WorkDigest['tests']>): string {
  const parts = [t.compiled === true ? 'compiled' : t.compiled === false ? 'did not compile' : ''];
  // What neither passed nor failed was skipped ("16349 of 16361 passed, 2 failed, 10 skipped"), so the numbers add up.
  const skipped = t.run !== undefined && t.passed !== undefined && t.failed !== undefined ? t.run - t.passed - t.failed : 0;
  if (t.run !== undefined) parts.push(`${t.passed ?? '?'} of ${t.run} tests passed${t.failed !== undefined ? `, ${t.failed} failed` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}`);
  else if (t.failed !== undefined) parts.push(`${t.failed} test${t.failed === 1 ? '' : 's'} failed`);
  return parts.filter(Boolean).join('; ');
}

/** The digest as labelled lines, in the order a reviewer reads them (the card and read_work). */
export function digestRows(d: WorkDigest): { label: string; text: string }[] {
  return [
    ...(d.hit ? [{ label: 'The player hit', text: d.hit }] : []),
    ...(d.cause ? [{ label: 'Cause', text: d.cause }] : []),
    ...(d.fix ? [{ label: 'The fix', text: d.fix }] : []),
    ...(d.tests ? [{ label: 'Tests', text: testsText(d.tests) }] : []),
    ...(d.unverified ? [{ label: 'Not checked', text: d.unverified }] : []),
    ...(d.text ? [{ label: d.by === 'the player' ? 'They wrote' : 'Summary', text: d.text }] : []),
  ];
}

/** Whose words the digest is, for its label. */
export const digestBy = (d: WorkDigest) => (d.by === 'FFBox' ? 'FFBox’s summary (a model’s words: check them against the code)' : 'The player’s words (untrusted)');

/** The card's heading over the digest, and the line under it that says whose words they are. */
export const digestHeading = (d: WorkDigest) => (d.by === 'FFBox' ? 'What FFBox found and changed' : 'What the player reported');
export const digestCaption = (d: WorkDigest) => (d.by === 'FFBox' ? 'FFBox’s summary, a model’s words: check them against the code.' : 'The player’s own words, untrusted.');

/**
 * An FFBox intake card with no summary yet (w3602, critic round 3: a sibling card with none still read "what am I
 * approving?"): the same heading, and one plain line saying none was written and where FFBox's write-up is.
 */
export function digestMissing(s: Pick<WorkItem, 'source'>): string | undefined {
  if (s.source?.digest || !s.source?.kind?.startsWith('ffbox')) return undefined;
  return 'FFBox wrote no summary for this request. Its full write-up is under Details, at the foot of this card.';
}

/** The digest in one block of text, for read_work and list_work. */
export function digestText(d: WorkDigest): string {
  return [`${digestBy(d)}:`, ...digestRows(d).map((r) => `- ${r.label}: ${r.text}`)].join('\n');
}

/** The fix branch without its ffbox/ prefix and run suffix, in words: "linux launch no redundant swapchain reset". */
export function branchWords(branch: string): string {
  return branch
    .replace(/^ffbox\//, '')
    .replace(/-d\d+t\d+-[0-9a-f]{6,}$/i, '')
    .replace(/[-_/]+/g, ' ')
    .trim();
}

type Src = Pick<WorkSource, 'kind' | 'branch' | 'pr' | 'digest' | 'reports' | 'rootCause'>;

/** What the fix is for, in a few words: the branch's own name, else the cause's first clause. */
function fixFor(s: Src): string {
  if (s.branch) return `“${branchWords(s.branch)}”`;
  return s.digest?.cause ? `“${clip(s.digest.cause.split(/[.;:]/)[0]!, 80)}”` : 'this report';
}

/** What Approve sets in motion for this request, concretely (w3602). */
export function approveAction(w: Pick<WorkItem, 'source'>): string {
  const s = w.source;
  const cost = 'one worker session of Claude usage';
  if (!s) return `The dispatcher gets it and a worker starts at the next free sandbox: ${cost}.`;
  const failed = s.digest?.tests?.failed;
  const fixTests = failed ? `, fixes the ${failed} failing test${failed === 1 ? '' : 's'}` : '';
  const pr = s.pr ? `reviews its pull request #${s.pr}` : 'opens a pull request';
  if (s.kind === 'ffbox-branch' || ((s.kind === 'ffbox-diagnosis') && s.branch)) {
    return `A worker reviews FFBox’s fix ${fixFor(s)} against the code${fixTests}, ${pr} and merges it on green: ${cost}.`;
  }
  if (s.kind === 'ffbox-diagnosis') {
    return `A worker checks FFBox’s diagnosis against the code${s.rootCause === 'not_found' ? ', looks for the cause FFBox did not find' : ''}, writes a fix, opens a pull request and merges it on green: ${cost}.`;
  }
  if (s.kind === 'ffbox-request') return `A worker checks Max’s diagnosis against the code and does what it calls for: a fix through a pull request merged on green, or a question back to you: ${cost}.`;
  if (s.kind === 'discord-bug') return `A worker reproduces the player’s report, finds the cause, fixes it, opens a pull request and merges it on green: ${cost}.`;
  return `The dispatcher gets it and a worker starts at the next free sandbox: ${cost}.`;
}

/** What Decline does for this request, as concretely. */
export function declineAction(w: Pick<WorkItem, 'source'>): string {
  const s = w.source;
  const end = 'Your reason goes with it if you type one; nothing is spent.';
  // A declined request's player reports go to FFBox as obsolete (server/intake.ts pushReportObsoletes, w853).
  const obsolete = s?.reports?.length ? ' FFBox marks the player’s report obsolete and posts nothing.' : '';
  if (s?.kind === 'ffbox-branch' || (s?.kind === 'ffbox-diagnosis' && s.branch)) return `It closes as declined: nobody reviews FFBox’s branch and it is never merged.${obsolete} ${end}`;
  if (s?.kind === 'ffbox-diagnosis') return `It closes as declined: nobody works on the player’s report.${obsolete} ${end}`;
  if (s?.kind === 'discord-bug' || s?.kind === 'ffbox-request') return `It closes as declined: nobody works on the player’s report and FF Factory posts nothing in their thread. ${end}`;
  return `It closes as declined and the dispatcher never hears of it. ${end}`;
}

/**
 * An FFBox request's digest from its conversation (w3602): the newest turn that ended with a summary, its run's verification
 * (the run that pushed the request's branch, else any that verified), and what the player hit from the lead report's id.
 */
export function digestOfConversation(view: Pick<ProviderConversationView, 'turns' | 'conversation' | 'summary' | 'at'>, s: Pick<WorkSource, 'branch' | 'reports' | 'version' | 'platform'>): WorkDigest | undefined {
  const turn = view.turns.find((t) => t.summary?.trim());
  if (!turn?.summary) return undefined;
  const runs = turn.runs ?? [];
  const run = runs.find((r) => s.branch && r.branch === s.branch && r.verification) ?? runs.find((r) => r.verification?.ran || r.verification?.testsRun !== undefined);
  const lead = view.conversation?.reportIds?.[0] ?? s.reports?.[0] ?? /\b\d{8}T\d{6}Z-(?:hang|crash|desync)-[0-9a-f]+\b/.exec(view.conversation?.title ?? view.summary?.title ?? '')?.[0];
  const hit = hitOf(view.conversation?.kind && KINDS[view.conversation.kind] ? view.conversation.kind : reportKind(lead), s.platform, s.version);
  return digestFromFfbox(turn.summary, turn.endedAt ?? view.at ?? new Date().toISOString(), { ...(hit ? { hit } : {}), ...(run?.verification ? { verification: run.verification } : {}) });
}

/** The approval question, about this request's own work (w3602): "Should a worker take on FFBox's fix “…”?". */
export function approveQuestion(w: Pick<WorkItem, 'source'>): string {
  const s = w.source;
  // The question names what the player hit when the digest says it ("a freeze (hang) on LinuxPlayer"), else the branch in words.
  const hit = s?.digest?.hit?.split(',')[0];
  if (s?.kind === 'ffbox-branch' || (s?.kind === 'ffbox-diagnosis' && s.branch)) return hit ? `Should a worker review FFBox’s fix for ${hit} and merge it?` : `Should a worker review FFBox’s fix ${fixFor(s)} and merge it?`;
  if (s?.kind === 'ffbox-diagnosis') return 'Should a worker take on FFBox’s diagnosis of this player’s report and fix it?';
  if (s?.kind?.startsWith('ffbox')) return 'Should a worker review FFBox’s work on this and take it on?';
  return `Should FF Factory work on this ${s?.kind === 'discord-bug' ? 'player’s bug report' : 'request'}?`;
}
