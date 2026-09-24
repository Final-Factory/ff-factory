import { useRef, useState } from 'react';
import { EFFORT_LEVELS, type AppState, type EffortLevel, type PermissionMode } from '../../../shared/types';
import { api } from '../api';
import { attempt, upsertSandbox, upsertSession } from '../store';
import { FREE_TEXT, navigate, PERMISSION_MODES } from '../util';
import { useTextareaDictation } from '../voice/useTextareaDictation';
import { DictationBar, MicButton } from './Mic';
import { Modal } from './ui';

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function NewSandboxModal({ app, onClose }: { app: AppState; onClose: () => void }) {
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [purpose, setPurpose] = useState('');
  const [seedLibrary, setSeedLibrary] = useState(true);
  const [startUnity, setStartUnity] = useState(false);
  const [busy, setBusy] = useState(false);

  const slug = slugify(name);
  const valid = slug.length > 0;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const sb = await attempt(
      api.createSandbox({
        name: slug,
        branch: branch.trim() || undefined,
        base: base.trim() || undefined,
        purpose: purpose.trim() || undefined,
        seedLibrary,
        startUnity,
      }),
    );
    setBusy(false);
    if (sb) {
      upsertSandbox(sb);
      navigate({ view: 'sandbox', sandboxId: sb.id });
      onClose();
    }
  };

  return (
    <Modal
      title="New sandbox"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create sandbox'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="shader-work" autoFocus />
          {name && slug !== name && <small className="mono dim">will be “{slug}”</small>}
        </label>
        <div className="field-row">
          <label className="field">
            <span>Branch</span>
            <input className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={`sandbox/${slug || '<name>'}`} />
          </label>
          <label className="field">
            <span>Base</span>
            <input className="input mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder={app.config.defaultBase} />
          </label>
        </div>
        <label className="field">
          <span>Purpose</span>
          <textarea className="input" rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="spec 098, VFX pass, …" />
        </label>
        <label className="check">
          <input type="checkbox" checked={seedLibrary} onChange={(e) => setSeedLibrary(e.target.checked)} />
          <span>
            Seed Library <small className="dim">copy the warm Library so Unity opens fast</small>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={startUnity} onChange={(e) => setStartUnity(e.target.checked)} />
          <span>Start Unity when ready</span>
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Where a new worker runs: a sandbox, or a machine (docs/machines.md). */
export type AgentTarget = { sandboxId: string; name: string } | { machineId: string; name: string };

export function NewAgentModal({ app, target, onClose }: { app: AppState; target: AgentTarget; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const voice = useTextareaDictation({ value: prompt, setValue: setPrompt, ref: promptRef });
  const [title, setTitle] = useState('');
  const [model, setModel] = useState(app.config.defaultModel);
  const [mode, setMode] = useState<PermissionMode | ''>('');
  const [effort, setEffort] = useState<EffortLevel | ''>('');
  const [busy, setBusy] = useState(false);
  const valid = prompt.trim().length > 0;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const s = await attempt(
      api.startSession({
        ...('machineId' in target ? { machineId: target.machineId } : { sandboxId: target.sandboxId }),
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        model: model || undefined,
        permissionMode: mode || undefined,
        effort: effort || undefined,
      }),
    );
    setBusy(false);
    if (s) {
      upsertSession(s);
      navigate('machineId' in target ? { view: 'machine', machineId: target.machineId, sessionId: s.id } : { view: 'sandbox', sandboxId: target.sandboxId, sessionId: s.id });
      onClose();
    }
  };

  const models = app.config.models.includes(app.config.defaultModel) ? app.config.models : [app.config.defaultModel, ...app.config.models];

  return (
    <Modal
      title={
        <>
          New agent {'machineId' in target ? 'on' : 'in'} <span className="accent">{target.name}</span>
        </>
      }
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Starting…' : 'Start agent'}
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>Prompt</span>
          <span className="dictate-wrap">
            <textarea
              ref={promptRef}
              {...FREE_TEXT}
              className="input"
              rows={6}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              {...voice.textareaProps}
              onKeyDown={(e) => {
                if (voice.keyDown(e)) return;
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
              }}
              placeholder="What should this agent do? (Ctrl/Cmd+Enter to start)"
              autoFocus
            />
            <MicButton d={voice.d} className="dictate-mic" />
          </span>
          <DictationBar d={voice.d} />
        </label>
        <label className="field">
          <span>Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Derived from the prompt if blank" />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Model</span>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === app.config.defaultModel ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Permission mode</span>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode | '')}>
              <option value="">Server default</option>
              {PERMISSION_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label} — {m.hint}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Effort</span>
          <select className="input" value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel | '')}>
            <option value="">Server default</option>
            {EFFORT_LEVELS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <small className="dim">How hard the model thinks (the Agent SDK's effort). xhigh and max cost more and take longer.</small>
        </label>
      </div>
    </Modal>
  );
}
