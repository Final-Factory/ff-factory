- **A person's hold of a computer is set at once, and every hold or setting change is read back** (w5895). lothsahn's
  "Hold new work on LothDesktop and let the running workers finish" (22:08 UTC) was held only at 03:47: the dispatcher's
  setting changes were refused, and the worker that asked had no hold tool. Now the orchestrator records the hold with
  `update_work hold`. It is set in the person's own turn; otherwise the dispatcher's `hold_machine` for that request
  goes through, and system_status shows "HOLD ASKED, NOT SET" until it is set. A worker's "needs the hold set by the
  orchestrator" goes to the orchestrator as an [orchestrator step]. `hold_machine`, `update_work hold` and
  `set_app_config` read the live state back, and a mismatch is an error. The read-back names each excepted request with
  no running worker, and when it will resume ("w5475: stopped; will resume here at its check-in 04:39Z"). A drain now
  lets only the workers running when it was set finish (`resumes: running`, the default). For now that is warn-only: a
  resume against it is logged and shown, not held.
