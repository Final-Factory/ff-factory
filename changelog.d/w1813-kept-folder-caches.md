- **Low disk now frees the rebuildable caches in worker folders the clean-up keeps, within minutes** (w1813, ben: "This
  applies on low disk at once"). While free space is below the soft threshold (or a person asks for a pass with
  machine_cleanup), a stopped worker's `tmp/ffa-<session>` that nothing wrote to for 15 minutes loses its player builds,
  the release tars urgent_release.py stages (six of about 2 GB per release), a Unity project's Temp, obj and Logs and its
  Library build caches (Bee, BuildCache, BurstCache and the like), `node_modules` and digested Profiler captures. A whole
  Library still waits for the 24 h of no activity (w1719), and so does everything else when disk is not low. A folder of
  game clones is no longer judged active for good because it holds more than 200,000 entries: the last-write check sees
  a cache or a Library only by its top and skips git's objects. A Unity lockfile no process names (a crashed editor's) no
  longer keeps its project's caches. Measured on beast: 70.5 GB of the 89 worker folders would go on low disk; at the
  24 h age 2.7 GB.
