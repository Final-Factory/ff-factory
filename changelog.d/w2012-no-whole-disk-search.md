- **Workers know where the plugin scripts are, and may not search a whole disk for them** (w2012, lothsahn: "Stop messing
  with my c:"). Workers hunting for unity-ui's `ui_look.py` or evidence-gate's `pr_evidence.py` ran `find / -name ui_look.py`,
  which walked all of C: on LothDesktop at about 0.95 cores (w1894's measurement) and ran on m5 too. Every worker now starts
  with `FF_AGENTS_PLUGIN` and `FF_SKILLS` (the ff-agents plugin folder Claude Code loaded, read from
  `installed_plugins.json` on the machine at launch, else FF Factory's own `tools/final-factory-agents` checkout;
  `server/pluginPaths.ts`), and its brief says `python "$FF_SKILLS/unity-ui/ui_look.py"`. The sandbox guard refuses, on
  every OS, find / fd / rg / grep -r / du / tree / ls -R / Get-ChildItem -Recurse / cmd `dir /s` / `where /r` and the Grep
  and Glob tools over `/`, a drive (`C:\`, `/c`, `/cygdrive/c`, `/mnt/c`), every user's folder or a home folder, and its
  message names `$FF_SKILLS`; searches in the sandbox, `$TMPDIR` and the install folder pass (`server/wholeDiskSearch.ts`).
  Applies to workers started after the machine's daemon update. Tests: `wholeDiskSearch.test.ts`.
