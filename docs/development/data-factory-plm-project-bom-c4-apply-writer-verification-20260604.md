# Data Factory #2253 C4 apply writer verification (2026-06-04)

## Scope

PR scope: C4 apply writer for PLM stock-preparation refresh plans.

This slice adds a narrow helper that consumes a reviewed C3 conflict plan and
applies clean decisions to one configured MetaSheet stock-preparation main
table through an injected MetaSheet records API.

It writes MetaSheet rows only. It does not read PLM, write any external
database, add a route/UI/migration, or touch K3 Save / Submit / Audit / BOM.

## Verification run

Commands:

```bash
pnpm --filter plugin-integration-core test:stock-preparation-apply-writer
pnpm --filter plugin-integration-core test:stock-preparation-conflict-planner
pnpm --filter plugin-integration-core test:stock-preparation-templates
```

Result:

```text
stock-preparation-apply-writer.test.cjs OK
stock-preparation-conflict-planner.test.cjs OK
stock-preparation-templates.test.cjs OK
```

## Test locks

- apply requires `write` or `admin`; `read` fails before any records API call;
- `add` creates a new stock-preparation row when the idempotency key is absent;
- rerunning the same accepted plan does not duplicate `add` rows;
- `update` patches an existing row and preserves human-owned fields by omission;
- `inactive` patches `active:false` and run/decision fields; it never deletes;
- `update` / `inactive` never create a missing target row; missing targets are
  row-level failures;
- `skip` and `manual_confirm` decisions are held and never written;
- C2/C3 bad-row `manual_confirm` does not abort clean add/update/inactive rows;
- duplicate target idempotency keys fail closed before patch;
- configured field id mapping is honored for query filters and write payloads;
- values-free evidence contains counts/status/error codes only, never
  project/component/material values.

## Boundary notes

C4 is not a UI or route. Permission is represented as an explicit
`permission: "write" | "admin"` input so a future route can pass the already
authorized Data Factory permission result into this helper.

The helper intentionally does not call the generic multitable target adapter
for `update` / `inactive`: that adapter's `upsert` can create when a key is
missing, but C4 must fail closed instead of creating partial rows for patch-only
decisions.
