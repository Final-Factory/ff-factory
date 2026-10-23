import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { splitMedia, type Ask } from '../../../shared/ask';
import { cardMedia } from '../../../shared/questionCard';
import { isVideoPath } from '../../../shared/imagePaths';
import { holdReload } from '../freshness';
import { useKeptState } from '../keep';
import { openLightbox } from '../store';
import { useTextareaDictation } from '../voice/useTextareaDictation';
import { DictationBar, MicButton } from './Mic';
import { PreviewVideo } from './Images';

/** A still or a clip a card previews: an absolute path (the review folder's, or the asking worker's own). */
export interface CardMedia {
  url: string;
  alt: string;
}

/** /api/image for a path: the review folder needs no session; a worker's own file is read through its session. */
const mediaSrc = (path: string, session?: string) => `/api/image?${new URLSearchParams({ ...(session ? { session } : {}), path })}`;

/**
 * The stills as thumbnails (a click opens them full size) and the clips as players that play in the card (w1868, Ben on a
 * w1762 card: "You don't put the clip in this little intake waiting for input box, so I can't see it").
 */
export function Previews({ media, session }: { media: CardMedia[]; session?: string }) {
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const shown = media.filter((m) => !broken.has(m.url));
  if (!shown.length) return null;
  const items = shown.map((m) => ({ src: mediaSrc(m.url, session), name: m.alt || m.url.split(/[\\/]/).pop() || 'still', video: isVideoPath(m.url) }));
  const lost = (url: string) => setBroken((b) => new Set([...b, url]));
  const clips = shown.map((m, i) => ({ m, it: items[i] })).filter((x) => x.it.video);
  const stills = shown.map((m, i) => ({ m, it: items[i] })).filter((x) => !x.it.video);
  return (
    <div className="qc-media" data-testid="qc-media">
      {clips.map(({ m, it }) => (
        <figure key={m.url} className="qc-clip" data-testid="qc-clip">
          <PreviewVideo src={it.src} onBroken={() => lost(m.url)} />
          <figcaption className="small dim">{it.name}</figcaption>
        </figure>
      ))}
      {stills.map(({ m, it }, i) => (
        <button key={m.url} type="button" className="qc-thumb" data-testid="qc-still" title={`${it.name}: open full size`} aria-label={`Open ${it.name} full size`} onClick={() => openLightbox(stills.map((x) => x.it), i)}>
          <img src={it.src} alt={it.name} loading="lazy" onError={() => lost(m.url)} />
        </button>
      ))}
    </div>
  );
}

/** The six parts a waiting card says besides its question and answers (w1868, shared/waitSummary.ts). */
export interface CardSummary {
  /** 1. What it is, in one plain line. */
  what: string;
  /** 2. Who must act and how long it has waited. */
  meta: ReactNode;
  /** 4. For an input with no answers to pick: the one step. */
  step?: string;
  /** 6. What happens after the answer. */
  after?: string;
  /** What changed since it was asked. */
  stale?: string;
  /** A visual question with no still or clip. */
  noMedia?: boolean;
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
  /** What it is, who acts and since when, and what follows the answer (w1868): shown in place of the title. */
  summary?: CardSummary;
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
  // The same dictation as the chat box (w1817): the transcript lands in the box for the answer to be edited before Send.
  const freeBox = useRef<HTMLTextAreaElement>(null);
  const voice = useTextareaDictation({ value: typed, setValue: setTyped, ref: freeBox });
  // A dictated answer is a sentence or more: the box grows to show it all for review (up to a few lines), instead of cutting it off in its one-line box.
  useLayoutEffect(() => {
    const el = freeBox.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, 160)}px`;
  }, [typed, kept]);
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
    <>
      <div className="qc-free">
        <textarea
          ref={freeBox}
          data-kept
          className="input qc-free-text"
          rows={options.length ? 1 : 2}
          placeholder={freePrompt}
          aria-label={freePrompt}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          {...voice.textareaProps}
          onKeyDown={(e) => void voice.keyDown(e)}
        />
        <MicButton d={voice.d} className="qc-mic" />
        <button type="button" className={`btn btn-sm ${typed.trim() ? 'btn-primary' : 'btn-outline'}`} disabled={!live || !typed.trim()} onClick={() => void give(typed)} data-testid="qc-send">
          {n > 1 && step < n - 1 ? 'Next' : 'Send'}
        </button>
      </div>
      <DictationBar d={voice.d} />
    </>
  );
  const details = (
    <details className="qc-details" data-testid="qc-details">
      <summary className="small dim">Details</summary>
      <div className="qc-details-body">{p.details}</div>
    </details>
  );
  const others = !p.mine && <p className="small dim">{p.answeredBy ? `${p.answeredBy} answers this.` : 'Someone else answers this.'}</p>;
  // The question's own stills and clips first, then the review files the wait names (w1868: a clip that sat only in Details
  // was never seen), then each answer's own under the answers.
  const media = cardMedia(ask, p.previews);
  const optionMedia = options.map((o) => ({ label: o.label, media: cardMedia(undefined, splitMedia(o.description ?? '').media.map((m) => m.url)) })).filter((x) => x.media.length);
  const sum = p.summary;
  return (
    <article className={`qc${p.mine ? ' mine' : ''}`} data-testid={p.testId}>
      {sum ? (
        <header className="qc-head qc-head-sum">
          <span className="qc-what" data-testid="qc-what">
            {sum.what}
          </span>
          <span className="small dim qc-meta" data-testid="qc-meta">
            {sum.meta}
          </span>
        </header>
      ) : (
        <header className="qc-head">
          <span className="qc-title">{p.title}</span>
        </header>
      )}
      {sum?.stale && (
        <p className="small tone-amber qc-stale" data-testid="qc-stale">
          May be out of date: {sum.stale}
        </p>
      )}
      {progress}
      <QuestionText q={q} legacy={!ask} />
      {p.note && (
        <p className="small dim qc-note" data-testid="qc-note">
          {p.note}
        </p>
      )}
      <Previews media={media} session={p.mediaSession} />
      {sum?.noMedia && (
        <p className="small tone-amber" data-testid="qc-no-media">
          It asks about something you have to see, but no still or clip came with it: ask for one before you answer.
        </p>
      )}
      {sum?.step && (
        <p className="small qc-step" data-testid="qc-step">
          {sum.step}
        </p>
      )}
      {p.look}
      {p.done ?? (
        <>
          {optionButtons}
          {optionMedia.map((x) => (
            <div key={x.label} className="qc-opt-media" data-testid="qc-opt-media">
              <span className="small dim">{x.label}:</span>
              <Previews media={x.media} session={p.mediaSession} />
            </div>
          ))}
          {p.extra}
          {free}
        </>
      )}
      {p.done && p.extra}
      {sum?.after && (
        <p className="small qc-after" data-testid="qc-after">
          <span className="dim">After you answer:</span> {sum.after}
        </p>
      )}
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

