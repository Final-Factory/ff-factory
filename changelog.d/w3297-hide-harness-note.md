- **A person's chat shows only what they wrote** (w3297; lothsahn: "When I ask questions, why does it show [held from previous
  turns] and a huge block of text?" and "hide that note from my chat"). The note FF Factory appends to a person's message for
  their orchestrator (the w1955 open questions and w3253 [for you] messages, the w830 held calls) still reaches the orchestrator
  in full, but their chat's bubble leaves it out (`shared/personMessage.ts`). The open questions now ride under their own header,
  "[FF Factory, not your person: your questions still open with them]"; "held from earlier turns" heads only the calls a gate
  held back.
