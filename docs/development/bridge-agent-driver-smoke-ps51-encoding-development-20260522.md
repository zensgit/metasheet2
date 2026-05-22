# Bridge Agent Driver Smoke PowerShell 5.1 Encoding Fix - development - 2026-05-22

## Context

The on-prem entity-machine follow-up for release
`multitable-onprem-bridge-agent-20260521-575261f43` proved that BA-M1 readonly
Bridge Agent can run against the PLM source through the discovered allowlist.

The same follow-up also exposed one operator-side packaging issue:

- packaged `scripts/ops/bridge-agent-driver-smoke.ps1` was UTF-8 without BOM;
- Windows PowerShell 5.1 can decode such scripts through the system code page;
- the script contained localized-login redaction regex literals with CJK text;
- running the script directly from the package hit a parse/decoding issue;
- an operator-created UTF-8 BOM execution copy worked around the issue.

This is a package/operator ergonomics bug, not a SQL connectivity or Bridge
Agent runtime failure.

## Change

The BA-M0.5 driver-smoke script now keeps the localized-login redaction regex
ASCII-safe by using .NET regex Unicode escape sequences:

```text
\u7528\u6237
\u4f7f\u7528\u8005
\u767b\u5165\u540d
\u767b\u5f55\u540d
\u767b\u5f55\u5931\u8d25
\u767b\u5165\u5931\u6557
```

The redaction behavior remains the same: English `Login failed for user ...`,
common Chinese localized login-failure forms, and exact quoted occurrences of
the supplied username are still masked to `<redacted-login>`.

The script source itself no longer depends on UTF-8 BOM decoding to preserve
those regex literals.

## Guardrails

Two gates were added:

1. `scripts/ops/bridge-agent-driver-smoke-contract.test.mjs`
   - asserts `bridge-agent-driver-smoke.ps1` contains only ASCII-safe bytes;
   - asserts the Unicode escape markers are present;
   - asserts literal CJK characters do not reappear in the script.

2. `scripts/ops/multitable-onprem-package-verify.sh`
   - rejects packaged `bridge-agent-driver-smoke.ps1` if it contains
     non-ASCII bytes.

This makes the Windows PowerShell 5.1 compatibility rule part of both local
verification and official on-prem package verification.

## Scope

- BA-M0.5 driver-smoke script redaction regex encoding only.
- Driver-smoke contract test.
- On-prem package verifier marker.
- Development and verification documentation.

No SQL query behavior changed. The smoke still executes only
`SELECT @@VERSION`.

## Out of scope

- BA-M1 readonly Bridge Agent HTTP behavior.
- MetaSheet/Data Factory BA-M2 integration.
- plugin-integration-core runtime.
- K3 Save / Submit / Audit.
- Any customer SQL writes or business table mutation.

## Deployment impact

Next Windows on-prem packages should run the packaged
`bridge-agent-driver-smoke.ps1` directly under Windows PowerShell 5.1 without
requiring an operator-created UTF-8 BOM copy.

Existing entity-machine BA-M1 PASS evidence remains valid; this change removes
the packaging/encoding workaround for future runs.
