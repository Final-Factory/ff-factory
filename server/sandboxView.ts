// The view of a machine sandbox as a host-style Sandbox record, for code that lists sandboxes by name.
import type { MachineSandbox, Sandbox } from '../shared/types.ts';

/** A sandbox of this host's own daemon as a host-style record, `id` "beast/x" (the standing agents' and the clean-up's view). */
export function hostSandboxFrom(msb: MachineSandbox, id = msb.id): Sandbox {
  const up = msb.unity.state === 'running' || msb.unity.state === 'starting';
  return {
    id,
    name: msb.id,
    branch: msb.git?.branch && msb.git.branch !== 'detached HEAD' ? msb.git.branch : msb.branch,
    base: msb.base,
    path: msb.path,
    purpose: msb.purpose,
    status: msb.status,
    ...(msb.statusDetail ? { statusDetail: msb.statusDetail } : {}),
    createdAt: msb.createdAt,
    unity: { state: up && msb.unity.pid ? msb.unity.state : msb.unity.state === 'crashed' ? 'crashed' : 'stopped', ...(up && msb.unity.pid ? { pid: msb.unity.pid } : {}), ...(msb.unity.logPath ? { logPath: msb.unity.logPath } : {}) },
    sessionIds: [...msb.sessionIds],
    ...(msb.git ? { git: msb.git } : {}),
  };
}
