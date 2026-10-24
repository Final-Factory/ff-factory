// The read-chain nudge, a pilot (w2014; docs/spend.md "Read chains handed to a subagent, a pilot"). lothsahn, 2026-10-24: "nudge
// workers to hand long read/search chains to Explore". Runs of five or more reads or searches in a row hold 20-30% of worker
// calls (measured, w2008 on beast's transcripts), and the game repo's CLAUDE.md already sends such a search to a subagent. This
// is the hook the agent host runs (launch.ts buildOptions): after the fifth Read, Grep, Glob or read/search Bash call in a row
// on the main thread, one line of context. Which sessions get it is server/readChain.ts. Light on purpose: it runs on every
// machine's daemon.
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/** Calls in a row that make a chain. */
export const READ_CHAIN_LENGTH = 5;

/** The one line a pilot worker reads after the fifth read or search in a row (the request's own words). */
export const READ_CHAIN_NUDGE =
  'five reads in a row: hand the rest of this search to ff-agents:Explore or scout and keep the conclusion (CLAUDE.md, Delegation policy)';

/** Commands that only read or search files. */
const READERS = new Set([
  'cat', 'head', 'tail', 'sed', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'ls', 'wc', 'awk', 'cut', 'sort', 'uniq', 'nl', 'less',
  'more', 'file', 'stat', 'jq', 'diff', 'tree', 'column', 'tr', 'xxd', 'od', 'strings', 'realpath', 'basename', 'dirname', 'git',
]);
/** Commands that change nothing and may sit beside a read (`cd x && grep`, `echo ---; cat y`); alone they are no read. */
const NEUTRAL = new Set(['cd', 'echo', 'printf', 'true', 'pwd']);
/** git subcommands that only read. */
const GIT_READS = new Set(['log', 'show', 'diff', 'grep', 'status', 'blame', 'ls-files', 'ls-tree', 'cat-file', 'rev-parse', 'describe', 'shortlog', 'reflog', 'merge-base', 'rev-list', 'name-rev']);

/** The command split into segments at unquoted ;, &&, ||, |, & and newlines, each a list of words; null when a word is unclosed. */
function segments(command: string): string[][] | null {
  const out: string[][] = [];
  let seg: string[] = [];
  let word = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (has) seg.push(word);
    word = '';
    has = false;
  };
  const endSeg = () => {
    endWord();
    if (seg.length) out.push(seg);
    seg = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      has = true;
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      // 2>&1 and >&2 are redirections, not a background &.
      if (c === '&' && word.endsWith('>')) {
        word += c;
        has = true;
        continue;
      }
      endSeg();
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
    } else if (c === ' ' || c === '\t') endWord();
    else {
      word += c;
      has = true;
    }
  }
  if (quote) return null;
  endSeg();
  return out;
}

/** A redirection that writes a file (not /dev/null, not 2>&1). */
function writesFile(words: string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    const m = /^\d*(>>?|&>)(.*)$/.exec(words[i]);
    if (!m) continue;
    const target = m[2] || words[i + 1] || '';
    if (target.startsWith('&') || target === '/dev/null' || target === 'NUL') continue;
    return true;
  }
  return false;
}

/** What one segment is: a read, neutral, or anything else. */
function kind(words: string[]): 'read' | 'neutral' | 'other' {
  if (writesFile(words)) return 'other';
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  const cmd = (words[i] ?? '').replace(/^.*\//, '');
  const args = words.slice(i + 1);
  if (!cmd) return 'neutral';
  if (NEUTRAL.has(cmd)) return 'neutral';
  if (!READERS.has(cmd)) return 'other';
  if (cmd === 'sed' && args.some((a) => /^-[^-]*i/.test(a) || a.startsWith('--in-place'))) return 'other';
  if (cmd === 'awk' && args.some((a) => a === 'inplace' || a.startsWith('-i'))) return 'other';
  if (cmd === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok' || a === '-fprint')) return 'other';
  if (cmd === 'git') {
    let j = 0;
    while (j < args.length && args[j].startsWith('-')) j += args[j] === '-C' || args[j] === '-c' ? 2 : 1;
    return GIT_READS.has(args[j] ?? '') ? 'read' : 'other';
  }
  return 'read';
}

/** Whether a Bash command only reads or searches files: every part reads or is neutral (cd, echo), and one part reads. */
export function isReadSearchBash(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const segs = segments(command);
  if (!segs || !segs.length) return false;
  const kinds = segs.map(kind);
  return kinds.includes('read') && kinds.every((k) => k !== 'other');
}

/** Whether a finished tool call is a read or a search. */
export function isReadSearchCall(toolName: string, toolInput: unknown): boolean {
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') return true;
  if (toolName === 'Bash') return isReadSearchBash((toolInput as { command?: unknown } | null)?.command);
  return false;
}

/**
 * The PostToolUse hook of one worker process. It counts the main thread's reads and searches in a row; any other tool call and
 * a new prompt start the count again, and a subagent's calls (agent_id set) neither count nor reset it. On the fifth it adds
 * READ_CHAIN_NUDGE, once per chain.
 */
export function readChainHook(): HookCallback {
  let count = 0;
  let prompt: string | undefined;
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse' || input.agent_id) return {};
    if (input.prompt_id !== prompt) {
      prompt = input.prompt_id;
      count = 0;
    }
    if (!isReadSearchCall(input.tool_name, input.tool_input)) {
      count = 0;
      return {};
    }
    count++;
    if (count !== READ_CHAIN_LENGTH) return {};
    return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: READ_CHAIN_NUDGE } };
  };
}
