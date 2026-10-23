import { useEffect, useMemo } from 'react';
import { toast, useStore } from '../store';
import { ATTACH_DEFAULTS, attachProblem, removePending, startUpload, usePendingFiles, type PendingFile } from '../upload';
import { fmtBytes } from '../util';
import { Icon } from './ui';

/** A small preview of a picture waiting to be sent; its object URL is let go when the chip goes. */
function Thumb({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="composer-file-thumb" src={url} alt="" />;
}

/**
 * The files waiting to go with a message or an answer (docs/attachments.md): one chip each with its progress, a retry for
 * one that failed and a remove control. `thumbs`: a picture shows as its own thumbnail (the question cards, w1912).
 * The same chips the chat's composer shows.
 */
export function PendingFileChips({ ownerId, files, thumbs }: { ownerId: string; files: PendingFile[]; thumbs?: boolean }) {
  if (!files.length) return null;
  return (
    <div className="composer-files" data-testid="pending-files">
      {files.map((f) => {
        const pct = Math.floor((f.sent * 100) / f.file.size);
        return (
          <span key={f.key} className={`composer-file${f.error ? ' failed' : f.ref ? ' done' : ''}`} title={f.error ? `${f.file.name}: ${f.error}` : f.file.name} data-testid="pending-file">
            {thumbs && /^image\//.test(f.file.type) ? <Thumb file={f.file} /> : <Icon name="file" size={14} />}
            <span className="composer-file-name">{f.file.name}</span>
            <span className="composer-file-size">{f.error ? 'failed' : f.ref ? fmtBytes(f.file.size) : `${pct}%`}</span>
            {!f.ref && !f.error && (
              <span className="composer-file-bar" role="progressbar" aria-label={`Uploading ${f.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <i style={{ width: `${pct}%` }} />
              </span>
            )}
            {f.error && (
              <button type="button" className="composer-file-btn" onClick={() => startUpload(ownerId, f.file, f.key)} title="Upload it again" aria-label={`Retry ${f.file.name}`}>
                <Icon name="refresh" size={12} />
              </button>
            )}
            <button type="button" className="composer-file-btn" onClick={() => removePending(ownerId, f.key)} title="Remove" aria-label={`Remove ${f.file.name}`}>
              <Icon name="x" size={12} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The files of one answer field (w1912): picked, pasted or dropped files upload at once through the chat box's own uploader
 * (web/src/upload.ts, its limits from the server's settings), and `ids` are what the answer then names.
 */
export function useAnswerFiles(ownerId: string) {
  const files = usePendingFiles(ownerId);
  const limits = useStore((s) => s.app?.config.attachments) ?? ATTACH_DEFAULTS;
  const add = (incoming: Iterable<File>) => {
    let pending = files.length;
    for (const f of incoming) {
      const why = attachProblem(f, pending, limits);
      if (why) toast(why, 'error');
      else {
        startUpload(ownerId, f);
        pending++;
      }
    }
  };
  return {
    files,
    add,
    limits,
    uploading: files.some((f) => !f.ref && !f.error),
    failed: files.some((f) => f.error),
    ids: () => files.flatMap((f) => (f.ref ? [f.ref.id] : [])),
  };
}
