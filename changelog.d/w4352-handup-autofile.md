- **Handed-up follow-ups never leave a merged request waiting for days** (w4352, lothsahn): follow-up requests a worker
  handed up (`hand_up_requests`, w2969) and nobody filed are sent again to the requester's orchestrator 2 h after the
  hand-up, and 12 h after it FF Factory files them itself as the requester's low-priority requests, related to the source
  request. Each is first checked against open and recently done work like an FFBox dev request; one already covered is
  dropped with a note naming what covers it. The source request then closes on its kept DONE, stalled ones included.
  Until then the Waiting tab lists the request under "Orchestrators' backlog", not as a wait on a person. Needs a portal
  deploy.
