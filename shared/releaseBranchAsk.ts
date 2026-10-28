// A Steam branch is never a question that holds a release's patch notes (w2444). Pure, shared by the server and `node --test`.
//
// lothsahn's standing rule: every release ends by posting its notes once, as Max in #dev-patch-notes, once it is live on Steam
// (landed on the branch the release lane sets, development included); never ask, just post. On 2026-10-28 two release workers
// held their notes behind a card asking which Steam branch to set, and he corrected both:
//   w2431 (0.50 Build 113): "Add the patch notes now. I'll update it later. Close the workitem"
//   w2440 (1.0 Build 22): "It's a dev build but you still upload the patch notes. Why did you suddenly decide not to update
//   patch notes for development builds. We've done that for ages"
// The same miss as 0.50.0.65/.66 on 2026-10-02 (the ff-agents evidence-gate lesson a-release-is-done-when-its-notes-are-posted).
// releaseBranchAskIn recognises a card that asks a person to choose, set or move a Steam branch (pre-release, default,
// development, "set it live"), so waiting_on_person refuses it and says to post the notes instead. Moving a branch is the
// person's own act, never an agent's ask. The go-live card for major new content (the ff-agents release checklist 1b, asked
// before the bump) and the A-or-B card (last green commit) still go through.

const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const BRANCH = String.raw`(?:pre-?release|default(?:\s+branch)?|development(?:\s+branch)?|(?:steam\s+)?branch(?:es)?|partner\s+site)`;

const branchAsks: RegExp[] = [
  // choose / pick / which Steam branch
  new RegExp(String.raw`\b(?:choose|pick|select|decide|say|tell me|name)\b[^.?!]{0,40}?\b(?:steam\s+)?branch\b`, 'i'),
  new RegExp(String.raw`\b(?:which|what)\s+(?:steam\s+)?branch\b`, 'i'),
  // set / move / promote / put it on pre-release or default; set it live on ...
  new RegExp(String.raw`\b(?:set|move|promote|put|push|switch)\b[^.?!]{0,80}?\b(?:on|to|onto|into)\s+(?:the\s+)?(?:pre-?release|default)\b`, 'i'),
  new RegExp(String.raw`\bset\b[^.?!]{0,60}?\blive\b[^.?!]{0,30}?\b(?:on|to)\s+(?:the\s+)?${BRANCH}`, 'i'),
  // leave it on development / keep it where it is
  new RegExp(String.raw`\b(?:leave|keep)\b[^.?!]{0,30}?\bon\s+(?:the\s+)?(?:development|pre-?release|default)\b`, 'i'),
  // wait for it to reach / be live on default before posting
  new RegExp(String.raw`\b(?:once|when|until|after)\b[^.?!]{0,40}?\b(?:on|reaches|carries|to)\s+(?:the\s+)?(?:pre-?release|default)\b`, 'i'),
];

/** The cards that legitimately name a Steam branch: major content's go-live moment (checklist 1b) and the A-or-B card. */
const ALLOWED = /\b(?:go-?live moment|steam event|last (?:fully )?green|from green)\b/i;

/** Steam, in words: without one, "which branch" or "set it to default" is about git or a setting, not a Steam branch. */
const STEAM = /\b(?:steam|pre-?release|partner\s+site|build\s?ids?|default\s+branch|development\s+branch|live\s+on)\b/i;

/** Whether `text` asks a person to choose, set or move a Steam branch (w2444). */
export function releaseBranchAskIn(text: string | undefined): boolean {
  const t = flat(text);
  if (!t || !STEAM.test(t) || ALLOWED.test(t)) return false;
  return branchAsks.some((re) => re.test(t));
}

/**
 * Why a wait for a person is refused because it asks about a Steam branch (w2444), or undefined. `what` is the wait's line and
 * `questions` the card's questions; one of them asking for a branch choice or move is enough, since a release worker's card
 * never holds anything on it.
 */
export function releaseBranchAskProblem(what: string | undefined, questions: readonly string[]): string | undefined {
  const units = [what, ...questions].map(flat).filter(Boolean);
  const hit = units.find((u) => releaseBranchAskIn(u));
  if (!hit) return undefined;
  const quoted = hit.length > 140 ? `${hit.slice(0, 139)}…` : hit;
  return (
    `Nothing was recorded (w2444): "${quoted}" asks a person about a Steam branch. A release's patch notes post once the build is live on Steam, which means landed on the branch the release lane sets (development included; release-status.py says LANDED), or uploaded with nothing set live for a pre-1.0 hotfix (BUILT): post them now with post_as_max (channel dev_patch_notes, key the version) and start the crash, desync and hang signature check from the landing time. ` +
    `Which branch a build sits on is Ben's or lothsahn's own move on the partner site, never a question and never a precondition for the notes (lothsahn, w2440: "It's a dev build but you still upload the patch notes. Why did you suddenly decide not to update patch notes for development builds. We've done that for ages"; w2431: "Add the patch notes now. I'll update it later. Close the workitem"). ` +
    'Report the BuildIDs and where it landed, and finish.'
  );
}
