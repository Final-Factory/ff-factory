// A worker's title is the job it is on (w575, Lothsahn: "the dispatcher sets the agent title whenever it hands it a new
// job with a good description of what the job is (starting with the workorder number)"): "wNNN: <what the job is>".
// The dispatcher writes the description; the request id goes in front here, once.

/** The longest title a session takes (SessionManager.setTitle). */
export const TITLE_MAX = 80;

/** What the dispatcher's tools say when a title is missing or unusable. */
export const TITLE_HELP =
  'title: what the job is, in a few plain words, for the dashboard (the request id goes in front by itself), e.g. "LothDesktop fresh install, sandboxes slot1..6". Not the request title cut short.';

/** A leading request id the description may already carry ("w513: ", "(w513) ", "w513 - "). */
const LEADING_ID = /^\(?w\d+\)?\s*(?:[:\-–—]\s*)?/i;

/**
 * "wNNN: <description>", one line of at most TITLE_MAX characters. `clip`: shorten a long description with "…" instead
 * of refusing it (for titles nobody wrote for the job: a person's own start without one, a merge's carried description).
 */
export function jobTitle(workId: string, description: string, opts: { clip?: boolean } = {}): string {
  const d = description.replace(/\s+/g, ' ').trim().replace(LEADING_ID, '').trim();
  if (!d) throw new Error(`${TITLE_HELP} (${workId} has none)`);
  const head = `${workId}: `;
  const t = head + d;
  if (t.length <= TITLE_MAX) return t;
  if (opts.clip) return `${head}${d.slice(0, TITLE_MAX - head.length - 1).trimEnd()}…`;
  throw new Error(`title "${t}" is ${t.length} characters; keep "${workId}: <description>" to ${TITLE_MAX}`);
}

/** The description part of a title ("w513: LothDesktop install" -> "LothDesktop install"). */
export function titleDescription(title: string): string {
  return title.replace(/\s+/g, ' ').trim().replace(LEADING_ID, '').trim();
}
