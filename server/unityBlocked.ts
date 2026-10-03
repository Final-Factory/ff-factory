import type { UnityBlocked } from '../shared/types.ts';
import { agentAnswers } from './watchdog.ts';

/**
 * The messages about an editor the watchdog could not unstick by itself (docs/unity-dialogs.md, "Who answers"). The
 * sandbox's agents are asked first, with the exact tool call; the dispatcher hears it with the same answer, and the
 * people (their orchestrators, the "Unity editor stuck" notification) only when a person is really needed.
 * `workers`: titles of the agents in that sandbox that were (or will be) messaged.
 */
export function unityBlockedNotices(sandboxId: string, b: UnityBlocked, workers: string[]): { person: boolean; dispatcher: string; workers?: string } {
  const what = b.reason === 'dialog' ? `a "${b.title}" dialog${b.text ? `: ${b.text.replace(/\s+/g, ' ').slice(0, 400)}` : ''}` : `${b.title} (${b.text ?? ''})`;
  const buttons = `buttons: ${(b.buttons ?? []).join(' / ') || 'n/a'}`;
  const head = `The Unity editor of sandbox ${sandboxId} is stuck on ${what}. ${b.advice ?? ''}`.trim();
  const a = agentAnswers(b);
  if (a.person) {
    return { person: true, dispatcher: `[unity blocked] ${head} Its workers see "blocked" in their unity status. It needs a person at the desktop: tell the user (${buttons}).` };
  }
  const how = a.buttons.length
    ? `the unity tool, action "answer_dialog" with button ${a.buttons.map((x) => `"${x.replace(/&/g, '').trim()}"`).join(' or ')}, or action "restart"`
    : 'the unity tool, action "restart" (force: true)';
  const who = workers.length ? `Its agent(s) ${workers.map((w) => `"${w}"`).join(', ')} were asked to answer it with ${how}; if none does, answer it yourself the same way` : `No agent is active in it: answer it yourself with ${how}`;
  return {
    person: false,
    dispatcher: `[unity blocked] ${head} No person is needed. ${who}. Its workers see "blocked" in their unity status (${buttons}).`,
    workers: workers.length
      ? `[unity blocked] Your sandbox's Unity editor (${sandboxId}) is stuck on ${what}. ${b.advice ?? ''} Decide and answer it now with mcp__sandbox__${how.replace('the unity tool, ', 'unity ')}. Then re-pin your Unity MCP instance and carry on.`.replace(/\s+/g, ' ')
      : undefined,
  };
}
