# SQL Server JOIN: the ON predicate becomes structure, not SQL text (G52B) — design, 2026-09-12

Branch `fix/mssql-join-on-hardening`, stacked on `fix/mssql-unicode-identifiers` (#5614 / G52)
@ `966ad86e7`. Companion: `docs/development/mssql-join-on-hardening-verification-20260912.md`.

Predecessor: `docs/development/mssql-unicode-identifiers-design-20260910.md` §9 follow-up 1, which
found this and deliberately left it open.

## 1. The gap

`MSSQLAdapter.select()` built its JOIN clause like this (pre-change):

```ts
const joinType = join.type?.toUpperCase() || 'INNER'
sql += ` ${joinType} JOIN ${this.quoteIdent(join.table)} ON ${join.on}`
```

The join TARGET went through the quoter. TWO caller-controlled fragments did not:

1. **`join.on`** — a caller-supplied SQL *expression*, concatenated verbatim.
2. **`join.type`** — `toUpperCase()` is not a guard. It is TYPED `'inner' | 'left' | 'right' | 'full'`,
   and a TypeScript type stops nothing at runtime: any JS caller, or any `as QueryOptions` cast (the
   route does exactly such a cast on its parsed body), can put arbitrary text in front of `JOIN`.
   Found while writing this change; same class, same fix, same file.

Both sat INSIDE the function G52 hardened, which is why G52's own scope note called `join.on` out
explicitly and why its test carried the label *(ON expression NOT covered)*: the `on: '1 = 1'` in that
test was an inert placeholder needed to build the clause, not a certification of the ON path.

### Why the write gate did not already cover it

`query()` runs `assertSqlWriteAllowed` on the finished statement text, default-deny. That gate is a
real backstop for a MANGLED IDENTIFIER (`… FROM [a] DROP TABLE x]` classifies as a write and is
refused). It is structurally blind to this one, and the reason is in its own allowlist
(`outbound-sql-write-gate.ts:389-397`): `union`, `select`, `from`, `exists`, `where`, `all` are all
READ-grammar keywords. So

```sql
SELECT TOP (1000) * FROM [dbo].[orders] INNER JOIN [dbo].[x] ON 1 = 1 UNION ALL SELECT password, 1 FROM dbo.users
```

is a PURE READ by the gate's own (correct) definition: it passes, runs, and returns another table's
rows. Verified, not asserted: `mssql-join-on-hardening.test.ts` MUTATION 4 restores the string branch,
ships that statement into the fake pool, and pins `isPureReadStatement(sql) === true`.

An exfiltration read is not a "write" — the gate is not broken, it is answering a different question.
That is the whole argument for removing the fragment instead of filtering it.

## 2. Caller census — who can pass `joins` today (the evidence, not the claim)

The implementer's claim was "no production caller repo-wide". Re-checked from both ends:

| Producer | Verdict | Evidence |
| --- | --- | --- |
| HTTP `POST /api/data-sources/:id/select` | **cannot** | `routes/data-sources.ts:191-201` — `SelectSchema` declares table/select/where/orderBy/limit/offset and NO `joins`. It is a plain (non-`.strict()`) zod object, so unknown keys are **stripped** from `parse.data`; the handler then spreads `parse.data` (`:1159`), so `joins` cannot survive the parse. |
| Plugin read facade | **cannot** | `data-source-plugin-facade.ts:134-137` types its `options` as `Pick<QueryOptions, 'limit' \| 'offset' \| 'where' \| 'orderBy'>` and `:658-676` builds the `QueryOptions` field by field. No pass-through object. |
| `DataSourceManager.copyData` | **does not** | `DataSourceManager.ts:1157-1161` passes `where`/`limit`/`offset`. |
| `DataSourceManager.select` | pass-through | `:1045-1057` forwards whatever it is given; its only callers are the route above and the facade. |
| Stock-prep BOM read plan | **refuses** | `plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:196-212` lists `join`/`joins` among `FORBIDDEN_PLAN_KEYS`. |
| `source-vendor-presets` `preset.joins` | different vocabulary | `preset-schema.cjs:760-805` — `{ fromRole, fromColumn, toRole, toColumn }` preset METADATA, validated against declared roles/columns and never turned into `QueryOptions.joins`. Notable as precedent: that lane already models a join as a COLUMN PAIR, not as SQL. |
| Repo-wide literal search | 1 hit, a test | `joins\s*:` across `*.ts/tsx/cjs/js/mjs/vue/json` (node_modules excluded) matched only `mssql-unicode-identifiers.test.ts:105` (G52's placeholder, rewritten by this change) and the unrelated stock-prep plan key above. |

So the accepted shape of `on` can be narrowed without a migration: there is nothing to migrate.
"Latent, not exploited" is the finding; "latent" is also what makes the fix cheap.

## 3. The change — option (a), structured

`QueryOptions.joins[].on` gains a structured form and `MSSQLAdapter` accepts ONLY that form:

```ts
export interface JoinOnPredicate { left: string; right: string; op?: '=' }   // BaseAdapter.ts:67-71
```

`MSSQLAdapter.select()` (`:550-558`) now calls two guards, both of which throw BEFORE `this.query()`
is reached, so a refused join sends no statement at all:

- `joinTypeKeyword()` (`:434-441`) — a `Map` lookup over `inner/left/right/full`, case-insensitive.
  A `Map` and not an object literal on purpose: `({}).constructor` is truthy, so an object-literal
  lookup would have handed `'constructor'` a function to splice in front of `JOIN`.
- `buildJoinOn()` (`:473-506`) — refuses a `string` outright (`SQLSERVER_JOIN_ON_UNSUPPORTED`), refuses
  a non-object, an array, an unknown key (a typo'd `operator: '<>'` must not be silently emitted as
  `=`), and any `op` other than `'='`. Both sides go through `quoteJoinSide()` (`:508-519`) → the
  adapter's existing `quoteIdent` → `quoteSqlServerIdentifier`. The ONLY text it can return is
  `<quoted> = <quoted>`.

Refusals carry `status: 400` + a `code`, the shape `routes/data-sources.ts:44-52` (`codedGateRefusal`)
forwards verbatim, and their messages render NO caller text — `field` is the adapter's own path
(`joins[0].on`) and `reason` comes from a fixed vocabulary. Identifier refusals keep G52's
`SQLSERVER_IDENTIFIER_INVALID` code and its already-escaped, length-bounded message, and gain the
field plus `status: 400`.

**Why (a) and not (b) — the strict `<ident> = <ident>` string grammar.** A string parser would have to
be exactly as strict as the structured shape to be safe, so it buys nothing but a second grammar that
can drift from the identifier rule it is supposed to mirror; it keeps a text channel alive for
"just one more" widening later (`AND`, then `OR`, then a function); and there is no caller to be kind
to (§2). Structure also makes the refusal reason precise (`joins[0].on.left`), which a regex cannot do.
Cost, stated plainly: a caller that genuinely needs a multi-column or non-equality ON has to use the
raw SQL lane (`query()`), which the write gate does classify. Nobody is in that position today.

### What is NOT claimed

- **Not every injection-shaped side is refused.** G52 admits Unicode letters/marks/digits/underscore
  and SPACE separators (customers' column names have spaces), so `a UNION ALL SELECT x FROM sys` passes
  the CHARACTER rule and is emitted — as ONE bracketed identifier,
  `ON [a UNION ALL SELECT x FROM sys] = [dbo].[a].[id]`. The BRACKETS are the defence, exactly as in
  G52 §2; the character class never was. The test asserts that emitted form byte for byte rather than a
  refusal this code does not perform.
- **No identifier rule was loosened for joins.** Join sides call the same `quoteIdent` as the table,
  the projection, `WHERE` and `ORDER BY`. The only movements are narrowings: `on` strings refused,
  non-`=` operators refused, unknown keys refused, `type` allowlisted (`''` used to fall back to INNER
  because it is falsy, and is now refused — no typed caller can produce it).
- **The K3 lane is untouched.** `plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-executor.cjs:32-33`
  keeps its OWN ASCII `SIMPLE_IDENTIFIER_PATTERN` / `QUALIFIED_IDENTIFIER_PATTERN`, has no JOIN
  builder at all, and imports nothing from this file. Nothing here widens or narrows that lane.

## 4. Contract change

| | before | after |
| --- | --- | --- |
| `on` type | `string` | `JoinOnPredicate \| string` (the string branch exists for PG/MySQL, see §6) |
| MSSQL `on: string` | concatenated verbatim | refused, `400 SQLSERVER_JOIN_ON_UNSUPPORTED`, no statement sent |
| MSSQL `on: {left,right,op?}` | not expressible | `ON [a].[b] = [c].[d]`, both sides bracket-quoted |
| MSSQL `type` | `toUpperCase()`, anything accepted | allowlist `inner/left/right/full`, else `400 SQLSERVER_JOIN_TYPE_INVALID` |
| HTTP `/select` | `joins` already stripped by zod | unchanged (still stripped) |

New error codes: `SQLSERVER_JOIN_ON_UNSUPPORTED`, `SQLSERVER_JOIN_ON_INVALID`,
`SQLSERVER_JOIN_ON_OPERATOR_INVALID`, `SQLSERVER_JOIN_TYPE_INVALID` — all `status: 400`.

## 5. Blast radius

Touched: `MSSQLAdapter.ts` (guards + the three comments that claimed the old behaviour),
`BaseAdapter.ts` (the type + its scope note), `mssql-unicode-identifiers.test.ts` (the placeholder
case, rewritten as a real assertion), a new spec. No pin is involved: neither file appears in
`.gitattributes`' content-digest list nor in `sealed-export-package-provenance.cjs` (which pins plugin
lib files and the 06x/07x migrations only). No plugin file, no `mssql-readonly-utils` change — the
join builder lives in the adapter so the helper package shared with the K3 lane gains no new surface.

## 6. Registered known differences (NOT closed here)

1. **`PostgresAdapter.ts:179-184` and `MySQLAdapter.ts:304-309` still concatenate `join.on` verbatim.**
   Out of scope by instruction and by shape: they quote identifiers their own ASCII way (`"` doubled /
   backticks), so the same change needs a different escape and its own matrix; and they have no
   `isPureReadStatement` gate in front of them. The `string` branch stays in the shared type FOR them —
   in exchange, a structured `on` handed to those two adapters today would stringify to
   `[object Object]`, i.e. a broken query, not an injection. Zero callers on either adapter (§2).
2. **`join.type` in PG/MySQL** is the same unvalidated `toUpperCase()` splice, for the same reason.
3. **G52 §9 follow-ups 2, 3, 4, 6 remain open** — `buildGenericWhereClause`'s caller-supplied
   `quoteIdentifier` override is the one to read next; it can replace THE ONE RULE from outside.
