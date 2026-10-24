- **A daemon's connect looks up its sessions' last events 200 at a time, a slice per loop turn** (w2026): a machine lists every
  session it ever ran, and the first minute after 738ed3ad2's start spent 12.8 s in that lookup, so the daemons' 8 s handshakes
  timed out and each machine reconnected up to 8 times. CONTRIBUTING.md "Performance" now says how to keep the loop free.
