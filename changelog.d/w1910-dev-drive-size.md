- **A new Windows worker's Dev Drive is sized for its pool and never past what its disk holds** (w1910, lothsahn: "I just
  installed the agent on lothlaptop.  Why is the V: 1TB!?"; "The maximum should be based on the number of slots and agents
  and workers selected and anything else that goes into that"). The old default, 90 % of the install volume's size up to
  1 TB, made LothLaptop's drive 1 TB on a D: with about 870 GB free, and the host guard then refused every agent there. The
  maximum is now 44 GB a sandbox, 10 GB an agent, 38 GB shared and 20 GB of clean-up room (measured on LothDesktop; 112 GB
  for one sandbox with one agent), capped so the install volume keeps 30 GB or a tenth of its free space. `-DevDriveMaxGB`
  still sets it.
