# K3 WISE On-Prem Preflight Session ID Design - 2026-05-15

## Purpose

Close the C2/C3 credential mismatch in the live K3 WISE PoC flow.

The live PoC packet builder already accepts either:

- `credentials.sessionId`; or
- `credentials.username` + `credentials.password`.

Before this change, the on-prem live preflight only accepted
`K3_USERNAME` + `K3_PASSWORD`. A customer who supplied only a K3 session id could
pass packet validation but still fail C2 with `GATE_BLOCKED`.

## Change

`scripts/ops/integration-k3wise-onprem-preflight.mjs` now accepts:

```text
K3_API_URL
K3_ACCT_ID
K3_SESSION_ID
```

or:

```text
K3_API_URL
K3_ACCT_ID
K3_USERNAME
K3_PASSWORD
```

The live-config check reports:

- `authMode=sessionId` when `K3_SESSION_ID` is present;
- `authMode=usernamePassword` when username/password is used;
- `sessionIdPresent`, `usernamePresent`, and `passwordPresent` booleans.

It never stores the raw `K3_SESSION_ID`, username password, or password value.

## Safety Boundary

The on-prem preflight remains read-only:

- no K3 WebAPI call;
- no DB write;
- no migration run;
- only a TCP probe to the K3 host/port in live mode.

Session id support is a presence-contract fix, not an authentication or K3 API
behavior change.

## Documentation

`docs/operations/integration-k3wise-live-gate-execution-package.md` now documents
C2/C3 credential parity and maps:

- `k3Wise.credentials.sessionId` to `K3_SESSION_ID`;
- `k3Wise.credentials.username` to `K3_USERNAME`;
- `k3Wise.credentials.password` to `K3_PASSWORD`.

## Claude Code

Claude Code is not required. The slice is fully repo-local and covered by the
existing on-prem preflight tests.
