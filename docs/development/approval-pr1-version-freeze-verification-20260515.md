# Approval PR1 Version Freeze Verification 2026-05-15

## Scope

Branch: `flow/version-freeze-hardening-20260515`

This verification covers PR1 `version-freeze-hardening` only:

- Internal delete/archive safety helper.
- Existing-instance version freeze regression coverage.
- Publish transaction and row-lock regression coverage.

No HTTP endpoint, UI, route, automation, SLA, add-sign, admin-jump, or migration changes were added.

## Commands

| Command | Result | Notes |
|---|---:|---|
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-product-service.test.ts --watch=false` | PASS | 1 file, 16 tests. |
| `pnpm --filter @metasheet/core-backend test:unit` | PASS | Final rerun: 165 files, 2143 tests. |
| `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts --watch=false` | PASS | 36 tests. Run after one unrelated full-suite `ECONNRESET` flake in this file. |
| `pnpm --filter @metasheet/core-backend build` | PASS | TypeScript compile passed. |
| `pnpm --filter @metasheet/core-backend lint` | N/A | Package has no `lint` script. |

Full integration was not rerun for PR1 because the recorded baseline already fails in the current local environment due missing DB setup (`database "chouhua" does not exist` / `DATABASE_URL is required`) and existing mock SQL drift. PR1 added no migration.

## Regression Matrix

| ID | Status | Test Evidence | Baseline / Failure Signal |
|---|---|---|---|
| T1 | PASS | `advances existing approvals from the instance-bound stale published definition and form snapshot` | Pins already-correct invariant. Would fail if advance used current active template instead of `instance.published_definition_id`. |
| T2 | PASS | Same test uses `form_snapshot: { legacyAmount: 250 }` to route through the frozen condition graph. | Pins already-correct invariant. Would fail if advance reloaded current schema/form data. |
| T3 | PASS | `creates new approvals from the currently active published definition` | Pins create path selecting active published definition. |
| T4 | PASS | `blocks template version delete/archive checks with unfinished count and sample id` | New guard; before PR1 the method did not exist. |
| T5 | PASS | Stale advance test returns `pub-old` with `is_active: false` and still advances. | Pins ability to read stale published definitions. |
| T6 | PASS | `rolls back publish when the active definition insert fails` | Pins rollback path and prevents post-insert template status update on failure. |
| T7 | PASS | Stale advance test asserts no SQL mentions `approval_templates` or `active_version_id`. | Pins source-of-truth invariant. |
| T8 | PASS | `serializes publish with a template row lock and template-scoped active definition swap`; `keeps only one active published definition across concurrent publish calls` | Unit-level guard for `FOR UPDATE`, active swap order, and virtual two-publisher serialization; true DB concurrency replay remains integration-DB gated. |
| T9 | PASS | Same stale advance test pins stored form snapshot routing. | No old-instance form resubmit/update path exists in current service. |
| T10 | PASS | Same stale advance test pins frozen runtime graph routing to `approval_old_high`. | Pins runtime graph independence. |
| T11 | PASS | Guard rejection test asserts `unfinishedCount` and `sampleInstanceId`. | New guard; before PR1 the method did not exist. |
| T12 | SKIP | Optional. | Not needed because mitigation was a code comment, not helper splitting. |

## Migration Rollback

No migration was added in PR1. `up -> down -> up` rollback verification is not applicable.

## Result

PR1 implementation is ready for Claude review against the scope gate:

- P1 is option (a): internal helper only, no product surface.
- P2 required coverage T1-T11 is present at unit level.
- Integration DB-gated concurrency replay remains a documented residual verification gap, not a code blocker for this local run.
