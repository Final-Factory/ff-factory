- **An instance's start-portal.sh raises its portal's node.exe even when the winpid it reads first names something else**
  (w6542): under Git Bash, `node ... &` is a forked bash.exe that then starts node.exe as its child, and a winpid read at
  once named that bash (1 of 25 starts on windows-latest), so the raise either failed (`could not open pid: error 87`,
  a red Windows test on #1504) or raised the bash and left the portal at its task's low priority. The raise now takes only a
  node.exe (that pid's node.exe child when it names the bash), and the script reads the winpid again, up to 5 times, while
  it names no process or no node.exe. Instances made before this keep their old start-portal.sh until it is written again.
