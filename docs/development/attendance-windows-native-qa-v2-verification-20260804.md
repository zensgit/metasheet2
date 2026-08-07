# Attendance Windows Native Exact-SHA QA v2 — Verification Notes

**Status: Draft / HOLD**

**Pinned source SHA:** `0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b`

**Campaign:** `attendance-windows-native-qa-v2-20260804`

## Purpose

Document the package/build/test infrastructure prepared for Windows-native
exact-SHA internal QA v2. This is preparation evidence only. It does **not**
authorize deployment, staging, customer UAT, flag enablement, external
notifications, or issue closure.

## What was re-ported

Safe package/build/test infrastructure only:

- Windows native preflight / start / stop / health / bootstrap / gateway scripts
- Package build and verifier hooks for native entrypoints
- PM2 discovery/sanitization hardening needed by Windows PowerShell 5.1
- Isolated QA env example and gateway PM2 config
- Exact source SHA pin + risk-matrix runner for PQA-01..10

Attendance product runtime was not edited.

## Exact-SHA contract

1. The Windows QA workflow proves the current product-runtime paths are
   byte-identical to the pinned source before building.
2. Package build resolves `SOURCE_SHA` and `QA_TOOLING_SHA` (40-char git SHAs)
   and writes:
   - package-root `SOURCE_SHA`
   - package-root `QA_TOOLING_SHA`
   - package JSON `sourceSha`
   - package JSON `qaToolingSha`
   - `windowsNativeQa.status = DRAFT_HOLD`
   - `windowsNativeQa.deploymentAuthorized = false`
3. Package verifier fails closed when:
   - `SOURCE_SHA` is missing/malformed
   - `QA_TOOLING_SHA` is missing/malformed or disagrees with the manifest
   - pin/manifest SHA mismatch
   - pin/matrix claim deployment authorization
4. Windows preflight fails closed on product SHA mismatch before migrations/start.
5. Risk-matrix runner fails closed on SHA mismatch, stale evidence SHAs,
   residue != 0, a missing explicit Draft/HOLD boundary, or incomplete Windows
   host/isolation/no-notification safety facts.
6. A PASS additionally requires (owner 3rd review):
   - a STRUCTURED, harness-produced `machineEvidence` record (schema
     `windows-qa/machine-evidence@1`, `producedBy=windows-qa-harness`,
     `harnessModule`, `determination=PASS`, non-empty `facts`) — a long free-text
     reason/evidence string alone is no longer accepted; and
   - that record's `qaToolingSha` (and any present per-case/top-level
     `qaToolingSha`) equal to the package `QA_TOOLING_SHA` — evidence produced by a
     different QA tooling SHA does not PASS. A package with no `QA_TOOLING_SHA`
     cannot PASS (fail closed). This raises the PASS floor; it is not a proof of
     authenticity (the summary JSON is copyable/operator-writable).

## Synthetic risk matrix honesty

Without Windows-host product evidence, the runner reports:

- PQA-01..PQA-10 = `BLOCKED`
- `residue = null` (not measured)
- `deploymentAuthorized = false`

It never invents product PASS. Old package claims from issue #4629
(`8dfde5a7…`, `66a98035…`, etc.) are listed as stale and rejected if reused.

PQA-10 is re-evaluated against the current SHA (scheduled identity/outcome/outbox
code exists on the pin) but remains BLOCKED until host synthetic evidence is
collected for this exact SHA.

The workflow's Windows QA mode rejects release publication. Artifact upload is
CI evidence transport only and remains Draft/HOLD.

## Local verification commands

```bash
# Node contract/unit tests (no dependency install required)
node --test \
  scripts/ops/attendance-windows-native-gateway.test.mjs \
  scripts/ops/attendance-windows-native-qa-runner.test.mjs \
  scripts/ops/attendance-windows-native-preflight.test.mjs \
  scripts/ops/attendance-onprem-package-verify-migrations.test.mjs \
  scripts/ops/onprem-windows-system-hardening.test.mjs

# Risk matrix honesty check against the repo pin + a synthetic SOURCE_SHA file
printf '%s\n' 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b > /tmp/SOURCE_SHA_fixture
# Prefer running from a package root that already contains SOURCE_SHA.

# Syntax checks
node --check scripts/ops/attendance-windows-native-gateway.mjs
node --check ecosystem.windows-native.config.cjs
node --check scripts/ops/attendance-windows-native-qa-runner.mjs
node -e "JSON.parse(require('fs').readFileSync('scripts/ops/attendance-windows-native-qa-v2.pin.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('scripts/ops/attendance-windows-native-qa-risk-matrix.json','utf8'))"
```

PowerShell helper self-test (pwsh or Windows PowerShell 5.1):

```powershell
./scripts/ops/attendance-windows-native-common.test.ps1
```

Package dry build requires prebuilt `apps/web/dist` and
`packages/core-backend/dist` (or a CI build job). Do not install dependencies
or deploy as part of this preparation note.

## Windows CI evidence and remaining gaps

Workflow run
[`30893406976`](https://github.com/zensgit/metasheet2/actions/runs/30893406976)
completed both jobs successfully on the pre-hardening tooling head
`ac10e39416621d0c300090cb73dd8b0e7e3c566b`. It proves the full package build,
the `windows-2025` preflight/start/health/bootstrap/stop lifecycle, a fresh
isolated PostgreSQL 17 migration plus second pass, and PM2 cleanup after
deliberate gateway-start failure. This is package/runtime lifecycle evidence
only; a fresh run on the final PR head remains part of the exact-head gate and
is recorded on the PR rather than back-editing this document after the run.

The following remain intentionally unclaimed:

- Product PQA-01..10 synthetic execution and evidence capture
- Any LAN ingress, staging, or customer-path validation

## Non-authorization statement

Draft/HOLD only. No deployment authorization. No staging authorization. No
reuse of old package PASS claims as current evidence.
