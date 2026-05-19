# Data Factory UX closeout verification - 2026-05-19

## Scope

Branch: `codex/data-factory-ux-closeout-20260519`

Files changed:

- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `docs/development/data-factory-ux-closeout-design-20260519.md`
- `docs/development/data-factory-ux-closeout-verification-20260519.md`

No backend, migration, API route, plugin runtime, or packaging file changed.

## Targeted checks

### Frontend workbench spec

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Result:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

Coverage added/updated:

- Data Factory page shows "新增或管理连接" instead of implying a separate
  "connect system" page.
- Inventory copy exposes edit / copy / stop / re-enable / delete operations.
- Inactive saved connections can be re-enabled with the new `启用` action.
- K3 WISE WebAPI target-only copy explains the business path: source data should
  come from staging, SQL read channel, or another readable connection.
- Empty dry-run preview renders a clear success-but-empty notice and does not
  enable export.
- Existing dry-run preview with one record still exports redacted CSV.

### Type-check

Command:

```bash
pnpm --filter @metasheet/web type-check
```

Result:

```text
@metasheet/web@2.0.0-alpha.1 type-check
vue-tsc -b
exit 0
```

## Issue #651 mapping

| Feedback | Verification |
| --- | --- |
| "连接新系统" looked like a separate settings page | Header and button copy now say inline draft/setup; spec checks the new page copy. |
| SQL / advanced connection entry was unclear | Button now says "展开 SQL / 高级连接"; existing advanced toggle behavior remains. |
| Edit/delete/duplicate were not discoverable | Inventory helper copy now lists actions; spec covers copy/edit/deactivate/delete and new activate. |
| K3 WISE WebAPI target-only explanation was too technical | Source hint and K3 notice now say WebAPI is target write only and name valid source choices. |
| Dry-run success with empty records looked ambiguous | Empty preview produces a dedicated notice plus export summary; spec covers `records=[]`, `errors=[]`. |

## Non-goals

- This PR does not implement K3 WebAPI read/list runtime.
- This PR does not inject the SQL Server executor.
- This PR does not add migrations or change staging install behavior.
- This PR does not change Save / Submit / Audit behavior.
