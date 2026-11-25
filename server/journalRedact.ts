import { redactLogLines } from './logRedact.ts';

/**
 * Everything the portal prints reaches the journal redacted (w5525, security audit w5452 finding 16). systemd keeps the
 * portal's stdout and stderr in the journal, and `fffctl logs` and portal_logs read it back; a token in an error message
 * or a URL with a password in it stayed there for weeks. Every console call (log, info, warn, error, debug, trace, dir,
 * table: Node's Console writes through its stream's write) and every direct process.stdout or process.stderr write goes
 * through redactLogLines (server/logRedact.ts: the vault's values, the shared token shapes, the log forms), and a line
 * that still looks like a secret is withheld. server/index.ts's first import is server/journalRedactStart.ts, which turns
 * it on before the rest of the portal's modules load.
 *
 * Cost: redaction is a few regular expressions per line, behind cheap first looks (maybeTokenShape, MAYBE_LOG_FORM);
 * measured in server/journalRedact.test.ts ("the cost per line").
 */

type Write = typeof process.stdout.write;
const installed = new WeakSet<NodeJS.WriteStream | NodeJS.WritableStream>();

/** `chunk` as the journal must get it: text redacted; a Buffer decoded, redacted and given back as text when it was UTF-8 text. */
export function redactChunk(chunk: unknown, encoding?: BufferEncoding): unknown {
  try {
    if (typeof chunk === 'string') return redactLogLines(chunk);
    if (chunk instanceof Uint8Array) {
      const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString(encoding && Buffer.isEncoding(encoding) ? encoding : 'utf8');
      const clean = redactLogLines(text);
      return clean === text ? chunk : clean;
    }
    return chunk;
  } catch {
    // A redactor that throws must not print the raw text, nor stop the portal's logging.
    return '[log output withheld: the redactor failed]\n';
  }
}

/** Route `stream`'s writes through the redactor. Idempotent. */
export function redactStream(stream: NodeJS.WriteStream | NodeJS.WritableStream) {
  if (installed.has(stream)) return;
  installed.add(stream);
  const write = stream.write.bind(stream) as Write;
  (stream as { write: Write }).write = function (chunk: unknown, encoding?: unknown, cb?: unknown) {
    const enc = typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;
    const clean = redactChunk(chunk, enc);
    // A Buffer that became text is written as UTF-8 text.
    const encOut = typeof clean === 'string' && typeof chunk !== 'string' ? 'utf8' : encoding;
    return (write as (c: unknown, e?: unknown, f?: unknown) => boolean)(clean, encOut, cb);
  } as Write;
}

/** The portal's stdout and stderr (what systemd puts in its journal), redacted from here on. */
export function redactProcessOutput() {
  redactStream(process.stdout);
  redactStream(process.stderr);
}

