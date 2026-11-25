- **Handed-up follow-ups never leave a merged request waiting for days** (w4352, lothsahn): follow-up requests a worker
  handed up (`hand_up_requests`, w2969) and nobody filed are sent again to the requester's orchestrator 2 h after the
  hand-up; until then the Waiting tab lists the request under "Orchestrators' backlog", not as a wait on a person. What
  happens at 12 h: w5577 below (FF Factory no longer files them itself). Needs a portal deploy.
