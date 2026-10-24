- **Transcript search no longer freezes the portal** (w2044): one `search_transcripts` call (or the page's Search) scanned
  every transcript synchronously and held the event loop 16 to 18 s at a time (stall profiles 2026-10-24 15:52 and 15:58Z),
  long enough for the daemons' links to go quiet. It now reads and unzips the files asynchronously and gives the loop back
  every 20 ms of scanning (`SEARCH_SLICE_MS`, server/search.ts); the answers are the same.
