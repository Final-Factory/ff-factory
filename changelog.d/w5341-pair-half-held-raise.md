- **A pair run holding its Unity slot on one machine goes one priority level up for its slot on the other** (w5341;
  lothsahn: "When work needs a two machine run for any reason and it's already got a slot on one machine, raise it a
  priority level for getting the other machine slot so that the pair can get running"). The portal marks the waiting leg
  one level up in its machine's priorities.json while a leg elsewhere holds its side, for the slot queue and w5324's
  preemption alike, and drops it once that side lets go. The waiting reason says "raised one level (normal → high): pair
  half-held". A held side counts one level up as a preemption victim, and only an older pair may take a younger pair's
  idle held side, so two crossed pairs neither swap sides forever nor deadlock (docs/unity-lifecycle.md, "Unity slots").
