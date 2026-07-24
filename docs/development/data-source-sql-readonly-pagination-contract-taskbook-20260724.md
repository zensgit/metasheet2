# Data-source SQL read pagination contract taskbook (2026-07-24)

> Status: **PAUSE - PROPOSED, owner ratification required**
>
> Scope: restore the already-approved deterministic-pagination invariant for
> `data-source:sql-readonly`, align the public structured-select API and
> `DataSourceManager.copyData`, and preserve the independent adapter hardening from
> Draft PR `#4580`.
>
> This document authorizes **nothing by itself**. Until D1-D8 are ratified, do not
> merge `#4580`, change runtime behavior, query production, deploy, or activate a
> connector.

## 0. Why this taskbook exists

Draft PR `#4580` (`55b36b218ddb2df1d55b0b9bdce326483ae8b17f`
at review) found three real adapter-boundary defects:

1. invalid MSSQL offsets could drop both `TOP` and `OFFSET/FETCH`, producing an
   unbounded read;
2. MySQL omitted the A5 limit boundary when `limit` was absent;
3. positive offset pagination without an explicit order silently risks duplicate
   and missing rows, while MSSQL's `ORDER BY (SELECT NULL)` only satisfied syntax.

Its shared guard is correct in isolation, but applying it at the adapter
chokepoint exposes two caller-contract breaks:

- `data-source:sql-readonly` non-watermark reads produce an offset cursor and do
  not pass `orderBy`, so page 1 succeeds and page 2 deterministically fails;
- `POST /api/data-sources/:id/select` currently accepts positive `offset` without
  `orderBy`; the adapter error is then mapped to `500 SELECT_ERROR`.

The first break is not hypothetical or limited to historical production rows.
The connector is registered unconditionally, is creatable from Workbench's
advanced-connector flow, and advertises `offsetPagingOnly: true`.

The old C0 design already locked the intended invariant:

> each page read must order by a stable key; if none is resolvable, the source is
> single-page-only and fails closed rather than risk duplicate/missing rows.

The C1 implementation and its tests omitted that invariant. This taskbook
restores it and removes the unsafe ambiguity in C0's phrase "primary key / first
column": a first column is not evidence of uniqueness and must never be guessed
as a pagination key.

## 1. Grounded current state

| Surface | Current behavior | Evidence |
| --- | --- | --- |
| SQL adapters | Postgres/MSSQL enforce A5; MySQL did not before `#4580` | `BaseAdapter.ts`, three SQL adapters |
| Connector offset mode | cursor becomes numeric offset; no `orderBy` | `data-source-sql-readonly-source-adapter.cjs` |
| Connector watermark mode | ordered keyset: monotonic id, or `(updated_at,tiebreaker)` | same adapter, C3 design |
| Introspection | every SQL `TableInfo` can expose `primaryKey[]` and `indexes[]` | `BaseAdapter.TableInfo`; three SQL adapters |
| Public select | `offset` and `orderBy` are independently optional | `SelectSchema`; OpenAPI `data-sources.yml` |
| Public select errors | non-not-found adapter errors become `500 SELECT_ERROR` | `routes/data-sources.ts` |
| `copyData` | loops with `limit+offset`, no ordering | `DataSourceManager.copyData` |
| Connector availability | registered by default; advanced UI can create it | plugin `index.cjs`; `IntegrationWorkbenchView.vue` |
| Cross-layer test | plugin tests use a facade fake; adapter conformance tests bypass plugin | current test inventory |

## 2. Decision rows (ratify D1-D8 explicitly)

### D1 - Split the hardening from the pagination migration

**Recommended: RATIFY.**

Replace the current all-in-one `#4580` delivery with two independently reviewed
units:

1. **H1 safe adapter hardening**
   - shared finite non-negative integer offset normalization;
   - MySQL A5 default/max limit enforcement;
   - cross-adapter A5 and invalid-offset conformance;
   - preserve existing positive-offset ordering behavior until H2 lands.
2. **H2 pagination-contract restoration**
   - connector stable ordering/single-page behavior;
   - public `/select` request contract;
   - `copyData` ordering;
   - adapter defense-in-depth ordering guard and MSSQL fallback removal;
   - cross-layer and real-wire verification.

H1 may enter its own merge flow after exact-head review. H2 remains
build-then-HOLD until D1-D8 are ratified and its own Gate-2 passes.

**Rejected:** merge the adapter ordering guard first and rely on runtime
inventory. Zero existing configurations does not prevent a newly created
connector from failing on page 2.

### D2 - Stable order for `data-source:sql-readonly` full/manual reads

**Recommended: RATIFY primary-key-first resolution.**

Before issuing the first non-watermark read for an object:

1. split the qualified object with the connector's existing parser, then call
   the owner-scoped `getTableInfo(dataSourceId, table, principal, schema)` facade
   seam;
2. if `TableInfo.primaryKey` is non-empty, order by **every primary-key column**
   ascending, in metadata order;
3. cache only that values-free metadata for the principal-bound adapter instance
   and exact `(schema, table)` pair; never cache credentials or rows;
4. pass the same `orderBy` on page 1 and every later page.

Composite primary keys are one total-order tuple and must not be truncated to
their first column.

**Red lines:**

- never use "first column";
- never inspect sample values to guess uniqueness;
- never select one arbitrary non-unique index;
- never restore MSSQL `ORDER BY (SELECT NULL)`;
- never accept a child/request-provided raw SQL ordering expression.

Watermark/keyset mode remains unchanged and continues to use its ratified
watermark ordering.

### D3 - Objects without a primary key

**Recommended: RATIFY fail-closed single-page behavior.**

For a non-watermark object whose introspection has no primary key:

- perform one bounded page with `offset=0`;
- if it returns fewer than `limit`, return it as terminal (`done=true`,
  `nextCursor=null`);
- if it returns exactly `limit`, fail the whole read with the stable code
  `DATA_SOURCE_PAGINATION_KEY_REQUIRED` and do not return records to the runner.

This is conservative: an object containing exactly `limit` rows can be refused,
but it cannot be silently truncated or corrupted. A later, separately ratified
extension may allow an operator-selected key only when metadata proves a
non-null unique index. It is not part of H2.

No external-system schema or database migration is introduced by D3.

### D4 - Public structured-select API

**Recommended: RATIFY request-level validation.**

For `POST /api/data-sources/:id/select`:

- `offset > 0` requires a non-empty `orderBy`;
- enforce the pair in `SelectSchema`/route validation before resolving or calling
  an adapter;
- return `400 VALIDATION_ERROR`, not `500 SELECT_ERROR`;
- keep limit-only and `offset=0` preview reads legal;
- update OpenAPI descriptions and generated contract expectations;
- document that the API proves explicit ordering only. The caller remains
  responsible for a stable unique tiebreaker.

The adapter guard remains a defense-in-depth backstop for internal callers.

### D5 - `DataSourceManager.copyData`

**Recommended: RATIFY preflight-before-write.**

Before its first source read or target insert:

1. extend the options type with structured `orderBy` entries; raw SQL remains
   forbidden;
2. introspect the source table and require its complete primary key;
3. validate every caller-supplied ordering column against that table's metadata,
   preserve the caller's valid prefix, and append any missing primary-key
   columns in metadata order as the deterministic unique suffix;
4. if the source has no primary key, fail with
   `DATA_SOURCE_PAGINATION_KEY_REQUIRED` even when a caller supplied a merely
   structural order;
5. pass the exact resolved order on every batch.

No batch may be written before ordering has been resolved. The existing absence
of in-tree production callers reduces migration risk but is not a reason to
leave a public manager method internally inconsistent.

### D6 - Error and evidence contract

**Recommended: RATIFY values-free errors and audit.**

- Stable errors may include the connector kind, data-source id, and qualified
  object name only where existing authorization already permits them.
- Never include credentials, DSNs, SQL text, row values, filters, or cursor
  payloads.
- Connector run evidence records mode (`offset-pk`, `single-page`, or existing
  watermark modes), page count, row count, and terminal/error code.
- A pagination-key failure must occur before target write, watermark advance, or
  success run finalization.

### D7 - Verification contract

**Recommended: RATIFY all checks below.**

H1:

- every SQL adapter: omitted limit bounded, over-max refused, valid limit kept;
- invalid offsets (`negative`, fractional, `NaN`, infinities) fail before query;
- reverse mutations for MySQL A5 and offset validation must turn tests red.

H2:

- cross-layer test traverses
  `data-source:sql-readonly -> host facade -> DataSourceManager -> real SQL adapter`;
- a two-plus-page table with a simple primary key has no duplicate or missing ids;
- a composite-primary-key table orders by every key column;
- removing connector `orderBy` forwarding makes the cross-layer test fail;
- no-PK short page succeeds terminally; no-PK full page fails and performs zero
  target writes;
- `/select` positive offset without order returns exact `400` and never calls the
  manager; positive offset with order succeeds;
- `copyData` resolves ordering before its first target insert, and a mutation that
  moves resolution after the first insert fails;
- `copyData` appends a composite primary key to a non-unique caller prefix; deleting
  any primary-key suffix column or accepting a no-primary-key table makes the
  focused tests fail;
- SQL Server 2019/2022 real-wire proves no `(SELECT NULL)` fallback;
- Postgres real-DB path proves the connector-to-adapter page loop;
- MySQL SQL-generation conformance is required; real-wire is required when the
  repository has an available MySQL CI service, otherwise the DEV/V must say it
  was not run;
- full core-backend, plugin, typecheck, and affected web/OpenAPI contracts;
- exact-head CI after final rebase.

Green plugin tests with a fake facade are not cross-layer proof.

### D8 - Inventory, rollout, and merge order

**Recommended: RATIFY.**

Runtime inventory is a migration-impact input, not the merge-safety proof:

1. use a read-only, values-free inventory grouped by tenant/workspace/status for
   `kind='data-source:sql-readonly'`;
2. do not read credentials or source rows;
3. for each approved active binding, classify only whether the bound object has
   a primary key after owner-authorized introspection;
4. any no-PK active binding remains an explicit migration HOLD.

Merge order:

1. H1 safe hardening;
2. H2 connector/API/copy contract plus DEV/V;
3. final rebase and merge simulation;
4. full CI and real-wire checks;
5. owner merge word.

No deployment or connector activation is included. Any operational inventory,
deployment, or feature activation remains a separate owner action.

## 3. Implementation decomposition after ratification

| Slice | Work | Builder / verifier | End state |
| --- | --- | --- | --- |
| H1 | A5 + invalid-offset-only split | Grok build/test; Codex mutation review | Draft PR, HOLD until review |
| H2a | Connector PK resolver + no-PK single-page contract | Grok build/test | Draft/stacked, HOLD |
| H2b | `/select` validation + OpenAPI | Grok build/test | Same H2 PR or small stacked PR |
| H2c | `copyData` preflight ordering | Grok build/test | Same H2 review set |
| H2d | Cross-layer + real-wire tests | Grok build; Codex adversarial/mutation verification | Gate-2 evidence |
| H2e | DEV/V and migration inventory procedure | Codex | Repo MD + truthful test matrix |

Independent read-only model review may be used for H2, but no model may ratify,
merge, deploy, query production, or activate the connector.

## 4. Required DEV/V deliverable

The H2 implementation must publish a repository document containing:

- ratified D1-D8 and exact owner-ratified SHA;
- before/after call graph for connector, public API, and `copyData`;
- error/evidence table;
- per-test reality table (fake facade, generated SQL, real adapter, real DB);
- all mutation results;
- runtime inventory result, if separately authorized;
- explicit untested environments;
- exact branch/head, rebase result, CI URLs, and merge status;
- a final statement distinguishing code review, merge, deployment, and runtime
  activation.

## 5. Ratification line

Owner may authorize the next build with:

> Ratify D1-D8 in the data-source SQL read pagination contract taskbook; authorize
> H1 then H2 build-then-HOLD only. No merge, production inventory, deployment, or
> activation.

Any change to D2/D3's key resolution, D4's public API behavior, or D8's
operational boundary requires a new owner decision.
