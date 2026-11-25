// What a worker is told when its agent host hit one of its caps (w5554, machine/workerCaps.ts): the host puts the note here,
// and the worker's next tool result carries it (a PostToolUse hook, server/sessions.ts), once. The host and its session share
// this process, so a module's queue is enough.
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

const notes: string[] = [];

/** A note for the worker's next tool result. */
export function pushCapNote(note: string) {
  // One of each: a cap hit again before the worker read the first says the same.
  if (!notes.includes(note)) notes.push(note);
}

/** The PostToolUse hook that hands the notes over. A subagent's calls (agent_id set) leave them for the agent's own. */
export function capNotesHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse' || input.agent_id || !notes.length) return {};
    const text = notes.splice(0).join('\n\n');
    return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: text } };
  };
}
