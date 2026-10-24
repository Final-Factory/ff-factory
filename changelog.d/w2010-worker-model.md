- **Workers start on Opus at medium effort; a Sonnet worker needs a stated reason** (w2010, lothsahn: "workers should be
  opus medium thinking", then "if the dispatcher is confident the task is small, it can start a sonnet worker
  directly"). The built-in defaults are now `defaultModel` `opus` and `worker.effort` `medium`. `start_agent` refuses an
  orchestrator's non-default `model` without `model_reason` (`small: <why it is sure>` or `asked: <the person's words>`),
  and the request's log and the start reply carry it. The dispatcher's brief says what "small" means.
