# DF Large-BOM C4 Checkpoint Apply Writer Verification - 2026-06-08

## Scope

Implemented the latent C4 checkpoint apply writer service for large-BOM jobs.

- Creates a checkpoint apply job only from a completed authoritative C3 plan artifact.
- Requires durable job storage, authenticated principal, and Data Factory `write` or `admin` permission.
- Requires explicit manual-confirm acknowledgement when the C3 plan contains held rows.
- Applies plan decisions in bounded chunks by reusing the existing C4 `applyStockPreparationPlan` writer.
- Persists checkpoint progress after each chunk; retry remains safe because add decisions are idempotent find-then-patch.
- Public projection is values-free: counts, status, revision-presence booleans, result status tokens, error-code tokens, and field-category tokens only.

## Boundary

Not included in this slice:

- No route or UI.
- No browser-supplied plan, target, sheet id, field id, or payload.
- No PLM/source read.
- No target read outside the injected MetaSheet records API used by the existing C4 writer.
- No external DB write, K3 write, Submit, Audit, BOM, production rollout, or batch apply enablement.

## Tests

Local verification:

```text
pnpm --filter plugin-integration-core test:stock-preparation-large-bom-jobs
pnpm --filter plugin-integration-core test:stock-preparation-apply-writer
pnpm --filter plugin-integration-core test:stock-preparation-conflict-planner
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
pnpm --filter plugin-integration-core test:http-routes
```

Covered cases:

- durable storage is mandatory;
- non-authoritative or missing C3 plan artifact is rejected;
- read permission is rejected for apply;
- manual-confirm rows require explicit acknowledgement before apply job creation;
- chunked apply writes clean rows while holding manual-confirm rows;
- public apply job summary stays values-free;
- simulated checkpoint loss after a successful add does not create a duplicate row on retry.

## Remaining Gated Work

The next C4 slices still need separate review:

- route/action wiring with server-side permission derivation;
- records API scoping to the configured target sheet;
- operator-facing progress and approval surface;
- entity-machine large-BOM validation before any production/batch rollout.
