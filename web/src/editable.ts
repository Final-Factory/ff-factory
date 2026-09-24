// The message boxes are contenteditable elements, not textareas. Chrome for iOS floats its AutoFill
// bar (passwords, cards, addresses) over a focused form field, autocomplete="off" or not, even with a
// hardware keyboard; it leaves contenteditable elements alone (Chromium's form_handlers.ts reports
// FORM, INPUT, SELECT, OPTION and TEXTAREA only, unless kAutofillSupportContentEditableIos, off by
// default, is on). These helpers keep such a box plain text: what it says, where the caret is, and
// inserting text.

/** 'plaintext-only' where the browser has it (Chrome, Safari, Edge, recent Firefox); else 'true', with pastes and drops made plain. */
export const EDITABLE_MODE: 'plaintext-only' | 'true' = (() => {
  try {
    const d = document.createElement('div');
    d.contentEditable = 'plaintext-only';
    return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true';
  } catch {
    return 'true';
  }
})();

const BLOCK = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE)$/;

function lastLeaf(n: Node): Node {
  while (n.lastChild) n = n.lastChild;
  return n;
}

/** Text, line breaks and blocks (the 'true' mode's Enter) as newlines; an end-of-text <br> placeholder as nothing. */
function flatten(root: Node): string {
  let out = '';
  const last = lastLeaf(root);
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) out += (c as Text).data;
      else if (c.nodeName === 'BR') out += c === last && (out === '' || out.endsWith('\n')) ? '' : '\n';
      else if (BLOCK.test(c.nodeName)) {
        if (out && !out.endsWith('\n')) out += '\n';
        walk(c);
      } else walk(c);
    }
  };
  walk(root);
  return out;
}

/**
 * What the box says. A text that ends in a line break carries one more (the browser's, or writeText's),
 * so that the empty last line shows and takes the caret; it is not part of the message.
 */
export function readText(el: HTMLElement): string {
  let t = flatten(el).replace(/\u00a0/g, ' ');
  if (t.endsWith('\n\n') && lastLeaf(el).nodeType === Node.TEXT_NODE) t = t.slice(0, -1);
  return t;
}

/** Replace what the box says (a draft, a suggestion, a dictation, a sent message's empty box). */
export function writeText(el: HTMLElement, text: string) {
  el.textContent = text.endsWith('\n') ? text + '\n' : text;
}

/** The selection in the box as [start, end] offsets into readText's text, or null when it is elsewhere. */
export function selectionOffsets(el: HTMLElement): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const upTo = (node: Node, offset: number) => {
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(node, offset);
    const div = document.createElement('div');
    div.appendChild(pre.cloneContents());
    return flatten(div).length;
  };
  return [upTo(r.startContainer, r.startOffset), upTo(r.endContainer, r.endOffset)];
}

/** Put the caret at a text offset (the end when past it). */
export function setCaret(el: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let left = offset;
  let placed = false;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n && !placed; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n as Text).data.length;
      if (left <= len) {
        range.setStart(n, left);
        placed = true;
      } else left -= len;
    } else if (n.nodeName === 'BR') {
      if (left === 0) {
        range.setStartBefore(n);
        placed = true;
      } else left -= 1;
    }
  }
  if (!placed) {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Put the caret where a drop at (x, y) lands in the box, when the browser can tell. */
export function dropCaret(el: HTMLElement, x: number, y: number) {
  const d = document as unknown as {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const range = document.createRange();
  const pos = d.caretPositionFromPoint?.(x, y);
  const r = pos ? null : d.caretRangeFromPoint?.(x, y);
  const [node, offset] = pos ? [pos.offsetNode, pos.offset] : r ? [r.startContainer, r.startOffset] : [null, 0];
  if (!node || !el.contains(node)) return;
  range.setStart(node, offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Type text at the caret as the user would (so undo works): line by line, with real line breaks
 * (inserting "\n" as text would make <div> paragraphs, even in plaintext-only).
 */
export function insertPlainText(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    if (i > 0 && !document.execCommand('insertLineBreak')) document.execCommand('insertText', false, '\n');
    if (line) document.execCommand('insertText', false, line);
  });
}
