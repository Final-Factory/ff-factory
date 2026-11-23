- **A sandbox editor's start turns Unity's user-wide Burst setting back on when it finds it off, and says so** (w5270;
  lothsahn's rule: test runs keep Burst on). Burst keeps "Enable Compilation" in the user-wide EditorPref
  `BurstCompilation`, read by every editor of that user on the machine. The game's automation launcher used to switch it
  off "for the session", and BEAST's sandbox editors then ran their tests with managed jobs on 2026-11-22/23 (found by
  w5250); m5's pref was off too. Before each start the daemon reads it (macOS `defaults` domain
  `com.unity3d.UnityEditor5.x`, Windows `HKCU\Software\Unity Technologies\Unity Editor 5.x\BurstCompilation_h2739774030`,
  Linux `~/.local/share/unity3d/prefs`), sets an explicit 0 back to 1, and logs `sandbox <id>: Unity's user-wide
  EditorPref BurstCompilation was 0 ...` in the daemon log and the start's answer. Missing or on is left alone; a
  failed check never stops the start (machine/burstPref.ts). Needs a daemon update on each machine.
