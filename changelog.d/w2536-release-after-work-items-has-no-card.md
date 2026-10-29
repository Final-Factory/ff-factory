- **A release asked for after work items has no A-or-B card** (w2536; lothsahn: "If someone asks for a release after a
  workitem or set of work items, always build off the tip when those work items merge."; "Because they need to have those
  there."). `read_rules release` says so for both lanes: the release request is blocked on those items, bumps on master's
  tip once they have merged, and asks the person first if one closes without a merged change. Every other release keeps
  the card. Test: `w1639ReleaseLanes.test.ts`.
