# K3 WISE Delivery Readiness Gate Design - 2026-05-06

## Goal

Give the K3 WISE PLM->ERP PoC a single, evidence-driven answer to:

- Is the deployed MetaSheet integration surface internally ready?
- Can customer test-account live PoC start?
- Did customer live PoC pass?
- Is production use ready?

Before this change, the evidence existed in separate places:

- postdeploy smoke JSON;
- live preflight packet JSON;
- live evidence report JSON.

Operators had to read those manually and infer the stage. That made "can we deliver now?" ambiguous.

## Design

Added `scripts/ops/integration-k3wise-delivery-readiness.mjs`.

Inputs are optional and additive:

- `--postdeploy-smoke <path>` reads `integration-k3wise-postdeploy-smoke.json`.
- `--preflight-packet <path>` reads live PoC `packet.json`.
- `--live-evidence-report <path>` reads `integration-k3wise-live-poc-evidence-report.json`.
- `--out-dir <dir>` writes JSON and Markdown artifacts.
- `--fail-on-blocked` exits non-zero when the decision is `BLOCKED`.

The script emits:

- `integration-k3wise-delivery-readiness.json`
- `integration-k3wise-delivery-readiness.md`

## Decisions

The readiness decision is intentionally conservative:

| Decision | Meaning |
|---|---|
| `BLOCKED` | One gate failed, or internal postdeploy evidence is missing. Do not start the next stage. |
| `INTERNAL_READY_WAITING_CUSTOMER_GATE` | Authenticated postdeploy smoke passed; wait for customer GATE answers. |
| `CUSTOMER_TRIAL_READY` | Postdeploy smoke and Save-only preflight packet passed; start customer test-account live PoC. |
| `CUSTOMER_TRIAL_SIGNED_OFF` | Live evidence report passed; prepare production change review. |

`CUSTOMER_TRIAL_SIGNED_OFF` does not mark production ready. The report always keeps
`productionUse.ready=false` until customer change approval, backup/rollback confirmation,
and a scheduled go-live window exist outside this script.

## Gate Rules

Postdeploy smoke passes only when:

- `ok === true`;
- authenticated checks ran;
- `signoff.internalTrial === "pass"` or legacy authenticated evidence has no signoff block.

Preflight packet passes only when:

- `status === "preflight-ready"`;
- `safety.saveOnly === true`;
- `safety.autoSubmit === false`;
- `safety.autoAudit === false`;
- `safety.productionWriteBlocked === true`.

Live evidence passes only when:

- evidence report `decision === "PASS"`.

## Files Changed

- `scripts/ops/integration-k3wise-delivery-readiness.mjs`
- `scripts/ops/integration-k3wise-delivery-readiness.test.mjs`
- `package.json`
- `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`
- `docs/development/integration-k3wise-delivery-readiness-gate-design-20260506.md`
- `docs/development/integration-k3wise-delivery-readiness-gate-verification-20260506.md`
