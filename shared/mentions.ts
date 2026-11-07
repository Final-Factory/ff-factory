// Whether words name a thing other than to rule it out (w2648). Pure, shared by the server and `node --test`.
//
// w2631's brief (the w2622 pair run, 2026-10-31) said "Direct IP, no Steam, no menus", and the menu reader
// (shared/desktop.ts mentionsMenus) took "menus" as "it clicks the game's menus": the run went only on computers with an
// unlocked screen and m5 and m3 were refused for about 3 hours. A mention counts unless its own clause (back to a comma, a
// stop or a "but") rules it out just before ("no menus", "without clicking", "doesn't click any menu", "not the lobby").

// A clause's last words that rule out the word after them: "no", "without", "never", "nor", "none", "not" and a "n't"
// verb, with at most three words between ("doesn't click any menu", "no title or lobby menus").
// w3455: "non-" right before it ("a direct (non-Steam) host") rules it out too.
const NEGATED_BEFORE = /(?:\b(?:no|without|never|nor|none|not|neither)\b|n['’]t\b|\bcannot\b)(?:\s+\S+){0,3}\s*$|\bnon-\s*$/i;
// The clause a word sits in starts after the last of these.
const CLAUSE_START = /[.;:,!?\n()]|\bbut\b|\bthen\b|\band then\b/i;

/**
 * A brief without what FF Factory added to it (w3455): request_pair's and timed_place's "FF Factory filed this for ..."
 * paragraph restates the marks ("only on computers signed in to Steam", "read from its words: a menu, a lobby, a
 * click"), and reading those back as the request's own words marked w3392 and w3431 as needing Steam.
 */
export function ownWords(text: string | undefined): string | undefined {
  if (!text) return text;
  const at = text.search(/(?:^|\n)\s*FF Factory filed this for /);
  return at < 0 ? text : text.slice(0, at);
}

/** Whether `text` has a match of `re` that its own clause does not rule out. */
export function affirmedMention(text: string | undefined, re: RegExp): boolean {
  text = ownWords(text);
  if (!text) return false;
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  for (const m of text.matchAll(new RegExp(re.source, flags))) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 80), at).split(new RegExp(CLAUSE_START.source, 'gi')).pop() ?? '';
    if (!NEGATED_BEFORE.test(before)) return true;
  }
  return false;
}
