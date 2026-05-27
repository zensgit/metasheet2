# Data Factory DF-N2-1 provenance contracts verification - 2026-05-26

## Scope Verified

This verification covers DF-N2-1 contracts only:

- plugin-local provenance event normalizer
- plugin-local event type enum
- redaction behavior for provenance attributes
- OpenAPI schema component parity
- no runtime persistence/query/UI/K3 write work

## Local Checks

Commands run from the repository root:

```bash
node plugins/plugin-integration-core/__tests__/provenance-contracts.test.cjs
node plugins/plugin-integration-core/__tests__/payload-redaction.test.cjs
pnpm -F plugin-integration-core test
pnpm exec tsx packages/openapi/tools/build.ts
pnpm exec tsx packages/openapi/tools/validate.ts packages/openapi/dist/openapi.yaml
git diff --check origin/main...HEAD
```

Results:

| Check | Result |
|---|---|
| provenance contract focused test | PASS |
| payload redaction focused test | PASS |
| plugin integration core full test | PASS |
| OpenAPI build | PASS |
| OpenAPI security validate | PASS |
| diff check | PASS |

## Acceptance Matrix

| Requirement | Evidence |
|---|---|
| Accepted event types match the DF-N2 plan's 11 events | `PROVENANCE_EVENT_TYPES` and OpenAPI `ProvenanceEventType` parity test |
| Unknown event types reject | `row_skipped` rejected in focused test |
| No silent defaults | required-field and invalid-type validation throws `ProvenanceContractValidationError` |
| Attribute payload is redacted | token/password/authorization/connection-string keys redacted in focused tests |
| Prototype pollution keys are dropped | `__proto__` / `constructor` / `prototype` test |
| OpenAPI component exists without new route | `ProvenanceEvent` / `ProvenanceEventType` added to `base.yml`; no path added |
| Runtime remains frozen | no pipeline-runner, route, migration, or frontend files touched |

## Secret Hygiene

Tests use fake placeholder strings only. No real K3 host, token, password, SQL connection string, customer material code, or customer response payload is committed.

## Remaining Gate

DF-N2-2 remains separate and gated. This PR does not authorize JSONB lineage storage, by-rowId query routes, or runner event append behavior.
