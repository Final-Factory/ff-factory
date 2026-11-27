- **An urgent 0.50.x release sets pre-release live, as FFBox's lane does** (w6534, after w6522; lothsahn: "Can it set
  that whenever a .50 release is made?"). `steam_upload` action upload now takes `live: "pre-release"` for a pre-1.0 main
  release whose version starts `0.50.`, and refuses it for any other: a master release, a 1.0 version, the demo
  (`liveBranchesFor`, server/steamUpload.ts). The daemon refuses it again for a version other than 0.50.x
  (machine/steamUpload.ts `LIVE_VERSIONS`), and ffbox's ffsteam.py a third time. Default and every other branch stay a
  person's. Needs a portal deploy and each machine's daemon update. Docs: steam-upload.md, ffbox.md. Tests:
  `server/steamUpload.test.ts`, `machine/steamUpload.test.ts`.
