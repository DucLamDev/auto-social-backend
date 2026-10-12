# Local social authentication smoke test

`scripts/social-auth-smoke.ts` is a local diagnostic tool for the tab-delimited
`auth_v2.csv` export. It never uploads the file, writes credentials to the API
or database, saves browser state, captures screenshots, or publishes content.

The tool is deliberately single-account and dry-run by default. Supported
diagnostic adapters are currently `dev.to`, `Instagram`, and `Threads`.

```powershell
# Resolve one record without opening a browser.
corepack pnpm social:auth-smoke -- `
  --auth-file ..\auth_v2.csv `
  --platform Instagram `
  --ordinal 1

# Use the accountRef printed by the dry run to bind the live run to that account identity.
corepack pnpm social:auth-smoke -- `
  --auth-file ..\auth_v2.csv `
  --platform Instagram `
  --account-ref <12-character-ref> `
  --execute-live-login
```

Each invocation handles exactly one account and has no internal concurrency or
automatic retry. Do not start multiple live invocations at once. Live mode uses
a pinned public network proxy plus a fixed provider host allowlist. Password and TOTP values are
read only into the local process memory and are never logged. CAPTCHA, recovery,
SMS/email OTP, consent, and unfamiliar security screens stop with
`CHALLENGE_REQUIRES_HUMAN`; the tool does not bypass them.

This script is not a publishing connector. Production publishing should keep
using reviewed official API/OAuth connectors or the reviewed browser recipe
manifest. Do not import web passwords or TOTP seeds from the TSV into the API or
database.
