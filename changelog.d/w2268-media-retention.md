- **The portal's hourly clean-up removes the pictures and videos of conversations idle over 14 days** (w2268; lothsahn:
  "delete pictures and videos from transcripts older than 14 days"). It looks in the two places they live: the chat
  pictures in `data/uploads/<session>/` and the review folder with its `.preview/` copies. A worker's picture counts from
  the later of its file time and the session's last activity; a coordinator, standing or ops chat's picture counts from its
  own time; a review file counts from when it was published. Kept whatever their age: live, waiting or asking sessions,
  the sessions of open or stalled requests, review topics named for an open request, and any file an open request or
  pending question names. The page shows "[image removed after 14 days]" or "[video removed after 14 days]" where the
  file was, never a broken link. Transcript text, logs, the ledger and attachments stay. Each folder logs to
  `cleanup-log.jsonl` (rule `media`) with the bytes freed, and `portal_logs` `cleanup` shows the pass's "media retention"
  line with the inventory before. The setting is `hostGuard.cleanup.mediaDays` (default 14, 0 = never). Needs a portal deploy.
