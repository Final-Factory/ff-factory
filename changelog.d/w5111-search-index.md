- **Transcript search answers in well under a second instead of up to a minute** (w5111): `search_transcripts` (and the
  page's Search) read, unzipped and tested every transcript on every call, 52 to 62 s for a plain query over 4,058
  transcripts on 2026-11-22. A worker thread now keeps an index of them (server/searchIndex.ts): each transcript is cut
  into ~1 MB chunks, and each chunk keeps its byte range, the times of its first and last events and a bitset of the
  three-letter pieces it holds, no text. A search reads only the chunks in its time window and sessions that can hold
  every word, newest first, and stops once it has the newest `limit` hits; each line it reads is tested as before
  (`matchLine`, server/searchText.ts), so the answers are the same. The index is built 30 s after the portal starts and
  kept up to date every 2 minutes and before each search; it lives in memory only. Each search logs its time and the
  chunks it read (`transcript search: ...` in the portal's log).
