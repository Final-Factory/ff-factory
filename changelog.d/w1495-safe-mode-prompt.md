- **A sandbox editor never sits on Unity's "Enter Safe Mode?" prompt** (w1495, ben: "keeps happening you should be able
  to get past this"). The dialog watch still presses "Ignore" when it can see the dialog (measured on Windows: pressed 7 s
  after it appeared). When nothing presses it, a Mac's watch paused by a locked screen or a sleeping display, a Mac without
  Accessibility, Linux with no watch, the watch now reads the prompt from the editor log (it stands still on
  `AssetDatabase: script compilation time:` after a `## Script Compilation Error for:` block, with no domain load since
  the boot's refresh). After 90 s it closes the editor and sends its workers the `error CS` lines, also shown in
  `unity status`, instead of leaving an editor whose bridge never comes up. No launch argument or setting can do it: an
  interactive editor launched with `-ignoreCompilerErrors` still showed the prompt, and the "Show Enter Safe Mode Dialog"
  preference only swaps the prompt for Safe Mode itself, where the bridge does not load. Applies at each machine's next
  daemon update. Docs: unity-dialogs.md ("Decisions", Safe Mode). Tests: `safeModePrompt.test.ts`.
