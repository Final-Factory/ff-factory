// Lab fixtures on the portal (w3939; docs/intake.md, "Nightly e2e regressions"). A nightly regression's worker may sit on any
// computer, but the lab's fixtures (players' saves a scenario names as `"save": "lab:<file>"`, e.g.
// w1440-lifesave-0.50.0.105.zip) live only in `<root>/nightly-history/fixtures` of the computer that runs the night: beast's
// worker waited 3 h for one it could not get.
//
// `fetch_lab_fixture { sha256, name? }` gives the worker's Inbox the file, by its SHA-256 as the scenario's `source` text
// gives it, through the attachment store, which is also the cache: a fixture the store holds is handed out without asking
// any computer, and when a computer that holds fixtures says hello the portal copies the ones it lacks (warm), so they stay
// here while that computer is off. Read-only on the holder: its daemon (machine/labFixtures.ts) lists and hashes the
// folder and sends one file by hash over an upload the portal opened for it, as publish_attachment does.
import { randomUUID } from 'node:crypto';
import type { AttachmentRecord, AttachmentStore } from './attachments.ts';
import { AttachmentError, publicRef } from './attachments.ts';
import { CHUNK_BYTES, fmtBytes } from '../shared/attachments.ts';
import type { AttachmentRef } from '../shared/types.ts';
import type { FromDaemon, ToDaemon } from './machineProtocol.ts';

type Result = Extract<FromDaemon, { type: 'lab_fixture_result' }>;
type Sent = Extract<FromDaemon, { type: 'lab_fixture_sent' }>;
type Listed = NonNullable<Result['files']>[number];

export interface LabFixturesDeps {
  store: AttachmentStore;
  /** Send to a machine's daemon; false when it is not connected. */
  post: (machineId: string, msg: ToDaemon) => boolean;
  /** The online machines whose hello offered `labFixtures`. */
  holders: () => string[];
  log: (line: string) => void;
  now?: () => number;
  /** How long after a holder's hello its fixtures are copied (default 60 s: the hello's own burst settles first). */
  warmDelayMs?: number;
  /** How long a holder has to answer a find (default 60 s), a list (5 min: it hashes what it has not hashed) and an upload (15 min). */
  findMs?: number;
  listMs?: number;
  uploadMs?: number;
}

/** What a fetch found, whatever its caller: a stored record and where it came from, or why none. */
type Got = { rec: AttachmentRecord; from: string; cached: boolean } | { problem: string };

const SHA256 = /^[a-f0-9]{64}$/;

export class LabFixtures {
  private readonly pending = new Map<string, { machineId: string; settle: (m: Result | Sent) => void }>();
  /** One fetch or copy per SHA-256 at a time: a second asker waits for the first's answer. */
  private readonly inflight = new Map<string, Promise<Got>>();
  /** Holders seen online and when (ISO), for the answer when none is online now. */
  private readonly lastSeen = new Map<string, string>();
  private readonly warming = new Set<string>();

  private readonly d: LabFixturesDeps;

  constructor(deps: LabFixturesDeps) {
    this.d = deps;
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** A holder's daemon answered a `lab_fixture` or ended a `lab_fixture_upload` (server/machines.ts). */
  onReport(machineId: string, msg: Result | Sent) {
    const p = this.pending.get(msg.id);
    if (p && p.machineId === machineId) p.settle(msg);
  }

  /** A daemon that holds fixtures said hello: copy the ones the store lacks, and keep the ones it has from being pruned. */
  onHolder(machineId: string) {
    this.lastSeen.set(machineId, new Date(this.now()).toISOString());
    if (this.warming.has(machineId)) return;
    this.warming.add(machineId);
    const timer = setTimeout(() => {
      this.warm(machineId)
        .catch((e) => this.d.log(`lab fixtures: warming from ${machineId}: ${(e as Error).message}`))
        .finally(() => this.warming.delete(machineId));
    }, this.d.warmDelayMs ?? 60_000);
    timer.unref();
  }

  /**
   * fetch_lab_fixture: the stored record for `sha256`, granted to the caller's machine (its daemon fetches it into the
   * agent's Inbox), with the words to tell the agent. Every refusal is text for the agent, never a throw.
   */
  async fetch(callerMachineId: string, sha256: unknown, name?: unknown): Promise<{ text: string; refs: AttachmentRef[] }> {
    const sha = String(sha256 ?? '').trim().toLowerCase();
    if (!SHA256.test(sha)) return refusal("sha256: 64 hex digits, as the scenario's `source` text gives it (scripts/nightly/scenarios/*.json).");
    const want = typeof name === 'string' && name.trim() ? name.trim() : undefined;
    if (want !== undefined && (want.length > 128 || /[\\/]|\.\./.test(want))) return refusal('name: a plain file name such as w1440-lifesave-0.50.0.105.zip (no path, at most 128 characters).');
    const got = await this.share(sha, () => this.obtain(sha, want));
    if ('problem' in got) return refusal(got.problem);
    this.d.store.grant(callerMachineId, [got.rec.id]);
    const r = got.rec;
    const lines = [
      `Fetched lab fixture ${r.name} (${fmtBytes(r.size)}, sha256 ${sha.slice(0, 12)}…) ${got.cached ? "from the portal's copy (no computer was asked)" : `from ${got.from}'s fixtures folder (read-only there)`}; SHA-256 checked on arrival.`,
      ...(want && want !== r.name ? [`Its name there is ${r.name}, not ${want}: the scenario's \`lab:${want}\` still needs the file under ${want}.`] : []),
      `Copy it to $FF_WORKER_ROOT/nightly-history/fixtures/${want ?? r.name} (create the folder; never overwrite a file of another SHA-256) so scripts/nightly/ffnightly.py finds it as lab:${want ?? r.name}.`,
    ];
    return { text: lines.join('\n'), refs: [publicRef(r)] };
  }

  private share(sha: string, run: () => Promise<Got>): Promise<Got> {
    const p = this.inflight.get(sha) ?? run().finally(() => this.inflight.delete(sha));
    this.inflight.set(sha, p);
    return p;
  }

  private async obtain(sha: string, name?: string): Promise<Got> {
    const have = this.d.store.bySha(sha);
    if (have) return { rec: have, from: 'the portal', cached: true };
    const holders = this.d.holders();
    for (const h of holders) this.lastSeen.set(h, new Date(this.now()).toISOString());
    if (!holders.length) {
      const seen = [...this.lastSeen].map(([m, at]) => `${m} (last online ${at})`);
      return {
        problem: [
          `No online computer holds a lab fixture cache now, and the portal has no copy of ${sha.slice(0, 12)}….`,
          seen.length ? `Computers that held it when last seen: ${seen.join(', ')}.` : 'The portal has not seen a computer that holds one since it started.',
          'Call `wake_me 30` and call fetch_lab_fixture again; the fixtures are copied to the portal whenever that computer is online. Do not ask a person to bring a computer online or wait on the orchestrator for it.',
        ].join(' '),
      };
    }
    const tried: string[] = [];
    const problems: string[] = [];
    for (const h of holders) {
      const asked = await this.ask(h, { op: 'find', sha256: sha }, this.d.findMs ?? 60_000);
      if ('error' in asked) {
        problems.push(`${h}: ${asked.error}`);
        continue;
      }
      const file = asked.files.find((f) => f.sha256 === sha && f.name === name) ?? asked.files.find((f) => f.sha256 === sha);
      if (!file) {
        tried.push(h);
        continue;
      }
      const got = await this.pull(h, file);
      if ('problem' in got) problems.push(got.problem);
      else return got;
    }
    return {
      problem: [
        tried.length ? `No lab fixture with sha256 ${sha} on ${tried.join(', ')} (the computers that hold lab fixtures and are online now); it must be the SHA-256 the scenario's \`source\` text gives.` : '',
        problems.length ? `Not delivered: ${problems.join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  /** Ask a holder, answered by its `lab_fixture_result` within `ms`. */
  private async ask(machineId: string, q: { op: 'list' | 'find'; sha256?: string }, ms: number): Promise<{ files: Listed[] } | { error: string }> {
    const id = randomUUID();
    const reply = this.wait<Result>(id, machineId, ms);
    if (!this.d.post(machineId, { type: 'lab_fixture', id, ...q })) {
      this.pending.delete(id);
      return { error: 'not connected' };
    }
    const r = await reply;
    if (!r) return { error: `no answer in ${Math.round(ms / 1000)} s` };
    if (!r.ok) return { error: r.error ?? 'its daemon could not read the fixtures folder' };
    return { files: Array.isArray(r.files) ? r.files.filter((f) => f && typeof f.name === 'string' && SHA256.test(String(f.sha256)) && Number.isSafeInteger(f.size)) : [] };
  }

  private wait<T extends Result | Sent>(id: string, machineId: string, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const done = (m?: T) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(m);
      };
      const timer = setTimeout(() => done(), ms);
      timer.unref();
      this.pending.set(id, { machineId, settle: (m) => done(m as T) });
    });
  }

  /** Copy one fixture of a holder into the store: an upload the portal opens, the holder's daemon fills, the hash checked. */
  private async pull(holder: string, file: Listed): Promise<Got> {
    const { store } = this.d;
    let uploadId: string;
    try {
      uploadId = store.begin({ name: file.name, size: file.size, sha256: file.sha256, machineId: holder, source: `lab fixture ${file.name} from ${holder}` }).uploadId;
    } catch (e) {
      return { problem: `${holder}'s ${file.name} (${fmtBytes(file.size)}) was not taken: ${e instanceof AttachmentError ? e.message : (e as Error).message}` };
    }
    const id = randomUUID();
    const reply = this.wait<Sent>(id, holder, this.d.uploadMs ?? 15 * 60_000);
    const cancel = () => {
      try {
        store.cancel(uploadId);
      } catch {
        // finished, or already dropped
      }
    };
    if (!this.d.post(holder, { type: 'lab_fixture_upload', id, sha256: file.sha256, uploadId, chunkBytes: CHUNK_BYTES })) {
      this.pending.delete(id);
      cancel();
      return { problem: `${holder} went offline before it sent ${file.name}` };
    }
    const sent = await reply;
    if (!sent || sent.error || !sent.attachmentId) {
      cancel();
      return { problem: `${holder} did not send ${file.name}: ${sent ? (sent.error ?? 'no attachment came of it') : 'no end to its upload in 15 minutes'}` };
    }
    const rec = store.get(sent.attachmentId);
    if (!rec || rec.sha256 !== file.sha256) {
      if (rec) store.forget([rec.id]);
      return { problem: `${file.name} from ${holder} is stored under another SHA-256 than ${file.sha256.slice(0, 12)}… (the portal masks secrets in a text file)` };
    }
    this.d.log(`lab fixtures: ${file.name} (${fmtBytes(file.size)}) copied from ${holder}`);
    return { rec, from: holder, cached: false };
  }

  /** Copy what a holder has and the store lacks; touch what it has, which keeps retention from deleting it. */
  private async warm(holder: string) {
    const { store } = this.d;
    if (!this.d.holders().includes(holder)) return;
    const listed = await this.ask(holder, { op: 'list' }, this.d.listMs ?? 5 * 60_000);
    if ('error' in listed) return this.d.log(`lab fixtures: ${holder} listed none (${listed.error})`);
    for (const f of listed.files) {
      if (!this.d.holders().includes(holder)) return;
      const have = store.bySha(f.sha256);
      if (have) {
        store.touch([have.id]);
        continue;
      }
      if (f.size > store.settings.maxBytes) {
        this.d.log(`lab fixtures: ${f.name} of ${holder} (${fmtBytes(f.size)}) is over the attachment limit (${fmtBytes(store.settings.maxBytes)}); not copied`);
        continue;
      }
      const got = await this.share(f.sha256, () => this.pull(holder, f));
      if ('problem' in got) this.d.log(`lab fixtures: ${got.problem}`);
    }
  }
}

const refusal = (text: string) => ({ text, refs: [] as AttachmentRef[] });
