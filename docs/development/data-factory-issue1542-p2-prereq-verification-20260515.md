# Data Factory issue #1542 P2 prerequisite guidance - verification - 2026-05-15

## Scope

Verifies the P2 frontend guardrail for issue #1542:

- `保存 Pipeline` is disabled until minimum save prerequisites are complete.
- The Workbench shows a save-specific prerequisite summary.
- Existing dry-run readiness remains intact.
- Existing staging-as-source and SQL blocked UX still pass.

No backend, migration, route, or package change is included.

## Local commands and results

### 1. Focused Workbench view suite

```text
cd apps/web
pnpm vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Result:

```text
RUN  v1.6.1 /Users/chouhua/Downloads/Github/metasheet2/apps/web

✓ tests/IntegrationWorkbenchView.spec.ts  (5 tests) 208ms

Test Files  1 passed (1)
Tests  5 passed (5)
```

### 2. Workbench client + view regression

```text
cd apps/web
pnpm vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Result:

```text
✓ tests/integrationWorkbench.spec.ts  (2 tests) 5ms
✓ tests/IntegrationWorkbenchView.spec.ts  (5 tests) 216ms

Test Files  2 passed (2)
Tests  7 passed (7)
```

### 3. Type check

```text
cd apps/web
pnpm vue-tsc --noEmit
```

Result: exit code 0.

### 4. Frontend production build

```text
cd apps/web
pnpm build
```

Result:

```text
> @metasheet/web@2.0.0-alpha.1 build /Users/chouhua/Downloads/Github/metasheet2/apps/web
> vue-tsc -b && vite build

✓ 2391 modules transformed.
✓ built in 6.03s
```

Vite emitted the existing large chunk warning and the existing mixed dynamic/static import warning for `WorkflowDesigner.vue`; neither is introduced by this Data Factory view change.

### 5. Whitespace / conflict marker check

```text
git diff --check origin/main...HEAD
```

Result: exit code 0.

## Assertions added

The existing full Workbench smoke now asserts:

- initial bootstrap disables `save-pipeline` while source/target objects and mappings are still missing,
- `save-readiness-summary` names `选择来源数据集` as one missing prerequisite,
- after staging-as-source is selected, target schema is loaded, mappings are seeded, and idempotency is present, `save-pipeline` becomes enabled,
- `save-readiness-summary` changes to `已满足保存条件`.

The existing source-empty guidance test now asserts:

- `save-readiness-summary` names `选择数据源系统` when no readable source exists,
- `save-pipeline` is disabled,
- `run-dry-run` remains disabled.

## Preserved behavior

The focused suite still covers and passes:

- Workbench renders `数据工厂`.
- K3 WISE preset entry remains visible.
- SQL Server source option is disabled when `queryExecutor` is missing.
- Staging creation CTA remains visible in source-empty and staging-empty states.
- Creating staging tables can auto-create/select `metasheet:staging` as source.
- Template payload preview still produces the K3 `Data` wrapper.
- Saving a complete pipeline still posts to `/api/integration/pipelines`.
- Dry-run still posts to `/api/integration/pipelines/:id/dry-run`.
- Save-only run still requires the explicit checkbox.
- Exported dry-run results still redact secret-shaped values.

## Safety checks

The change does not:

- print or store secrets,
- call external systems,
- alter Save-only execution,
- change submit/audit defaults,
- expose raw SQL,
- introduce new migrations.

## Manual reasoning

Save readiness and dry-run readiness are deliberately not identical:

- Saving a pipeline is metadata persistence, so it only needs selected systems/objects, mappings, and idempotency.
- Dry-run is an execution path, so it still requires active source/target status plus a saved pipeline ID.

This prevents a common deployment-test trap: users can see exactly why they cannot save yet, without mistaking payload preview for pipeline dry-run.
