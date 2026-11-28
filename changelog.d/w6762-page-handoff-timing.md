- **Where a page connect's seconds go** (w6762): each page socket connect now logs the page's and the server's clocks at
  each step (the upgrade's arrival against the page's attempt start, the open, the first state's hand-off and its arrival
  at the page), ws's deflate of the first state (queue, run, chunks, the kernel write after it), the thread pool's lag
  and the VM's CPU over the connect (vm, steal, node, tailscaled). After w6336 reconnects still waited 3-9 s to open and
  3-10 s for the first state with the server's build at 0.1-0.5 s; this says which of the network, the thread pool and
  the CPU holds them, before a fix is chosen.
