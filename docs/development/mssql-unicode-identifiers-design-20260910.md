# SQL Server identifiers: Unicode in, injection still out (G52) — design, 2026-09-10

Branch `fix/mssql-unicode-identifiers`. Companion:
`docs/development/mssql-unicode-identifiers-verification-20260910.md`.

## 1. The gap

`quoteSqlServerIdentifier` validated every dot-separated segment against `/^[A-Za-z0-9_]+$/` and threw
`SQLSERVER_IDENTIFIER_INVALID` otherwise. Every generic SQL Server read funnels through it — table
name, projected columns, `WHERE` keys, `ORDER BY`, `JOIN` target
(`packages/core-backend/src/data-adapters/MSSQLAdapter.ts`, `quoteIdent` / `whereIdentifier`), plus
the shared bounded-`SELECT` builder used by the K3 executor.

So a customer whose ERP 二开 named a table `销售订单` or a column `供应商 名称` — the normal case in a
Chinese SQL Server deployment — could not READ it. Not "read it slowly", not "read it without an
index": the statement was refused before a connection was opened. The refusal also bought nothing,
because the same function has always emitted the name inside `[...]`.

## 2. What actually makes this safe

**One rule: an identifier never reaches SQL text except through `quoteSqlServerIdentifierPart`, which
brackets it and doubles every `]`.**

T-SQL's delimited-identifier grammar has exactly ONE metacharacter inside `[...]`: the closing bracket,
escaped by doubling. Nothing else inside a delimited identifier can end it or start a new token — not
`'`, not `;`, not `--`, not `/*`, not a newline, not a keyword. So `]`-doubling is a *total* escape, and
the injection defence is that escape, not the character set. Widening the character set does not touch
it.

Three properties hold this together, and each one is separately falsifiable (see §6 of the verification
doc):

1. **Validation and quoting are halves of one function.** `assertSqlServerIdentifierPart` is called BY
   the quoter. There is no "checked here, emitted over there" seam in which a value could pass a check
   and then be emitted by a path that forgot to escape.
2. **The quoter proves its own output, per call.** After building the token it re-reads it with SQL
   Server's own end-of-token rule (`scanBracketToken`: a token ends at the first `]` NOT followed by
   another `]`) and refuses unless the result is byte-identical to the input. A missing or wrong escape
   becomes a THROW instead of a statement.
3. **The write gate agrees with the quoter.** `outbound-sql-write-gate.ts`'s `scanSqlNoise` strips
   bracketed identifiers using the SAME `]]` rule before it classifies a statement. Quoter, SQL Server
   parser and classifier therefore agree on where an identifier ends, so a hostile-looking object name
   can neither smuggle a verb past the gate nor turn a legitimate read into a refused "write". This is
   defence in depth: `assertSqlWriteAllowed` runs on the MSSQLAdapter path only; the escape is what
   protects the paths that have no gate (the shared `buildSimpleSelectQuery`, used by the K3 executor
   against its own pool).

Two things that are NOT part of the safety argument, stated so they are not mistaken for it:

- Values never travel in statement text at all — filters and watermarks are bound parameters
  (`request.input(...)` / `$N`), and schema introspection queries `INFORMATION_SCHEMA` with `$1`/`$2`.
- `mssql@10`'s tedious driver sends the batch text as an RPC parameter to `sp_executesql` and binds
  values with `addParameter` (`node_modules/.../mssql/lib/tedious/request.js`, `connection.execSql(req)`
  at the end of `_query`). There is no client-side string interpolation of our identifier text.

## 3. The rule

Applied per dot-separated segment, after the whole value is trimmed.

### Accepted

| Class | Regex / bound | Why it is safe, and why it is wanted |
| --- | --- | --- |
| Unicode letters | `\p{L}` | The gap itself: 物料表 / товары / नाम. Inert inside `[...]`. |
| Combining marks | `\p{M}` | Decomposed Vietnamese/Devanagari/Latin names would otherwise fail on their second code point. |
| Unicode digits | `\p{N}` | Superset of `0-9`. |
| Underscore | `_` | Was already accepted. |
| Space separators | `\p{Zs}` (U+0020, U+3000, NBSP, …) **not** first or last | `含空格的别名` is half the reported gap. A space cannot end a delimited identifier. |
| A literal `]` | — | A real object name may contain one, and the doubling expresses it EXACTLY. Admitting it is also what keeps the escape a live, tested path instead of dead decoration. |
| 1–3 dot-separated parts | `object`, `schema.object`, `db.schema.object` | Unchanged from before this PR. |
| ≤ 128 UTF-16 code units per part | `part.length` | Exactly SQL Server's own bound, see below. |

The accepted character set is a strict SUPERSET of the old `[A-Za-z0-9_]`. Nothing that used to be
accepted is now refused **on character grounds**.

### Refused

| Class | Reason |
| --- | --- |
| Empty / blank value, empty segment (`a..b`, `dbo.`, `.t`) | Nothing to name. |
| Segment > 128 UTF-16 code units | SQL Server's own limit, see §4. |
| Leading/trailing space separator **inside a qualified name** (`dbo. 订单`) | Invisible in every UI, so an operator cannot tell it from the trimmed name; SQL Server's own trailing-blank handling for identifiers is not uniform across contexts. Refusing says so rather than silently reading a different object. |
| `[` | Its only realistic appearance in operator input is a name already bracketed in SSMS (`[dbo].[订单]`). We cannot tell that from a name whose characters really are `[dbo]`, and guessing would mean shipping a bracket parser — new attack surface for a formatting convenience. Refusing catches 100% of pre-bracketed input (every such form contains `[`). **This specific check is a MESSAGE guard, not a safety guard** — `[` is already outside the allowlist, so removing the check still refuses, just with a less actionable reason. Labelled as such in the source. |
| Control characters and newlines (`\p{Cc}`), format/bidi/zero-width/BOM (`\p{Cf}`), lone surrogates (`\p{Cs}`), private-use and unassigned (`\p{Co}`, `\p{Cn}`), line/paragraph separators (U+2028/U+2029) | Not because they could inject (they could not — see §2) but because none of them NAMES anything, several are invisible or script-spoofing, and a newline splits every log line and error message that carries the value. Refusing `\p{Cn}` also means a code point newer than the running Node's Unicode tables is refused; that is deliberate fail-closed. |
| ASCII punctuation: `;` `'` `"` `-` `/` `*` `%` `(` `)` `\` `,` `+` `=` `@` `#` `$` `.`(inside a segment) … | Kept out to hold the change to what the gap actually needs, and to keep this adapter's rule consistent with the Postgres/MySQL adapters' own `sanitizeIdentifier`. **`$` is load-bearing rather than incidental**: `MSSQLAdapter.query` rewrites `$N` placeholders over FINISHED statement text, so `[amount$1]` would be silently rewritten to `[amount@p0]`. Refusing `$` removes the class instead of the instance. |
| 4+ dot-separated parts (`server.db.schema.object`) | See §5. |

Admitting a further punctuation character later is a one-character edit to
`ALLOWED_PART_CHARACTERS` plus a test row. Deliberately not done speculatively: the reported gap is
non-ASCII letters and spaces, and `[a] DROP TABLE x --` staying refused is worth more today than
`Order-No` reading.

**Known limitation:** a segment whose literal name contains a dot is unrepresentable — `a.b` is read as
two parts. Making it representable means accepting pre-bracketed input; see the `[` row.

**Pre-existing behaviour kept:** the whole value is trimmed before splitting (`requiredString`), so a
leading/trailing space on the OUTER edge is silently dropped rather than refused. Only inner-segment
edges hit the rule above. This is unchanged from before the PR.

## 4. The 128 limit is in UTF-16 code units, and that matters

SQL Server object names are `sysname`, which is `nvarchar(128)` — 128 UCS-2/UTF-16 units. Not bytes
(a Chinese name is 3 bytes/char in UTF-8, and `nvarchar` is not UTF-8 anyway) and not code points: a
supplementary character such as 𠮷 (U+20BB7) or an emoji costs TWO units. JavaScript's `String#length`
counts exactly those units, so `part.length <= 128` is the server's own unit, not an approximation.

Tested both ways: 64 × 𠮷 (128 units, 64 code points) is ACCEPTED; 65 × 𠮷 (130 units) is REFUSED; and
128 × 𠮷 — 128 code points, which a naive `[...part].length` check would accept — is REFUSED.

## 5. Three parts stay, four parts are refused

- **1–3 parts** (`object`, `schema.object`, `db.schema.object`) — unchanged. Three parts is
  cross-DATABASE on the SAME server, bounded by the login the data source connects with, and it was
  already accepted (pinned by `helper-contract.test.cjs` and `data-source-identifier-quoting.test.ts`
  before this PR). Not widened, not narrowed.
- **4+ parts** (`server.db.schema.object`) — **newly refused.** A four-part name is a LINKED SERVER
  reference: it leaves the configured server entirely and executes under the linked server's
  credentials, so this data source's read-only guarantee does not reach it. Note the write gate cannot
  substitute here — a four-part *SELECT* contains no reserved non-read keyword, so
  `isPureReadStatement` classifies it as a legitimate read. This is the one place the PR NARROWS the
  contract, and it is called out for review: a deployment reading through a linked server by four-part
  name would now be refused. No such configuration exists in this repo's fixtures or tests.
- **The plugin adapter stays at TWO parts.** `data-source-sql-readonly-source-adapter.cjs`'s
  `requiredSqlIdentifier(..., { qualified: true })` still allows at most `schema.object`, because
  `splitQualifiedObject` next to it only understands schema + object; a third part would be passed
  whole as the table name and resolve to something else. Cross-database from THAT surface is a separate
  boundary and is not opened here.

## 6. Layering — who validates what

```
plugin config (lookupProjection)      data-source-sql-readonly-source-adapter.cjs
  ├─ ≤2 parts, no surrounding space, no __proto__/prototype/constructor   [local, stricter]
  └─ character rule ────────────────► assertSqlServerIdentifierPart       [shared]

K3 WISE executor                      k3-wise-sqlserver-executor.cjs
  ├─ /^[A-Za-z_][A-Za-z0-9_]*(\.…)?$/ ASCII, ≤2 parts, no leading digit   [local, stricter]
  └─ then ─────────────────────────► quoteSqlServerIdentifier             [shared]

MSSQLAdapter (table/columns/where/orderBy/join)
  └─ quoteIdent ──────────────────► quoteSqlServerIdentifier              [shared]
```

The K3 lane deliberately does NOT inherit the widening: its own pre-check runs first and
`k3-wise-adapters.test.cjs` already asserts "K3 executor must not inherit generic helper multi-part
identifier policy". K3 WISE ships ASCII table names (`t_ICItem`), so there is no gap to close there and
no reason to widen a lane that talks to a specific known schema.

The plugin gate calls the SHARED character rule rather than keeping a parallel regex, so the gate in
front of the quoter cannot drift from the quoter.

## 7. Error surface

`SQLSERVER_IDENTIFIER_INVALID` still exists — it now means "the name really is unusable", not "your
table name is not ASCII". Changes:

- Every refusal carries `details.reason` (a fixed enum string; never the value).
- `MSSQLAdapter.quoteIdent` re-throws with the `code` preserved (it used to be dropped) and renders the
  offending identifier with `JSON.stringify`, truncated to 160 characters. A rejected identifier is
  arbitrary text by definition, so pasting it raw into an error string — and from there into a log
  line — would let a newline in a table name split the log record.
- `apps/web/src/services/integration/errorCodeLabels.ts` gains ONE entry (append-only, no existing
  entry touched — #5597 is in flight on that file) whose hint states the new rule and points at the
  two ways out: a legal object name from the DBA, or an ASCII-aliased view.

## 8. Second half of G52 — the source-field list

`IntegrationObjectTemplateSection.vue` rendered the schema as a bare `<ul>`. A real ERP table is
40–200 columns, and once names may be 中文 the list is both long and hard to skim. Three purely local
affordances, no parent state, no service call, no wire change:

- a filter box matching NAME, LABEL and TYPE case-insensitively (so `qty` finds `数量` when the adapter
  supplied a label, and `nvarchar` finds every text column), with an `n / total` counter and an explicit
  "no match" row;
- the declared type as a badge — already present on `IntegrationObjectSchemaField.type`, simply never
  displayed;
- click-to-copy of the exact field NAME (not the label — the label is not what a mapping expression
  accepts), with the "已复制" flash shown ONLY after the clipboard write resolved. On-prem deployments
  are frequently plain HTTP, where `navigator.clipboard` does not exist; there the click does nothing
  rather than claiming a copy that did not happen.

Values-free: only schema METADATA is rendered or copied, never a row value.

## 9. Not done here

- Postgres / MySQL identifiers stay ASCII (`BaseAdapter.sanitizeIdentifier`,
  `MySQLAdapter.sanitizeMySQLIdentifier`). The same customer story exists for a Chinese-named Postgres
  schema; the fix is the same shape (quote + escape `"` by doubling) but a different escape, a different
  set of consumers, and its own test matrix.
- Punctuation (`-`, `%`, `(`, `)`) stays refused; see §3.
- The K3 lane stays ASCII; see §6.
- A live SQL Server round-trip. The bracket/escape behaviour asserted here is grammar, not server
  configuration, so it is provable offline; a real-instance read of a 中文-named table belongs to the
  222 smoke window (`docs/operations/data-source-system-integration-c5-k3-mssql-smoke-runbook-20260615.md`).
