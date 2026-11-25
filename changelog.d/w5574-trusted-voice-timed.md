- **The daemon no longer runs the voice python or a timed run's player from what a worker could plant** (w5574, from
  w5542's audit): the voice tools moved from `<root>/voice` to the daemon's folder (`<root>/daemon/voice`, reinstalled
  there by itself on a machine with voice on, after which the old folder is removed), and a toolsDir or uvPath elsewhere
  in the worker root is refused. A timed run keeps a laid-out build, and starts each leg's player, only when the folder
  holds exactly the order's bytes (every piece's SHA-256, no extra file), not just the same sizes. Needs a portal deploy
  (daemons update themselves after it).
