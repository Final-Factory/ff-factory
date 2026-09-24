// What a sandbox or machine is called on screen. Its id (the folder, Unity project and Library name)
// is historical and reads like a task, so the label (what it is doing now) is the name; the id is only
// the slot it lives in.

/** A label that means "free": empty or "unused". */
export function isUnused(purpose: string | undefined): boolean {
  const p = (purpose ?? '').trim().toLowerCase();
  return !p || p === 'unused';
}

/** The name to show: the label, or "Unused". */
export function displayName(x: { purpose?: string }): string {
  return isUnused(x.purpose) ? 'Unused' : x.purpose!.trim();
}

/** "Belt splitter fix (slot agent-mcp)": for one-line texts such as notifications and tool output. */
export function nameWithSlot(x: { id: string; purpose?: string }): string {
  return `${displayName(x)} (slot ${x.id})`;
}
