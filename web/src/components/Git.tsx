import { useState } from 'react';
import type { GitStatus } from '../../../shared/types';
import { api } from '../api';
import { toast, toastError } from '../store';
import { fmtRelative, useNow } from '../util';
import { CopyButton, Icon, Modal } from './ui';

/** "3 changed · 1 untracked · ↑2 ↓5", or "clean". */
export function gitSummary(g: GitStatus): string {
  const parts = [g.dirty || g.untracked ? [g.dirty ? `${g.dirty} changed` : '', g.untracked ? `${g.untracked} untracked` : ''].filter(Boolean).join(' · ') : 'clean'];
  if (g.ahead) parts.push(`↑${g.ahead}`);
  if (g.behind) parts.push(`↓${g.behind}`);
  return parts.join(' · ');
}

/** The real git state of a sandbox or machine: branch now, changes, ahead/behind, last commit, open PR. */
export function GitFacts({ git }: { git?: GitStatus }) {
  const now = useNow(30000);
  if (!git) {
    return (
      <span className="fact mono">
        <Icon name="branch" size={13} /> <span className="dim">git status not read yet</span>
      </span>
    );
  }
  return (
    <>
      <span className="fact mono">
        <Icon name="branch" size={13} /> <span className="ellipsis git-branch">{git.branch}</span>
        <CopyButton text={git.branch} label="Copy branch" />
        <span className={`git-extra ${git.dirty || git.untracked ? 'tone-amber' : 'dim'}`}>
          · {[gitSummary(git), git.upstream ? '' : 'not pushed'].filter(Boolean).join(' · ')}
        </span>
      </span>
      {(git.head || git.pr) && (
        <span className="fact">
          <Icon name="log" size={13} />
          {git.head && (
            <span className="ellipsis dim" title={`${git.head.sha} ${git.head.subject}`}>
              <span className="mono">{git.head.sha}</span> {git.head.subject}
              {git.head.date ? ` · ${fmtRelative(git.head.date, now)}` : ''}
            </span>
          )}
          {git.pr && (
            <a className="pr-link" href={git.pr.url} target="_blank" rel="noreferrer" title={git.pr.title}>
              PR #{git.pr.number}
              {git.pr.draft ? ' (draft)' : ''}
            </a>
          )}
        </span>
      )}
    </>
  );
}

/** Switch a sandbox's or machine's branch (the switch_branch tool): the server refuses, with a reason, when it is not safe. */
export function SwitchBranchModal({ target, name, git, onClose }: { target: { sandbox: string } | { machine: string }; name: string; git?: GitStatus; onClose: () => void }) {
  const [branch, setBranch] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!branch.trim() || busy) return;
    setBusy(true);
    try {
      toast((await api.switchBranch(target, branch.trim(), from.trim() || undefined)).note);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const dirty = !!git && git.dirty > 0;
  return (
    <Modal
      title={
        <>
          Switch <span className="mono accent">{name}</span> to another branch
        </>
      }
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!branch.trim() || busy || dirty} onClick={submit}>
            {busy ? 'Switching…' : 'Switch'}
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
        {git && (
          <p className={`small ${dirty ? 'tone-amber' : 'dim'}`}>
            Now on <span className="mono">{git.branch}</span>: {gitSummary(git)}.
            {dirty ? ' Commit or put those changes aside first; the switch is refused while there are any.' : ''}
          </p>
        )}
        <label className="field">
          <span>Branch</span>
          <input className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="098-belt-splitters" autoFocus />
        </label>
        <label className="field">
          <span>Create it from, if it is new</span>
          <input className="input mono" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="origin/develop" />
        </label>
        <p className="dim small">
          Unpushed commits on the current branch are pushed first. An existing branch is checked out (and fast-forwarded if it only lags origin); one that
          only exists on origin is tracked. A running editor is refreshed and recompiled. Refused while an agent there is mid-turn.
        </p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
