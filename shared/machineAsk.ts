// Capacity is never a question for a person (w2147). Pure, shared by the server and `node --test`.
//
// lothsahn, 2026-10-25: "Stop asking to bring computers online. It's a cluster where computers are sometimes online and
// sometimes paused. Use and schedule resources based on what you have. Don't ask for permission". On w1958 a timed A/B whose
// only fitting computer, desktop-coosego, was offline reached lothsahn as a card: "bring desktop-coosego back online, or say
// which computer may time the shield frame-rate A/B". The second correction of its kind: on w847 the dispatcher asked Ben to
// re-run an installer (lothsahn: "When we say update the machines, do the update"). machineAskIn recognises a question
// whose ask is a computer's availability or choice, so waiting_on_person and decide_work ask refuse it and say how it waits
// Queued instead (server/timedAsk.ts decideTimedPlace files a timed leg Queued even with no computer up). A concrete
// blocker only a person can clear (their own login or password, FileVault, a reboot of their own machine, an admin prompt)
// still goes through.

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A computer, in words: the nouns, plus the fleet's ids the caller passes. "machine" is also a game noun (a factory's
 * machines), so it counts only beside a word of the fleet's work (INFRA): "which machine should make copper" is a design
 * question, "which machine may time the A/B" a capacity ask.
 */
const machineNoun = (ids: readonly string[], machine: boolean) =>
  `(?:computers?|laptops?|desktops?|macs?|pcs?${machine ? '|machines?' : ''}${ids.filter(Boolean).map((id) => `|${esc(id)}`).join('')})`;
const INFRA = /\b(?:tim(?:e|ed|ing)|run|runs|bench|a\/b|builds?|sandbox(?:es)?|editors?|workers?|online|offline|asleep|paused|capacity|daemon|tailscale)\b/i;

const machineAsks = (m: string): RegExp[] => [
  // bring / get / put X (back) online, up, on the network
  new RegExp(String.raw`\b(?:bring|get|put|have)\b[^.?!]{0,60}?\b(?:back\s+)?(?:online|on the network|up and running)\b`, 'i'),
  new RegExp(String.raw`\b${m}\b[^.?!]{0,30}?\bback\s+(?:online|up|on)\b`, 'i'),
  // wake, unpause, power on, turn on, boot, start X
  new RegExp(String.raw`\b(?:wake|unpause|un-pause|resume|power(?:\s+on|\s+up)?|turn\s+on|switch\s+on|boot|start(?:\s+up)?)\b[^.?!]{0,30}?\b${m}\b`, 'i'),
  new RegExp(String.raw`\b${m}\b[^.?!]{0,30}?\b(?:wakes?|woken|wakes? up|unpaused?|powered\s+on|turned\s+on|switched\s+on|booted)\b`, 'i'),
  // which computer may run it; another one; name, pick or choose one
  new RegExp(String.raw`\b(?:which|what|another|a different|other|the other|some other)\s+(?:\w+\s+)?${m}\b`, 'i'),
  new RegExp(String.raw`\b(?:say|name|pick|choose|tell me|decide|select|nominate|suggest)\b[^.?!]{0,30}?\b${m}\b`, 'i'),
  // permission to use a computer; may I use / run on / time on X; wait for X
  new RegExp(String.raw`\b(?:permission|allowed|ok|okay|go-ahead|go ahead)\b[^.?!]{0,40}?\b(?:use|run|time|build|play)\b[^.?!]{0,40}?\b${m}\b`, 'i'),
  new RegExp(String.raw`\b(?:may|can|should|shall)\s+(?:i|we|it|this|the \w+)\s+(?:use|run (?:\w+ )?on|time (?:\w+ )?on|go to|move to|build on)\s+(?:the\s+)?${m}\b`, 'i'),
  new RegExp(String.raw`\bwait(?:s|ing)?\s+(?:for|on|until)\s+(?:the\s+)?${m}\b`, 'i'),
  // run an installer or update a machine for us (w847)
  new RegExp(String.raw`\b(?:re-?run|run|launch|start)\s+(?:the\s+|an\s+)?(?:\w+\s+)?installer\b`, 'i'),
  new RegExp(String.raw`\bupdate\s+(?:the\s+)?${m}\b`, 'i'),
];

/** A blocker only a person can clear: their own login, password or FileVault, a reboot of their machine, an admin prompt. */
const PERSON_ONLY =
  /\b(?:log\s?in|logs?\s+in|sign\s?in|signs?\s+in|password|passcode|passphrase|filevault|2fa|two-factor|steam guard|unlock|reboot|admin(?:istrator)?\s+(?:prompt|password|rights|approval)|uac|keychain|touch id)\b/i;

const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Whether `text` asks a person for a computer's availability or choice (w2147); `ids` are the fleet's machine ids. */
export function machineAskIn(text: string | undefined, ids: readonly string[] = []): boolean {
  const t = flat(text);
  if (!t || PERSON_ONLY.test(t)) return false;
  return machineAsks(machineNoun(ids, INFRA.test(t))).some((re) => re.test(t));
}

/**
 * Why a question for a person is only a capacity ask and so is refused (w2147), or undefined. `what` is the wait's line and
 * `questions` the card's questions (their own words); it is refused when every one of them (or `what`, with no questions)
 * asks for a computer's availability or choice and none names a blocker only that person can clear. `who` says what the
 * caller does instead.
 */
export function machineAskProblem(what: string | undefined, questions: readonly string[], ids: readonly string[], who: 'worker' | 'dispatcher'): string | undefined {
  const units = [what, ...questions].map(flat).filter(Boolean);
  if (!units.length || units.some((u) => PERSON_ONLY.test(u))) return undefined;
  const asks = questions.map(flat).filter(Boolean);
  if (!(asks.length ? asks : [flat(what)]).every((q) => machineAskIn(q, ids))) return undefined;
  const quoted = units[0].length > 140 ? `${units[0].slice(0, 139)}…` : units[0];
  const head = `Nothing was recorded (w2147, lothsahn, 2026-10-25: "Stop asking to bring computers online. It's a cluster where computers are sometimes online and sometimes paused. Use and schedule resources based on what you have. Don't ask for permission"): "${quoted}" asks a person only for a computer (to bring one online, wake or unpause it, pick one, or allow one that is allowed). That is a capacity wait, Queued, never a question for a person.`;
  const only = 'Ask a person only for a blocker only they can clear (their own login or password, a reboot of their own machine), and name that blocker.';
  return who === 'worker'
    ? `${head} Timed work: timed_run queues for its computer and goes out by itself when that one is back, and timed_place always files the leg, Queued, which starts by itself on the first computer that fits in the timing order (smallest free first, then pre-emption, then the queue; never m5). A check on several computers: request_pair, which waits for them. Anything else that needs a computer that is offline or busy: commit and push, then end your turn with your report and a line "wNNN: still open: queued for <the computer or kind of computer it needs>"; the dispatcher queues it (decide_work queue) and it starts when one fits. ${only}`
    : `${head} Use decide_work queue with needs naming the computers that can take it: it starts by itself on the first that comes online or frees up, in order. ${only}`;
}
