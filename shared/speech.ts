// Turning an agent's markdown reply into something worth hearing, and splitting it for streaming
// playback (docs/voice.md). Pure, no imports.

/** How much of a reply voice mode reads before saying the rest is on screen. */
export const MAX_SPOKEN_CHARS = 1500;

/** Id-like tokens: hashes (7+ hex with a digit and a letter, so a word like "defaced" stays), UUIDs, long numbers, tokens. */
const LONG_ID = /\b(?:(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{7,}|[A-Za-z0-9_-]{28,})\b/gi;

function speakInlineCode(code: string): string {
  const c = code.trim();
  if (!c) return '';
  // A path or file:line: say the file name.
  if (/[\\/]/.test(c) && !/\s/.test(c)) {
    const last = c.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? c;
    return last.replace(/:\d+(?:[-:]\d+)?$/, '');
  }
  if (c.length > 40 || LONG_ID.test(c)) {
    LONG_ID.lastIndex = 0;
    return '';
  }
  return c;
}

/**
 * Markdown -> plain sentences for a speech engine. Code blocks and tables become a short
 * "(code omitted)" / "(table omitted)", links read as their text, bare URLs as "link", ids and
 * hashes are dropped, lists become sentences.
 */
export function speakableText(md: string, maxChars = MAX_SPOKEN_CHARS): string {
  let s = md.replace(/\r\n?/g, '\n');
  s = s.replace(/```[\s\S]*?(```|$)/g, '\n\nCode block omitted.\n\n');
  // Tables: a header row plus a |---| separator, and the rows that follow.
  s = s.replace(/(^\|.*\|[ \t]*\n)(^\|?[ \t]*:?-{2,}.*\n?)((?:^\|.*\|?[ \t]*\n?)*)/gm, '\n\nTable omitted.\n\n');
  s = s.replace(/<[^>\n]+>/g, ' '); // html tags
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `Image: ${alt}.` : ''));
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, 'link');
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => speakInlineCode(c));
  s = s.replace(LONG_ID, '');
  const lines = s.split('\n').map((line) => {
    let l = line.trim();
    if (!l) return '';
    if (/^([-*_])\1{2,}$/.test(l)) return ''; // horizontal rule
    l = l.replace(/^#{1,6}\s+/, '');
    l = l.replace(/^>\s?/, '');
    l = l.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    l = l.replace(/^\[[ xX]\]\s+/, '');
    l = l.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2').replace(/~~(.+?)~~/g, '$1');
    l = l.replace(/\s*(→|->|=>)\s*/g, ' to ').replace(/\s*(←|<-)\s*/g, ' from ');
    l = l.replace(/\s&\s/g, ' and ').replace(/\s+\/\s+/g, ' or ');
    l = l.replace(/[|*#`~]+/g, ' ');
    // Emoji and symbols that engines read out by name.
    l = l.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
    l = l.replace(/\s{2,}/g, ' ').trim();
    // Each line (heading, bullet) is its own sentence.
    if (l && !/[.!?:;,]$/.test(l)) l += '.';
    return l;
  });
  let out = lines.filter(Boolean).join(' ');
  out = out.replace(/\(\s*\)/g, '').replace(/\s+([.,;:!?])/g, '$1').replace(/([.!?])\.+/g, '$1').replace(/\s{2,}/g, ' ').trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    out = `${end > maxChars / 2 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '.'} The rest is on screen.`;
  }
  return out;
}

/**
 * Split text into chunks for synthesis: the first is one short sentence (so playback starts fast),
 * the rest group sentences up to `maxLen`.
 */
export function speechChunks(text: string, maxLen = 260): string[] {
  // The second chunk is synthesised while the first plays, so it stays small too (Kokoro on the GPU:
  // ~0.2 s for a sentence, ~1 s for 250 characters).
  const limit = (i: number) => (i === 1 ? Math.min(maxLen, 140) : maxLen);
  const sentences = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
  const pieces: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxLen) pieces.push(s);
    else {
      // A run-on sentence: split at commas, then at spaces.
      let rest = s;
      while (rest.length > maxLen) {
        let at = rest.lastIndexOf(', ', maxLen);
        if (at < maxLen / 3) at = rest.lastIndexOf(' ', maxLen);
        if (at <= 0) at = maxLen;
        pieces.push(rest.slice(0, at + 1).trim());
        rest = rest.slice(at + 1).trim();
      }
      if (rest) pieces.push(rest);
    }
  }
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    // The first chunk stays alone: it is what the listener waits for.
    if (out.length > 1 && last && last.length + 1 + p.length <= limit(out.length - 1)) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out;
}

/** "stop", "cancel", "stop listening", "exit voice mode", …: ends hands-free voice mode. */
export function isStopCommand(transcript: string): boolean {
  const t = transcript
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:(?:ok(?:ay)?|hey|please)\s)?(?:stop|cancel|quit|exit|end|enough|that's all|goodbye|bye|never mind|nevermind)(?:\s(?:it|now|please|listening|talking|voice(?: mode)?|voice mode off|thanks|thank you))*$/.test(t) || /^(?:voice mode off|turn off voice(?: mode)?|stop voice mode|end voice mode)$/.test(t);
}

/** The transcript fields turnReply needs (a structural slice of shared/types TranscriptEvent). */
export interface ReplyEvent {
  seq: number;
  kind: string;
  text?: string;
  ok?: boolean;
}

/**
 * The reply to read once a turn that started after `mark` has finished: its last assistant message
 * (the agent's final words; the orchestrator's answer), else the result text. Undefined while the
 * turn is still running.
 */
export function turnReply(events: readonly ReplyEvent[], mark: number): { text: string; ok: boolean } | undefined {
  const i = events.findIndex((e) => e.seq > mark && e.kind === 'result');
  if (i < 0) return undefined;
  const result = events[i];
  for (let j = i - 1; j >= 0 && events[j].seq > mark; j--) {
    if (events[j].kind === 'assistant' && events[j].text?.trim()) return { text: events[j].text!.trim(), ok: result.ok !== false };
  }
  const t = result.text?.trim() ?? '';
  return { text: t || (result.ok === false ? 'The turn ended with an error.' : 'Done.'), ok: result.ok !== false };
}
