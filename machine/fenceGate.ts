/**
 * The worker fence fails closed (w5555, lothsahn: "File it: the fence fails closed, with a portal alert").
 *
 * When daemon.json turns this OS's worker write fence on (`workerFence: "seatbelt"` on macOS, `writeLock: true` on Linux,
 * `workerIntegrity: "low"` on Windows; docs/worker-root.md, "Turning a fence off"), no sandbox worker starts outside it:
 * - while the fence is still being set up (Windows labels the root's folders Low in the background), a start waits;
 * - when its probe fails (machine/fenceProbe.ts), sandbox worker starts on this machine are refused with the probe's error,
 *   the portal shows an alert naming the machine and that error, and placement sees the machine as busy;
 * - only when the key is absent (`worker_fence off`, the emergency switch, or a machine never fenced) do workers start
 *   unfenced, as before the fence.
 *
 * Agents without a sandbox (standing agents) are not fenced and never wait here: they run at the daemon's own level on
 * purpose (docs/worker-root.md, "Who runs outside the fence").
 */
import type { WorkerFenceReport } from '../shared/types.ts';

export type { WorkerFenceReport };

/** The fence each OS has, and the daemon.json key that turns it on (scripts/worker/worker.ts workerFenceSetting). */
export function fenceKindFor(platform: NodeJS.Platform): WorkerFenceReport['kind'] | undefined {
  if (platform === 'darwin') return 'seatbelt';
  if (platform === 'linux') return 'landlock';
  if (platform === 'win32') return 'low';
  return undefined;
}

/** Whether daemon.json turns this OS's fence on. A key meant for another OS turns nothing on here. */
export function fenceWanted(cfg: { workerFence?: string; writeLock?: boolean; workerIntegrity?: string }, platform: NodeJS.Platform): boolean {
  if (platform === 'darwin') return cfg.workerFence === 'seatbelt';
  if (platform === 'linux') return cfg.writeLock === true;
  if (platform === 'win32') return cfg.workerIntegrity === 'low';
  return false;
}

/** What a sandbox worker's start does now: go, wait for the fence's setup, or be refused with a reason. */
export type FenceStartGate = { go: true } | { wait: Promise<void> } | { refuse: string };

/**
 * The fence's state on this machine and the gate a sandbox worker's start passes. Starts `setting_up` when the fence is
 * wanted (the daemon then calls `on()` or `failed(why)` once its setup and probe end), `off` when it is not.
 */
export class FenceGate {
  private report: WorkerFenceReport;
  private readonly done: Promise<void>;
  private settle!: () => void;
  private readonly changed: (r: WorkerFenceReport) => void;

  constructor(o: { wanted: boolean; kind?: WorkerFenceReport['kind']; machine?: string; changed?: (r: WorkerFenceReport) => void; now?: () => Date }) {
    this.changed = o.changed ?? (() => undefined);
    this.now = o.now ?? (() => new Date());
    this.machine = o.machine;
    this.done = new Promise<void>((r) => (this.settle = r));
    this.report = { state: o.wanted ? 'setting_up' : 'off', ...(o.kind ? { kind: o.kind } : {}), since: this.now().toISOString() };
    if (!o.wanted) this.settle();
  }

  private readonly now: () => Date;
  private readonly machine?: string;

  get state(): WorkerFenceReport {
    return { ...this.report };
  }

  /** The fence's setup and probe passed: sandbox workers start inside it. */
  on(): void {
    this.set({ state: 'on' });
  }

  /** The fence's setup or probe failed: sandbox workers are held (refused) until it is fixed or switched off. */
  failed(why: string): void {
    this.set({ state: 'failed', why: why.slice(0, 600) });
  }

  private set(r: Pick<WorkerFenceReport, 'state' | 'why'>): void {
    if (this.report.state !== 'setting_up') return; // decided once per daemon start: a restart probes again
    this.report = { ...r, ...(this.report.kind ? { kind: this.report.kind } : {}), since: this.now().toISOString() };
    this.settle();
    this.changed(this.state);
  }

  /** Resolves once the fence is decided (on, failed or off). */
  get decided(): Promise<void> {
    return this.done;
  }

  /** The gate for a start of an agent in a sandbox (`sandbox` true) or outside one (standing agents: always go). */
  startGate(sandbox: boolean): FenceStartGate {
    if (!sandbox) return { go: true };
    const s = this.report.state;
    if (s === 'on' || s === 'off') return { go: true };
    if (s === 'setting_up') return { wait: this.done };
    return { refuse: fenceRefusal(this.machine, this.report.why) };
  }

  /** Whether a sandbox agent may be given this run spec now: true only when the fence is on or off on purpose. */
  allowsSandboxRun(): boolean {
    return this.report.state === 'on' || this.report.state === 'off';
  }
}

/** The refusal a sandbox worker's start gets on a machine whose fence failed (w5555). */
export function fenceRefusal(machine: string | undefined, why: string | undefined): string {
  return `the worker fence on ${machine ?? 'this machine'} failed (${why ?? 'no reason given'}): sandbox workers there are held so none starts unfenced (w5555). Fix the fence (its daemon log says why; a daemon restart probes again) or switch it off on purpose with ops_worker machine_update worker_fence off.`;
}
