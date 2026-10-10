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

export interface DayCount {
  day: string;
  /** Every prompt a person answered that day. */
  prompts: number;
  /** The ones for a delete, by kind. */
  cleanup: Partial<Record<CleanupKind, number>>;
  cleanupTotal: number;
}

/** Count the prompts a person answered in transcript lines (JSONL text), per UTC day. */
export function countApprovals(lines: Iterable<string>, since = '', days = new Map<string, DayCount>()): Map<string, DayCount> {
  for (const line of lines) {
    if (!line.includes('"permission"')) continue;
    let e: { kind?: string; t?: string; toolName?: string; input?: { command?: unknown }; decision?: string; decidedBy?: unknown };
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
