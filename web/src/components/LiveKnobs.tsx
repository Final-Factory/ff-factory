import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { LiveKnob, LiveMaterialKnobs } from '../../../shared/types';
import { api } from '../api';
import { toastError } from '../store';

type Value = number | number[];

const THROTTLE_MS = 100;
const REREAD_MS = 5000;
const RECHECK_MS = 1500;
const keyOf = (material: string, name: string) => `${material}\u0000${name}`;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const same = (a: Value, b: Value) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b);

export function fmtNum(v: number): string {
  if (!isFinite(v)) return '–';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

function hexOf(rgb: number[]): string {
  return '#' + rgb.slice(0, 3).map((x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0')).join('');
}

/** A colour's hue (largest channel 1, so an HDR emission shows as its colour) and its intensity (that largest channel). */
function colorParts(c: number[], hdr: boolean): { hue: number[]; k: number } {
  const rgb = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
  if (!hdr) return { hue: rgb.map(clamp01), k: 1 };
  const k = Math.max(...rgb);
  return { hue: k > 1e-6 ? rgb.map((x) => x / k) : [1, 1, 1], k: Math.max(0, k) };
}

const colorValue = (hue: number[], k: number, alpha: number): number[] => [hue[0] * k, hue[1] * k, hue[2] * k, alpha];

/** The slider's span for a float or an intensity: from the value first seen, so it holds still under the thumb; it only grows. */
function useSpan(initial: number, floor: number, factor: number): [number, (v: number) => number] {
  const hi = useRef(Math.max(factor * Math.abs(initial), floor));
  return [hi.current, (v: number) => (hi.current = Math.max(hi.current, factor * Math.abs(v)))];
}

function Slider({ min, max, value, onMove, onCommit, label }: { min: number; max: number; value: number; onMove: (v: number) => void; onCommit: () => void; label: string }) {
  const pct = max > min ? clamp01((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className="lv-range"
      min={min}
      max={max}
      step={(max - min) / 400}
      value={Math.min(max, Math.max(min, value))}
      aria-label={label}
      style={{ '--p': `${pct}%` } as CSSProperties}
      onChange={(e) => onMove(Number(e.target.value))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
      onBlur={onCommit}
    />
  );
}

/** A number typed in: it sends while the text is a number, and settles on the sent value when it loses focus. */
function NumberField({ value, onMove, onCommit, int, label, step = int ? 1 : 0.1 }: { value: number; onMove: (v: number) => void; onCommit: () => void; int?: boolean; label: string; step?: number }) {
  const [text, setText] = useState(fmtNum(value));
  const editing = useRef(false);
  const parse = (t: string): number | undefined => {
    const n = Number(t);
    return t.trim() !== '' && isFinite(n) ? (int ? Math.round(n) : n) : undefined;
  };
  useEffect(() => {
    // Not while typing a number that is still on its way (a lone "-"); a refused value snaps the text back too.
    const typed = parse(text);
    if (!editing.current || (typed !== undefined && typed !== value)) setText(fmtNum(value));
  }, [value]);
  return (
    <input
      className="input input-sm lv-num mono"
      inputMode="decimal"
      value={text}
      aria-label={label}
      onFocus={() => (editing.current = true)}
      onChange={(e) => {
        setText(e.target.value);
        const n = parse(e.target.value);
        if (n !== undefined) onMove(n);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const n = (parse(text) ?? value) + (e.key === 'ArrowUp' ? step : -step);
          const next = int ? Math.round(n) : Math.round(n * 1e6) / 1e6;
          setText(fmtNum(next));
          onMove(next);
        }
      }}
      onBlur={() => {
        editing.current = false;
        onCommit();
        setText(fmtNum(value));
      }}
    />
  );
}

/** A knob's value as the toast says it: a colour by its hue and intensity (a raw HDR channel above 1 would read as white), else the numbers. */
function sayValue(knob: LiveKnob, v: Value): string {
  if (!Array.isArray(v)) return fmtNum(v);
  if (knob.type === 'color') {
    const { hue, k } = colorParts(v, !!knob.hdr);
    return hexOf(hue) + (knob.hdr ? ` ×${fmtNum(Math.round(k * 100) / 100)}` : '');
  }
  return v.map(fmtNum).join(', ');
}

/** The game's reason for an unreadable material, without its error code; a material that is not loaded yet comes by itself. */
function sayMaterialError(error: string): string {
  const text = error.replace(/^bad_arguments:\s*/, '').replace(/[.\s]+$/, '');
  return /no loaded material/i.test(error) ? `${text}. It is read again every few seconds (a material loads when the game first draws it).` : `${text}.`;
}

function KnobRow({ knob, value, error, onMove, onCommit }: { knob: LiveKnob; value: Value; error?: string; onMove: (v: Value) => void; onCommit: () => void }) {
  const num = typeof value === 'number' ? value : (value[0] ?? 0);
  const [floatHi, growFloat] = useSpan(num, 1, 2);
  const arr = Array.isArray(value) ? value : [num];
  const colors = knob.type === 'color' ? colorParts(arr, !!knob.hdr) : undefined;
  const [kHi, growK] = useSpan(colors?.k ?? 1, 8, 2);
  const label = knob.label || knob.name;

  let control: ReactNode;
  let readout: ReactNode = null;
  if (knob.type === 'range') {
    const lo = knob.min ?? 0;
    const hi = knob.max ?? 1;
    control = <Slider min={lo} max={hi} value={num} onMove={onMove} onCommit={onCommit} label={label} />;
    readout = <span className="lv-knob-val mono">{fmtNum(num)}</span>;
  } else if (knob.type === 'float') {
    growFloat(typeof knob.value === 'number' ? knob.value : 0); // from what the game holds, not from a value still being typed
    control = <Slider min={num < 0 || (knob.min ?? 0) < 0 ? -floatHi : 0} max={floatHi} value={num} onMove={onMove} onCommit={onCommit} label={label} />;
    readout = <NumberField value={num} onMove={onMove} onCommit={onCommit} label={`${label}, number`} />;
  } else if (knob.type === 'int') {
    control = <span className="lv-int-note dim small">whole number</span>;
    readout = <NumberField value={num} int onMove={onMove} onCommit={onCommit} label={label} />;
  } else if (knob.type === 'color' && colors) {
    const alpha = arr[3] ?? 1;
    const { hue, k } = colors;
    if (knob.hdr && Array.isArray(knob.value)) growK(colorParts(knob.value, true).k); // from what the game holds: growing from the drag would run away
    control = (
      <span className="lv-color">
        <input
          type="color"
          className="lv-swatch"
          value={hexOf(hue)}
          aria-label={`${label}, colour`}
          onChange={(e) => {
            const h = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(e.target.value);
            if (h) onMove(colorValue([parseInt(h[1], 16) / 255, parseInt(h[2], 16) / 255, parseInt(h[3], 16) / 255], knob.hdr ? Math.max(k, 1e-6) : 1, alpha));
          }}
          onBlur={onCommit}
        />
        {knob.hdr && <Slider min={0} max={kHi} value={k} onMove={(x) => onMove(colorValue(hue, x, alpha))} onCommit={onCommit} label={`${label}, intensity`} />}
      </span>
    );
    readout = (
      <span className="lv-knob-val mono">
        {hexOf(hue)}
        {knob.hdr && <span className="dim"> ×{fmtNum(Math.round(k * 100) / 100)}</span>}
      </span>
    );
  } else {
    control = (
      <span className="lv-vec">
        {['x', 'y', 'z', 'w'].map((axis, i) => (
          <NumberField
            key={axis}
            value={arr[i] ?? 0}
            label={`${label}, ${axis}`}
            onMove={(x) => onMove(Array.from({ length: 4 }, (_, j) => (j === i ? x : (arr[j] ?? 0))))}
            onCommit={onCommit}
          />
        ))}
      </span>
    );
  }

  return (
    <div className={`lv-knob lv-knob-${knob.type}${error ? ' has-error' : ''}`} data-testid="live-knob" data-knob={knob.name}>
      <span className="lv-knob-name" title={knob.name}>
        {label}
        {knob.moved && <span className="lv-moved" title="Moved from the material's own value" aria-label="moved" />}
      </span>
      <span className="lv-knob-ctl">{control}</span>
      {readout}
      {error && (
        <span className="lv-knob-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * The knobs the game says cannot move the picture (w1509: on Ben's station shield view they looked dead): something else
 * sets the property. No control, so nothing looks like it works; each says why, folded away under one line.
 */
function DrivenKnobs({ knobs }: { knobs: LiveKnob[] }) {
  if (!knobs.length) return null;
  return (
    <details className="lv-driven" data-testid="live-driven">
      <summary className="dim small">
        {knobs.length === 1 ? '1 more the game sets itself' : `${knobs.length} more the game sets itself`}: moving {knobs.length === 1 ? 'it' : 'them'} here would change nothing
      </summary>
      {knobs.map((k) => (
        <div className="lv-knob lv-knob-driven" key={k.name} data-testid="live-knob-driven" data-knob={k.name}>
          <span className="lv-knob-name" title={k.name}>
            {k.label || k.name}
          </span>
          <span className="lv-driven-why dim small">{k.driven}</span>
        </div>
      ))}
    </details>
  );
}

interface Lane {
  /** The value the knob had when this drag or edit started: the toast's "from", until an answer settles it. */
  origin?: Value;
  /** The hand is still on the control (no release or blur yet): the origin outlives answers until it lets go. */
  held?: boolean;
  inflight: boolean;
  latest?: Value;
  timer?: ReturnType<typeof setTimeout>;
  last: number;
}

/**
 * The knobs of a view's materials (docs/live-view.md). A drag sends at most one move per THROTTLE_MS per knob, and always the
 * final value; one request is in flight per knob, so an answer never lands behind a newer one and a stale value is never
 * queued: while it flies, only the newest value waits. The slider follows the hand at once (draft) and settles on what the
 * game answered; a refused move shows its reason under the knob and snaps back. `liveNow`: the view streams; a new play
 * session (it goes live again) reads the knobs again.
 */
export function LiveKnobs({ sessionId, liveNow, onMoved }: { sessionId: string; liveNow: boolean; onMoved?: (text: string) => void }) {
  const [mats, setMats] = useState<LiveMaterialKnobs[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resetting, setResetting] = useState<string>();
  const matsRef = useRef<LiveMaterialKnobs[] | null>(null);
  matsRef.current = mats;
  const lanes = useRef(new Map<string, Lane>());
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;

  const load = useCallback(async () => {
    try {
      const r = await api.liveKnobs(sessionId);
      setMats(r);
      setLoadError(undefined);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  const first = useRef(true);
  useEffect(() => {
    // A view that is holding cannot answer: read once when the page opens, then again each time it goes live.
    if (!first.current && !liveNow) return;
    first.current = false;
    lanes.current.forEach((l) => clearTimeout(l.timer));
    lanes.current.clear();
    setDraft({});
    setErrors({});
    void load();
  }, [sessionId, liveNow, load]);

  // A while after the last answer the knobs are read again (w1509): a value something else wrote back after the knob set
  // it shows only then, and the game then says why the knob cannot move the picture.
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recheck = () => {
    clearTimeout(recheckTimer.current);
    recheckTimer.current = setTimeout(() => void load(), RECHECK_MS);
  };

  useEffect(
    () => () => {
      lanes.current.forEach((l) => clearTimeout(l.timer));
      clearTimeout(recheckTimer.current);
    },
    [],
  );

  // A material the game cannot read yet (it loads when first drawn) is read again until it answers.
  const unreadable = !!mats?.some((m) => m.error);
  useEffect(() => {
    if (!unreadable) return;
    const t = setInterval(() => void load(), REREAD_MS);
    return () => clearInterval(t);
  }, [unreadable, load]);

  const find = (material: string, name: string) => matsRef.current?.find((m) => m.material === material)?.knobs.find((k) => k.name === name);

  const flush = (material: string, name: string) => {
    const key = keyOf(material, name);
    const lane = lanes.current.get(key);
    if (!lane || lane.inflight || lane.latest === undefined) return;
    clearTimeout(lane.timer);
    lane.timer = undefined;
    const sent = lane.latest;
    lane.latest = undefined;
    lane.inflight = true;
    lane.last = Date.now();
    const before = find(material, name);
    api
      .liveKnob(sessionId, { material, name, value: sent })
      .then((r) => {
        lane.inflight = false;
        // The game's answer says whether it can move the picture (driven, w1509): an answer without one clears it.
        const next: LiveKnob | undefined = before ? { ...before, ...(r.knob ?? {}), value: r.knob?.value ?? sent, moved: true, ...(r.knob ? { driven: r.knob.driven } : {}) } : r.knob;
        if (next) setMats((ms) => ms?.map((m) => (m.material === material ? { ...m, knobs: m.knobs.map((k) => (k.name === name ? next : k)) } : m)) ?? ms);
        if (lane.latest === undefined) setDraft((d) => (key in d ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)) : d));
        else schedule(material, name);
        // "from" is what the knob held when the drag started, "to" what the game answered for this send.
        const answered = r.knob?.value ?? sent;
        if (before && lane.origin !== undefined && !same(lane.origin, answered)) onMovedRef.current?.(`${before.label || before.name} ${sayValue(before, lane.origin)} → ${sayValue(before, answered)}`);
        if (lane.latest === undefined && !lane.timer && !lane.held) lane.origin = undefined;
        recheck();
      })
      .catch((e: unknown) => {
        // Snap back to what the game last answered, and say why.
        lane.inflight = false;
        lane.latest = undefined;
        lane.origin = undefined;
        clearTimeout(lane.timer);
        lane.timer = undefined;
        setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)));
        setErrors((x) => ({ ...x, [key]: e instanceof Error ? e.message : String(e) }));
      });
  };

  const schedule = (material: string, name: string) => {
    const lane = lanes.current.get(keyOf(material, name));
    if (!lane || lane.timer) return;
    lane.timer = setTimeout(() => {
      lane.timer = undefined;
      flush(material, name);
    }, Math.max(0, THROTTLE_MS - (Date.now() - lane.last)));
  };

  const move = (material: string, name: string, value: Value) => {
    const key = keyOf(material, name);
    let lane = lanes.current.get(key);
    if (!lane) lanes.current.set(key, (lane = { inflight: false, last: 0 }));
    if (lane.origin === undefined) lane.origin = find(material, name)?.value;
    lane.held = true;
    lane.latest = value;
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((x) => (key in x ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== key)) : x));
    schedule(material, name);
  };

  /** Released: the final value goes now, not after the throttle. */
  const commit = (material: string, name: string) => {
    const lane = lanes.current.get(keyOf(material, name));
    if (!lane) return;
    lane.held = false;
    flush(material, name);
    if (!lane.inflight && lane.latest === undefined && !lane.timer) lane.origin = undefined;
  };

  const reset = async (material: string) => {
    setResetting(material);
    try {
      await api.liveReset(sessionId, material);
      for (const [key, lane] of lanes.current) {
        if (key.startsWith(`${material}\u0000`)) {
          clearTimeout(lane.timer);
          lanes.current.delete(key);
        }
      }
      setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith(`${material}\u0000`))));
      setErrors((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith(`${material}\u0000`))));
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setResetting(undefined);
    }
  };

  if (!mats) {
    return loadError ? (
      <div className="lv-note lv-err" role="alert">
        Could not read the knobs: {loadError}{' '}
        <button className="link-btn" onClick={() => void load()}>
          Try again
        </button>
      </div>
    ) : (
      <div className="lv-note">
        <span className="spinner spinner-sm" /> Reading the knobs…
      </div>
    );
  }
  if (!mats.length) return <div className="lv-note">This view has no materials yet. The agent names them when it starts the view (live_view start, materials).</div>;

  return (
    <div className="lv-mats" data-testid="live-knobs">
      {loadError && (
        <div className="lv-note lv-err" role="alert">
          Could not read the knobs again: {loadError}
        </div>
      )}
      {mats.map((m) => {
        const anyMoved = m.knobs.some((k) => k.moved);
        return (
          <section className="lv-mat" key={m.material} data-testid="live-material">
            <div className="lv-mat-head">
              <span className="lv-mat-name mono ellipsis" title={m.material}>
                {m.material}
              </span>
              {m.shader && (
                <span className="dim small ellipsis" title={m.shader}>
                  {m.shader}
                </span>
              )}
              <span className="spacer" />
              <button className="btn btn-ghost btn-xs" disabled={resetting === m.material || (!anyMoved && !m.error)} onClick={() => void reset(m.material)} title="Put this material's knobs back to what the game loaded" data-testid="live-reset">
                {resetting === m.material ? <span className="spinner spinner-sm" /> : null} Reset
              </button>
            </div>
            {m.error ? (
              <div className="lv-note lv-err">Could not read this material: {sayMaterialError(m.error)}</div>
            ) : m.knobs.length === 0 ? (
              <div className="lv-note">No knobs: its shader has no properties to move.</div>
            ) : (
              <>
                {m.knobs
                  .filter((k) => !k.driven)
                  .map((k) => {
                    const key = keyOf(m.material, k.name);
                    return <KnobRow key={k.name} knob={k} value={draft[key] ?? k.value} error={errors[key]} onMove={(v) => move(m.material, k.name, v)} onCommit={() => commit(m.material, k.name)} />;
                  })}
                <DrivenKnobs knobs={m.knobs.filter((k) => k.driven)} />
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
