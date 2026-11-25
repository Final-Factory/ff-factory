- Machines: on Linux and macOS a timed run's player runs inside a write fence of its own (Landlock, Seatbelt) that lets it
  write only its run and build folders and the game's data root and player home inside the install; a leg is refused if
  the fence cannot run (w5564).
