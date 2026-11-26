- **The rerun guard counts a Linux OOM kill as out of memory** (w6140): on attempt 1, a step whose process was SIGKILLed
  (bash's `Killed`, exit code 137, or cargo's signal 9) may be rerun once when the job's runner-health step shows swap
  under 1 % free or available memory under 5 % of RAM, and no test failed (ffu run 45857906682 on ffu-biscuit-2). A kill
  without that memory evidence is still a real failure.
