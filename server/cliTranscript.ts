// What Claude Code adds to a conversation's context out of the stream's view, read from its own transcript (w1556, asked by
// Lothsahn: "Why is over half the cost on w1510 unitemized?"). The SDK stream shows the agent's messages, tool calls and results,
// never the attachments the CLI puts beside them: its reminders (the tokens left on every call, edited files, diagnostics, the
// date and environment), hook output, the CLAUDE.md and skill list a resumed process sends again, the files a compaction attaches,
// and the task notifications it writes itself. Its transcript (~/.claude/projects/<cwd>/<session id>.jsonl, on the machine the
// agent runs on) records each of them before the model call that reads it. The context meter (shared/spend.ts) counted them as
// `unitemised`; AgentSession now tails the transcript and hands them to the meter before each call (CliTranscriptTail), and a
// process that resumes a conversation with no saved tally rebuilds it from the transcript (rebuildMeter) instead of carrying it.
// docs/spend.md "What unitemised was (w1556)".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextMeter, type MeterState } from '../shared/spend.ts';

type D = Record<string, any>;

/** The folder Claude Code keeps a working directory's transcripts in: every character but a letter or digit becomes `-`. */
export function cliProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** Where Claude Code writes a conversation's transcript, or undefined when it is not there (another layout, another machine). */
export function cliTranscriptPath(cwd: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(sessionId)) return undefined;
  const root = cliProjectsDir(env);
  const direct = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  // a long path is shortened with a hash, a moved sandbox keeps its old folder: look in each project folder once
  try {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // no projects folder
  }
  return undefined;
}

/** Keys of an attachment that say what it is, not text the model reads. */
const META_KEYS = new Set(['type', 'toolUseID', 'hookName', 'hookEvent', 'requestId', 'uuid', 'taskId', 'exitCode', 'durationMs', 'timeoutMs']);
/** The characters of text an attachment puts in the context: its string values, less the keys that only describe it. */
export function attachmentChars(a: unknown, depth = 0): number {
  if (typeof a === 'string') return a.length;
  if (typeof a === 'number' || typeof a === 'boolean') return depth > 1 ? String(a).length : 0;
  if (Array.isArray(a)) return a.reduce((n: number, x) => n + attachmentChars(x, depth + 1), 0);
  if (!a || typeof a !== 'object' || depth > 8) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(a)) if (!META_KEYS.has(k)) n += attachmentChars(v, depth + 1);
  return n;
}

const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: D) => (b?.type === 'text' ? (b.text ?? '') : '')).join('') : '');
const imagesIn = (c: unknown) => (Array.isArray(c) ? c.filter((b: D) => b?.type === 'image').length : 0);
const isPrompt = (d: D) => d.type === 'user' && typeof d.message?.content === 'string' && !d.isMeta && !d.isCompactSummary;
/** A message Claude Code wrote into the conversation itself (a task's notification, another session's message): no stream shows it. */
const cliWritten = (text: string, meta: boolean) => meta || text.startsWith('<task-notification>');

/** An attachment that starts a new process: a process's attachment pass sends the base again, one that goes on does not. */
const PROCESS_START = new Set(['instructions', 'skill_listing', 'agent_listing_delta', 'deferred_tools_delta', 'mcp_instructions_delta', 'session_context']);

/**
 * One transcript line, the part of it the stream never shows: its attachments and the messages the CLI wrote. Returns whether it
 * was such a line. A live session gets the rest from the stream; the replay (feedStream) feeds it too.
 */
export function feedHidden(m: ContextMeter, d: D): boolean {
  if (d.isSidechain) return false;
  if (d.type === 'attachment' && d.attachment && typeof d.attachment.type === 'string') {
    const a = d.attachment;
    if (a.type === 'queued_command') {
      // a message the session sent mid-turn is counted where it was sent (AgentSession.send); a task notification is the CLI's own
      const p = typeof a.prompt === 'string' ? a.prompt : textOf(a.prompt);
      if (cliWritten(p, false)) m.addHidden('brief', p.length);
    } else m.attachment(a.type, attachmentChars(a));
    return true;
  }
  if (d.type === 'user' && typeof d.message?.content === 'string' && !d.isCompactSummary && cliWritten(d.message.content, !!d.isMeta)) {
    m.addHidden('brief', d.message.content.length);
    return true;
  }
  if (d.type === 'user' && d.isMeta && Array.isArray(d.message?.content)) {
    m.addHidden('brief', textOf(d.message.content).length);
    return true;
  }
  return false;
}

/** One transcript line, the part of it the stream shows, fed as AgentSession feeds the stream (a replay of what it saw). */
export function feedStream(m: ContextMeter, d: D) {
  if (d.isSidechain) return;
  if (d.type === 'system' && d.subtype === 'compact_boundary') m.summary(d.compactMetadata?.postTokens ?? 0);
  else if (isPrompt(d) && !cliWritten(d.message.content, false)) m.addUser(d.message.content.length + 200);
  else if (d.type === 'user' && Array.isArray(d.message?.content) && !d.isMeta) {
    for (const b of d.message.content) if (b?.type === 'tool_result' && b.tool_use_id) m.addToolResult(b.tool_use_id, textOf(b.content).length, imagesIn(b.content));
  } else if (d.type === 'assistant' && d.message?.id && d.message.usage) {
    const u = d.message.usage;
    m.call({ id: d.message.id, model: d.message.model, in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0, cw5: u.cache_creation?.ephemeral_5m_input_tokens ?? 0 });
    for (const b of Array.isArray(d.message.content) ? d.message.content : []) if (b?.type === 'tool_use' && b.id) m.addToolUse(b.id, b.name ?? '', b.input, 0);
  }
}

/** The lines of a transcript, each once (a resumed conversation's file can hold a line again). */
export function readCliLines(file: string): D[] {
  const seen = new Set<string>();
  const lines: D[] = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue;
    let d: D;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    if (d.uuid) {
      if (seen.has(d.uuid)) continue;
      seen.add(d.uuid);
    }
    lines.push(d);
  }
  return lines;
}

/**
 * A transcript's lines through a meter, cut into the processes it shows (a turn whose attachment pass sends the base again began a
 * new process, which resumes the tally: ContextMeter.resume). `hidden` feeds what the stream never shows (the meter since w1556);
 * without it the meter sees only what the stream showed (before). `onTurn` gets each turn's reading.
 */
export function replayLines(
  lines: D[],
  o: { hidden: boolean; make?: () => ContextMeter; carryFirst?: boolean; onTurn?: (t: ReturnType<ContextMeter['drain']>, process: number) => void },
): { meter: ContextMeter; calls: number; processes: number } {
  const make = o.make ?? (() => new ContextMeter());
  let m = make();
  let calls = 0;
  let processes = 1;
  const drain = () => o.onTurn?.(m.drain(), processes);
  for (let i = 0; i < lines.length; i++) {
    const d = lines[i];
    if (isPrompt(d) && calls > 0 && !cliWritten(d.message.content, false)) {
      drain();
      let fresh = false;
      for (let j = i + 1; j < lines.length && lines[j].type !== 'assistant'; j++) if (PROCESS_START.has(lines[j].attachment?.type)) fresh = true;
      if (fresh) {
        processes++;
        // a new process: the tally goes on through its snapshot, as AgentSession resumes it
        const next = make();
        // --carry-first: the first resume finds no saved tally, as a conversation that crossed the w1484 deploy did
        if (o.carryFirst && processes === 2) next.carry();
        else next.resume(JSON.parse(JSON.stringify(m.snapshot())) as MeterState);
        m = next;
      }
    }
    if (o.hidden && feedHidden(m, d)) continue;
    if (d.type === 'assistant' && d.message?.usage && !d.isSidechain) calls++;
    feedStream(m, d);
  }
  drain();
  return { meter: m, calls, processes };
}

/**
 * A conversation's tally rebuilt from its transcript, for a process that resumes it with no saved state (one that began before
 * w1484, a state older than METER_STATE_DAYS, a conversation moved to this machine with its transcript): its history in its
 * categories and its base as its first call measured, instead of one lump of `carried` (w1556). Undefined when there is none.
 */
export function rebuildMeter(file: string | undefined): MeterState | undefined {
  if (!file) return undefined;
  try {
    const { meter, calls } = replayLines(readCliLines(file), { hidden: true });
    meter.drain();
    return calls > 0 ? meter.snapshot() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The transcript of a running process, read as it grows: before each model call AgentSession takes what the CLI appended since
 * (`feed`), and the meter gets the attachments and the CLI's own messages the stream did not show. It starts where the file ends when
 * the process starts (the history before is in the meter's tally), or at its start for a new conversation. A line still being
 * written waits for the next read.
 */
export class CliTranscriptTail {
  private offset: number;
  private partial = '';
  readonly file: string;
  constructor(file: string, fromStart: boolean) {
    this.file = file;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // not written yet
    }
    this.offset = fromStart ? 0 : size;
  }

  /** What the CLI appended since the last read, fed to the meter. Returns the lines it fed. */
  feed(m: ContextMeter): number {
    let fd: number | undefined;
    let n = 0;
    try {
      fd = fs.openSync(this.file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) this.offset = 0; // rewritten
      // at most 8 MB a read: an hour of a busy session's transcript is under 2 MB
      const len = Math.min(size - this.offset, 8 << 20);
      if (len <= 0) return 0;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset += len;
      const text = this.partial + buf.toString('utf8');
      const cut = text.lastIndexOf('\n');
      this.partial = text.slice(cut + 1);
      for (const raw of text.slice(0, cut + 1).split('\n')) {
        if (!raw) continue;
        try {
          if (feedHidden(m, JSON.parse(raw))) n++;
        } catch {
          // a line we cannot read
        }
      }
    } catch {
      // no transcript (yet): the meter goes on without it
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return n;
  }
}
