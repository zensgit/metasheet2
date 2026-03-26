# Multitable Pilot Contract Gate Hardening Verification

Date: 2026-03-26  
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Commands

```bash
pnpm verify:multitable-pilot:release-gate:test
pnpm verify:multitable-pilot:readiness:test
pnpm verify:multitable-openapi:parity
pnpm --filter @metasheet/web exec vitest run tests/multitable-embed-route.spec.ts tests/multitable-client.spec.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts tests/integration/multitable-record-form.api.test.ts tests/integration/multitable-attachments.api.test.ts tests/integration/multitable-view-config.api.test.ts --reporter=dot
node --check scripts/ops/multitable-pilot-readiness.mjs
node --check scripts/ops/multitable-pilot-handoff.mjs
bash -n scripts/ops/multitable-pilot-release-gate.sh scripts/ops/multitable-pilot-release-bound.sh scripts/ops/multitable-pilot-ready-local.sh
```

## Expected Coverage

- `pnpm verify:multitable-pilot:release-gate:test`
  - verifies success-path `gates/report.json` generation
  - verifies report commands stay aligned with actual executed `pnpm` argv
  - verifies failed steps still emit `gates/report.json` with `ok: false` and `failedStep`
- `pnpm verify:multitable-pilot:readiness:test`
  - verifies readiness fails when the multitable gate report is missing
  - verifies readiness fails when the gate report records a failed step
  - verifies `REQUIRE_GATE_REPORT=false` still supports ad hoc analysis
- `pnpm verify:multitable-openapi:parity`
  - verifies the OpenAPI parity step added to the canonical gate still passes
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-embed-route.spec.ts tests/multitable-client.spec.ts --reporter=dot`
  - verifies the route/client contract step added to the canonical gate
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run ...`
  - verifies the corrected backend integration gate set
- `node --check scripts/ops/multitable-pilot-readiness.mjs`
  - syntax verification for the hardened readiness script
- `node --check scripts/ops/multitable-pilot-handoff.mjs`
  - syntax verification for the handoff artifact copier after adding readiness gate evidence
- `bash -n ...`
  - syntax verification for the hardened shell scripts

## Files Verified In This Slice

- `scripts/ops/multitable-pilot-release-gate.sh`
- `scripts/ops/multitable-pilot-release-gate.test.mjs`
- `scripts/ops/multitable-pilot-readiness.mjs`
- `scripts/ops/multitable-pilot-readiness.test.mjs`
- `scripts/ops/multitable-pilot-handoff.mjs`
- `scripts/ops/multitable-pilot-release-bound.sh`
- `docs/deployment/multitable-internal-pilot-runbook-20260319.md`
- `docs/deployment/multitable-pilot-feedback-template-20260319.md`
- `docs/deployment/multitable-pilot-daily-triage-template-20260319.md`
- `docs/deployment/multitable-pilot-quickstart-20260319.md`
- `docs/deployment/multitable-pilot-team-checklist-20260319.md`
