- **Workers compact before a long wait** (w1469, lothsahn: "compact before long waits"). A turn that ends with the worker waiting
  on a person, another request, a merge or a deploy, or on a check-in 55 minutes or more away compacts it right away, while its
  cache is warm, when its context is 100,000 tokens or more (`worker.compactBeforeWaitTokens`, 0 off). After the cache's hour
  the conversation is then written again small, not whole: on beast those rewrites cost $79 more than reading in 3 days
  (measured), and the compaction before waits alone is modelled at -22% of the workers' spend. CI waits are left out (they come
  back within the hour as a rule). The same pilot as the 200,000-token compaction. Tests: `workerCompact.test.ts`.
