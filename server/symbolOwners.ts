// Which request built an urgent-lane release, and which request filed its symbols (w5550, rogue-worker audit w5451 item 18).
// lothsahn: "File it: file_ffbox_symbols only for the worker's own builds". Before this, any worker could call
// file_ffbox_symbols for any version FFBox's urgent claim covered, and wrong symbols would mislead crash triage.
//
// The urgent lane's build starts with the builder's switch_branch onto `urgent/<v>` (the game repo's ci-release skill,
// urgent-release.md section 3 step 1: "Always through switch_branch"; the shell guard refuses a worker's own git switch
// or checkout, so this is the one way onto that branch). The portal records that switch here, with the caller's open
// requests, and file_ffbox_symbols then accepts a version only from a session of one of those requests. The first request
// whose call files symbols for a version owns them: another request is refused, so it can never overwrite them.
// FFBox's own release lane files its symbols on FFBox itself and never comes through here (docs/ffbox.md).
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';

/** urgent/<v>, v four numbers: the urgent lane's pointer at the commit it builds (server/releaseHandBack.ts URGENT_BRANCH). */
const URGENT_VERSION = /^urgent\/(\d{1,6}\.\d{1,6}\.\d{1,6}\.\d{1,6})$/;

/** One switch onto urgent/<v>: the build of that version a request started. */
export interface UrgentBuild {
  workIds: string[];
  session: string;
  machine: string;
  sandbox: string;
  at: string;
}

/** The request whose file_ffbox_symbols call first sent a version's symbols. */
export interface SymbolFiling {
  workIds: string[];
  session: string;
  at: string;
}

export interface VersionRecord {
  builds: UrgentBuild[];
  filed?: SymbolFiling;
}

/** The version an urgent/<v> branch builds, or undefined for any other branch. */
export function urgentVersionOf(branch: string | undefined): string | undefined {
  return branch ? URGENT_VERSION.exec(branch.trim())?.[1] : undefined;
}

const MAX_BUILDS = 20;
const MAX_VERSIONS = 200;
const list = (ids: readonly string[]) => ids.join(', ');

export class SymbolOwners {
  private versions = new Map<string, VersionRecord>();
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      const saved = readJsonDurable<Record<string, VersionRecord>>(file, { check: checkObject }) ?? {};
      for (const [v, r] of Object.entries(saved)) if (r && Array.isArray(r.builds)) this.versions.set(v, { builds: r.builds, ...(r.filed ? { filed: r.filed } : {}) });
    } catch (e) {
      console.warn('symbol owners: could not read:', (e as Error).message);
    }
  }

  get(version: string): VersionRecord | undefined {
    return this.versions.get(version);
  }

  /**
   * A switch_branch onto `branch` by `session` (whose open requests are `workIds`) in machine/sandbox. Records it when the
   * branch is urgent/<v> and the session has an open request; answers the version recorded, else undefined.
   */
  recordSwitch(branch: string, session: string, workIds: readonly string[], machine: string, sandbox: string, at = new Date().toISOString()): string | undefined {
    const version = urgentVersionOf(branch);
    const ids = [...new Set(workIds.map((w) => w.toLowerCase()))];
    if (!version || !ids.length) return undefined;
    const r = this.versions.get(version) ?? { builds: [] };
    const same = r.builds.find((b) => b.session === session && b.machine === machine && b.sandbox === sandbox && list(b.workIds) === list(ids));
    if (same) same.at = at;
    else r.builds = [...r.builds, { workIds: ids, session, machine, sandbox, at }].slice(-MAX_BUILDS);
    this.versions.delete(version);
    this.versions.set(version, r);
    while (this.versions.size > MAX_VERSIONS) this.versions.delete(this.versions.keys().next().value!);
    this.save();
    return version;
  }

  /**
   * Why a session serving `workIds` may not file symbols for `version`, or undefined when it may: the version must be a
   * build one of its requests started (a recorded switch onto urgent/<v>), and symbols another request filed are never
   * replaced.
   */
  refusal(version: string, workIds: readonly string[]): string | undefined {
    const mine = new Set(workIds.map((w) => w.toLowerCase()));
    if (!mine.size) return `Refused (w5550): file_ffbox_symbols takes symbols only for a build your own request made, and this session serves no open request.`;
    const r = this.versions.get(version);
    if (!r?.builds.length) return `Refused (w5550): no urgent build of ${version} is recorded for any request. A build is recorded when its builder's switch_branch puts its sandbox on urgent/${version} (the ci-release skill's urgent-release.md, section 3 step 1); FFBox's own release lane files its symbols itself.`;
    const own = r.builds.filter((b) => b.workIds.some((w) => mine.has(w)));
    if (!own.length) return `Refused (w5550): ${version} was built for ${list([...new Set(r.builds.flatMap((b) => b.workIds))])}, not for your request (${list([...mine])}). Only the request that built a version files its symbols.`;
    if (r.filed && !r.filed.workIds.some((w) => mine.has(w))) return `Refused (w5550): ${version}'s symbols were filed by ${list(r.filed.workIds)} at ${r.filed.at}; only that request may file them again, never another one over them.`;
    return undefined;
  }

  /** `session`'s call (serving `workIds`) sent symbols for `version`: the first such request owns them. */
  recordFiling(version: string, session: string, workIds: readonly string[], at = new Date().toISOString()) {
    const r = this.versions.get(version);
    if (!r || r.filed) return;
    r.filed = { workIds: [...new Set(workIds.map((w) => w.toLowerCase()))], session, at };
    this.save();
  }

  private save() {
    if (!this.file) return;
    try {
      writeJsonDurable(this.file, Object.fromEntries(this.versions), { indent: 2 });
    } catch (e) {
      console.warn('symbol owners: could not save:', (e as Error).message);
    }
  }
}
