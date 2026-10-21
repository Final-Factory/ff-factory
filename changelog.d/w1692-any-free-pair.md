- **A determinism check runs on any two free machines; a cross-OS pair only when the change can differ by platform**
  (w1692, lothsahn: "We should only schedule a cross os determinism check if truly needed. There's only one m3 and m5 is
  often offline", and "Not windows by default, any OS.  Being particular about a machine or OS limits the fleet we can
  use."). One bullet in the orchestrators' and the dispatcher's briefs (`server/agents.ts`) and the intake rule's class 2
  check (`server/intakeRules.ts`); the full rule is the ff-agents evidence-gate lesson.
