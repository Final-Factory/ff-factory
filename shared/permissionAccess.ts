// Who may answer a worker's pending permission request (w891, docs/orchestrators.md "Owners answer each other's workers'
// permission requests"). One rule for the server's answer route and for the pages that show the Allow and Deny buttons.
import type { Requester, UserRole } from './types.ts';

export type PermissionAccess =
  /** The worker works for them (their request is on it, or they started it). */
  | 'own'
  /** Another person's worker, answered by the owner role (w677: owners act on each other's work). */
  | 'owner';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * How `me` may answer a permission request of this worker, or undefined when they may not: a worker's own people always
 * (`audience`: the people its open requests are for, else whoever started it), and anyone with the owner role for any
 * worker, whoever's it is. A member answers only workers they work for.
 */
export function permissionAccess(me: { userId: string; role: UserRole | undefined }, worker: { requestedBy?: Requester }, audience: readonly Pick<Requester, 'userId'>[]): PermissionAccess | undefined {
  if (audience.some((r) => same(r.userId, me.userId)) || (worker.requestedBy && same(worker.requestedBy.userId, me.userId))) return 'own';
  return me.role === 'owner' ? 'owner' : undefined;
}

/** The first line of a tool call for a notice: a shell command's own text, else the tool and its input, short. */
export function permissionWhat(toolName: string, input: unknown): string {
  const flat = (s: string, max: number) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const cmd = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined;
  if (typeof cmd === 'string' && cmd.trim()) return flat(cmd, 160);
  const rest = input === undefined || input === null ? '' : flat(JSON.stringify(input), 160);
  return rest ? `${toolName} ${rest}` : toolName;
}
