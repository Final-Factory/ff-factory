/**
 * Clean-up approvals per day (w913, lothsahn, 2026-10-10: "Random clean up commands take a lot of approvals"): how many shell
 * commands that delete something a person had to approve, by kind, read from the portal's transcripts. Before and after the
 * deploy that carries w913: `node scripts/cleanup-approvals.ts <dataDir> [--since 2026-10-03] [--split 2026-10-11]`.
 * A prompt is a `permission` event with a `decision` and `decidedBy` (a person answered it, server/sessions.ts decide); the
 * delete a session answers itself (server/tempDelete.ts) leaves no such event, so the "after" count falls to what still asks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type CleanupKind = 'session temp ($TMPDIR, /tmp)' | 'save copy' | 'player slots / builds / captures' | 'sandbox scratch' | 'git worktree' | 'other delete';

const STMT = /(?:^|[;&|\n]\s*)((?:rm|rmdir|remove-item|ri|del|rd)\b[^;&|\n]*|find\b[^;&|\n]*-delete[^;&|\n]*|[^;&|\n]*player_slots\.py\s+prune[^;&|\n]*|git\s+worktree\s+(?:remove|prune)[^;&|\n]*)/gi;

/** The kinds of delete a shell command holds (a statement each), or [] when it holds none. Heredoc bodies are not statements. */
export function cleanupKinds(command: string): CleanupKind[] {
  const text = command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, '');
  const out: CleanupKind[] = [];
  for (const m of text.matchAll(STMT)) {
    const s = m[1].replace(/\\/g, '/');
    if (/player_slots\.py\s+prune/i.test(s)) out.push('player slots / builds / captures');
    else if (/git\s+worktree/i.test(s)) out.push('git worktree');
    else if (/locallow|never games|finalfactory\/saves|\/saves\//i.test(s)) out.push('save copy');
    else if (/\$\{?(tmpdir|tmp|temp)\b|\$env:(temp|tmp)|ffa-[0-9a-f]{6,}|\/tmp\/|ffw\/tmp|appdata\/local\/temp|%temp%/i.test(s)) out.push('session temp ($TMPDIR, /tmp)');
    else if (/captures|screenshots|\/shots|\/clips|builds?\/|\.nightly-builds|\/player\b|bench/i.test(s)) out.push('player slots / builds / captures');
    else if (/scratch/i.test(s)) out.push('sandbox scratch');
    else if (/(^|\s)-[a-z]*r|-recurse/i.test(s)) out.push('other delete');
  }
  return out;
}

/**
 * What a prompt was about, for every prompt, not only deletes (w1097, lothsahn, 2026-10-12: "Why did it do that, and how
 * do we allow it to do what it just needed to do without a complex bash prompt?"). Claude Code's own reason when the
 * transcript has it (`reason` on the permission event, from w1097 on); before that, the command's shape.
 */
export function promptKind(toolName: string | undefined, input: { command?: unknown } | undefined, reason?: string): string {
  if (reason) {
    if (/^Dangerous \S+ operation on possibly-empty variable path/i.test(reason)) return 'Claude Code: dangerous rm of a $VAR path (glob, brace list)';
    if (/^Dangerous \S+ operation on critical path/i.test(reason)) return 'Claude Code: dangerous rm of a critical path';
    if (/^Dangerous \S+ operation/i.test(reason)) return 'Claude Code: dangerous rm, other';
    if (/^touches /.test(reason)) return 'Claude Code: a path outside the allowed folders';
    return `Claude Code: ${reason.replace(/\s+/g, ' ').replace(/[`'"].*$/, '').slice(0, 70).trim()}`;
  }
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return `tool: ${toolName?.replace(/^(mcp__[^_]+(?:_[^_]+)*?)__.*$/, '$1') ?? 'unknown'}`;
  const cmd = typeof input?.command === 'string' ? input.command : '';
  const del = cleanupKinds(cmd);
  if (del.length) return `${toolName} delete: ${del[0]}${/\n|\(\)\s*\{|\bfor\b|\bwhile\b|\buntil\b/.test(cmd) ? ', in a multi-step command' : ''}`;
  if (/locallow|never games|application support\/never games/i.test(cmd)) return `${toolName}: the game's data folder`;
  if (/(?:^|[;&|\s])git\s/.test(cmd)) return `${toolName}: git`;
  if (/\n|\(\)\s*\{/.test(cmd)) return `${toolName}: multi-step, no delete`;
  return `${toolName}: other`;
}

export interface DayCount {
  day: string;
  /** Every prompt a person answered that day. */
  prompts: number;
  /** The ones for a delete, by kind. */
  cleanup: Partial<Record<CleanupKind, number>>;
  cleanupTotal: number;
  /** Every prompt, by `promptKind`. */
  kinds?: Record<string, number>;
}

/** Count the prompts a person answered in transcript lines (JSONL text), per UTC day. */
export function countApprovals(lines: Iterable<string>, since = '', days = new Map<string, DayCount>()): Map<string, DayCount> {
  for (const line of lines) {
    if (!line.includes('"permission"')) continue;
    let e: { kind?: string; t?: string; toolName?: string; input?: { command?: unknown }; reason?: string; decision?: string; decidedBy?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.kind !== 'permission' || !e.t || !e.decision || !e.decidedBy) continue;
    const day = e.t.slice(0, 10);
    if (day < since) continue;
    const d = days.get(day) ?? { day, prompts: 0, cleanup: {}, cleanupTotal: 0 };
    d.prompts++;
    const kind = promptKind(e.toolName, e.input, typeof e.reason === 'string' ? e.reason : undefined);
    d.kinds = { ...d.kinds, [kind]: (d.kinds?.[kind] ?? 0) + 1 };
    if ((e.toolName === 'Bash' || e.toolName === 'PowerShell') && typeof e.input?.command === 'string') {
      const kinds = cleanupKinds(e.input.command);
      if (kinds.length) {
        d.cleanupTotal++;
        d.cleanup[kinds[0]] = (d.cleanup[kinds[0]] ?? 0) + 1;
      }
    }
    days.set(day, d);
  }
  return days;
}

function main() {
  const args = process.argv.slice(2);
  const dataDir = args.find((a) => !a.startsWith('--') && !/^\d{4}-\d\d-\d\d$/.test(a));
  const opt = (name: string) => args.find((_a, i) => args[i - 1] === name);
  if (!dataDir) {
    console.error('usage: node scripts/cleanup-approvals.ts <dataDir> [--since YYYY-MM-DD] [--split YYYY-MM-DD]');
    process.exit(2);
  }
  const dir = path.join(dataDir, 'transcripts');
  const days = new Map<string, DayCount>();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.jsonl')) countApprovals(fs.readFileSync(path.join(dir, f), 'utf8').split('\n'), opt('--since') ?? '', days);
  }
  const split = opt('--split');
  let before = 0;
  let after = 0;
  for (const d of [...days.values()].sort((a, b) => a.day.localeCompare(b.day))) {
    console.log(`${d.day}${split ? (d.day < split ? ' (before)' : ' (after)') : ''}  prompts ${String(d.prompts).padStart(4)}  clean-up ${String(d.cleanupTotal).padStart(4)}  ${Object.entries(d.cleanup).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (split) {
      if (d.day < split) before += d.cleanupTotal;
      else after += d.cleanupTotal;
    }
  }
  if (split) console.log(`clean-up prompts a person answered: before ${split} ${before}, from ${split} ${after}`);
  console.log(`\nevery prompt a person answered, by kind${split ? ` (before ${split} / from ${split})` : ''}:`);
  for (const [kind, n] of byKind([...days.values()], split)) console.log(`  ${String(n.total).padStart(4)}${split ? `  (${n.before} / ${n.after})` : ''}  ${kind}`);
}

/** The kinds over every day, most first; with a split day, how many fell before it and from it on. */
export function byKind(days: DayCount[], split?: string): [string, { total: number; before: number; after: number }][] {
  const out = new Map<string, { total: number; before: number; after: number }>();
  for (const d of days) {
    for (const [k, n] of Object.entries(d.kinds ?? {})) {
      const c = out.get(k) ?? { total: 0, before: 0, after: 0 };
      c.total += n;
      if (split && d.day < split) c.before += n;
      else c.after += n;
      out.set(k, c);
    }
  }
  return [...out.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
