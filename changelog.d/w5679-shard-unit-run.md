- **The Linux unit tests run in two shards** (w5679). One run of the whole suite took up to 541 s of its 10-minute
  watchdog; now each half runs on its own runner ("Unit tests (Linux, 1/2)" and "2/2"), and "Unit test coverage
  (Linux)" adds their coverage up into the one table (`scripts/lcov-merge.ts`). Typecheck and the web build are
  "Typecheck, build (Linux)".
