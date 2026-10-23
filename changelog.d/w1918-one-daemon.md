- **One daemon per machine** (w1918). LothLaptop had three daemons answering its Unity slots mailbox after its updates. An
  update's stop now fails, naming the pids, instead of starting a new daemon beside one that would not die. A daemon that
  sees a newer daemon of the same machine on its mailbox ends, and its supervisor does not start it again (exit code 75).
  Tests: `unitySlots.test.ts`, `machineDeployWin.test.ts`.
