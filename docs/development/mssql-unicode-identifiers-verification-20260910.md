# SQL Server Unicode identifiers (G52) — verification, 2026-09-10

Design: `docs/development/mssql-unicode-identifiers-design-20260910.md`.
Branch `fix/mssql-unicode-identifiers`, based on `origin/main` 11dddc18b.
Environment: Windows 11, Node 25.9.0 (repo CI leg is 20.x), pnpm 9.15.9, `pnpm install
--frozen-lockfile --offline` exit 0.

No live SQL Server was reachable from this machine. Everything asserted below is about statement TEXT
and the T-SQL delimited-identifier grammar, which is provable offline; a real-instance read of a
中文-named table belongs to the 222 smoke window (see design §9).

## 1. Commands and exit codes

| # | Command | Result |
| --- | --- | --- |
| 1 | `node packages/mssql-readonly-utils/__tests__/identifier-unicode.test.cjs` | `[mssql-readonly-utils] unicode identifier tests passed`, **exit 0** |
| 2 | `pnpm --filter @metasheet/mssql-readonly-utils test` (contract + unicode + `tsc` ts-consumer) | **exit 0** |
| 3 | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/mssql-unicode-identifiers.test.ts tests/unit/data-source-identifier-quoting.test.ts tests/unit/mssql-adapter.test.ts tests/unit/mssql-readonly-utils-consumer.test.ts tests/unit/outbound-sql-write-gate.test.ts tests/unit/data-source-a5-adapter-conformance.test.ts tests/unit/mssql-adapter-connect-wiring.test.ts` | 7 files / **142 tests passed**, exit 0 |
| 3b | the same runner over EVERY `tests/unit/*` matching `data-source|sql|k3` (23 files — the full blast radius of the helper, not only the suites named above) | 23 files / **367 tests passed**, exit 0 |
| 4 | `node __tests__/<suite>.test.cjs` in `plugins/plugin-integration-core` for `data-source-sql-readonly-source-adapter`, `k3-wise-adapters`, `mssql-readonly-utils-consumer`, `pipeline-runner`, `http-routes`, `b2a-trial-registry-wiring`, `test-chain-completeness` | **exit 0** each |
| 5 | `pnpm --filter @metasheet/web exec vitest run tests/IntegrationObjectTemplateSection.spec.ts tests/integrationErrorCodeLabels.spec.ts tests/IntegrationHelpView.spec.ts tests/IntegrationWorkbenchView.spec.ts tests/integrationWorkbench.spec.ts` | 5 files / **118 tests passed**, exit 0 |
| 6 | `node --test scripts/ops/multitable-onprem-package-verify-k3-helper-contract.test.mjs` | pass 1 / fail 0, exit 0 |
| 7 | `pnpm --filter @metasheet/core-backend exec tsc --noEmit -p tsconfig.json` | **exit 0** |
| 8 | `pnpm --filter @metasheet/web run type-check` **and** `npx vue-tsc -b --force` in `apps/web` | **exit 0** (the `--force` run is deliberate — `vue-tsc -b` is incremental and can report a stale green) |
| 9 | `npx eslint` on the changed `.vue` / `.ts` files (web + core-backend configs) | **exit 0**, no findings |

Counts before/after on the one existing suite whose expectations changed:
`tests/unit/outbound-sql-write-gate.test.ts` 64 → **65** tests (one row moved from the "rejected" list
into a new accepted-case test; see §4).

## 2. The two-outcome contract

`packages/mssql-readonly-utils/__tests__/identifier-unicode.test.cjs` routes EVERY case through one
`classify()` helper, so there is no third outcome to hide in:

- **refused** ⇒ `error.code === 'SQLSERVER_IDENTIFIER_INVALID'`, `error.details.reason` is a string, the
  message contains no control character and (for values ≥ 6 chars) does not carry the raw value; or
- **quoted** ⇒ the output passes `assertBracketShape`, an **independent** scanner written inside the test
  file (it does not call the module under test, so the helper cannot certify itself), AND
  `unquoteSqlServerIdentifier(quoted) === input`.

`assertBracketShape` walks the text with SQL Server's own end-of-token rule and additionally asserts no
C0/C1 control character survives inside a quoted identifier.

## 3. The matrix (57 rows: 19 accepted, 38 refused)

Accepted, with the exact emitted text asserted:

| Input | Emitted |
| --- | --- |
| `orders` | `[orders]` |
| `订单` | `[订单]` |
| `dbo.订单` | `[dbo].[订单]` |
| `仓库.订单` | `[仓库].[订单]` |
| `sales order 2024` | `[sales order 2024]` |
| `销售 订单` | `[销售 订单]` |
| `a　b` (U+3000) | `[a　b]` |
| `물품` / `товары` / `cáfé` | bracketed unchanged |
| `2024_orders` | `[2024_orders]` |
| `tenant.dbo.orders` | `[tenant].[dbo].[orders]` |
| `x`×128 | bracketed unchanged |
| 𠮷×64 (128 UTF-16 units) | bracketed unchanged |
| `a]b` | `[a]]b]` |
| `a]]b` | `[a]]]]b]` |
| `orders]` | `[orders]]]` |
| **`a] DROP TABLE x`** | **`[a]] DROP TABLE x]`** |
| **`订单] SELECT 1`** | **`[订单]] SELECT 1]`** |

Refused (`SQLSERVER_IDENTIFIER_INVALID`):

`a] DROP TABLE x --` · `a;DROP TABLE x` · `a' UNION SELECT 1 --` · `a/*x*/b` · `[dbo].[订单]` · `a[b` ·
`srv.tenant.dbo.orders` · `a.b.c.d.e` · `` (empty) · `   ` · `tenant..orders` · `dbo.` · `.orders` ·
`dbo. 订单` · `a\nb` · `a\rb` · `a\tb` · `a\u0000b` · `a\u0007b` · `a\u007fb` · `a\u0085b` · `a\u200bb`
(ZWSP) · `a\u200db` (ZWJ) · `a\u202eb` (RTL override) · `a\ufeffb` (BOM) · `a\u2028b` · `a\u2029b` ·
lone surrogate · `bad-name` · `amount$1` · `a@b` · `a%b` · `a\b` · `a"b` · `x`×129 · 𠮷×65 (130 units) ·
𠮷×128 (128 code points / 256 units) · `dbo.` + `x`×129.

### Injection cases specifically

| Case | Outcome | Why that is the safe outcome |
| --- | --- | --- |
| `a] DROP TABLE x` | **quoted** `[a]] DROP TABLE x]` | The `]` is doubled, so SQL Server reads ONE identifier named `a] DROP TABLE x`. `isPureReadStatement('SELECT TOP (10) * FROM [a]] DROP TABLE x]')` returns **true** — the gate agrees it is one identifier. The statement fails at the server as "invalid object name", which is correct: no such table. |
| the SAME text emitted WITHOUT the escape | — | `isPureReadStatement('SELECT TOP (10) * FROM [a] DROP TABLE x]')` returns **false**. The second, independent barrier catches what the escape would have let through. |
| `a] DROP TABLE x --` | refused | `-` is outside the allowlist. |
| `a;DROP TABLE x` | refused | `;` is outside the allowlist. |
| `a' UNION SELECT 1 --` | refused | `'` is outside the allowlist. |
| `a/*x*/b` | refused | `/` and `*` are outside the allowlist. |
| `[dbo].[订单]` (pre-bracketed) | refused | `[` refused with an actionable reason. |
| `srv.tenant.dbo.orders` | refused | four-part = linked server, see design §5. Note the write gate CANNOT catch this one — a four-part SELECT carries no non-read reserved word — which is why the part cap exists. |

### Round-trip property

400 pseudo-random identifiers (deterministic seed `20260910`, alphabet = ASCII + `_` + space + `]` +
CJK/Hangul/Cyrillic/Thai/Latin-1 + U+3000 + 𠮷, 1–3 parts); all 400 were exercised (measured, not
assumed — the suite asserts `checked > 300` so a generator that silently stopped producing cases cannot
pass as coverage). For each: `unquoteSqlServerIdentifier(quote(x)) === x`, the shape scanner passes, and
the `]` count is verified arithmetically and independently of the parser —
`count(']' in quoted) === Σ over parts (1 + 2 × count(']' in part))`.

## 4. The one existing expectation that changed

`packages/core-backend/tests/unit/outbound-sql-write-gate.test.ts` previously asserted that ALL of
`['a b', 'a-b', 'a;b', 'a)b', "a'b", 'a*b']` are refused as WHERE identifiers. `'a b'` — a column named
with an ordinary space — was **the G52 outage itself**, so it moved out of that list into a new test
that asserts `'a b'`, `'供应商 名称'`, `'物料编码'` and `'销售订单.数量'` build a statement (they reach
`Not connected` from the fake pool, the same success signal the neighbouring qualified-key test uses).
The rejection list keeps the other five and gains `'a/*b'` and `'a--b'`, so the character rule is still
proven not to have simply fallen open.

No other existing expectation moved. `data-source-identifier-quoting.test.ts` (which pins
`mssqlQuote('bad-name')` throwing and `tenant.dbo.orders` quoting) and
`helper-contract.test.cjs` (which pins `bad-name`, `tenant..orders`, and three-part quoting) are
untouched and green.

## 5. Wiring — the SQL the adapter actually emits

`packages/core-backend/tests/unit/mssql-unicode-identifiers.test.ts` captures statements from a fake
`mssql` pool (no server):

- `select('仓库.销售订单', { select: ['物料编码','供应商 名称'], where: {'供应商 名称': 'ACME'}, orderBy: [{column:'物料编码'}] })`
  emits `FROM [仓库].[销售订单]`, `[物料编码], [供应商 名称]`, `WHERE [供应商 名称] = @p0`,
  `ORDER BY [物料编码] ASC`, and the VALUE `ACME` appears nowhere in the text.
- The table name appears exactly once and never un-bracketed (`/[^\[]销售订单/` must not match).
- `select('a] DROP TABLE x')` emits `FROM [a]] DROP TABLE x]` and NOT `FROM [a] DROP TABLE x]`.
- JOIN target and OFFSET paging quote identically.
- `select('bad-table')` and `select('srv.db.dbo.t')` reject with `/Invalid identifier/`.
- `quoteIdent('evil\nDELETE FROM t --')` throws a message that contains `\\n` (escaped) and **no raw
  newline**, carries `code: 'SQLSERVER_IDENTIFIER_INVALID'`, and for a 50 000-character identifier the
  message stays under 260 characters.

## 6. Mutation probes

All probes rewrite the runtime **in memory** (`Module.prototype._compile` on a mutated source string);
nothing is written to disk. M1, M1b, M2, M3, M4, M5 live permanently in
`packages/mssql-readonly-utils/__tests__/identifier-unicode.test.cjs` (`testMutationProbes`) and M7 in
`packages/core-backend/tests/unit/mssql-unicode-identifiers.test.ts`, so they re-run on every CI pass.
M6 was run once, ad hoc, with the same in-memory loader; it is reported here rather than kept as a test
because its result is a NEGATIVE one (see the row).

| # | Mutation | Baseline | Mutated | Which assertion goes RED |
| --- | --- | --- | --- | --- |
| M1 | delete `.replace(/]/g, ']]')` | `"[a]] DROP TABLE x]"` | `THROW … / segment could not be bracket-quoted losslessly` | matrix row `INJECTION: bracket + write verb` (the quoter's own round-trip proof fires first, so the failure is a refusal, not a bad statement) |
| M1b | delete the escape **and** the round-trip proof (`if (!parsed \|\| …)` → `if (false)`) | `"[a]] DROP TABLE x]"` | `"[a] DROP TABLE x]"` — a real injection | same matrix row, plus the independent `assertBracketShape` scanner, plus `isPureReadStatement` flipping to `false` in the core-backend spec |
| M2 | add `\p{C}` to `ALLOWED_PART_CHARACTERS` | `THROW … / character outside …` | `"[a\nb]"` | every control/format refusal row (newline, NUL, ZWSP, RTL override, BOM, U+2028/9, lone surrogate) |
| M3 | `IDENTIFIER_MAX_PARTS = 3` → `99` | `THROW … / more than three parts — a four-part name targets a LINKED SERVER` | `"[srv].[tenant].[dbo].[orders]"` | matrix row `four parts (LINKED SERVER)` and the adapter-level `select('srv.db.dbo.t')` rejection |
| M4 | `IDENTIFIER_MAX_CODE_UNITS = 128` → `100000` | `THROW … / segment exceeds 128 characters` | `"[xxx…129]"` | matrix rows `129 UTF-16 units`, `65 supplementary`, `128 code points but 256 units` |
| M5 | `EDGE_SPACE_SEPARATOR` → a never-matching regex | `THROW … / segment starts or ends with a space` | `"[dbo].[ 订单]"` | matrix row `inner segment leading space` |
| M6 | delete the explicit `[` refusal | `THROW … / segment contains "[" — pass the plain object name …` | `THROW … / character outside …` | only the REASON changes, not the outcome — **this check is a message guard, not a safety guard**, and is labelled as such in the source and in design §3 |
| M7 | replace `quoteSqlServerIdentifier` with identity in `MSSQLAdapter`'s import (`vi.doMock`) | `FROM [仓库].[销售订单]` | `FROM 仓库.销售订单` (bare) | every SQL-shape assertion in the core-backend spec — this is what proves the adapter is wired to the ONE quoter rather than formatting brackets itself |

M6 is reported as a negative result deliberately: it is the one guard added here whose removal does
NOT change the security outcome.

## 7. Residual risk / what is NOT proven

- **No live server.** The claim "`]]` is a total escape" is T-SQL grammar plus MS documentation, and the
  agreement with `scanSqlNoise` is proven by executing both. What is not proven here is the behaviour
  of a real instance under a specific collation. A `SELECT` from a 中文-named table on the 222 box would
  close that, and is the natural smoke item.
- **Four-part names are now refused.** If any deployment reads through a linked server by four-part
  name, this PR breaks that read. Nothing in the repo's fixtures, tests or configs does. Flagged for
  owner review as the single narrowing in the change.
- **`\p{Cn}` (unassigned) is refused**, so a code point newer than the running Node's Unicode tables is
  refused even if the server accepts it. Deliberate fail-closed; the symptom would be one very new CJK
  extension character in an object name.
- **The outer trim is unchanged**, so `'  dbo.orders  '` still silently becomes `dbo.orders` while
  `'dbo. 订单'` is refused. Pre-existing asymmetry, documented rather than changed, because changing
  `requiredString` would touch every other helper caller.
- **Punctuation stays refused** (`-`, `%`, `(`, `)`, …). If a customer reports `Order-No`, the fix is one
  character in `ALLOWED_PART_CHARACTERS` plus a matrix row; the escape already handles it.
- **The helper package's own `pnpm test` is not run by any workflow.** That is why
  `packages/core-backend/tests/unit/mssql-unicode-identifiers.test.ts` `require`s the `.cjs` suite: the
  core-backend vitest run IS a required context (`plugin-tests.yml`, "Run core-backend tests"), so the
  whole matrix gates a merge rather than sitting inert next to the code it certifies.
