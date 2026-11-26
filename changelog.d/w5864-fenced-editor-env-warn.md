- **A fenced (Low) Windows sandbox editor's environment is checked, warn-only** (w5864): each start logs which of the
  daemon's variables the minimal environment (`machine/editorEnv.ts`, Windows' own, the root's folders, the bridge's and
  editor scripts' switches) would leave out, credential-like names named apart, names only. The editor still starts with
  the whole environment; enforcing it, with a fallback to the whole one, is a later pull request (docs/worker-root.md).
