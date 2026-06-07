# Data Factory PLM Stock Preparation Duplicate Expanded Key D3 Verification - 2026-06-07

## Scope

D3 is the first executable duplicate-expanded-key policy slice.

It implements `keep_multiple_rows` only. Other duplicate policies remain held:
`merge_quantity`, `select_representative`, `skip_selected`, and
`source_correction_required`.

## Implementation

- `plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs`
  carries the configured PLM detail `sortField` into expanded rows as
  `sortLine`, giving same-parent duplicate rows a stable discriminator when the
  source schema provides one.
- `plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs`
  resolves only duplicate groups with:
  - selected policy `keep_multiple_rows`;
  - a stable discriminator (`sourceDetail`, `pathParent`, or `sortLine`);
  - no existing row under the clean/base idempotency key.
- Resolved duplicate rows become normal `add` decisions with surgical
  discriminator keys. C4 still uses the existing add path
  (find-then-patch/create); no new writer decision type is introduced.
- `plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs`
  binds the reviewed policy state into the dry-run revision:
  - run-only policy choices are stored in the one-use dry-run token;
  - table-scope policy changes after dry-run invalidate the token;
  - resolved duplicate groups require `acceptDuplicateResolution=true`.
  - public policy-review evidence reflects resolved groups as
    `add_decisions_require_ack`, while held groups remain
    `manual_confirm_held`.
- `apps/web/src/views/IntegrationWorkbenchView.vue` shows resolved/held
  duplicate group state and requires an explicit checkbox before Apply can send
  a resolved-duplicate request.

## Guardrails

- Default remains fail-closed `hold`.
- Clean-to-collision transitions hold by default. D3 does not silently re-key,
  orphan, deactivate, or duplicate rows that were already written under the
  clean/base idempotency key.
- Surgical keys are applied only inside resolved collision groups. Non-collision
  rows keep their original `idempotencyKey`.
- Apply still rejects client-supplied C3 plans, C4 payloads, target scopes, and
  `conflictPolicyReview`.
- Public evidence is values-free: fingerprints, policy names, scopes,
  discriminator type, counts, and hold reasons only. No project number, raw
  idempotency key, component values, parent/path values, discriminator values,
  target sheet id, field id, credential, token, payload, or raw SQL is exposed.
- No PLM write, external database write, K3 path, migration, or package change.

## Verification

Commands run:

```bash
node plugins/plugin-integration-core/__tests__/stock-preparation-conflict-planner.test.cjs
node plugins/plugin-integration-core/__tests__/stock-preparation-conflict-policies.test.cjs
node plugins/plugin-integration-core/__tests__/stock-preparation-table-actions.test.cjs
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
pnpm --filter plugin-integration-core test
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Results:

- conflict planner suite: pass.
- conflict policy suite: pass.
- table action suite: pass.
- HTTP route suite: pass.
- plugin-integration-core full test script: pass.
- Workbench spec: 29/29 pass.
- Vue type-check: pass.

## Negative Controls Locked By Tests

- A saved table-scope `keep_multiple_rows` policy is explicitly reported as
  active on the next dry-run before Apply can proceed.
- Changing table-scope policy after dry-run invalidates the token.
- Resolved duplicate groups cannot be applied without
  `acceptDuplicateResolution=true`.
- Run-only policy choices are token-bound; Apply does not accept
  client-supplied `conflictPolicyReview`.
- Clean-to-collision transitions stay held and do not mark the existing
  base-key row inactive.
- Missing stable discriminator stays held.
- Public resolution evidence remains values-free.

## Deferred

The remaining duplicate policies are not implemented in D3:
`merge_quantity`, `select_representative`, `skip_selected`, and
`source_correction_required`.

Large-BOM background expansion/checkpointed apply and production rollout remain
separate explicit opt-ins.
