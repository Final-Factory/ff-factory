// A sandbox editor's MCP for Unity instance name, "<project folder>@<hash>" (w1478). The bridge names an editor by its
// project folder and the first 8 hex of sha1(Application.dataPath), the project's Assets folder with forward slashes:
// the editor's ~/.unity-mcp/unity-mcp-status-<hash>.json (measured on beast 2026-10-18: F:/ffw/sandboxes/slot1..5/Assets
// hash to the port files of slot1..5's editors, and four status files' project_path match). Giving a worker the name
// saves the mcpforunity://instances read before every pin: 339 such reads in 81 beast worker sessions (2026-10-15..18).
import { createHash } from 'node:crypto';

export function unityInstanceName(worktree: string): string {
  const fwd = worktree.replace(/\\/g, '/').replace(/\/+$/, '');
  const hash = createHash('sha1').update(`${fwd}/Assets`).digest('hex').slice(0, 8);
  return `${fwd.slice(fwd.lastIndexOf('/') + 1)}@${hash}`;
}
