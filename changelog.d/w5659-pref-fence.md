- **macOS workers can be refused preference writes too** (w5659): daemon.json `"workerPrefFence": true` adds
  `(deny user-preference-write)` to the workers' Seatbelt profile. `defaults write`, EditorPrefs and PlayerPrefs reach
  `~/Library/Preferences` through cfprefsd, outside the sandbox, so the file rules never stopped them. Off when unset:
  macOS logs nothing for a sandbox rule, so there is no warn-only form. `machine_update worker_fence off` still turns the
  whole fence off. docs/worker-fence.md "Known limits" has the measurements.
