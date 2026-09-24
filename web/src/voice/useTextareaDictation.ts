import { useRef, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { insertTranscript } from '../../../shared/voice';
import { useDictation, type Dictation } from './dictation';

/**
 * Dictation into a controlled textarea: the transcript goes in at the caret (or replaces the
 * selection), for the user to review. With `onAutoSend` and the device's "send automatically" setting on,
 * it is sent at once instead.
 */
export function useTextareaDictation(opts: {
  value: string;
  setValue: (v: string) => void;
  ref: RefObject<HTMLTextAreaElement | null>;
  onAutoSend?: (text: string) => void;
}): {
  d: Dictation;
  /** Spread onto the textarea. */
  textareaProps: { onSelect: (e: SyntheticEvent<HTMLTextAreaElement>) => void; onKeyUp: (e: KeyboardEvent) => void };
  /** Call first in the textarea's onKeyDown; true means it was the dictation shortcut (or Esc), so stop. */
  keyDown: (e: KeyboardEvent) => boolean;
} {
  const latest = useRef(opts);
  latest.current = opts;
  // The last caret/selection in the box; null until the user has been in it (then text goes at the end).
  const sel = useRef<[number, number] | null>(null);

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
        el.setSelectionRange(next.caret, next.caret);
      });
    }
  });

  return {
    d,
    textareaProps: {
      onSelect: (e) => {
        const el = e.currentTarget;
        sel.current = [el.selectionStart, el.selectionEnd];
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
