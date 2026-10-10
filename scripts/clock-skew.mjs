// Moves the wall clock forward for a test run, to find tests that only pass in the month they were written (w858):
//   SKEW_DAYS=30 node --import ./scripts/clock-skew.mjs --test server/<file>.test.ts
// Only Date.now() and new Date() move; file modification times and timers do not, so tests that compare a file's mtime
// with the clock (retention, versioned writes, agentHost heartbeats) fail under it for that reason alone. A failure that
// names a date, or a request or record that "aged", is the kind to fix.
const off = Number(process.env.SKEW_DAYS || 0) * 86_400_000;
const RealDate = Date;
class SkewDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(RealDate.now() + off);
    else super(...a);
  }
  static now() { return RealDate.now() + off; }
}
globalThis.Date = SkewDate;
