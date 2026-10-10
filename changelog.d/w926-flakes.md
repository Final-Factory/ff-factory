- The flaky unit tests and nested-VM failures w922 counted were all fixed before w926 looked (w636, w513, w568, w753,
  w759, w537): docs/ci.md names each cause and fix, and how to check a failure's commit against its fix before counting
  it. `durable.test.ts` runs the steady-stream test with a 500 ms fsync too, the Windows runners' failure, on every pull
  request (w926).
