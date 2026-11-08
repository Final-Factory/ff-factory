- **`ff-leftovers` lists and ends a native program a Git Bash script left running in the background** (w3637, ben; found
  on w3454 on BEAST). A script's `python bench_queue.py timed ... &` lives on with the script's MSYS `bash.exe` as its
  Windows parent, and that bash shows no environment, so the python looked like the agent itself and `ff-leftovers end`
  said "None is left" while it kept waiting (pid 52636). A shell is now never taken for the agent host. Test:
  `leftovers.test.ts` (w3637).
