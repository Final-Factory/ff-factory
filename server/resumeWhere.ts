/**
 * What stop_agent and message_agent say about where a machine worker resumes (w4608), as plain text, so nobody reports a
 * move that did not happen. 5d876a0b (w4591) was stopped and messaged at 17:33Z on 2026-11-17 to move it out of
 * lothdesktop/slot2; its sandbox was never released (w4397's agent was there), its turn ran in slot2 again, and the
 * replies said only "Stopped." and "Sent". A move counts only once the worker is recorded in the new sandbox; one under
 * way says so, and where the worker still is.
 */

/** Where a worker messaged between turns was, read before the send places it. */
export interface BeforeSend {
  /** Its sandbox id. */
  sandbox?: string;
  /** It had released that sandbox (placeReleased). */
  released: boolean;
  /** Why its sandbox stays its (PlaceAgain.stayWhy), or undefined. */
  stay?: string;
}

/** Where it is after the send. */
export interface AfterSend {
  machine: string;
  sandbox?: string;
  /** The sandbox's folder, by sandbox id. */
  pathOf: (sandbox?: string) => string | undefined;
  /** It still waits to be placed again (placeReleased). */
  released: boolean;
  /** The sandbox it is being moved into right now (PlaceAgain.placingOf). */
  placing?: { machine: string; sandbox: string };
}

/** message_agent's line on where the worker resumes; '' when it has no sandbox. */
export function resumeWhereLine(before: BeforeSend, after: AfterSend): string {
  if (!before.sandbox) return '';
  const at = (sb?: string) => {
    const p = after.pathOf(sb);
    return `${after.machine}/${sb}${p ? ` (${p})` : ''}`;
  };
  if (after.placing) return ` Not moved yet: it is being placed again in ${after.placing.machine}/${after.placing.sandbox}, and is still recorded in ${at(after.sandbox)}; its turn starts only once the move is done, and its log says "Placed again …" (or why the move failed).`;
  if (after.released) return ` Not moved yet: it released ${at(before.sandbox)} and waits to be placed again (above: why).`;
  if (after.sandbox !== before.sandbox) return ` Where: it now runs in ${at(after.sandbox)} (it was in ${after.machine}/${before.sandbox}).`;
  if (before.released) return ` Where: back in its own sandbox ${at(after.sandbox)}.`;
  return ` Where: it resumes in ${at(after.sandbox)}, the sandbox it was in, NOT another: that sandbox was never released (${before.stay ?? 'its release had not run yet'}). Stopping a worker moves it only once its sandbox is released (list_sandboxes shows it); to move work now, start it in a free sandbox.`;
}

/** stop_agent's line on where the stopped worker resumes: its sandbox is released, or why not yet; '' with no sandbox. */
export function stopWhereLine(machine: string | undefined, sandbox: string | undefined, released: boolean, stay: string | undefined): string {
  if (!machine || !sandbox) return '';
  const where = `${machine}/${sandbox}`;
  if (released) return ` It had released ${where}; a message places it again.`;
  return stay
    ? ` Its sandbox ${where} is not released: ${stay}. A message before it is released resumes it in ${where}, not in another sandbox.`
    : ` Its sandbox ${where} is released by the next release pass (about a minute); a message after that places it again (its own sandbox if still free, else another free one on ${machine}), a message before resumes it in ${where}.`;
}
