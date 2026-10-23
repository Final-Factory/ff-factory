// Where a coordinator's context goes between compactions (w1866, asked by Lothsahn: "You have been compacting every few
// messages, going from ~30k to over 100k quickly. Can you figure out what is growing your context so quickly and a way to
// have that use less tokens?"). Reads Claude Code's own transcript of a conversation (<home>/.claude/projects/<cwd>/<session
// id>.jsonl) and answers counts only, never its text: per compaction cycle the size it started at and what that start held
// (the summary, the files Claude Code attached again, its instructions and listings, and the rest: the system prompt and the
// tool definitions), and over the cycles the tokens each source added (each tool by name, each kind of harness message, the
// coordinator's own output) and which kinds of turn added them. portal_logs serves it as the coordinator_context source
// (server/portalLogs.ts, docs/portal-logs.md).
//
// Measured: every model call's context (input + cache read + cache write) and output, from the call's own usage; the growth
// of a cycle is the sum of the differences between consecutive calls. Estimated: the split of that growth among sources, by
// characters (CHARS_PER_TOKEN, the meter's calibration in docs/spend.md), except the coordinator's own output, which is
// carried into the next call's context about token for token (the same calibration: 1.01 tokens per output token) and is
// taken from the usage. What no visible content explains (reminders Claude Code adds out of view, the estimate's error) is
// shown as its own row, never spread over the others.
import { CHARS_PER_TOKEN } from '../shared/spend.ts';
import { attachmentChars } from './cliTranscript.ts';

type D = Record<string, any>;

/** A paragraph this long or longer that a cycle already held is counted as repeated text. */
const REPEAT_MIN_CHARS = 80;
/** A call whose context is this much smaller than the last one's with no compaction marker starts a cycle too. */
const SHRINK_TOKENS = 5_000;

/** Two-word harness tags; any other tag is its first word ("[timer t3 …]" is "timer", "[machine m5 …]" is "machine"). */
const TWO_WORD_TAGS = [
  'worker update', 'work request', 'work update', 'ledger cleanup', 'ops worker', 'machine updates', 'app restarted', 'unity blocked',
  'person message', 'conditional decision', 'from another owner', 'intake auto-closed', 'intake question', 'intake escalation',
  'standing agent', 'needs you', 'worker permission',
];

/** The kind of message a prompt is, by its leading tag: a person's own words, or the harness's tag. */
export function messageKind(text: string): string {
  const s = text.trimStart();
  if (s.startsWith('<')) return 'command';
  const m = /^\[([^\]\n]{1,120})\]/.exec(s);
  if (!m) return 'untagged';
  const t = m[1].toLowerCase().trim();
  if (t.startsWith('from ffbox')) return 'from FFBox';
  if (t.startsWith('from another owner')) return 'from another owner';
  if (t.startsWith('via ')) return 'person'; // [via FFBox: …] and remote sessions carry a person's own words (w831)
  if (/^from the /.test(t)) return t.split(/[,:]/)[0].slice(0, 30);
  if (t.startsWith('from ')) return 'person'; // [from <name>]: a person's own message (server/sessions.ts)
  for (const w of TWO_WORD_TAGS) if (t.startsWith(w)) return w;
  return (t.split(/[\s,:]/)[0] || 'untagged').slice(0, 30);
}

/** A tool's short name: the portal's MCP prefix off, and list_work split by whether it asked for one request. */
function toolName(name: string, input: D | undefined): string {
  const n = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  if (n === 'list_work') return input && typeof input.id === 'string' && input.id ? 'list_work id' : 'list_work list';
  return n;
}

const textOf = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : '')).join('\n');
  return '';
};

interface Source {
  chars: number;
  items: number;
  max: number;
  repeat: number;
}

interface Cycle {
  /** Time of the first line after the marker (or of the window's start). */
  startedAt?: string;
  endedAt?: string;
  /** How the cycle began: a compaction (its trigger and Claude Code's own sizes), a shrink with no marker, or the window's start. */
  began: { kind: 'compaction'; trigger: string; pre?: number; post?: number } | { kind: 'shrink' } | { kind: 'window' };
  /** How it ended (filled by the next cycle's start); open while the conversation goes on. */
  ended?: Cycle['began'];
  startCtx?: number;
  startParts: Map<string, number>;
  /** Characters of the system prompt, from Claude Code's own snapshot of it, when the cycle holds one. */
  systemPrompt?: number;
  reattached: { name: string; chars: number }[];
  instructions: { name: string; chars: number }[];
  peak: number;
  calls: number;
  turns: number;
  growth: number;
  ownOut: number;
  sources: Map<string, Source>;
  kinds: Map<string, { turns: number; tokens: number; sources: Map<string, number> }>;
  seen: Set<string>;
}

const newCycle = (began: Cycle['began']): Cycle => ({
  began,
  startParts: new Map(),
  reattached: [],
  instructions: [],
  peak: 0,
  calls: 0,
  turns: 0,
  growth: 0,
  ownOut: 0,
  sources: new Map(),
  kinds: new Map(),
  seen: new Set(),
});

const base = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;

/** Every cycle of a transcript's text (a tail may start mid-line: the first line is dropped when `partialStart`). */
export function contextCycles(text: string, partialStart = false): Cycle[] {
  const lines = text.split('\n');
  if (partialStart) lines.shift();
  const cycles: Cycle[] = [];
  let cur = newCycle({ kind: 'window' });
  // what was added since the last call: source -> chars, and its repeated chars
  let pending = new Map<string, { chars: number; repeat: number; items: number; max: number }>();
  const toolNames = new Map<string, string>();
  const uuids = new Set<string>();
  let lastId: string | undefined;
  let lastCtx: number | undefined;
  let lastOut = 0;
  let kind = 'window start';

  const add = (src: string, chars: number, body?: string) => {
    if (chars <= 0) return;
    let repeat = 0;
    if (body) {
      for (const para of body.split(/\n{2,}/)) {
        const p = para.trim();
        if (p.length < REPEAT_MIN_CHARS) continue;
        if (cur.seen.has(p)) repeat += p.length;
        else cur.seen.add(p);
      }
    }
    const e = pending.get(src) ?? { chars: 0, repeat: 0, items: 0, max: 0 };
    e.chars += chars;
    e.repeat += repeat;
    e.items++;
    e.max = Math.max(e.max, chars);
    pending.set(src, e);
  };
  const turnOf = (k: string) => {
    let t = cur.kinds.get(k);
    if (!t) cur.kinds.set(k, (t = { turns: 0, tokens: 0, sources: new Map() }));
    return t;
  };
  const startCycle = (began: Cycle['began'], at?: string) => {
    cur.ended = began;
    cycles.push(cur);
    cur = newCycle(began);
    cur.startedAt = at;
    pending = new Map();
    lastCtx = undefined;
    lastOut = 0;
    lastId = undefined;
  };
  const call = (id: string, usage: D, at?: string) => {
    const ctx = Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
    const out = Number(usage.output_tokens ?? 0);
    if (id === lastId) {
      lastOut = Math.max(lastOut, out);
      return;
    }
    if (lastCtx !== undefined && ctx < lastCtx - SHRINK_TOKENS) startCycle({ kind: 'shrink' }, at);
    cur.calls++;
    cur.endedAt = at ?? cur.endedAt;
    cur.peak = Math.max(cur.peak, ctx);
    if (cur.startCtx === undefined) {
      cur.startCtx = ctx;
      for (const [s, e] of pending) cur.startParts.set(s, (cur.startParts.get(s) ?? 0) + e.chars);
    } else if (lastCtx !== undefined) {
      const delta = ctx - lastCtx;
      cur.growth += delta;
      cur.ownOut += lastOut;
      const t = turnOf(kind);
      t.tokens += delta;
      t.sources.set('own output', (t.sources.get('own output') ?? 0) + lastOut);
      for (const [s, e] of pending) {
        const g = cur.sources.get(s) ?? { chars: 0, items: 0, max: 0, repeat: 0 };
        g.chars += e.chars;
        g.items += e.items;
        g.max = Math.max(g.max, e.max);
        g.repeat += e.repeat;
        cur.sources.set(s, g);
        t.sources.set(s, (t.sources.get(s) ?? 0) + e.chars / CHARS_PER_TOKEN);
      }
    }
    pending = new Map();
    lastCtx = ctx;
    lastOut = out;
    lastId = id;
  };

  for (const line of lines) {
    if (!line) continue;
    let d: D;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== 'object' || d.isSidechain) continue;
    // a resumed conversation's file can hold a line again (readCliLines)
    if (typeof d.uuid === 'string') {
      if (uuids.has(d.uuid)) continue;
      uuids.add(d.uuid);
    }
    const at = typeof d.timestamp === 'string' ? d.timestamp : undefined;
    if (cur.startedAt === undefined && at) cur.startedAt = at;
    if (d.type === 'system' && d.subtype === 'compact_boundary') {
      const m = d.compactMetadata ?? {};
      startCycle({ kind: 'compaction', trigger: String(m.trigger ?? '?'), pre: m.preTokens, post: m.postTokens }, at);
      continue;
    }
    if (d.type === 'assistant') {
      const msg = d.message ?? {};
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type === 'tool_use' && typeof b.id === 'string') {
          // its input rides the call's output tokens (exact, under "own output"); its result is counted by this name
          toolNames.set(b.id, toolName(String(b.name ?? '?'), b.input));
        }
      }
      if (msg.usage && typeof msg.id === 'string') call(msg.id, msg.usage, at);
      continue;
    }
    if (d.type === 'attachment') {
      const a = d.attachment ?? {};
      const t = String(a.type ?? '?');
      if (t === 'file' || t === 'compact_file_reference') {
        const chars = attachmentChars(t === 'file' ? a.content : a);
        add(t === 'file' ? 're-attached file' : 'file reference', chars);
        if (t === 'file') cur.reattached.push({ name: base(String(a.filename ?? a.displayPath ?? '?')), chars });
      } else if (t === 'instructions') {
        for (const f of Array.isArray(a.files) ? a.files : []) {
          const chars = String(f?.content ?? '').length;
          add('instructions (CLAUDE.md, MEMORY.md)', chars);
          cur.instructions.push({ name: `${base(String(f?.path ?? '?'))} (${String(f?.type ?? '?')})`, chars });
        }
      } else if (t === 'queued_command') {
        const body = textOf(a.prompt ?? a.content ?? '');
        add(`message: ${messageKind(body)}`, body.length, body);
      } else if (t === 'prompt_snapshot') {
        // the system prompt as sent, recorded beside the conversation: part of the base, not of the messages
        cur.systemPrompt = attachmentChars(a.systemPrompt);
      } else if (t !== 'deferred_tools_record') {
        add(`attachment: ${t}`, attachmentChars(a));
      }
      continue;
    }
    if (d.type !== 'user') continue;
    const msg = d.message ?? {};
    const content = msg.content;
    if (d.isCompactSummary) {
      add('compaction summary', textOf(content).length);
      continue;
    }
    if (Array.isArray(content) && content.some((b: D) => b?.type === 'tool_result')) {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const body = textOf(b.content);
        add(`tool: ${toolNames.get(b.tool_use_id) ?? '?'}`, body.length, body);
      }
      continue;
    }
    const body = textOf(content);
    if (d.isMeta) {
      add('meta', body.length);
      continue;
    }
    const k = messageKind(body);
    add(`message: ${k}`, body.length, body);
    if (k !== 'command') {
      kind = k;
      cur.turns++;
      turnOf(k).turns++;
    }
  }
  cur.ended = undefined;
  cycles.push(cur);
  return cycles.filter((c) => c.calls > 0);
}

const tk = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);
const n = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : '-');
const hm = (iso?: string) => (iso ? iso.replace(/:\d\d(\.\d+)?Z$/, 'Z').replace('T', ' ') : '?');

function beganText(b: Cycle['began']): string {
  if (b.kind === 'compaction') return `a ${b.trigger} compaction${b.pre ? ` (${n(b.pre)} → ${b.post ? n(b.post) : '?'} tokens, Claude Code's count)` : ''}`;
  return b.kind === 'shrink' ? 'a shrink with no compaction marker' : 'the start of the window read';
}

/** Start parts grouped for the table: summary, re-attached files, instructions, listings, the first message. */
function startGroups(c: Cycle): [string, number][] {
  const g = new Map<string, number>();
  for (const [s, chars] of c.startParts) {
    const key = s.startsWith('message:') ? 'messages' : s.startsWith('attachment: ') ? `listing ${s.slice(12)}` : s;
    g.set(key, (g.get(key) ?? 0) + tk(chars));
  }
  return [...g].sort((a, b) => b[1] - a[1]);
}

/**
 * The report's lines for one coordinator: each cycle, then the sources and turn kinds over every cycle that grew. `label`
 * starts every line, so a grep for a person's name picks their orchestrator.
 */
export function contextReport(label: string, cycles: Cycle[], maxCycles = 8): string[] {
  const out: string[] = [];
  const shown = cycles.slice(-maxCycles);
  if (!shown.length) return [`${label}: no model call in the part of the transcript read`];
  const full = shown.filter((c) => c.began.kind !== 'window' && c.ended);
  out.push(
    `${label}: ${shown.length} cycle(s) shown (${full.length} complete: begun and ended by a compaction or shrink). Measured: each call's context and output. Estimated: the split by source (characters ÷ ${CHARS_PER_TOKEN}).`,
  );
  shown.forEach((c, i) => {
    const parts = startGroups(c);
    const known = parts.reduce((a, [, t]) => a + t, 0);
    const rest = (c.startCtx ?? 0) - known;
    const files = c.reattached.length ? ` Re-attached: ${c.reattached.map((f) => `${f.name} ${n(tk(f.chars))}`).join(', ')}.` : '';
    const instr = c.instructions.length ? ` Instructions: ${c.instructions.map((f) => `${f.name} ${n(tk(f.chars))}`).join(', ')}.` : '';
    out.push(
      `${label}: cycle ${i + 1}, ${hm(c.startedAt)} to ${hm(c.endedAt)}, began with ${beganText(c.began)}${c.ended ? `, ended with ${beganText(c.ended)}` : ', still open'}: ` +
        `start ${n(c.startCtx ?? 0)} tokens (measured) = system prompt, tools and unseen ${n(rest)} (the rest${c.systemPrompt ? `; the system prompt alone ${n(tk(c.systemPrompt))}` : ''})${parts.map(([s, t]) => ` + ${s} ${n(t)}`).join('')} (estimated); ` +
        `peak ${n(c.peak)}; ${c.turns} turn(s), ${c.calls} call(s); grew ${n(c.growth)} tokens (measured), ${c.turns ? n(c.growth / c.turns) : '-'} a turn.${files}${instr}`,
    );
  });

  // over every cycle shown (each one's growth is measured, whatever began it)
  const growth = shown.reduce((a, c) => a + c.growth, 0);
  const turns = shown.reduce((a, c) => a + c.turns, 0);
  const src = new Map<string, Source>();
  for (const c of shown) {
    for (const [s, e] of c.sources) {
      const g = src.get(s) ?? { chars: 0, items: 0, max: 0, repeat: 0 };
      g.chars += e.chars;
      g.items += e.items;
      g.max = Math.max(g.max, e.max);
      g.repeat += e.repeat;
      src.set(s, g);
    }
  }
  const ownOut = shown.reduce((a, c) => a + c.ownOut, 0);
  const rows: [string, number, string][] = [['own output (text, thinking, tool inputs; exact)', ownOut, '']];
  for (const [s, e] of src) {
    rows.push([s, tk(e.chars), `${e.items} item(s), ${n(tk(e.chars / e.items))} each, largest ${n(tk(e.max))}${e.repeat ? `, ${pct(e.repeat, e.chars)} repeated paragraphs` : ''}`]);
  }
  const explained = rows.reduce((a, r) => a + r[1], 0);
  rows.push(['unseen (reminders out of view, the estimate\'s error)', growth - explained, '']);
  rows.sort((a, b) => b[1] - a[1]);
  out.push(`${label}: growth by source over the ${shown.length} cycle(s): ${n(growth)} tokens in ${turns} turn(s) (measured), ${turns ? n(growth / turns) : '-'} a turn:`);
  for (const [s, t, more] of rows) out.push(`${label}:   ${s}: ${n(t)} (${pct(t, growth)})${turns ? `, ${n(t / turns)} a turn` : ''}${more ? `; ${more}` : ''}`);

  const kinds = new Map<string, { turns: number; tokens: number; sources: Map<string, number> }>();
  for (const c of shown) {
    for (const [k, e] of c.kinds) {
      const g = kinds.get(k) ?? { turns: 0, tokens: 0, sources: new Map() };
      g.turns += e.turns;
      g.tokens += e.tokens;
      for (const [s, t] of e.sources) g.sources.set(s, (g.sources.get(s) ?? 0) + t);
      kinds.set(k, g);
    }
  }
  out.push(`${label}: growth by the kind of message that started the turn (measured; its top sources estimated):`);
  for (const [k, e] of [...kinds].sort((a, b) => b[1].tokens - a[1].tokens)) {
    const top = [...e.sources].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, t]) => `${s} ${n(t)}`).join(', ');
    out.push(`${label}:   ${k}: ${e.turns} turn(s), ${n(e.tokens)} tokens (${pct(e.tokens, growth)}), ${e.turns ? n(e.tokens / e.turns) : '-'} a turn; top: ${top}`);
  }
  if (full.length) {
    const ft = full.reduce((a, c) => a + c.turns, 0);
    const fs = full.reduce((a, c) => a + (c.startCtx ?? 0), 0);
    const fp = full.reduce((a, c) => a + c.peak, 0);
    out.push(`${label}: complete cycles: ${n(ft / full.length)} turn(s) between compactions, start ${n(fs / full.length)} tokens, peak ${n(fp / full.length)} (means, measured)`);
  }
  return out.map((l) => l.slice(0, 1000));
}
