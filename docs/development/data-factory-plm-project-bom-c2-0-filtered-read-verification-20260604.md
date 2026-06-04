# Data Factory PLM project BOM C2-0 filtered-read bridge verification (2026-06-04)

## Scope

C2-0 for issue #2253. This is the small bridge prerequisite before the C2
`projectNo -> PLM BOM` dry-run expansion helper.

It makes `data-source:sql-readonly` support equality-filtered reads so C2 can
perform flat, parameterized PLM lookups such as `FileCode = projectNo` and
`parentId = componentSourceId`.

It does not add the PLM BOM expansion helper, write MetaSheet rows, add UI,
change K3, or add any raw SQL / join / stored procedure surface.

## Locks

- `read.filters` is converted to host facade `select(..., { where })`.
- The host facade forwards `where` to `DataSourceManager.select`.
- Filters are equality-only primitives: string / number / boolean / null.
- Object-shaped operators and arrays fail closed before the facade read.
- Existing offset pagination behavior is unchanged.
- Owner-scope and read-only checks remain in the host facade choke point.

## Verification

Run:

```bash
pnpm --filter plugin-integration-core test:data-source-bridge
pnpm --filter @metasheet/core-backend test:unit -- data-source-plugin-facade.test.ts
git diff --check
```

Expected: all pass.

## Next

C2 remains a separate opt-in. It can use the #2253 candidate PLM relation
descriptors to build app-side recursion over flat parameterized reads. If live
PLM requires recursive CTE / stored procedure / vendor API / raw SQL, the track
still pivots to a customer flat BOM view or deferred PLM adapter/API.
