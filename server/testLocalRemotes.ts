// w6099: a test whose checkouts push to or fetch from a bare repository in a temp folder imports this, so the remote guard
// (server/remoteGuard.ts) lets those local origins through in its process. Imported by test files and test kits only; no
// daemon or portal module imports it, and remoteGuard.test.ts, which tests the guard itself, does not.
(globalThis as { ffTestLocalRemotes?: boolean }).ffTestLocalRemotes = true;
