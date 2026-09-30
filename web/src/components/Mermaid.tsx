import { useEffect, useState } from 'react';
import { openLightbox } from '../store';
import { CopyButton, Icon } from './ui';

// Loaded only when a chat shows a diagram (it is most of a megabyte). Strict: no scripts, no click handlers,
// and mermaid passes its own output through DOMPurify. Dagre, the layout GitHub draws them with (mermaid 12's
// default, ELK, scatters a flowchart with subgraphs).
type MermaidApi = (typeof import('mermaid'))['default'];
let loading: Promise<MermaidApi> | undefined;
const load = () =>
  (loading ??= import('mermaid').then(({ default: m }) => {
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', layout: 'dagre' });
    return m;
  }));

// One diagram at a time (mermaid measures text in a scratch element of the page); the same source is drawn once.
let queue: Promise<unknown> = Promise.resolve();
let count = 0;
const drawn = new Map<string, Promise<string>>();
function draw(source: string): Promise<string> {
  const hit = drawn.get(source);
  if (hit) return hit;
  const run = queue.then(async () => {
    const m = await load();
    const id = `mermaid-${++count}`;
    try {
      return (await m.render(id, source)).svg;
    } finally {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  drawn.set(source, run);
  if (drawn.size > 40) drawn.delete(drawn.keys().next().value!);
  run.catch(() => drawn.delete(source));
  return run;
}

/** The diagram as an image of its own size, for the lightbox (inline it scales to the column). */
function svgImage(svg: string): string {
  const t = document.createElement('template');
  t.innerHTML = svg;
  const el = t.content.querySelector('svg');
  if (!el) return '';
  const vb = el.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  if (vb?.length === 4) {
    el.setAttribute('width', String(vb[2]));
    el.setAttribute('height', String(vb[3]));
  }
  el.style.removeProperty('max-width');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(el))}`;
}

/** A ```mermaid block drawn as a diagram, with its source a click away (and shown when it does not parse). */
export default function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    let live = true;
    // A message still streaming changes on every token: draw once it settles.
    const t = setTimeout(
      () =>
        draw(source).then(
          (s) => live && (setSvg(s), setError(undefined)),
          (e) => live && setError(String((e as Error)?.message ?? e).split('\n')[0]),
        ),
      drawn.has(source) ? 0 : 250,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [source]);
  const open = () => svg && openLightbox([{ src: svgImage(svg), name: 'diagram.svg' }], 0);
  const sourceView = showSource || (error && !svg);
  return (
    <div className="md-code md-mermaid">
      <div className="md-code-bar">
        <span className="md-code-lang">mermaid</span>
        <span className="md-code-actions">
          {svg && !sourceView && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={open} title="Open large" aria-label="Open diagram large">
              <Icon name="expand" size={12} />
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowSource(!showSource)} aria-pressed={showSource}>
            {showSource ? 'Diagram' : 'Source'}
          </button>
          <CopyButton getText={() => source} label="Copy code" />
        </span>
      </div>
      {sourceView ? (
        <>
          {error && !svg && <div className="md-mermaid-error small">Could not draw this diagram: {error}</div>}
          <pre>
            <code>{source}</code>
          </pre>
        </>
      ) : svg ? (
        <div className="md-mermaid-diagram" role="img" aria-label="Diagram" onClick={open} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="md-mermaid-loading dim small">Drawing diagram…</div>
      )}
    </div>
  );
}
