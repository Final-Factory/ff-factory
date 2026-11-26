- **A read fence switch no longer reports a timeout it did not have** (w6089): `machine_daemon` read-fence-on/-warn/-off
  waited 60 s, but a Windows daemon answers only after setting its No-Read-Up labels, which took up to 3 min 13 s on BEAST.
  The portal now waits up to 10 minutes for those actions. Needs a portal deploy.
