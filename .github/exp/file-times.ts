// w5619 scaffolding: print each test file's wall time (its file-level test event).
export default async function* fileTimes(source: AsyncIterable<{ type: string; data?: any }>): AsyncGenerator<string> {
  const rows: [number, string][] = [];
  for await (const e of source) {
    const d = e.data;
    if (e.type === 'test:complete' && d && d.nesting === 0 && typeof d.name === 'string' && d.name.endsWith('.test.ts')) {
      rows.push([d.details?.duration_ms ?? -1, d.name]);
    }
  }
  rows.sort((a, b) => b[0] - a[0]);
  yield `FILETIMES ${rows.length} files\n`;
  for (const [ms, n] of rows) yield `FILETIME ${(ms / 1000).toFixed(1)} ${n}\n`;
}
