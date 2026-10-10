- **CI: a push to `main` runs only the secret scan and the identity check** (w925, lothsahn: "3B"). Pull requests keep
  the whole suite; the VM, Windows, worker-update and Dev Drive workflows no longer run on a push to `main`; the nightly
  VM run and the daily Windows suite stay; each push to `main` is its own concurrency group, so none is cancelled. The
  whole suite on `main` by hand: `gh workflow run ci.yml --ref main`. docs/ci.md, "What runs where".
