- **A person's hold on a machine drains its CI runners** (w5916; lothsahn: "Make it so a portal hold shuts down CI workers
  when they finish"). While `placement.hold` or a drain names a machine, its daemon suspends each self-hosted runner's
  listener once it is idle (a job in progress finishes first; an operations runner is never held), keeps them suspended across
  a daemon or portal restart, and resumes them when the hold lifts, or after 12 h without word from the portal. Runners a
  Dev Drive grow ended while held start on the lift. `list_machines`, `list_sandboxes` and the machine page say
  "runners draining (1 busy)" or "runners stopped by hold". No runner is deregistered or reconfigured. Needs a portal deploy
  and each machine's daemon update.
