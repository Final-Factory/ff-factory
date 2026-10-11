- **The portal follows a root install's sandbox folder when the daemon moves it** (w1038): after the Dev Drive move `list_machines` and
  `list_sandboxes` still gave LothDesktop's root as `D:\work\ffw\sandboxes` (the junction) and every welcome sent that back to the daemon,
  overriding its `daemon.json` (the pool root, and the seed copy mode `clone`). `adoptLayout` now takes the daemon's pool folder, seed and
  copy mode when the folder differs, and sends the pool again. Needs a portal deploy.
