// Temporary (w521 measurement): per test file, the sum of its top-level tests' durations.
export default async function* fileTimes(source) {
  const per = new Map();
  for await (const ev of source) {
    if ((ev.type === 'test:pass' || ev.type === 'test:fail') && ev.data.nesting === 0 && ev.data.file && ev.data.details?.type !== 'suite') {
      const f = ev.data.file.replace(/\/g, '/').replace(/^.*?\/(server|scripts|machine)\//, '$1/');
      const e = per.get(f) ?? { ms: 0, n: 0, max: 0 };
      e.ms += ev.data.details.duration_ms; e.n++; e.max = Math.max(e.max, ev.data.details.duration_ms);
      per.set(f, e);
    }
  }
  const rows = [...per].sort((a, b) => b[1].ms - a[1].ms);
  let total = 0;
  for (const [, e] of rows) total += e.ms;
  yield `files ${rows.length}, summed ${(total / 1000).toFixed(1)} s\n`;
  for (const [f, e] of rows) yield `${(e.ms / 1000).toFixed(1).padStart(7)} s  ${String(e.n).padStart(3)} tests  max ${(e.max / 1000).toFixed(1).padStart(6)} s  ${f}\n`;
}
