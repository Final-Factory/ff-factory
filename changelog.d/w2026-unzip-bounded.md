- **A daemon's connect after a start unzips one compressed transcript at a time, by a stream** (w2026): the first start after
  the tail files came has none beside the older `.gz` files, and every machine's connect asked at once, each unzipping a whole
  transcript into memory. `scripts/release-pass-bench.ts` times one release pass over a production-sized ledger (local only).
