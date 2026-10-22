- **The agent node's firewall rule reaches the machines** (w1742). #517's rule for `<root>\tools\node\node.exe` was made
  only by the install's elevated firewall step, which a daemon update skips, so it reached neither lothdesktop nor BEAST
  (lothdesktop after b3c106c: no rule names the node, six rules from old temp-node prompts left). The agent tools run now
  checks every player slot's and the node's rule (`firewallCheckScript`, no admin rights needed) and, elevated, makes the
  missing ones with `firewall.ps1`; over the daemon's link it cannot, so the rollout runs the tools form again over the
  portal's ssh, elevated for an administrator's account, and the report names any rule still missing. Docs:
  worker-install.md ("The agent tools", step 9). Tests: `agentNode.test.ts`, `machineRollout.test.ts`.
