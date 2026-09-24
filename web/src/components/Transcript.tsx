import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PendingPermission, SessionInfo, TranscriptEvent } from '../../../shared/types';
import { api } from '../api';
import { attempt, clearFocusEvent, focusPermission, useStore } from '../store';
import { fmtClock, fmtCost, fmtDuration } from '../util';
import { Markdown } from './Markdown';
import { ImageStrip, MentionedImages, uploadUrl } from './Images';
import { prettyJson, summarizeToolInput, toolDisplayName } from './toolSummary';
import { Icon } from './ui';

type ToolUse = Extract<TranscriptEvent, { kind: 'tool_use' }>;
type ToolResult = Extract<TranscriptEvent, { kind: 'tool_result' }>;
type PermissionEv = Extract<TranscriptEvent, { kind: 'permission' }>;

type Item =
  | { type: 'event'; ev: TranscriptEvent }
  | { type: 'tool'; use: ToolUse; result?: ToolResult };

function buildItems(events: TranscriptEvent[]): Item[] {
  const results = new Map<string, ToolResult>();
  const uses = new Set<string>();
  for (const e of events) {
    if (e.kind === 'tool_result') results.set(e.toolUseId, e);
    else if (e.kind === 'tool_use') uses.add(e.toolUseId);
  }
  const items: Item[] = [];
  for (const e of events) {
    if (e.kind === 'tool_use') items.push({ type: 'tool', use: e, result: results.get(e.toolUseId) });
    else if (e.kind === 'tool_result') {
      // Folded into its tool_use row; only orphans (history trimmed by limit) render alone.
      if (!uses.has(e.toolUseId)) items.push({ type: 'event', ev: e });
    } else items.push({ type: 'event', ev: e });
  }
  return items;
}

export function Transcript({
  session,
  size = 'normal',
  empty,
}: {
  session: SessionInfo;
  size?: 'normal' | 'large';
  empty?: ReactNode;
}) {
  const events = useStore((s) => s.transcripts[session.id]);
  const loaded = useStore((s) => !!s.loaded[session.id]);
  const streaming = useStore((s) => s.streaming[session.id]);
  const focusId = useStore((s) => s.focusRequestId);

  const items = useMemo(() => buildItems(events ?? []), [events]);

  const pendingById = useMemo(() => {
    const m = new Map<string, PendingPermission>();
    for (const p of session.pendingPermissions) m.set(p.requestId, p);
    return m;
  }, [session.pendingPermissions]);

  // Pending requests with no transcript row yet still need a card.
  const orphanPending = useMemo(() => {
    const seen = new Set((events ?? []).filter((e): e is PermissionEv => e.kind === 'permission').map((e) => e.requestId));
    return session.pendingPermissions.filter((p) => !seen.has(p.requestId));
  }, [events, session.pendingPermissions]);

  // ---- auto-scroll ----
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = near;
    if (near) setShowJump(false);
  };

  const scrollToBottom = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottom.current = true;
    setShowJump(false);
  };

  // New session on screen: start at the bottom.
  useLayoutEffect(() => {
    atBottom.current = true;
    scrollToBottom();
  }, [session.id]);

  useLayoutEffect(() => {
    if (atBottom.current) scrollToBottom();
    else setShowJump(true);
  }, [items.length, streaming, orphanPending.length]);

  // Content that grows after layout (markdown, images, expanded rows) keeps us pinned.
  useEffect(() => {
    const el = scroller.current?.firstElementChild;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // "Needs you" jump target.
  useEffect(() => {
    if (!focusId || !pendingById.has(focusId)) return;
    const el = scroller.current?.querySelector(`[data-request-id="${CSS.escape(focusId)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
      focusPermission(null);
    }
  }, [focusId, pendingById, items.length]);

  // A search hit: scroll to that event (or the tool row holding its result) and flash it.
  const focus = useStore((s) => s.focusEvent);
  useEffect(() => {
    if (!focus || focus.sessionId !== session.id) return;
    const wrap = scroller.current?.querySelector(`[data-seq="${focus.seq}"], [data-seq2="${focus.seq}"]`);
    const el = wrap?.firstElementChild as HTMLElement | null | undefined;
    if (!el) return;
    atBottom.current = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
    clearFocusEvent();
  }, [focus, items.length, session.id]);

  const isEmpty = loaded && items.length === 0 && !streaming && orphanPending.length === 0;

  return (
    <div className={`transcript transcript-${size}`}>
      <div className="transcript-scroll" ref={scroller} onScroll={onScroll}>
        <div className="transcript-inner">
          {!loaded && !events && (
            <div className="transcript-loading">
              <span className="spinner" /> Loading transcript…
            </div>
          )}
          {isEmpty && (empty ?? <div className="transcript-empty">No messages yet.</div>)}
          {items.map((it) =>
            it.type === 'tool' ? (
              <div key={it.use.seq} className="tr-item tr-tool" data-seq={it.use.seq} data-seq2={it.result?.seq}>
                <ToolRow use={it.use} result={it.result} sessionId={session.id} />
              </div>
            ) : (
              <div key={it.ev.seq} className="tr-item" data-seq={it.ev.seq}>
                <EventRow ev={it.ev} sessionId={session.id} pending={pendingById} />
              </div>
            ),
          )}
          {orphanPending.map((p) => (
            <PermissionCard
              key={p.requestId}
              sessionId={session.id}
              requestId={p.requestId}
              toolName={p.toolName}
              input={p.input}
              reason={p.reason}
              pending
            />
          ))}
          {streaming && (
            <div className="msg msg-assistant msg-streaming">
              <Markdown text={streaming} />
            </div>
          )}
          {session.status === 'running' && !streaming && <WorkingIndicator detail={session.statusDetail} />}
        </div>
      </div>
      {showJump && (
        <button className="jump-pill" onClick={() => scrollToBottom(true)}>
          Jump to latest <Icon name="chevron" size={12} />
        </button>
      )}
    </div>
  );
}

function WorkingIndicator({ detail }: { detail?: string }) {
  return (
    <div className="working">
      <span className="working-bars">
        <i />
        <i />
        <i />
      </span>
      {detail || 'Working'}
    </div>
  );
}

const EventRow = memo(function EventRow({
  ev,
  sessionId,
  pending,
}: {
  ev: TranscriptEvent;
  sessionId: string;
  pending: Map<string, PendingPermission>;
}) {
  switch (ev.kind) {
    case 'user':
      // Harness notices ([worker update] …) are for the orchestrator; show them folded like thinking.
      if (ev.from === 'system') return <Thinking text={ev.text} label={systemLabel(ev.text)} />;
      return (
        <div className={`msg msg-user from-${ev.from}`}>
          {ev.from !== 'human' && <div className="msg-label">{ev.from === 'orchestrator' ? 'Orchestrator' : 'System'}</div>}
          {ev.images?.length ? <ImageStrip items={ev.images.map((r, i) => ({ src: uploadUrl(sessionId, r), name: `image-${ev.seq}-${i + 1}.${r.mediaType.split('/')[1]}` }))} /> : null}
          {ev.text && <div className="msg-user-text">{ev.text}</div>}
          <time className="msg-time">{fmtClock(ev.t)}</time>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <Markdown text={ev.text} />
          <MentionedImages text={ev.text} place={{ session: sessionId }} />
        </div>
      );
    case 'thinking':
      return <Thinking text={ev.text} />;
    case 'tool_result':
      return (
        <div className={`tool tool-orphan${ev.isError ? ' tool-error' : ''}`}>
          <div className="tool-head static">
            <span className="tool-name">result</span>
            <span className="tool-summary">{ev.text.split('\n')[0]}</span>
          </div>
          {ev.images?.length ? <ResultImages sessionId={sessionId} result={ev} /> : null}
        </div>
      );
    case 'result':
      return (
        <div className={`turn-footer${ev.ok ? '' : ' turn-footer-bad'}`}>
          <span className="rule" />
          <span>
            {ev.ok ? 'Done' : 'Stopped'} · {ev.turns} turn{ev.turns === 1 ? '' : 's'} · {fmtCost(ev.costUsd)} ·{' '}
            {fmtDuration(ev.durationMs)}
          </span>
          <span className="rule" />
        </div>
      );
    case 'system':
      return <div className="sys-line">{ev.text}</div>;
    case 'error':
      return (
        <div className="err-line">
          <strong>Error</strong> {ev.text}
        </div>
      );
    case 'permission': {
      const isPending = !ev.decision && pending.has(ev.requestId);
      const p = pending.get(ev.requestId);
      return (
        <PermissionCard
          sessionId={sessionId}
          requestId={ev.requestId}
          toolName={ev.toolName}
          input={ev.input}
          reason={p?.reason}
          pending={isPending}
          decision={ev.decision}
        />
      );
    }
  }
});

/** The label for a harness notice, by its tag. */
function systemLabel(text: string) {
  if (text.startsWith('[run ')) return 'Run started';
  if (text.startsWith('[standing agent]')) return 'Standing agent';
  if (text.startsWith('[wake_me]')) return 'Wake-up';
  if (text.startsWith('[heartbeat]')) return 'Heartbeat';
  if (/^\[(resumed|restart)/i.test(text)) return 'Restart';
  return 'Worker update';
}

function Thinking({ text, label = 'Thinking' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking${open ? ' open' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={12} /> {label}
        {!open && <span className="thinking-peek">{text.replace(/^\[worker update\]\s*/, '').replace(/\s+/g, ' ').slice(0, 140)}</span>}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

const RESULT_PREVIEW = 1600;

/** Images a tool returned (a screenshot, a Read of a PNG): shown without opening the row. */
function ResultImages({ sessionId, result }: { sessionId: string; result: ToolResult }) {
  return <ImageStrip size="small" items={(result.images ?? []).map((r, i) => ({ src: uploadUrl(sessionId, r), name: `result-${result.seq}-${i + 1}.${r.mediaType.split('/')[1]}` }))} />;
}

const ToolRow = memo(function ToolRow({ use, result, sessionId }: { use: ToolUse; result?: ToolResult; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const { server, tool } = toolDisplayName(use.name);
  const summary = summarizeToolInput(use.name, use.input);
  const state = !result ? 'pending' : result.isError ? 'error' : 'ok';
  const resultText = result?.text ?? '';
  const truncated = resultText.length > RESULT_PREVIEW && !full;

  return (
    <div className={`tool tool-${state}${use.parentToolUseId ? ' tool-nested' : ''}${open ? ' open' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-state" />
        <span className="tool-name">
          {server && <span className="tool-server">{server} · </span>}
          {tool}
        </span>
        <span className="tool-summary">{summary}</span>
        <Icon name="chevron" size={12} />
      </button>
      {result?.images?.length ? <ResultImages sessionId={sessionId} result={result} /> : null}
      {open && (
        <div className="tool-body">
          <ToolInput name={use.name} input={use.input} />
          {result && (
            <div className="tool-result">
              <div className="tool-sub">{result.isError ? 'Error' : 'Result'}</div>
              <pre className="code">{truncated ? resultText.slice(0, RESULT_PREVIEW) + '\n…' : resultText || '(empty)'}</pre>
              {resultText.length > RESULT_PREVIEW && (
                <button className="btn btn-ghost btn-xs" onClick={() => setFull(!full)}>
                  {full ? 'Collapse' : `Show all (${resultText.length.toLocaleString()} chars)`}
                </button>
              )}
            </div>
          )}
          {!result && <div className="tool-sub dim">Waiting for result…</div>}
        </div>
      )}
    </div>
  );
});

function ToolInput({ name, input }: { name: string; input: unknown }) {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name === 'Bash' && typeof o.command === 'string') {
    return (
      <>
        {typeof o.description === 'string' && <div className="tool-sub">{o.description}</div>}
        <pre className="code code-cmd">{o.command}</pre>
      </>
    );
  }
  if (name === 'Edit' && typeof o.old_string === 'string' && typeof o.new_string === 'string') {
    return (
      <>
        <div className="tool-sub mono">{String(o.file_path ?? '')}</div>
        <pre className="code diff">
          {o.old_string.split('\n').map((l, i) => (
            <div key={'o' + i} className="diff-del">
              - {l}
            </div>
          ))}
          {o.new_string.split('\n').map((l, i) => (
            <div key={'n' + i} className="diff-add">
              + {l}
            </div>
          ))}
        </pre>
      </>
    );
  }
  return <pre className="code">{prettyJson(input)}</pre>;
}

function PermissionCard({
  sessionId,
  requestId,
  toolName,
  input,
  reason,
  pending,
  decision,
}: {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  reason?: string;
  pending: boolean;
  decision?: 'allow' | 'deny';
}) {
  const [busy, setBusy] = useState(false);
  const [denyOpen, setDenyOpen] = useState(false);
  const [note, setNote] = useState('');
  const [showInput, setShowInput] = useState(false);
  const { server, tool } = toolDisplayName(toolName);
  const summary = summarizeToolInput(toolName, input);

  const decide = async (allow: boolean, message?: string) => {
    setBusy(true);
    await attempt(api.permission(sessionId, requestId, allow, message));
    setBusy(false);
  };

  const cls = pending ? 'pending' : decision === 'allow' ? 'allowed' : decision === 'deny' ? 'denied' : 'resolved';

  return (
    <div className={`perm perm-${cls}`} data-request-id={requestId}>
      <div className="perm-head">
        <Icon name="bell" size={14} />
        <span className="perm-title">
          {pending ? 'Permission requested' : decision === 'allow' ? 'Allowed' : decision === 'deny' ? 'Denied' : 'Permission request'}
        </span>
        <span className="perm-tool mono">
          {server && <span className="dim">{server} · </span>}
          {tool}
        </span>
      </div>
      {summary && <div className="perm-summary mono">{summary}</div>}
      {reason && <div className="perm-reason">{reason}</div>}
      <button className="link-btn" onClick={() => setShowInput(!showInput)}>
        {showInput ? 'Hide input' : 'Show input'}
      </button>
      {showInput && <ToolInput name={toolName} input={input} />}
      {pending && !denyOpen && (
        <div className="perm-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>
            <Icon name="check" size={14} /> Allow
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => decide(false)}>
            <Icon name="x" size={14} /> Deny
          </button>
          <button className="link-btn" disabled={busy} onClick={() => setDenyOpen(true)}>
            Deny with note…
          </button>
        </div>
      )}
      {pending && denyOpen && (
        <form
          className="perm-deny"
          onSubmit={(e) => {
            e.preventDefault();
            void decide(false, note.trim() || undefined);
          }}
        >
          <input
            autoFocus
            className="input"
            placeholder="Tell the agent what to do instead"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="btn btn-danger" disabled={busy} type="submit">
            Deny
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => setDenyOpen(false)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
