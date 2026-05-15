# K3 WISE On-Prem Preflight Session ID Verification - 2026-05-15

## Verification Date

2026-05-15T09:23:38Z

## Commands

```bash
node --check scripts/ops/integration-k3wise-onprem-preflight.mjs
pnpm verify:integration-k3wise:onprem-preflight
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
pnpm verify:integration-k3wise:delivery
rg -n "K3_SESSION_ID|sessionId|K3_USERNAME|K3_PASSWORD|C2/C3 credential parity" \
  scripts/ops/integration-k3wise-onprem-preflight.mjs \
  scripts/ops/integration-k3wise-onprem-preflight.test.mjs \
  docs/operations/integration-k3wise-live-gate-execution-package.md
git diff --check origin/main...HEAD
```

## Expected Assertions

| Area | Assertion |
| --- | --- |
| Live config | `K3_SESSION_ID` plus `K3_API_URL` and `K3_ACCT_ID` passes `k3.live-config`. |
| Live config | Username/password still passes unchanged. |
| Missing config | Missing credentials now reports `K3_USERNAME+K3_PASSWORD or K3_SESSION_ID`. |
| Secret hygiene | Raw `K3_SESSION_ID` never appears in stdout, JSON, or Markdown. |
| Docs | Live GATE package no longer documents C2/C3 divergence. |

## Local Results

| Command | Result |
| --- | --- |
| `node --check scripts/ops/integration-k3wise-onprem-preflight.mjs` | PASS |
| `pnpm verify:integration-k3wise:onprem-preflight` | PASS, 15/15 |
| `node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs` | PASS, 21/21 |
| `pnpm verify:integration-k3wise:delivery` | PASS, 10/10 |
| `rg ...` contract scan | PASS |
| `git diff --check origin/main...HEAD` | PASS |

## Secret Scan

```bash
rg -n "(eyJ[A-Za-z0-9_-]{20,}|Bearer\\s+[A-Za-z0-9._-]+|password\\s*[:=]\\s*['\\\"][^<]|access_token=|api_key=|session_id=|postgres(ql)?://[^:/?@[:space:]]+:[^@[:space:]]+@)" \
  scripts/ops/integration-k3wise-onprem-preflight.mjs \
  scripts/ops/integration-k3wise-onprem-preflight.test.mjs \
  docs/operations/integration-k3wise-live-gate-execution-package.md \
  docs/development/integration-k3wise-onprem-preflight-session-id-design-20260515.md
```

Expected matches are test fixtures and `<fill-outside-git>` placeholders only:

- redaction tests deliberately include secret-looking URL/query values;
- the live GATE runbook contains a synthetic
  `postgres://rehearsal:<fill-outside-git>@...` example.

No real secret value is introduced.

## Deployment Impact

- No backend runtime change.
- No database migration.
- No frontend change.
- No package-content change.
- Operators can now run C2 live preflight for customers who provide a K3 session
  id instead of username/password.
