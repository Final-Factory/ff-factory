- **CI's browser install gives up on a hung Ubuntu mirror after 4 minutes and tries once more** (w1758): w922 had this, and
  w1194's move back to GitHub's runners dropped it, so 3 WebKit jobs on 2026-10-22 sat in `apt-get update` until the job's
  20-minute timeout. The install takes 22 to 37 s median, 55 s at most when the mirror is well (60 jobs, measured).
  `scripts/e2e-legs.test.ts` now fails a ci.yml whose install step lacks the limit or the second try.
