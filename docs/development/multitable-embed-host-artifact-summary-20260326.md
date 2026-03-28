# Multitable Embed Host Artifact Summary

## Goal

Promote the new embed-host smoke evidence out of `readiness.md`/`readiness.json` and into the top-level pilot artifacts that operators actually read first:

- `release-bound/report.json`
- `release-bound/report.md`
- `handoff.json`
- `handoff.md`

This closes the gap where embed-host protocol and draft-protection checks were technically present in readiness, but still easy to miss during pilot review and sign-off.

## Design

### 1. Reuse readiness as the source of truth

Do not invent a second embed-host schema in handoff or release-bound.

Instead:

- `scripts/ops/multitable-pilot-handoff.mjs`
  reads `readiness.json`
- it promotes:
  - `embedHostProtocol`
  - `embedHostNavigationProtection`
- it derives:
  - `embedHostAcceptance.ok = protocol.ok && navigationProtection.ok`

This keeps the readiness summary authoritative while still surfacing the evidence at the handoff layer.

### 2. Make handoff visibly actionable

`handoff.json` now contains:

- `embedHostAcceptance`
- `embedHostProtocol`
- `embedHostNavigationProtection`

`handoff.md` now contains a top-level `## Embed Host Acceptance` section with:

- overall PASS/FAIL
- protocol evidence summary
- navigation protection summary
- required/observed/missing checks

That turns handoff into the operator-facing summary instead of forcing the reader to drill into readiness.

### 3. Promote the same evidence into release-bound

`scripts/ops/multitable-pilot-release-bound.sh` now reads the promoted fields from `handoff.json` and copies them into:

- `report.json`
- `report.md`

The release-bound markdown stays intentionally compact:

- overall embed-host acceptance
- protocol available/status
- navigation protection available/status
- links back to `handoff.md` and `readiness.md` for the detailed check list

This keeps shell-side report generation simple while still making the signal impossible to miss.

## Verification

I ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
node --check scripts/ops/multitable-pilot-handoff.mjs
bash -n scripts/ops/multitable-pilot-release-bound.sh
node --test \
  scripts/ops/multitable-pilot-readiness.test.mjs \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs
```

Results:

- `node --check` passed
- `bash -n` passed
- node tests passed: `7/7`

New regression coverage:

- `scripts/ops/multitable-pilot-handoff.test.mjs`
  verifies real `handoff.mjs` fixture output promotes embed-host readiness evidence into top-level `handoff.json` and `handoff.md`
- `scripts/ops/multitable-pilot-release-bound.test.mjs`
  verifies `release-bound.sh` promotes embed-host evidence into top-level `report.json` and `report.md`

## Outcome

Embed-host protocol and draft-protection are now first-screen pilot artifacts, not buried readiness details. That improves operator review, checkpoint prep, and UAT/customer sign-off readiness without changing the underlying smoke contract.
