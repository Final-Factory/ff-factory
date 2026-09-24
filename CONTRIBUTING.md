# Contributing

Thanks for looking. This is a tool built for one team's workflow and shared as-is, so please open
an issue before a large change to check it fits.

## Development

```bash
npm install && npm --prefix web install
npm test                                   # node --test server/*.test.ts
npm run typecheck && npm --prefix web run build
```

A throwaway `config.json` (set `FFSB_CONFIG` to its path) pointing `repo.url` at a local bare repo
and `unity.editorPath` at nothing is enough to run everything except Unity. See the Development
section of the README.

## Guidelines

- Keep changes focused, with a test for new server behaviour (`server/*.test.ts`).
- Never commit `config.json`, `data/`, real hostnames, usernames, tokens or paths from your
  machine. Use neutral examples (`C:/path/to/...`, `<host>.<tailnet>.ts.net`).
- Anything that widens what agents may do (guard rules, tool groups, permissions) needs a clear
  reason in the pull request.

By contributing you agree that your contributions are licensed under the MIT License
([LICENSE](LICENSE)).
