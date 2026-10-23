- **A Dev Drive grow starts from what the VHDX really is, and the disk guard counts the new maximum at once** (w1947). An
  update that asks for a larger maximum writes the VHDX's own maximum into devdrive.json next to the wanted one, so a stale
  record (LothLaptop's said 1024 GB for an 80 GB drive) cannot keep the daemon from growing it; after the grow, the host
  guard judges the VHDX's room by the new maximum instead of daemon.json's old one until the next update.
