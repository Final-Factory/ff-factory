- **Pair briefs: an old line's run takes master's whole nightly runner (w6154).** The leg brief told a worker whose
  commit's ffnightly.py lacked a flag to write master's ffnightly.py over it. On a 0.50 (pre-1.0) commit, master's
  runner imports modules that line does not have (lab.py:35 `import winstop`, and balance_lane, combat_damage,
  desync_reports, lane_settings, player_cache, reach), so w6122's leg failed at once on 48f1fbab. PLAYERS_IN_SANDBOX
  now fetches master's scripts/nightly/use_master_runner.sh into $TMPDIR and runs `apply` before the run and `restore`
  after it. The script overlays every top-level scripts/nightly *.py and *.json and removes what it added, so the brief
  does not go stale when master adds a module.
