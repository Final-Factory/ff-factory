- **`set_app_config claudeAccounts.dispatcher` promises a restart only when one is due** (w6093, a follow-up of w5921): a
  mid-turn dispatcher whose token already satisfied the new setting was told it "restarts there within 30 s", and nothing
  restarted (rightly). The answer now says "already runs on <token> of <pool>'s pool, which has room: nothing to restart".
  Needs a portal deploy.
