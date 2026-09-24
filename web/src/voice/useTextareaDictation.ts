import { useEffect, useRef, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { insertTranscript } from '../../../shared/voice';
import { selectionOffsets, setCaret } from '../editable';
import { useDictation, type Dictation } from './dictation';

/** A textarea, or a contenteditable message box (web/src/editable.ts). */
type Box = HTMLTextAreaElement | HTMLElement;
const isTextarea = (el: Box): el is HTMLTextAreaElement => el instanceof HTMLTextAreaElement;

/**
 * Dictation into a controlled text box: the transcript goes in at the caret (or replaces the
 * selection), for the user to review. With `onAutoSend` and the device's "send automatically" setting on,
 * it is sent at once instead.
 */
export function useTextareaDictation(opts: {
  value: string;
  setValue: (v: string) => void;
  ref: RefObject<Box | null>;
  onAutoSend?: (text: string) => void;
}): {
  d: Dictation;
  /** Spread onto the box. */
  textareaProps: { onSelect: (e: SyntheticEvent<HTMLElement>) => void; onKeyUp: (e: KeyboardEvent) => void };
  /** Call first in the box's onKeyDown; true means it was the dictation shortcut (or Esc), so stop. */
  keyDown: (e: KeyboardEvent) => boolean;
} {
  const latest = useRef(opts);
  latest.current = opts;
  // The last caret/selection in the box; null until the user has been in it (then text goes at the end).
  const sel = useRef<[number, number] | null>(null);

  // A contenteditable box has no select event of its own (React's onSelect leaves out plaintext-only
  // ones): follow the document's selection while it is in the box.
  useEffect(() => {
    const onChange = () => {
      const el = latest.current.ref.current;
      if (!el || isTextarea(el)) return;
      const s = selectionOffsets(el);
      if (s) sel.current = s;
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, []);

  const d = useDictation((t, { autoSend }) => {
    const { value, setValue, ref, onAutoSend } = latest.current;
    const [s, e] = sel.current ?? [value.length, value.length];
    const next = insertTranscript(value, s, e, t);
    setValue(next.text);
    sel.current = [next.caret, next.caret];
    if (autoSend && onAutoSend) return onAutoSend(next.text);
    const el = ref.current;
    // On a phone, focusing would pop the keyboard up over what was just dictated.
    if (el && !window.matchMedia('(pointer: coarse)').matches) {
      requestAnimationFrame(() => {
        el.focus();
        if (isTextarea(el)) el.setSelectionRange(next.caret, next.caret);
        else setCaret(el, next.caret);
      });
    }
  });

  return {
    d,
    textareaProps: {
      onSelect: (e) => {
        const el = e.currentTarget;
        if (isTextarea(el)) sel.current = [el.selectionStart, el.selectionEnd];
      },
      onKeyUp: d.onKeyUp,
    },
    keyDown: (e) => {
      if (!d.onKeyDown(e)) return false;
      e.preventDefault();
      // Esc would otherwise also close a modal around the box.
      e.stopPropagation();
      return true;
    },
  };
}
