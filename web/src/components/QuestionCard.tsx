import { useEffect, useState, type ReactNode } from 'react';
import { splitMedia, type Ask } from '../../../shared/ask';
import { cardMedia } from '../../../shared/questionCard';
import { isVideoPath } from '../../../shared/imagePaths';
import { holdReload } from '../freshness';
import { useKeptState } from '../keep';
import { openLightbox } from '../store';
import { previewSrc } from './Images';

/** A still or a clip a card previews: an absolute path (the review folder's, or the asking worker's own). */
export interface CardMedia {
  url: string;
  alt: string;
}

/** /api/image for a path: the review folder needs no session; a worker's own file is read through its session. */
const mediaSrc = (path: string, session?: string) => `/api/image?${new URLSearchParams({ ...(session ? { session } : {}), path })}`;

/** The stills and clips as thumbnails; a click opens them full size (a clip plays there). */
export function Previews({ media, session }: { media: CardMedia[]; session?: string }) {
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const shown = media.filter((m) => !broken.has(m.url));
  if (!shown.length) return null;
  const items = shown.map((m) => ({ src: mediaSrc(m.url, session), name: m.alt || m.url.split(/[\\/]/).pop() || 'still', video: isVideoPath(m.url) }));
  const thumb = (m: CardMedia, i: number) => (
    <button key={m.url} type="button" className="qc-thumb" title={`${m.alt || items[i].name}: open full size`} aria-label={`Open ${m.alt || items[i].name} full size`} onClick={() => openLightbox(items, i)}>
      {items[i].video ? (
        <>
          <video src={`${previewSrc(items[i].src)}#t=0.1`} muted playsInline preload="metadata" onError={() => setBroken(new Set([...broken, m.url]))} />
          <span className="qc-play" aria-hidden>
            ▶
          </span>
        </>
      ) : (
        <img src={items[i].src} alt={m.alt || items[i].name} loading="lazy" onError={() => setBroken(new Set([...broken, m.url]))} />
      )}
    </button>
  );
  return (
    <div className="qc-media" data-testid="qc-media">
      {shown.map((m, i) => thumb(m, i))}
    </div>
  );
}

export interface QuestionCardProps {
  /** Its own key for what is kept across a reload (the answers so far, a typed answer). */
  id: string;
  testId: string;
  title: string;
  /** Structured questions, shown one at a time. Empty: `question` is asked in words alone. */
  asks: Ask[];
  /** The question when there are no structured ones (a free-text question, cleaned). */
  question: string;
  /** The review stills and clips the wait names; each question's own media come first. */
  previews: string[];
  /** The worker whose files the media are, when they are not in the review folder. */
  mediaSession?: string;
  /** Whether the viewer answers it; otherwise the card says who does and its buttons are off. */
  mine: boolean;
  /** Who answers it, when it is not the viewer. */
  answeredBy?: string;
  /** Answer it: the label picked or the words typed (several questions: each one's answer, in order). False when it failed. */
  onAnswer?: (text: string, answers: string[]) => Promise<boolean>;
  /** What the free box says (default "Or type your own answer"). */
  freeLabel?: string;
  /** Shown instead of the answer controls once answered (sent to the orchestrator, recorded). */
  done?: ReactNode;
  /** A quiet line under the question (an intake report's possible repeat). */
  note?: string;
  /** Something to look at before answering, under the question (the Live view's button). */
  look?: ReactNode;
  /** Controls that answer it besides the buttons (a worker's permission cards). */
  extra?: ReactNode;
  /** Everything else, behind one Details link. */
  details: ReactNode;
  busy?: boolean;
}

/**
 * A card on the Waiting on input and Intake tabs (w1597, Ben: "just ask the question clearly, give me the option selections
 * and thats it"): the request's title, one question at a time, its answers as buttons (the recommended one first, marked)
 * with a box for a free answer, its stills and clips as previews, and one collapsed Details link for the rest. A click sends
 * the answer the way a typed one goes (the caller's onAnswer); with several questions the answers are sent together after
 * the last, and Back goes to the one before.
 */
export function QuestionCard(p: QuestionCardProps) {
  const n = p.asks.length;
  // The answers given so far, kept across a reload for a new version (web/src/keep.ts).
  const [kept, setKept] = useKeptState(`qc.answers.${p.id}`, '[]');
  const answers = (() => {
    try {
      const a = JSON.parse(kept) as unknown;
      return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').slice(0, n) : [];
    } catch {
      return [];
    }
  })();
  const [typed, setTyped] = useKeptState(`qc.typed.${p.id}`, '');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    holdReload(`qc:${p.id}`, sending);
    return () => holdReload(`qc:${p.id}`, false);
  }, [p.id, sending]);
  const step = Math.min(answers.length, Math.max(n - 1, 0));
  const ask: Ask | undefined = p.asks[step];
  const live = p.mine && !!p.onAnswer && !p.done && !sending && !p.busy;
  const give = async (answer: string) => {
    const text = answer.trim();
    if (!text || !live) return;
    const next = n > 1 ? [...answers.slice(0, step), text] : [text];
    if (n > 1 && next.length < n) {
      setKept(JSON.stringify(next));
      setTyped('');
      return;
    }
    setSending(true);
    const ok = await p.onAnswer!(text, next);
    setSending(false);
    if (ok) {
      setKept('[]');
      setTyped('');
    } else if (n > 1) setKept(JSON.stringify(next.slice(0, -1)));
  };
  const back = () => setKept(JSON.stringify(answers.slice(0, Math.max(step - 1, 0))));
  const q = ask ? splitMedia(ask.question).text : p.question;
  // The recommended answer first, whatever order it came in (shared/ask.ts checkAsk puts it there too).
  const options = [...(ask?.options ?? [])].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
  const pickedHere = answers[step];
  const progress = n > 1 && (
    <div className="qc-progress" data-testid="qc-progress">
      <span className="small dim">
        Question {step + 1} of {n}
      </span>
      <span className="qc-dots" aria-hidden>
        {p.asks.map((_, i) => (
          <span key={i} className={`qc-dot${i < answers.length ? ' done' : ''}${i === step ? ' now' : ''}`} />
        ))}
      </span>
      {step > 0 && !p.done && (
        <button type="button" className="link-btn small" onClick={back} data-testid="qc-back">
          Back
        </button>
      )}
    </div>
  );
  const optionButtons = options.length > 0 && (
    <div className="qc-options" role="group" aria-label={`Answers to: ${q}`}>
      {options.map((o) => {
        const d = splitMedia(o.description ?? '');
        return (
          <button
            key={o.label}
            type="button"
            className={`qc-opt${o.recommended ? ' qc-rec' : ''}${pickedHere === o.label ? ' qc-picked' : ''}`}
            data-testid="qc-option"
            disabled={!live}
            onClick={() => void give(o.label)}
          >
            <span className="qc-opt-head">
              <span className="qc-opt-label">{o.label}</span>
            </span>
            {d.text && <span className="qc-opt-desc">{d.text}</span>}
            {/* Recommended sits in one place: above the answer (CSS order; the label stays first for a screen reader). */}
            {o.recommended && (
              <span className="chip chip-amber qc-tag" data-testid="qc-recommended">
                Recommended
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
  const freePrompt = p.freeLabel ?? (options.length ? 'Or type your own answer' : 'Your answer');
  const free = p.mine && p.onAnswer && !p.done && (
    <div className="qc-free">
      <textarea
        data-kept
        className="input qc-free-text"
        rows={options.length ? 1 : 2}
        placeholder={freePrompt}
        aria-label={freePrompt}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      <button type="button" className={`btn btn-sm ${typed.trim() ? 'btn-primary' : 'btn-outline'}`} disabled={!live || !typed.trim()} onClick={() => void give(typed)} data-testid="qc-send">
        {n > 1 && step < n - 1 ? 'Next' : 'Send'}
      </button>
    </div>
  );
  const details = (
    <details className="qc-details" data-testid="qc-details">
      <summary className="small dim">Details</summary>
      <div className="qc-details-body">{p.details}</div>
    </details>
  );
  const others = !p.mine && <p className="small dim">{p.answeredBy ? `${p.answeredBy} answers this.` : 'Someone else answers this.'}</p>;
  // Structured questions bring their own media; the review files a wait names are shown with a free-text question only (Details has them otherwise).
  const media = cardMedia(ask, ask ? [] : p.previews);
  return (
    <article className={`qc${p.mine ? ' mine' : ''}`} data-testid={p.testId}>
      <header className="qc-head">
        <span className="qc-title">{p.title}</span>
      </header>
      {progress}
      <QuestionText q={q} legacy={!ask} />
      {p.note && (
        <p className="small dim qc-note" data-testid="qc-note">
          {p.note}
        </p>
      )}
      <Previews media={media} session={p.mediaSession} />
      {p.look}
      {p.done ?? (
        <>
          {optionButtons}
          {p.extra}
          {free}
        </>
      )}
      {p.done && p.extra}
      {others}
      {details}
    </article>
  );
}

/** The question's words; a free-text one from before w1597 (no answers given) a size smaller. */
function QuestionText({ q, legacy }: { q: string; legacy: boolean }) {
  return (
    <p className={`qc-q${legacy ? ' qc-q-legacy' : ''}`} data-testid="qc-question">
      {q}
    </p>
  );
}

/** A quiet line for Details: the label, then what. */
export function DetailLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="small qc-detail">
      <span className="dim">{label}:</span> {children}
    </p>
  );
}

