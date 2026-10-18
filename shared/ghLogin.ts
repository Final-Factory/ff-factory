// Each machine's own gh login and its token's scopes (w1463, docs/machines.md "The machine's gh login"). Ben: a worker four
// times now had a push of a .github/workflows file refused because its machine's gh token lacks the `workflow` scope (the
// latest w1459 on BEAST, whose lesson in final-factory-agents PR #241 asks for "FF Factory naming the machine's gh scopes in
// each brief"). The daemon reads `gh auth status` (machine/ghLogin.ts) and reports the account and the scope NAMES only,
// never the token; the portal shows them in list_machines, puts a line in every worker's brief, and places work that changes
// .github/workflows on a machine whose token may push it (server/placement.ts). Pure, shared by the daemon and the portal.

/** What a daemon reports of its machine's gh login (FromDaemon `gh_login`). Names only: no token, no part of one. */
export interface GhLogin {
  /** When the daemon last read it (ISO). */
  checkedAt: string;
  /** gh answered with a logged-in account on github.com. */
  ok: boolean;
  /** The GitHub account it acts as ("bryding"). */
  account?: string;
  /**
   * The OAuth scopes GitHub reports for the token ("repo", "workflow", "read:org"), sorted. Empty: GitHub reported none,
   * which is a fine-grained token (its permissions are not scopes and cannot be read) or a token granted no scope.
   */
  scopes?: string[];
  /** Where gh found it: "keyring", "oauth_token" (gh's hosts file), "GH_TOKEN", "GITHUB_TOKEN". */
  source?: string;
  /** Why there is no account (gh missing, not logged in, GitHub did not answer), in FF Factory's own words. */
  error?: string;
}

/** The scope GitHub requires to create or change a file under .github/workflows/ (a classic or OAuth token). */
export const WORKFLOW_SCOPE = 'workflow';

const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SCOPE = /^[a-z][a-z0-9:_-]{0,39}$/;
const SOURCE = /^[A-Za-z0-9_.-]{1,40}$/;
const ERRORS = 160;

/**
 * A report as the portal keeps it, or undefined when it is not one: only an account name, scope names and a source that
 * look like GitHub's are kept, so nothing else (a token, a path, gh's own text) can reach the portal's record, a brief or a
 * log through it, whatever a daemon sends.
 */
export function sanitizeGhLogin(raw: unknown): GhLogin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const checkedAt = typeof r.checkedAt === 'string' && !Number.isNaN(Date.parse(r.checkedAt)) ? new Date(r.checkedAt).toISOString() : undefined;
  if (!checkedAt) return undefined;
  const account = typeof r.account === 'string' && ACCOUNT.test(r.account) ? r.account : undefined;
  const scopes = Array.isArray(r.scopes) ? [...new Set(r.scopes.filter((s): s is string => typeof s === 'string' && SCOPE.test(s)))].sort() : undefined;
  const source = typeof r.source === 'string' && SOURCE.test(r.source) ? r.source : undefined;
  const ok = r.ok === true && !!account;
  const error = !ok ? cleanError(typeof r.error === 'string' ? r.error : 'no account reported') : undefined;
  return { checkedAt, ok, ...(account ? { account } : {}), ...(scopes ? { scopes } : {}), ...(source ? { source } : {}), ...(error ? { error } : {}) };
}

/** An error line with anything token-like taken out and cut short: it is shown in list_machines and briefs. */
function cleanError(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9_])(gh[pousr]_|github_pat_)[A-Za-z0-9_]*/g, '<token>')
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERRORS);
}

/** Scope names from gh's "repo, workflow" (JSON) or "'repo', 'workflow'" (text). */
export function scopeList(text: string): string[] {
  return [...new Set(text.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter((s) => SCOPE.test(s)))].sort();
}

/**
 * The active github.com account from `gh auth status --active --hostname github.com --json hosts` (gh 2.71 and later):
 * {"hosts":{"github.com":[{"state":"success","active":true,"login":"bryding","tokenSource":"keyring","scopes":"gist, repo"}]}}.
 * Undefined when the text is not that JSON (an older gh: parse its text instead).
 */
export function parseGhStatusJson(text: string, now: Date): GhLogin | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const hosts = (doc as { hosts?: Record<string, unknown> } | null)?.hosts;
  if (!hosts || typeof hosts !== 'object') return undefined;
  const list = Array.isArray(hosts['github.com']) ? (hosts['github.com'] as Record<string, unknown>[]) : [];
  const a = list.find((x) => x && x.active === true) ?? list[0];
  const checkedAt = now.toISOString();
  if (!a) return { checkedAt, ok: false, error: 'gh is not logged in to github.com' };
  const login = typeof a.login === 'string' && ACCOUNT.test(a.login) ? a.login : undefined;
  const source = typeof a.tokenSource === 'string' && SOURCE.test(a.tokenSource) ? a.tokenSource : undefined;
  if (a.state !== 'success' || !login) {
    const why = a.state === 'timeout' ? 'GitHub did not answer gh in time' : 'GitHub refused the login (gh auth status: not valid)';
    return { checkedAt, ok: false, ...(login ? { account: login } : {}), ...(source ? { source } : {}), error: why };
  }
  return { checkedAt, ok: true, account: login, scopes: scopeList(typeof a.scopes === 'string' ? a.scopes : ''), ...(source ? { source } : {}) };
}

/**
 * The active github.com account from `gh auth status --active --hostname github.com`'s text, for a gh without --json:
 * "✓ Logged in to github.com account bryding (keyring)" (or older "as bryding (oauth_token)") and "Token scopes: 'gist',
 * 'repo'". Its "Token:" line is never read.
 */
export function parseGhStatusText(text: string, now: Date): GhLogin {
  const checkedAt = now.toISOString();
  const blocks = text.split(/\r?\n(?=\s*(?:[✓X!]\s*)?(?:Logged in|Failed to log in))/);
  const block = blocks.find((b) => /Active account:\s*true/i.test(b)) ?? blocks.find((b) => /Logged in to github\.com/i.test(b)) ?? text;
  const m = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)(?: \(([^)\s]+)\))?/i.exec(block);
  if (!m || !ACCOUNT.test(m[1])) {
    const why = /not logged in|gh auth login/i.test(text) ? 'gh is not logged in to github.com' : /Failed to log in|invalid|expired/i.test(text) ? 'GitHub refused the login (gh auth status: not valid)' : 'gh auth status named no github.com account';
    return { checkedAt, ok: false, error: why };
  }
  const scopes = /Token scopes:\s*([^\r\n]*)/i.exec(block)?.[1] ?? '';
  const source = m[2] && SOURCE.test(m[2]) ? m[2] : undefined;
  return { checkedAt, ok: true, account: m[1], scopes: /^none$/i.test(scopes.trim()) ? [] : scopeList(scopes), ...(source ? { source } : {}) };
}

/** Whether the login may push a change to .github/workflows: true, false, or undefined when unknown (no report, an error, no scopes reported). */
export function canPushWorkflows(gh: GhLogin | undefined): boolean | undefined {
  if (!gh?.ok || !gh.scopes) return undefined;
  if (gh.scopes.includes(WORKFLOW_SCOPE)) return true;
  // No scope at all is what GitHub reports for a fine-grained token, whose Workflows permission cannot be read.
  return gh.scopes.length ? false : undefined;
}

/** "bryding (gist, read:org, repo)", "bryding (no scopes reported: a fine-grained token?)", "not logged in (…)". */
export function ghLoginLabel(gh: GhLogin | undefined): string {
  if (!gh) return 'not reported yet (an older daemon)';
  if (!gh.ok) return `${gh.account ? `${gh.account}, ` : ''}not usable (${gh.error ?? 'unknown'})`;
  return `${gh.account} (${gh.scopes?.length ? gh.scopes.join(', ') : 'no scopes reported: a fine-grained token, whose Workflows permission cannot be read'})`;
}

/** What the login means for workflow files, in a few words. */
export function workflowWords(gh: GhLogin | undefined): string {
  const can = canPushWorkflows(gh);
  return can === true ? 'can push .github/workflows' : can === false ? 'cannot push .github/workflows (no workflow scope)' : 'whether it can push .github/workflows is unknown';
}

/** list_machines' part: "gh: bryding (repo, workflow; can push .github/workflows)". */
export function ghMachineLine(gh: GhLogin | undefined): string {
  return gh?.ok ? `gh: ${gh.account} (${gh.scopes?.length ? gh.scopes.join(', ') : 'no scopes reported'}; ${workflowWords(gh)})` : `gh: ${ghLoginLabel(gh)}`;
}

/**
 * Words that say a request changes a GitHub Actions workflow file: ".github/workflows", "a workflow file", "the workflow
 * scope", "main.yml" beside a CI word. A wrong yes only steers the work to a machine that can push such a file.
 */
const WORKFLOW_WORDS: readonly RegExp[] = [
  /\.github[\\/]+workflows\b/i,
  /\bworkflows?\s+(?:files?|scopes?|permissions?|ya?ml)\b/i,
  /\b(?:add|edit|change|update|modify|fix|touch|write)\w*\s+(?:a\s+|an\s+|the\s+|its\s+|our\s+)?(?:new\s+)?(?:CI\s+|GitHub\s+Actions?\s+|Actions\s+)workflows?\b/i,
  /\b(?:ci|main|windows|release|master-batch|nightly)\.ya?ml\b[^\n]{0,80}\b(?:CI|jobs?|steps?|workflows?|Actions)\b/i,
  /\b(?:CI|jobs?|steps?|workflows?|Actions)\b[^\n]{0,80}\b(?:ci|main|windows|release|master-batch|nightly)\.ya?ml\b/i,
];

/** Whether `text` (a request's title, brief, the start prompt) says the work changes .github/workflows. */
export function changesWorkflows(text: string | undefined): boolean {
  const t = text ?? '';
  return WORKFLOW_WORDS.some((re) => re.test(t));
}

/**
 * The worker brief's line (w1463): what this run's gh and git push act as, and whether that may push .github/workflows.
 * `vaultToken`: the vault GitHub entry this run gets as GH_TOKEN ("vault-ben-github …abcd"), which overrides the machine's
 * login (docs/vault.md section 13). `able`: the other machines whose login has the workflow scope.
 */
export function ghBriefLine(machine: string, gh: GhLogin | undefined, vaultToken: string | undefined, able: readonly string[]): string {
  const elsewhere = able.filter((m) => m !== machine);
  const handOff = `such a change must be pushed from a machine that can (${elsewhere.length ? `${elsewhere.join(', ')}: list_machines shows each machine's gh` : 'none reports the workflow scope now: list_machines shows each machine\'s gh'}); commit the rest, push without the workflow file, and hand that step to your orchestrator. Never print a token`;
  if (vaultToken) {
    return `- GitHub token: this run's gh and git push use ${vaultToken} from the vault, not this machine's login (${ghLoginLabel(gh)}). A vault GitHub token is fine-grained: Workflows (read and write) is required of it (docs/vault.md 13.2) but cannot be checked without writing, so if GitHub refuses a push of .github/workflows ("refusing to allow ... without \`workflows\` permission"), ${handOff}.`;
  }
  const can = canPushWorkflows(gh);
  const who = `this machine's gh token: ${ghLoginLabel(gh)}`;
  if (can === true) return `- GitHub token: ${who}: it can push changes to .github/workflows.`;
  if (can === false) return `- GitHub token: ${who}: it cannot push .github/workflows (GitHub refuses a workflow file without the \`workflow\` scope); ${handOff}.`;
  return `- GitHub token: ${who}: whether it can push .github/workflows is unknown (\`gh auth status\` shows its scopes; it needs \`workflow\`); if GitHub refuses such a push, ${handOff}.`;
}
