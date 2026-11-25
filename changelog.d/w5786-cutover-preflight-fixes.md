- **`fffctl migrate --cut-over`'s tailnet preflight: a real route in the trustProxy refusal, and one gap closed** (w5786,
  from the review of #1252). The refusal said `fffctl configure`, which has no trustProxy option; it now says
  `set_app_config trustProxy true` on the VM's portal. A move with `--no-tailscale`, an https `*.ts.net` URL and
  `trustProxy` off in the VM's config passed and would then refuse every daemon (only Serve or the Funnel answers https
  on a ts.net name); it now stops with exit code 4 before anything is touched.
