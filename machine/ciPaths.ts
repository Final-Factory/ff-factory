// w5017: does any workflow run on a pull request of these files? ffu's ci.yml has `pull_request: paths-ignore:
// ['docs/**']`, so a PR that changes only docs/ gets no workflow run, and `ff-pr merge` waited on CI that never comes
// (ffu #395 w3382, #754 w4073, #938 w4973: each merged by hand with gh pr merge --match-head-commit). ff-pr asks this
// only when the head has no workflow run at all, reading each workflow at the PR's base.
//
// It fails closed: a PR skips CI only when at least one workflow has a pull_request trigger whose paths or paths-ignore
// filter excludes every changed file, and no workflow would run or cannot be read. A trigger with no path filter, a
// branches or types filter, a `!` or other pattern this does not read, a workflow it cannot parse, no workflows, no
// changed files or more than 300 (GitHub's filter reads only the first 300) all count as "CI would run".

/** How one workflow's pull_request triggers meet the changed files. */
export type Trigger = { kind: 'none' } | { kind: 'runs'; why: string } | { kind: 'skips'; why: string };

const PR_EVENTS = ['pull_request', 'pull_request_target'];
/** GitHub evaluates path filters against at most this many changed files (docs: "Diffs are limited to 300 files"). */
export const MAX_FILES = 300;

/** Drop a `#` comment that is outside quotes. */
function stripComment(line: string): string {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

interface Line {
  indent: number;
  text: string;
}

function linesOf(yaml: string): Line[] {
  const out: Line[] = [];
  for (const raw of yaml.replace(/\r/g, '').split('\n')) {
    const t = stripComment(raw).trimEnd();
    if (!t.trim()) continue;
    out.push({ indent: t.length - t.trimStart().length, text: t.trim() });
  }
  return out;
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

/** A `[a, 'b']` flow list, or undefined when it is not one. */
function flowList(v: string): string[] | undefined {
  const m = /^\[(.*)\]$/.exec(v.trim());
  if (!m) return undefined;
  return m[1].trim() ? m[1].split(',').map(unquote).filter(Boolean) : [];
}

/** The lines nested under the line at `i` (deeper indent), as indices. */
function childrenOf(ls: Line[], i: number): number[] {
  const out: number[] = [];
  for (let j = i + 1; j < ls.length && ls[j].indent > ls[i].indent; j++) out.push(j);
  return out;
}

/** A key's value: the inline text after `key:`, else a block list of `- x` lines under it. */
function valueOf(ls: Line[], i: number): { inline: string; list: string[] | undefined; kids: number[] } {
  const inline = ls[i].text.replace(/^[^:]+:/, '').trim();
  const kids = childrenOf(ls, i);
  const list = kids.length && kids.every((j) => ls[j].text.startsWith('- ')) ? kids.map((j) => unquote(ls[j].text.slice(2))) : undefined;
  return { inline, list, kids };
}

const keyOf = (t: string) => /^(['"]?)([A-Za-z_][\w-]*)\1\s*:(?:\s|$)/.exec(t)?.[2];

/** A GitHub path filter as a RegExp, or undefined for a pattern this does not read (fails closed). */
export function globRegex(p: string): RegExp | undefined {
  if (!p || /[!+[\]{}\\]/.test(p)) return undefined;
  let re = '';
  for (let i = 0; i < p.length; ) {
    if (p.startsWith('**/', i)) (re += '(?:.*/)?'), (i += 3);
    else if (p.startsWith('**', i)) (re += '.*'), (i += 2);
    else if (p[i] === '*') (re += '[^/]*'), i++;
    else if (p[i] === '?') (re += '[^/]'), i++;
    else (re += p[i].replace(/[.^$|()]/g, '\\$&')), i++;
  }
  return new RegExp(`^${re}$`);
}

/** One event's settings block (the `paths-ignore:` and the rest under `pull_request:`) against the files. */
function eventTrigger(ls: Line[], at: number, event: string, files: string[]): Trigger {
  const v = valueOf(ls, at);
  if (v.inline && !/^(?:\{\s*\}|null|~)$/.test(v.inline)) return { kind: 'runs', why: `${event}: ${v.inline} is not read here` };
  const filters: Record<string, string[]> = {};
  for (const j of v.kids) {
    if (ls[j].indent !== ls[v.kids[0]].indent) continue;
    const k = keyOf(ls[j].text);
    if (!k) return { kind: 'runs', why: `${event}: "${ls[j].text}" is not read here` };
    const kv = valueOf(ls, j);
    const list = kv.list ?? flowList(kv.inline) ?? (kv.inline ? [unquote(kv.inline)] : undefined);
    if (!list) return { kind: 'runs', why: `${event}.${k} is not read here` };
    filters[k] = list;
  }
  const other = Object.keys(filters).filter((k) => k !== 'paths' && k !== 'paths-ignore');
  if (other.length) return { kind: 'runs', why: `${event} has ${other.join(', ')} (not read here)` };
  const pats = filters['paths-ignore'] ?? filters.paths;
  if (!pats) return { kind: 'runs', why: `${event} has no path filter` };
  const res = pats.map(globRegex);
  if (!pats.length || res.some((r) => !r)) return { kind: 'runs', why: `${event} has a path pattern not read here (${pats.join(', ')})` };
  const hit = (f: string) => res.some((r) => r!.test(f));
  if (filters['paths-ignore']) {
    const out = files.filter((f) => !hit(f));
    return out.length ? { kind: 'runs', why: `${out[0]} is outside ${event} paths-ignore [${pats.join(', ')}]` } : { kind: 'skips', why: `${event} paths-ignore [${pats.join(', ')}]` };
  }
  const inside = files.filter(hit);
  return inside.length ? { kind: 'runs', why: `${inside[0]} is in ${event} paths [${pats.join(', ')}]` } : { kind: 'skips', why: `${event} paths [${pats.join(', ')}]` };
}

/** How one workflow file's pull_request triggers meet the changed files. */
export function workflowTrigger(yaml: string, files: string[]): Trigger {
  const ls = linesOf(yaml);
  const on = ls.findIndex((l) => l.indent === 0 && /^(['"]?)on\1\s*:/.test(l.text));
  if (on < 0) return { kind: 'runs', why: 'no on: found' };
  const v = valueOf(ls, on);
  if (v.inline) {
    const events = flowList(v.inline) ?? [unquote(v.inline)];
    return events.some((e) => PR_EVENTS.includes(e)) ? { kind: 'runs', why: `on: ${v.inline} has no path filter` } : { kind: 'none' };
  }
  if (v.list) return v.list.some((e) => PR_EVENTS.includes(e)) ? { kind: 'runs', why: 'on: lists pull_request with no path filter' } : { kind: 'none' };
  const top = v.kids.length ? ls[v.kids[0]].indent : 0;
  const skips: string[] = [];
  for (const j of v.kids) {
    if (ls[j].indent !== top) continue;
    const k = keyOf(ls[j].text);
    if (!k) return { kind: 'runs', why: `on: "${ls[j].text}" is not read here` };
    if (!PR_EVENTS.includes(k)) continue;
    const t = eventTrigger(ls, j, k, files);
    if (t.kind === 'runs') return t;
    if (t.kind === 'skips') skips.push(t.why);
  }
  return skips.length ? { kind: 'skips', why: skips.join('; ') } : { kind: 'none' };
}

/** The verdict over every workflow: skips only when no workflow runs on a PR of these files, with why either way. */
export function noPrCi(names: string[], load: (name: string) => string | undefined, files: string[]): { skips: boolean; why: string } {
  if (!files.length) return { skips: false, why: 'the PR lists no changed files' };
  if (files.length > MAX_FILES) return { skips: false, why: `${files.length} changed files, over the ${MAX_FILES} GitHub's path filters read` };
  if (!names.length) return { skips: false, why: 'the base has no workflows' };
  const skips: string[] = [];
  // Read one at a time (a gh call each), stopping at the first that runs: most PRs change code, and ff-pr push asks too.
  for (const name of names) {
    const yaml = load(name);
    if (yaml === undefined) return { skips: false, why: `${name} could not be read` };
    const t = workflowTrigger(yaml, files);
    if (t.kind === 'runs') return { skips: false, why: `${name} runs: ${t.why}` };
    if (t.kind === 'skips') skips.push(`${name} ${t.why}`);
  }
  if (!skips.length) return { skips: false, why: 'no workflow has a pull_request trigger with a path filter' };
  return { skips: true, why: `every changed file (${files.length}) is filtered out: ${skips.join('; ')}` };
}
