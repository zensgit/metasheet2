# Bridge Agent Readonly BA-M1 Verification

Date: 2026-05-21

## Local Verification

Commands run from repo root:

```bash
node --test scripts/ops/bridge-agent-readonly-contract.test.mjs
git diff --check origin/main...HEAD
```

Secret-shape scan over the six changed files:

```bash
node <<'NODE'
const fs = require('node:fs');
const files = [
  'scripts/ops/bridge-agent-readonly.ps1',
  'scripts/ops/bridge-agent-readonly-contract.test.mjs',
  'scripts/ops/fixtures/bridge-agent-readonly/config.example.json',
  'docs/operations/bridge-agent-readonly-runbook-20260521.md',
  'docs/development/bridge-agent-readonly-development-20260521.md',
  'docs/development/bridge-agent-readonly-verification-20260521.md',
];
const patterns = [
  new RegExp('Bearer ' + '[A-Za-z0-9]'),
  new RegExp('ey' + 'J[A-Za-z0-9_-]{6,}\\.'),
  new RegExp('postgres' + '://[^<\\s]+'),
  new RegExp('METASHEET_BRIDGE_SQL_' + 'PASSWORD=.'),
  new RegExp('Pass' + 'word=.*;'),
];
let hits = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      console.error(`${file}: ${pattern}`);
      hits++;
    }
  }
}
process.exit(hits === 0 ? 0 : 1);
NODE
```

## Contract Matrix

| Check | Evidence |
| --- | --- |
| Localhost-only binding | Contract test asserts `127.0.0.1` and non-localhost rejection marker. |
| Windows-native provider | Contract test asserts `System.Data.SqlClient.SqlConnection`. |
| No raw SQL endpoint | Contract test asserts `RAW_SQL_REJECTED` and no write SQL statement markers. |
| Object allowlist | Config test asserts only `material`, `bom`, `bom_child`. |
| Readonly query shape | Contract test asserts `SELECT TOP $Limit` plus quoted identifier helper. |
| Secrets outside config | Config test asserts username/password/header secrets are environment-variable names only. |
| Error redaction | Contract test asserts redaction helpers, nested exception traversal, and sensitive data markers. |

## Windows Host Validation

This was not executed on the macOS development host. The operator must run the
commands in `docs/operations/bridge-agent-readonly-runbook-20260521.md` on the
MetaSheet on-prem Windows bridge host after local SQL credentials are provided.

Required live results:

- `-ValidateConfigOnly` prints config validation passed.
- `/health` returns `ok=true` and `databaseReachable=true`.
- `/objects` returns only allowlisted objects.
- `/schema/material`, `/schema/bom`, `/schema/bom_child` return safe schemas.
- `/query/material` returns at most the requested capped rows.
- unknown object, raw SQL, filters, and excessive limit requests fail.
- no token, password, connection string, host, database name, or SQL username is
  copied into issue comments, PRs, screenshots, or artifacts.

## Local Result

| Command | Result |
| --- | --- |
| `node --test scripts/ops/bridge-agent-readonly-contract.test.mjs` | PASS, 4/4 |
| `git diff --check origin/main...HEAD` | PASS, rc=0 |
| `command -v pwsh` | unavailable on the macOS dev host; Windows live validation is delegated to the runbook |
| secret-shape scan | PASS, 0 hits |
