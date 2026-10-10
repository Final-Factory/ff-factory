// Who may answer a worker's pending permission request (w891, docs/orchestrators.md "Owners answer each other's workers'
// permission requests"). One rule for the server's answer route and for the pages that show the Allow and Deny buttons.
import type { Requester, UserRole } from './types.ts';

export type PermissionAccess =
  /** The worker works for them (their request is on it, or they started it). */
  | 'own'
  /** Another person's worker, answered by the owner role (w677: owners act on each other's work). */
  | 'owner'
  /** Another person's worker, answered by a member: allowed as it always was (w891 changes nothing for members). */
  | 'other';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * How `me` answers a permission request of this worker. Anyone signed in may (the rule before w891 stays for members); this
 * says whose work it is, so the answer is recorded and its people told: their own worker ('own'), another person's answered
 * by an owner ('owner'), or by a member ('other'). `audience`: the people its open requests are for, else whoever started it.
 */
export function permissionAccess(me: { userId: string; role: UserRole | undefined }, worker: { requestedBy?: Requester }, audience: readonly Pick<Requester, 'userId'>[]): PermissionAccess {
  if (audience.some((r) => same(r.userId, me.userId)) || (worker.requestedBy && same(worker.requestedBy.userId, me.userId))) return 'own';
  return me.role === 'owner' ? 'owner' : 'other';
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
