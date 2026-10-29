import { useEffect, useMemo, useState } from 'react';
import { REPORT_KINDS, type AppState, type Report, type ReportHit, type ReportKind, type ReportSummary } from '../../../shared/types';
import { api } from '../api';
import { attempt } from '../store';
import { fmtBytes, fmtRelative, href, lsGet, lsSet, navigate, PLAIN_TEXT } from '../util';
import { attachmentUrl } from './Attachments';
import { fileUrl } from './Images';
import { LocalImages, Markdown } from './Markdown';
import { Icon } from './ui';

/** A report's kind in words (w2541, docs/reports.md). */
export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  analysis: 'Analysis',
  profile: 'Profile',
  investigation: 'Investigation',
  'root-cause': 'Root cause',
  design: 'Design',
  research: 'Research',
  other: 'Other',
};

/** A time to the minute: seconds are noise on a report. */
const STAMP: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
const operators = (r: ReportSummary) => r.requesters.map((p) => p.displayName).join(', ') || 'nobody named';

/** The dates the list can go back to: everything, or the last week, month or quarter. */
const SINCE_DAYS = [
  { days: 0, label: 'Any date' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const;

const sinceIso = (days: number, now: number) => (days ? new Date(now - days * 86_400_000).toISOString() : undefined);

/** One saved filter of the list, kept in this browser across reloads like the request list's states (w418). */
function useSaved(key: string): [string, (v: string) => void] {
  const storage = `ffsb.reports.${key}`;
  const [v, setV] = useState(() => lsGet(storage) ?? '');
  return [
    v,
    (next: string) => {
      setV(next);
      lsSet(storage, next);
    },
  ];
}

/**
 * The Reports tab (w2541, docs/reports.md): every report a worker filed (a design, an analysis, a profile), newest first,
 * as the request list shows requests, each with the operator who asked for it. Filters by kind, operator, request and
 * date run here on the summaries; words go to the server's full-text search, which also returns the matching lines.
 */
export function ReportsTab({ app, now }: { app: AppState; now: number }) {
  const all = app.reports ?? [];
  const [kind, setKind] = useSaved('kind');
  const [person, setPerson] = useSaved('person');
  const [request, setRequest] = useState('');
  const [since, setSince] = useSaved('since');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ReportHit[] | null>(null);
  const days = Number(since) || 0;
  const people = useMemo(() => [...new Set(all.flatMap((r) => r.requesters.map((p) => p.displayName)))].sort((a, b) => a.localeCompare(b)), [all]);
  const counts = useMemo(() => {
    const n = new Map<ReportKind, number>();
    for (const r of all) n.set(r.kind, (n.get(r.kind) ?? 0) + 1);
    return n;
  }, [all]);
  const words = q.trim();
  const req = request.trim().toLowerCase();

  // Words: the server searches every report's whole text (and its latest revision) with the same filters.
  useEffect(() => {
    if (!words) {
      setHits(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      const found = await attempt(api.searchReports({ q: words, kind, person, request: req, since: sinceIso(days, Date.now()) }));
      if (live && found) setHits(found);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [words, kind, person, req, days, all]);

  const from = sinceIso(days, now);
  const shown: ReportHit[] = hits
    ? hits
    : all
        .filter((r) => (!kind || r.kind === kind) && (!person || r.requesters.some((p) => p.displayName === person)) && (!req || r.workId.toLowerCase() === req || r.workTitle.toLowerCase().includes(req)) && (!from || r.updatedAt >= from))
        .map((report) => ({ report, snippet: '' }));
  const filtered = !!(kind || person || req || days || words);

  if (!all.length) {
    return (
      <div className="panel-empty" data-testid="reports-empty">
        <Icon name="inbox" size={28} />
        <p>No reports yet.</p>
        <p className="dim small">When someone asks for a design, an analysis or a profile, its worker files the result here as a report, tagged with who asked.</p>
      </div>
    );
  }
  return (
    <div className="sa-scroll" data-testid="reports-tab">
      <div className="report-filters">
        <input {...PLAIN_TEXT} type="search" className="input report-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the reports’ text…" aria-label="Search the reports’ text" enterKeyHint="search" data-testid="reports-search" />
        <select className="input" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Asked by" data-testid="reports-person">
          <option value="">Anyone</option>
          {people.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input {...PLAIN_TEXT} className="input report-request" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Request (w…)" aria-label="Request" data-testid="reports-request" />
        <select className="input" value={String(days)} onChange={(e) => setSince(e.target.value === '0' ? '' : e.target.value)} aria-label="Date" data-testid="reports-since">
          {SINCE_DAYS.map((d) => (
            <option key={d.days} value={d.days}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <div className="ledger-states" role="toolbar" aria-label="Show reports of one kind" data-testid="reports-kinds">
        <button className={`ledger-state${!kind ? ' on' : ''}`} aria-pressed={!kind} onClick={() => setKind('')}>
          All <span className="mono">{all.length}</span>
        </button>
        {REPORT_KINDS.filter((k) => counts.get(k) || kind === k).map((k) => (
          <button key={k} className={`ledger-state${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(kind === k ? '' : k)} data-testid={`reports-kind-${k}`}>
            {REPORT_KIND_LABEL[k]} <span className="mono">{counts.get(k) ?? 0}</span>
          </button>
        ))}
        {filtered && (
          <button
            className="link-btn small"
            onClick={() => {
              setKind('');
              setPerson('');
              setRequest('');
              setSince('');
              setQ('');
            }}
          >
            Clear
          </button>
        )}
      </div>
      {shown.length ? (
        <div className="run-list" data-testid="reports-list">
          {shown.map((h) => (
            <ReportRow key={h.report.id} r={h.report} snippet={h.snippet} now={now} />
          ))}
        </div>
      ) : (
        <p className="dim small ledger-none">No report matches.</p>
      )}
    </div>
  );
}

function ReportRow({ r, snippet, now }: { r: ReportSummary; snippet: string; now: number }) {
  return (
    <div className="run-row work-row report-row" data-testid={`report-${r.id}`}>
      <a className="run-row-top" href={href({ view: 'dispatcher', tab: r.id })}>
        <span className="work-main">
          <span className="work-title">{r.title}</span>
          <span className="work-sub">
            <span className="tone-blue">{REPORT_KIND_LABEL[r.kind]}</span> · asked by <strong data-testid={`report-operator-${r.id}`}>{operators(r)}</strong> · {r.workId} {r.workTitle}
            {r.revisions > 1 ? <span className="dim"> · {r.revisions} revisions</span> : null}
          </span>
          {snippet ? <span className="work-sub report-snippet">{snippet}</span> : r.excerpt ? <span className="work-sub report-snippet dim">{r.excerpt}</span> : null}
        </span>
        <span className="work-side">
          <span className="run-cost dim" title={new Date(r.updatedAt).toLocaleString(undefined, STAMP)}>
            {fmtRelative(r.updatedAt, now)}
          </span>
        </span>
      </a>
    </div>
  );
}

/** Media a report keeps is served from /api/reports/…; any other local path it names is read as its worker's session would. */
const reportImage = (sessionId: string | undefined) => (p: string) => (p.startsWith('/api/reports/') || !sessionId ? p : fileUrl({ session: sessionId }, p));

/**
 * One report's page (w2541): its Markdown with its stills and clips, who asked for it, the request it answers (a link
 * back), and every revision, each readable.
 */
export function ReportPage({ app, id, now }: { app: AppState; id: string; now: number }) {
  const summary = app.reports?.find((r) => r.id === id);
  const [rev, setRev] = useState<number | undefined>(undefined);
  const [report, setReport] = useState<Report | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await attempt(api.report(id, rev));
      if (live) setReport(r ?? null);
    })();
    return () => {
      live = false;
    };
    // A new revision filed while open (the summary's updatedAt) shows at once.
  }, [id, rev, summary?.updatedAt]);
  const back = (
    <a className="link-btn small" href={href({ view: 'dispatcher', tab: 'reports' })} data-testid="report-back">
      <Icon name="back" size={13} /> All reports
    </a>
  );
  if (report === undefined) return <div className="sa-scroll report-page">{back}</div>;
  if (!report) {
    return (
      <div className="sa-scroll report-page">
        {back}
        <p className="dim small">There is no report {id}.</p>
      </div>
    );
  }
  const latest = report.history.length;
  const work = app.work?.find((w) => w.id === report.workId);
  return (
    <div className="sa-scroll report-page" data-testid={`report-page-${report.id}`}>
      {back}
      <header className="report-head">
        <h3 className="report-title">{report.title}</h3>
        <p className="small report-meta">
          Report {report.id} · <span className="tone-blue">{REPORT_KIND_LABEL[report.kind]}</span> · asked by <strong data-testid="report-operator">{operators(report)}</strong> · for{' '}
          <a href={href({ view: 'dispatcher', tab: report.workId })} data-testid="report-request">
            {report.workId} {work?.title ?? report.workTitle}
          </a>
        </p>
        <p className="small dim report-meta">
          Filed {new Date(report.createdAt).toLocaleString(undefined, STAMP)}
          {latest > 1 ? ` · revised ${fmtRelative(report.updatedAt, now)}` : ''}
          {latest > 1 && (
            <>
              {' · '}
              <select className="input" value={report.rev} onChange={(e) => setRev(Number(e.target.value) === latest ? undefined : Number(e.target.value))} aria-label="Revision" data-testid="report-revision">
                {[...report.history].reverse().map((h) => (
                  <option key={h.n} value={h.n}>
                    Revision {h.n} of {latest}
                  </option>
                ))}
              </select>
            </>
          )}
        </p>
        {latest > 1 && (
          <p className="small dim report-meta" data-testid="report-revision-note">
            {(() => {
              const h = report.history.find((x) => x.n === report.rev);
              return h ? `Revision ${h.n}, ${new Date(h.at).toLocaleString(undefined, STAMP)}${h.note ? `: ${h.note}` : ''}` : null;
            })()}
          </p>
        )}
        {report.rev < latest && (
          <p className="small tone-amber">
            An older revision.{' '}
            <button className="link-btn small" onClick={() => setRev(undefined)}>
              Show the latest
            </button>
          </p>
        )}
      </header>
      <LocalImages.Provider value={reportImage(report.sessionId)}>
        <div className="report-body">
          <Markdown text={report.body} />
        </div>
      </LocalImages.Provider>
      {report.attachments.length > 0 && (
        <div className="report-attachments small">
          <span className="dim">Attachments</span>
          {report.attachments.map((a) => (
            <a key={a.id} href={attachmentUrl(a.id)} download={a.name}>
              <Icon name="paperclip" size={13} /> {a.name} <span className="dim">{fmtBytes(a.size)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** The reports a request links to (w2541), for its row's detail: a link to each. */
export function WorkReports({ reports }: { reports: { id: string; title: string; kind: ReportKind }[] }) {
  return (
    <p className="small" data-testid="work-reports">
      Reports:{' '}
      {reports.map((r, i) => (
        <span key={r.id}>
          {i ? ', ' : ''}
          <a
            href={href({ view: 'dispatcher', tab: r.id })}
            onClick={(e) => {
              e.preventDefault();
              navigate({ view: 'dispatcher', tab: r.id });
            }}
          >
            <span className="mono">{r.id}</span> {r.title}
          </a>
        </span>
      ))}
    </p>
  );
}
