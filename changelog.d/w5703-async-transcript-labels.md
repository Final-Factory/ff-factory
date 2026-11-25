- **Turning on `workerTranscriptLabels` no longer takes the machine offline for minutes** (w5703): the daemon's first lock
  of the transcripts (and the way back) ran a few hundred icacls calls synchronously on its main loop; on BEAST that held
  heartbeats about 5.5 minutes and the portal showed it offline. Each call now runs through the daemon's asynchronous exec,
  one at a time, and heartbeats go on meanwhile (docs/transcript-seal.md). Needs a daemon update.
