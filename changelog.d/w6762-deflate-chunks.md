- **Page connects no longer wait on 16 KB deflate pieces** (w6762): the page socket's zlib buffer is 256 KB, not 16 KB,
  so a first state is deflated in a few thread-pool jobs instead of one per 16 KB of output. The first timed connects
  after a restart spent 8.2 s of 9.0 s (638 KB, 15 chunks) and 21.0 s of 22.1 s (4.7 MB, 77 chunks) in that deflate;
  locally, with the pool and the loop kept busy, 4.7 MB now goes out in 0.3 s instead of 1.8 s.
