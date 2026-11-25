- **The daemon and the agent host run only a trusted bench_queue.py** (w5572, from w5542's audit): their own bench
  tickets (timed runs, editor boots, the editor bench gate) ran the copy of highest `RULES_VERSION` among the sandboxes,
  which workers can write. They now run the game repo's master copy, fetched with `gh api` into the daemon's folder
  (`<appDir>/trusted/bench/bench_queue.py`, again after 10 minutes), with `python -s`, no `PYTHON*` settings, python
  resolved outside the worker root, and fsmonitor off for the git it runs. `unity-slot run`, inside the worker's fence,
  is unchanged. Needs a portal deploy (daemons update themselves after it).
