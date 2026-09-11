# SQL Server JOIN ON hardening (G52B) — verification, 2026-09-12

Design: `docs/development/mssql-join-on-hardening-design-20260912.md`.
Branch `fix/mssql-join-on-hardening`, stacked on `fix/mssql-unicode-identifiers` @ `966ad86e7`.

## 1. What is under test

`packages/core-backend/tests/unit/mssql-join-on-hardening.test.ts` (53 cases, new) plus the rewritten
join case in `packages/core-backend/tests/unit/mssql-unicode-identifiers.test.ts`.

G52's join case was labelled *(ON expression NOT covered)* and used `on: '1 = 1'` as an inert
placeholder. It is now a real assertion — the structured predicate, quoted, with the ON clause pinned
as a whole substring — and the string `'1 = 1'` heads the REFUSAL matrix in the new spec, which is what
"the placeholder was not a certification" looks like in code.

## 2. Positive: the emitted statement, byte for byte

```
SELECT TOP (5) * FROM [销售订单] INNER JOIN [仓库].[物料] ON [销售订单].[物料编码] = [仓库].[物料].[物料编码]

SELECT TOP (3) [物料编码] FROM [销售订单] LEFT JOIN [仓库].[物料]
  ON [销售订单].[物料编码] = [仓库].[物料].[物料编码]
  WHERE [销售订单].[物料编码] = @p0 ORDER BY [物料编码] ASC

SELECT TOP (1) * FROM [销售订单] RIGHT JOIN [dbo].[a] ON [dbo].[a].[id] = [销售订单].[a_id]
                                 FULL JOIN [dbo].[b] ON [dbo].[b].[id] = [销售订单].[b_id]
```

(`toBe`, not `toContain`, on the whole statement.) Each is also asserted to stay a pure read at the
write gate (`isPureReadStatement === true`), the WHERE value is asserted absent from the text (it is
bound), and `]` in a side is asserted to come out doubled: `ON [a]] DROP TABLE x] = [dbo].[a].[id]`.

One positive case exists to keep the claim honest rather than to certify safety: a side made only of
letters and spaces (`a UNION ALL SELECT x FROM sys`) passes G52's character rule and IS emitted — as
one bracketed identifier. The test pins that exact text. The brackets are the defence; the character
class never was (design §3 "What is NOT claimed").

## 3. Negative: refused, with NO statement sent

Every negative asserts three things — the throw, the `code`/`status`, and `fp.calls.length === 0`
(the fake pool records statement text as sent, so an empty recorder is "nothing was sent").

| Class | Payloads | Code |
| --- | --- | --- |
| string `on` | `1 = 1`; `a.b = c.d`; `1 = 1 UNION ALL SELECT password, 1 FROM dbo.users`; `1 = 1; DROP TABLE dbo.t`; `1 = 1 --`; `1 = 1 /* x */`; `1 = 1 OR EXISTS (SELECT 1 FROM dbo.users)`; `a.b = dbo.f(1)`; `a.b = srv.db.dbo.t`; `a.b = [srv].[db].[dbo].[t]`; `''` (11) | `SQLSERVER_JOIN_ON_UNSUPPORTED` |
| side breaks the identifier rule | four-part `srv.db.dbo.t`; `a; DROP TABLE dbo.t`; `a --`; `a (SELECT 1)`; `a' OR '1'='1`; `a.*`; `a = b`; `[dbo].[a]`; `''`; `dbo..a` — left AND right (11) | `SQLSERVER_IDENTIFIER_INVALID` |
| operator | `op: '<>'`, `'LIKE'`, `'>'` (3) | `SQLSERVER_JOIN_ON_OPERATOR_INVALID` |
| shape | unknown key `operator`; smuggling key `sql`; array; `null`; `undefined`; number; missing `right`; non-string `left` (8) | `SQLSERVER_JOIN_ON_INVALID` |
| join type | `inner UNION ALL SELECT password, 1 FROM dbo.users -- `; `cross`; `outer`; `inner ` (trailing space); `''`; `INNER JOIN dbo.x ON 1=1 INNER`; `constructor`/`toString`/`__proto__` (9) | `SQLSERVER_JOIN_TYPE_INVALID` |

Message safety is asserted, not assumed: the refusal names the field (`joins[0].on`, and `joins[1].on`
when the second join is the bad one) and does NOT contain the payload; a newline in a side reaches the
message only escaped (`\n`, never a raw line break), inheriting G52's log-safe rendering.

## 4. Mutation probes — "remove the guard, the spec goes red"

Run in memory, nothing written to the repo: a vitest setup file outside the repo patches
`MSSQLAdapter.prototype` with the real implementation MINUS one guard, and the UNMODIFIED spec runs
against it. Command shape:

```
G52B_MUTANT=<NONE|A|B|C|D|E> npx vitest run --config <scratch>/g52b-mutation.vitest.config.ts
```

| # | Mutant (one guard removed) | Result | Which cases turn red |
| --- | --- | --- | --- |
| control | none | **53 passed** | — |
| A | `buildJoinOn` accepts a string `on` again (pre-G52B behaviour) | **12 failed / 41 passed** | all 11 string payloads + the "names the offending join by index" case |
| B | the `op === '='` refusal deleted (everything else intact) | **3 failed / 50 passed** | `<>`, `LIKE`, `>` |
| C | join sides no longer routed through the quoter | **20 failed / 33 passed** | all 5 byte-exact positives + 14 identifier refusals + the in-spec MUTATION 3 probe |
| D | the ≤3-part (LINKED SERVER) cap not applied to join sides — same per-segment rule, same log-safe wrapping | **2 failed / 51 passed** | exactly the two four-part cases (left and right) |
| E | join TYPE allowlist replaced by `toUpperCase() \|\| 'INNER'` | **7 failed / 46 passed** | all 7 join-type cases |

Five further probes live INSIDE the spec (so they run in CI, unlike the external ones) and assert what
each mutant actually does. Two of them were rewritten after the first run disproved their draft: with
the quoter (or the type allowlist) gone, `a] DROP TABLE x` / `inner MERGE dbo.t USING` make the
statement classify as a WRITE, so the default-deny gate refuses it with `OUTBOUND_SQL_WRITE_DISABLED`
and nothing is sent. Both probes now assert BOTH sides of that line:

- gate-caught payload → 403, nothing sent (the pinned positive is dead either way);
- read-grammar-only payload (`a UNION ALL SELECT x FROM sys`, `left outer`) → the mutant SHIPS the
  statement, `isPureReadStatement === true`. The gate is a backstop for the first, never for the second.

MUTATION 4 is the load-bearing one for the whole design: restore the string branch, and
`ON 1 = 1 UNION ALL SELECT password, 1 FROM dbo.users` reaches the pool AND the write gate calls it a
pure read. That is why the string form is refused rather than filtered.

## 5. Suites run

```
$ npx vitest run tests/unit/mssql-join-on-hardening.test.ts tests/unit/mssql-unicode-identifiers.test.ts \
    tests/unit/mssql-adapter.test.ts tests/unit/mssql-adapter-connect-wiring.test.ts \
    tests/unit/mssql-readonly-utils-consumer.test.ts tests/unit/data-source-a5-adapter-conformance.test.ts \
    tests/unit/data-source-identifier-quoting.test.ts tests/unit/data-source-plugin-facade.test.ts \
    tests/unit/data-source-result-boundary.test.ts tests/unit/outbound-sql-write-gate.test.ts
 Test Files  10 passed (10)
      Tests  256 passed (256)

$ node __tests__/helper-contract.test.cjs      # packages/mssql-readonly-utils
[mssql-readonly-utils] helper contract tests passed
$ node __tests__/identifier-unicode.test.cjs
[mssql-readonly-utils] unicode identifier tests passed
$ node __tests__/mssql-readonly-utils-consumer.test.cjs   # plugins/plugin-integration-core
[plugin-integration-core] mssql-readonly-utils CJS consumer smoke passed

$ npx tsc --noEmit            # packages/core-backend
(exit 0)
```

`tsc --noEmit` covers `src/**` only (the package tsconfig excludes `**/*.test.ts`), so the union type
change is proven to compile for `PostgresAdapter`/`MySQLAdapter`, and the new spec is checked by
vitest's transform rather than by the type-checker.

## 6. Not run / not claimed

- **No live SQL Server.** Every assertion is on the statement TEXT the adapter hands the driver, via a
  fake pool. Nothing here proves SQL Server's parser agrees — that is inherited from G52's argument
  (bracketed identifiers, `]]` escape) and from `scanBracketToken`'s per-call round-trip proof.
- **PostgresAdapter / MySQLAdapter still splice `join.on` and `join.type` verbatim** (design §6) —
  untouched by instruction; no test added there, and their behaviour is byte-identical to before.
- **The HTTP route was not exercised end-to-end for joins** (it cannot carry them: zod strips the key —
  design §2), so no supertest case was added; the census is source evidence, not a runtime assertion.
- **Full `pnpm test` was not run** (memory-constrained machine, per the task): only the ten specs above
  plus the three helper/plugin node suites. CI remains the judge.
