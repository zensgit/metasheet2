# Data Factory #2253 C5 Bridge-source support verification (2026-06-05)

## Scope

This slice enables the stock-preparation parameterized action to read from the
onsite `bridge:legacy-sql-readonly` PLM source when the action is explicitly
configured for that source kind.

It is not a fallback from `data-source:sql-readonly`. The server-side action
config, the saved external system, and the read plan must all agree on the
source kind.

## Runtime changes

- `bridge:legacy-sql-readonly` adapter `read()` now forwards structured
  equality filters to the local Bridge Agent.
- `scripts/ops/bridge-agent-readonly.ps1` accepts only allowlisted primitive
  equality filters and binds filter values as SQL parameters.
- `plm.stock-preparation.pull-bom.v1` accepts `bridge:legacy-sql-readonly` only
  as an explicitly configured source kind.
- The route still rejects a saved external-system/action source-kind mismatch
  before adapter creation.

## Boundaries

- No raw SQL.
- No joins, CTEs, stored procedures, or vendor API calls.
- No PLM/external database write.
- No MetaSheet apply or target-row write in dry-run.
- No K3 Save / Submit / Audit / BOM.
- No source credential copy.

## Verification

Local commands:

```bash
pnpm --filter plugin-integration-core test:bridge-agent-readonly
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
pnpm --filter plugin-integration-core test:http-routes
bash -n scripts/ops/multitable-onprem-package-verify.sh
pwsh -NoProfile -Command '$ErrorActionPreference="Stop"; [void][scriptblock]::Create((Get-Content -Raw "scripts/ops/bridge-agent-readonly.ps1")); "bridge-agent-readonly.ps1 parses"'
```

What the tests lock:

- Bridge adapter sends `{ limit, filters }` and rejects operator objects/arrays.
- BOM read plans accept `bridge:legacy-sql-readonly` as an explicit source kind.
- C5 action config inherits Bridge `readPlan.sourceKind` only when the source is
  Bridge, and rejects source/read-plan kind mismatch.
- Route dry-run reaches the Bridge source adapter with equality-filtered flat
  reads.
- Route dry-run rejects a saved external-system kind mismatch before adapter
  creation.
- Package verification now requires the new Bridge Agent filter contract:
  allowlisted fields, primitive equality values, SQL parameter binding, and
  `filtersApplied`.

## Entity-machine follow-up

After a package is cut and deployed, rerun the #2253 source gate on the entity
machine:

1. Configure the PLM action source as `bridge:legacy-sql-readonly`.
2. Confirm the saved external system is also `bridge:legacy-sql-readonly`.
3. Run dry-run for one `projectNo`.
4. Capture values-free evidence only:
   - action id;
   - source kind;
   - projectNo present/not value;
   - dry-run status;
   - C2/C3 counts and error codes;
   - Bridge Agent filtered query status / `filtersApplied`.

Do not paste PLM row values, target row values, component names, quantities, raw
payloads, database credentials, or Bridge shared secrets.
