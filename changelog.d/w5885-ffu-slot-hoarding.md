- **A stale worker gives its ffu slot up, and a worker with no slot waits instead of building in its temp folder** (w5885,
  lothsahn: "Clean up stale ones and fix how stale workers held on to slots. Update instructions so workers block on those
  slots instead of doing builds in temp directories"). A slot's holder now loses it once it is on no open request, once it
  stopped or waits and left the slot unused for 30 min, or once the slot went unused for 2 h; any work it left is committed
  and kept on branch `rescue/ffu-slot/<slot>-<holder>-<sha8>`, pushed to origin, and the holder is told on its next take.
  `ffu-slot take` with no free slot exits 4 and says to wait (`take --wait <minutes>`, or a wake_me check-in), no longer
  "Build in your temp folder this time". `ffu-slot sweep` frees every slot that may be taken now. Why the limits:
  docs/ffu-sandboxes.md.
