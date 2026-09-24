/** One-line human summary of a tool call's input, for the collapsed tool row. */

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function shortPath(p: string): string {
  // Worktree paths are long; keep the tail that identifies the file.
  const norm = p.replace(/\\/g, '/');
  const i = norm.indexOf('/Assets/');
  if (i >= 0) return norm.slice(i + 1);
  const parts = norm.split('/');
  return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : norm;
}

export function toolDisplayName(name: string): { server?: string; tool: string } {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (m) return { server: m[1], tool: m[2] };
  return { tool: name };
}

/** A tool's name for people: "list sandboxes" for mcp__sandboxes__list_sandboxes, "Read" for Read. */
export function toolLabel(name: string): string {
  const { server, tool } = toolDisplayName(name);
  return server ? tool.replace(/_/g, ' ') : tool;
}

/** "Edit ×2, refresh unity, read console": the tools a run of calls used, in order, repeats counted. */
export function toolsSummary(names: string[], max = 4): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(toolLabel(n), (counts.get(toolLabel(n)) ?? 0) + 1);
  const parts = [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
  return parts.length > max ? `${parts.slice(0, max).join(', ')}, …` : parts.join(', ');
}

export function summarizeToolInput(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'Bash':
      return oneLine(str(o.command) ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = str(o.file_path) ?? str(o.notebook_path) ?? '';
      return shortPath(p);
    }
    case 'Grep':
      return oneLine(`${str(o.pattern) ?? ''}${o.path ? `  in ${shortPath(String(o.path))}` : ''}${o.glob ? `  (${o.glob})` : ''}`);
    case 'Glob':
      return oneLine(`${str(o.pattern) ?? ''}${o.path ? `  in ${shortPath(String(o.path))}` : ''}`);
    case 'WebFetch':
      return oneLine(str(o.url) ?? '');
    case 'WebSearch':
      return oneLine(str(o.query) ?? '');
    case 'Task':
    case 'Agent':
      return oneLine(str(o.description) ?? str(o.prompt) ?? '');
    case 'TodoWrite':
      return Array.isArray(o.todos) ? `${o.todos.length} todo${o.todos.length === 1 ? '' : 's'}` : '';
    case 'Skill':
      return oneLine(str(o.skill) ?? str(o.command) ?? '');
  }
  if (name.startsWith('mcp__sandboxes__') || name.startsWith('mcp__')) {
    const pairs = Object.entries(o)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? oneLine(v, 60) : String(v)}`);
    return oneLine(pairs.join('  '));
  }
  const firstStr = Object.values(o).find((v) => typeof v === 'string') as string | undefined;
  return firstStr ? oneLine(firstStr) : '';
}

export function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}
