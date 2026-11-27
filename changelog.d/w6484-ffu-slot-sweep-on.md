- **Stale ffu slots are now freed by the daemon itself** (w6484's enforce step, after the warn-only #1500). When the slot
  report names a slot whose holder has stopped or is gone, the daemon runs `ffu-slot sweep`: unpushed work goes to a rescue
  branch first and the warm target stays (`staleOutput.ffuSlotSweep`, now `on` by default; lothsahn: "Turn it on
  everywhere: free stale slots by themselves."). The portal setting at `warn` or `off` takes it back with nobody at the machine.
