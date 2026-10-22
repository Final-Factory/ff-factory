- **No Windows Firewall prompts from node on worker machines** (w1742, lothsahn: "now we're making random folders under
  the temp directory and nodejs is triggering the windows firewall"). The tests' port check (`server/testPorts.ts`) bound
  0.0.0.0, 41 times in one `npm test` (measured on lothdesktop with a listen spy), and workers ran the suite with a node they
  unpacked into their session temp folder, so every session's new node path raised an "allow access" prompt over the
  unattended desktop. Now: the port check binds 127.0.0.1 only and finds a wildcard listener by connecting to it; the
  opsWorker test pipes and the web mock name their address; `server/listenLoopback.test.ts` fails any new listen on every
  address. On Windows the agent tools rollout puts a pinned node (v24.22.1, SHA-256 checked) at
  `<root>\tools\node\node.exe` and the daemon puts it first on its agents' PATH, so workers stop unpacking their own; the
  install's elevated firewall step gives that path an inbound rule (group "Final Factory agent node") and deletes the rules
  earlier prompts left for programs under `<root>\tmp`. Docs: worker-install.md ("The agent tools", step 8). Tests:
  `agentNode.test.ts`, `listenLoopback.test.ts`.
