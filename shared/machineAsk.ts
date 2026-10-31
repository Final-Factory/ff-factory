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

/**
 * A fork whose answers differ only in where or when work runs (w2648) is the dispatcher's to decide, never a person's. At
 * 08:40 on 2026-10-31 the dispatcher asked lothsahn about w2631 (a 3-leg pair run that only beast fitted), and the card got
 * past machineAskProblem because its question asked for no computer: only its answers differed, "re-file 2 legs, starts
 * now", "3 legs, wait for lothdesktop", "leave queued". It sat for about 3 hours until lothsahn answered with w2147's rule.
 */
// Words that name where or when work runs: a fork whose answers differ by one of them is a placement fork.
const PLACE_STRONG = new Set(
  (
    'leg legs machine machines computer computers pc pcs mac macs laptop laptops desktop desktops sandbox sandboxes slot slots ' +
    'host hosts client clients joiner joiners peer peers process processes instance instances wait waits waiting waited queue ' +
    'queued queues queueing now later online offline paused asleep busy idle available unavailable capacity cluster'
  ).split(' '),
);
// Verbs and words that go with placement but also with a person's own fork ("Put it in" or "Leave it out", w1597): an
// answer may differ by them only beside a word above.
const PLACE_WORDS = new Set([
  ...PLACE_STRONG,
  ...(
    'box boxes hold holds held keep kept leave left park parked file filed refile refiled rerun retry start starts started ' +
    'starting run runs running ran go goes place placed put free frees freed back comes come returns room fit fits fitting ' +
    'schedule scheduled two three four fewer more extra daemon'
  ).split(' '),
]);
const ASK_STOP = new Set(
  (
    'a an the and or but so it its this that these those to of in on at for with by from as is are be been was were will ' +
    'would can could should may might do does not no yes then than there here we you i me my our your they them their he ' +
    'she his her who what which when where how if just only also too very same other another each every all both any some ' +
    'one ones until after before while about into out over up down off again still yet already re s t ll ve d m recommended'
  ).split(' '),
);
/** Words that make a fork a person's even when its answers say only where or when: money, publishing, approvals, deletes. */
const RESERVED = /\$|\b(?:spend|spends|spending|cost|costs|money|budget|pay|paid|approv\w*|publish\w*|release\w*|merge\w*|delet\w*|ship it|steam branch)\b/i;

const askWords = (s: string): string[] => s.toLowerCase().replace(/['’]/g, '').match(/[a-z0-9#]+/g) ?? [];

/** Whether an ask's answers differ only in machines, legs, sandboxes or waiting (w2648), read from their labels. */
export function placementOnlyAsk(ask: { question: string; options: readonly { label: string; description?: string }[] }, ids: readonly string[] = []): boolean {
  if (ask.options.length < 2) return false;
  const all = [ask.question, ...ask.options.flatMap((o) => [o.label, o.description ?? ''])].join(' ');
  if (PERSON_ONLY.test(all) || RESERVED.test(all)) return false;
  const fleet = new Set(ids.map((id) => id.toLowerCase()));
  const place = (w: string) => PLACE_WORDS.has(w) || fleet.has(w);
  const sets = ask.options.map((o) => new Set(askWords(o.label).filter((w) => !ASK_STOP.has(w))));
  const union = new Set(sets.flatMap((s) => [...s]));
  const diff = [...union].filter((w) => !sets.every((s) => s.has(w)));
  const strong = (w: string) => PLACE_STRONG.has(w) || fleet.has(w);
  const number = (w: string) => /^(?:\d+|w\d+|#\d+)$/.test(w);
  // "2 legs" against "3 legs" differs only in a number beside a word of placement both say.
  if (!diff.length || ![...union].some(strong) || !diff.some((w) => strong(w) || number(w))) return false;
  return diff.every((w) => place(w) || number(w));
}

/**
 * Why a card is refused as a placement fork (w2648), or undefined: one of its questions has answers that differ only in
 * machines, legs, sandboxes or waiting. It names the answer to take: the one that starts on what is there now.
 */
export function placementForkProblem(asks: readonly { question: string; options: readonly { label: string; description?: string; recommended?: boolean }[] }[], ids: readonly string[], who: 'worker' | 'dispatcher'): string | undefined {
  const fork = asks.find((a) => placementOnlyAsk(a, ids));
  if (!fork) return undefined;
  const now = fork.options.find((o) => /\b(?:now|starts?|start(?:ed|ing))\b/i.test(o.label) && !/\bwait/i.test(o.label)) ?? fork.options.find((o) => o.recommended) ?? fork.options[0];
  const q = flat(fork.question);
  const head = `Nothing was recorded (w2648, after w2147; lothsahn, 2026-10-25: "Use and schedule resources based on what you have. Don't ask for permission"): the answers to "${q.length > 120 ? `${q.slice(0, 119)}…` : q}" differ only in machines, legs, sandboxes or waiting, and that choice is yours. Take the one that starts on what is there now ("${clipLabel(now.label)}"), and say what you did in your note.`;
  return who === 'dispatcher'
    ? `${head} A pair run whose legs never started is re-marked with decide_work pair_legs and pair_menus (any action; queue on a Queued one only re-marks it), then started with start_agent; work for a computer that is not up is queued with needs. Ask a person only for what only they can give (a login, a reboot of their own machine, money, an approval).`
    : `${head} A check on several computers: request_pair, asked again with legs or menus to re-mark a run whose legs never started; timed work: timed_place or timed_run. Ask a person only for what only they can give (a login, a reboot of their own machine, money, an approval).`;
}

const clipLabel = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
