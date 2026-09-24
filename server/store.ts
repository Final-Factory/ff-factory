import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AppSettings, DelegationRequest, Machine, Sandbox, ServerEvent, SessionInfo, StandingAgent, TranscriptEvent } from '../shared/types.ts';

/** Everything the UI hears about goes through here and out the WebSocket. */
export const bus = new EventEmitter<{ event: [ServerEvent] }>();
bus.setMaxListeners(100);
export const emit = (e: ServerEvent) => bus.emit('event', e);

interface Persisted {
  sandboxes: Sandbox[];
  sessions: SessionInfo[];
  orchestratorId?: string;
  standingAgents?: StandingAgent[];
  delegations?: DelegationRequest[];
  machines?: Machine[];
  settings?: AppSettings;
}

/**
 * The durable record: sandboxes and session metadata in one JSON file (small, rewritten whole),
 * transcripts as one append-only JSONL per session. No database, so no native modules to build
 * on the Windows host.
 */
export class Store {
  readonly sandboxes = new Map<string, Sandbox>();
  readonly sessions = new Map<string, SessionInfo>();
  readonly standing = new Map<string, StandingAgent>();
  readonly delegations = new Map<string, DelegationRequest>();
  readonly machines = new Map<string, Machine>();
  orchestratorId?: string;
  settings: AppSettings = { heartbeatMinutes: null };
  private readonly file: string;
  private readonly transcriptDir: string;
  private readonly uploadDir: string;
  private readonly seqs = new Map<string, number>();
  private saveTimer?: NodeJS.Timeout;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'state.json');
    this.transcriptDir = path.join(dataDir, 'transcripts');
    this.uploadDir = path.join(dataDir, 'uploads');
    fs.mkdirSync(this.transcriptDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const p: Persisted = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const s of p.sandboxes) this.sandboxes.set(s.id, s);
      for (const s of p.sessions) this.sessions.set(s.id, s);
      this.orchestratorId = p.orchestratorId;
      for (const a of p.standingAgents ?? []) this.standing.set(a.id, a);
      for (const d of p.delegations ?? []) this.delegations.set(d.id, d);
      for (const m of p.machines ?? []) this.machines.set(m.id, { ...m, online: false });
      this.settings = { ...this.settings, ...p.settings };
    }
  }

  putSandbox(s: Sandbox) {
    this.sandboxes.set(s.id, s);
    this.save();
    emit({ type: 'sandbox', sandbox: s });
  }

  removeSandbox(id: string) {
    this.sandboxes.delete(id);
    this.save();
    emit({ type: 'sandbox_removed', id });
  }

  putSession(s: SessionInfo) {
    this.sessions.set(s.id, s);
    this.save();
    emit({ type: 'session', session: s });
  }

  removeSession(id: string) {
    this.sessions.delete(id);
    this.save();
    emit({ type: 'session_removed', id });
  }

  putStanding(a: StandingAgent) {
    this.standing.set(a.id, a);
    this.save();
    emit({ type: 'standing', agent: a });
  }

  removeStanding(id: string) {
    this.standing.delete(id);
    this.save();
    emit({ type: 'standing_removed', id });
  }

  putDelegation(d: DelegationRequest) {
    this.delegations.set(d.id, d);
    this.save();
    emit({ type: 'delegation', request: d });
  }

  putSettings(patch: Partial<AppSettings>) {
    this.settings = { ...this.settings, ...patch };
    this.save();
    emit({ type: 'settings', settings: this.settings });
    return this.settings;
  }

  putMachine(m: Machine) {
    this.machines.set(m.id, m);
    this.save();
    emit({ type: 'machine', machine: m });
  }

  removeMachine(id: string) {
    this.machines.delete(id);
    this.save();
    emit({ type: 'machine_removed', id });
  }

  /** Persist an event whose seq was assigned elsewhere (a machine daemon). A seq already on file is ignored. */
  appendFull(sessionId: string, e: TranscriptEvent) {
    const last = this.seqs.get(sessionId) ?? this.lastSeq(sessionId);
    if (e.seq <= last) return;
    fs.appendFileSync(this.transcriptPath(sessionId), JSON.stringify(e) + '\n');
    this.seqs.set(sessionId, e.seq);
    emit({ type: 'transcript', sessionId, event: e });
  }

  lastSeq(sessionId: string): number {
    const n = this.seqs.get(sessionId);
    if (n !== undefined) return n;
    return this.readTranscript(sessionId, 1)[0]?.seq ?? 0;
  }

  append(sessionId: string, e: DistributiveOmit<TranscriptEvent, 'seq' | 't'>): TranscriptEvent {
    const seq = this.nextSeq(sessionId);
    const full = { ...e, seq, t: new Date().toISOString() } as TranscriptEvent;
    fs.appendFileSync(this.transcriptPath(sessionId), JSON.stringify(full) + '\n');
    emit({ type: 'transcript', sessionId, event: full });
    return full;
  }

  /** Rewrite one already-persisted event (used to record a permission decision). */
  amend(sessionId: string, seq: number, patch: Partial<TranscriptEvent>) {
    const all = this.readTranscript(sessionId);
    const i = all.findIndex((e) => e.seq === seq);
    if (i < 0) return;
    all[i] = { ...all[i], ...patch } as TranscriptEvent;
    fs.writeFileSync(this.transcriptPath(sessionId), all.map((e) => JSON.stringify(e)).join('\n') + '\n');
    emit({ type: 'transcript', sessionId, event: all[i] });
  }

  readTranscript(sessionId: string, limit?: number): TranscriptEvent[] {
    const f = this.transcriptPath(sessionId);
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const out: TranscriptEvent[] = [];
    for (const line of limit ? lines.slice(-limit) : lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn last line after a crash; skip it
      }
    }
    return out;
  }

  deleteTranscript(sessionId: string) {
    fs.rmSync(this.transcriptPath(sessionId), { force: true });
    fs.rmSync(path.join(this.uploadDir, safeId(sessionId)), { recursive: true, force: true });
  }

  /** Keep an image with a session (sent by the user, or returned by a tool); returns its id. */
  saveImage(sessionId: string, mediaType: string, data: string, id: string = randomUUID()): string {
    const ext = IMAGE_EXT[mediaType];
    if (!ext) throw new Error(`unsupported image type ${mediaType}`);
    const dir = path.join(this.uploadDir, safeId(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${safeId(id)}.${ext}`), Buffer.from(data, 'base64'));
    return id;
  }

  /** The file behind an ImageRef, or undefined. */
  imagePath(sessionId: string, id: string): string | undefined {
    const dir = path.join(this.uploadDir, safeId(sessionId));
    for (const ext of Object.values(IMAGE_EXT)) {
      const f = path.join(dir, `${safeId(id)}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }

  /** Where the transcripts are (for search). */
  get transcriptsDir() {
    return this.transcriptDir;
  }

  /** Events from `seq` on (to show an older search hit in context). */
  readTranscriptFrom(sessionId: string, seq: number): TranscriptEvent[] {
    return this.readTranscript(sessionId).filter((e) => e.seq >= seq);
  }

  private transcriptPath(id: string) {
    return path.join(this.transcriptDir, `${id}.jsonl`);
  }

  private nextSeq(sessionId: string) {
    let n = this.seqs.get(sessionId);
    if (n === undefined) {
      const last = this.readTranscript(sessionId, 1)[0];
      n = last ? last.seq : 0;
    }
    this.seqs.set(sessionId, n + 1);
    return n + 1;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this.saveTimer);
    const p: Persisted = {
      sandboxes: [...this.sandboxes.values()],
      sessions: [...this.sessions.values()],
      orchestratorId: this.orchestratorId,
      standingAgents: [...this.standing.values()],
      delegations: [...this.delegations.values()],
      machines: [...this.machines.values()],
      settings: this.settings,
    };
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Windows can refuse the rename while an indexer or antivirus holds the file; retry shortly.
      console.warn('state save failed, retrying:', (e as Error).message);
      this.save();
    }
  }
}

export const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Ids become file names: keep them to [\w-]. */
const safeId = (id: string) => id.replace(/[^\w-]/g, '_');

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
