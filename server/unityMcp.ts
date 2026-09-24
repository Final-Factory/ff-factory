import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Config } from './config.ts';

/** The scenes open in an editor, as `sceneState` reads them. */
export interface SceneState {
  playing: boolean;
  /** Open scenes with unsaved edits ("(untitled)" for one never saved). */
  dirty: string[];
  /** Loaded scenes that have a file, in hierarchy order. */
  scenes: string[];
  active: string;
}

/** A pinned connection to one sandbox's editor through the MCP-for-Unity server (config unity.mcpServer). */
export interface UnityBridge {
  sceneState(): Promise<SceneState>;
  /** Replace the open scenes with an empty untitled one, so a branch switch changes no open scene file. */
  parkScenes(): Promise<void>;
  /** Open these scenes again (the first single, the rest additive); returns the ones that no longer exist. */
  reopenScenes(scenes: string[], active: string): Promise<string[]>;
  /** Refresh assets and recompile; with `wait`, resolves once the editor reports ready. */
  refresh(wait: boolean): Promise<void>;
  close(): Promise<void>;
}

const deadline = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

/** The "FFSB|k=v|k=v" line our execute_code snippets return, wherever the tool's JSON wrapping puts it. */
export function parseMarker(text: string): Record<string, string> | undefined {
  // Stops at a quote or a backslash: the result may be JSON inside JSON. Unity asset paths use "/".
  const m = /FFSB\|([^"\\\n\r]*)/.exec(text);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const part of m[1].split('|')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const list = (v: string | undefined) => (v ? v.split(';').filter(Boolean) : []);

/** C# for execute_code: C# 6, fully qualified (the snippet runs as a method body). */
export const SCENE_STATE_CS = `
var dirty = new System.Collections.Generic.List<string>();
var scenes = new System.Collections.Generic.List<string>();
for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++) {
  var s = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);
  if (s.isDirty) dirty.Add(string.IsNullOrEmpty(s.path) ? "(untitled)" : s.path);
  if (s.isLoaded && !string.IsNullOrEmpty(s.path)) scenes.Add(s.path);
}
return "FFSB|playing=" + (UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode ? "1" : "0")
  + "|dirty=" + string.Join(";", dirty.ToArray()) + "|scenes=" + string.Join(";", scenes.ToArray())
  + "|active=" + UnityEngine.SceneManagement.SceneManager.GetActiveScene().path;
`;

export const PARK_CS = `
UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
return "FFSB|parked=1";
`;

/** Scene paths go into C# string literals: JSON's escapes are valid C#. */
export function reopenCs(scenes: string[], active: string): string {
  return `
var paths = new string[] { ${scenes.map((p) => JSON.stringify(p)).join(', ')} };
var missing = new System.Collections.Generic.List<string>();
bool first = true;
foreach (var p in paths) {
  if (UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEditor.SceneAsset>(p) == null) { missing.Add(p); continue; }
  UnityEditor.SceneManagement.EditorSceneManager.OpenScene(p, first ? UnityEditor.SceneManagement.OpenSceneMode.Single : UnityEditor.SceneManagement.OpenSceneMode.Additive);
  first = false;
}
var act = UnityEngine.SceneManagement.SceneManager.GetSceneByPath(${JSON.stringify(active)});
if (act.IsValid() && act.isLoaded) UnityEngine.SceneManagement.SceneManager.SetActiveScene(act);
return "FFSB|missing=" + string.Join(";", missing.ToArray());
`;
}

/**
 * Connect to a sandbox's running editor, pinned to its instance ("<id>@<hash>"). The same MCP server
 * the workers use; switch_branch uses it to keep Unity's "modified externally" dialog from appearing.
 */
export async function openUnity(cfg: Config, sandboxId: string, cwd: string): Promise<UnityBridge> {
  const srv = cfg.unity.mcpServer;
  if (!srv) throw new Error('no unity.mcpServer in config.json');
  const transport = new StdioClientTransport({ command: srv.command, args: srv.args, env: { ...(process.env as Record<string, string>), ...srv.env }, cwd, stderr: 'ignore' });
  const client = new Client({ name: 'ff-factory', version: '1.0.0' });
  try {
    await deadline(client.connect(transport), 120_000, 'starting the Unity MCP server');
    const res = await deadline(client.readResource({ uri: 'mcpforunity://instances' }), 60_000, 'listing Unity instances');
    const text = res.contents.map((c) => ('text' in c ? c.text : '')).join('\n');
    const escaped = sandboxId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const instance = new RegExp(`${escaped}@[0-9a-f]+`, 'i').exec(text)?.[0];
    if (!instance) throw new Error(`no Unity instance named ${sandboxId}@… is connected`);
    await deadline(client.callTool({ name: 'set_active_instance', arguments: { instance } }), 60_000, 'pinning the editor');
  } catch (e) {
    await client.close().catch(() => undefined);
    throw e;
  }

  const call = async (name: string, args: Record<string, unknown>, timeoutMs: number) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const out = JSON.stringify(r.content);
    if (r.isError) throw new Error(`${name}: ${out.slice(0, 300)}`);
    return out;
  };
  const exec = async (code: string) => {
    const out = await call('execute_code', { action: 'execute', code, safety_checks: true }, 120_000);
    const m = parseMarker(out);
    if (!m) throw new Error(`execute_code gave no result: ${out.slice(0, 300)}`);
    return m;
  };

  return {
    async sceneState() {
      const m = await exec(SCENE_STATE_CS);
      return { playing: m.playing === '1', dirty: list(m.dirty), scenes: list(m.scenes), active: m.active ?? '' };
    },
    async parkScenes() {
      await exec(PARK_CS);
    },
    async reopenScenes(scenes, active) {
      return list((await exec(reopenCs(scenes, active))).missing);
    },
    async refresh(wait) {
      await call('refresh_unity', { mode: 'force', scope: 'all', compile: 'request', wait_for_ready: wait }, 10 * 60_000);
    },
    close: () => client.close().catch(() => undefined),
  };
}
