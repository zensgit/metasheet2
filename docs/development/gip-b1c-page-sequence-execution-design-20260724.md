# GIP B1c — Page-Sequence Execution Context: Design (2026-07-24)

**Status: PROPOSED / design-first / no runtime.**

This document designs the B1c slice of the database & system integration line. B1c ships **no code in this slice**: no runtime, no route, no flag, no arming, no schema change. Implementation is a **later owner gate**. The slice order that places B1c is owner-ratified in `docs/development/database-system-integration-line-design-and-verification-20260724.md` — the line's single design-and-verification document and evidence ledger. This document deliberately does **not** restate that ledger's contents (including the slice order itself) and must never become a competing fact source; B1c's position in the order is defined there, not here. **Status of that line document: it is not yet on `origin/main`** — at the time of writing it is the sole file of open PR #4590 (verified by `git ls-tree` against `origin/main` and by the PR file list). It is cited throughout as the ratified authority it becomes on merge; the citation must be re-confirmed against `origin/main` before any B1c implementation gate.

Code claims below about **shipped** symbols were verified against `origin/main` (`a3e5765727ca608e8c49c7a44a025e6e4aae5d40`) at the time of writing, by reading the named symbols — not from memory and not from prior memos. Three cited artifacts are **not** on `origin/main` and are flagged as such wherever they appear: the line document above (open PR #4590), and the in-flight B1a symbols `PAGED_READ_LEGAL_COMBINATIONS` and `orderingKeySpec` (status notes in §2; flagged uses in §6). Where this document is **not certain** of a dialect guarantee, it says **"to be confirmed by spike"** rather than asserting. No live database was reachable during authoring; every claim here is a code-reading or engine-documentation-level claim, and the per-dialect sections separate the two explicitly.

---

## 1. The problem — a probe certifies ONE statement; a page sequence needs a context that SPANS it

The shipped qualification spike (`plugins/plugin-integration-core/lib/gip-binding-qualification-spike.cjs`) certifies an **ordering key**, via a total-order probe that is deliberately **one statement** (`buildOrderingKeyTotalOrderProbeSql` composes the duplicate probe and the NULL probe into a single `SELECT` so both predicates are evaluated against one observed state). The PostgreSQL reference strategy declares:

- `strategyId: 'gip.total_order_probe.postgres'`
- `strategyVersion: 'v1'`
- `dialect: 'postgres'`
- `snapshotSemantics: 'single_statement_mvcc'`

and the module's own comment is explicit that `snapshotSemantics` is **the STRATEGY'S claim** ("single statement executes under one MVCC snapshot in PG"), that "Whether a single statement actually implies one source snapshot is a DIALECT/ISOLATION property — the PLATFORM does not assume it", and that the probe runs "OUTSIDE any transaction (the caller supplies a plain query fn; the spike never opens/joins a transaction)".

So `single_statement_mvcc` means exactly what it says: **one probe statement observes one MVCC snapshot**. It says **nothing about a page sequence**. Nothing that exists today makes page 2 read the same database state as page 1:

- `DataSourceManager.select(dataSourceId, table, options?)` (`packages/core-backend/src/data-adapters/DataSourceManager.ts`) resolves the adapter, ensures it is connected, and delegates to `adapter.select(table, options)`. Its `QueryOptions` (`packages/core-backend/src/data-adapters/BaseAdapter.ts`) carries `limit` / `offset` / `orderBy` / `select` / `joins` / `where` — **no transaction and no connection handle**. The same holds for `DataSourceManager.query`.
- The execution is **pool-per-call**: `PostgresAdapter.query` calls `this.pool.query(sql, params)` (the `pg` pool checks a client out, runs the one statement, and releases it); `MySQLAdapter.query` calls `this.pool.execute(sql, params)`; `MSSQLAdapter.query` calls `this.pool.request().query(...)`. Two consecutive `select()` calls may run on **different connections**, and even on the same connection they are separate implicit transactions.
- The adapters do declare transaction methods (`BaseDataAdapter.beginTransaction/commit/rollback/inTransaction`, with `Transaction = unknown`), but **transaction objects cannot be passed into `select()`/`query()`** — no read method accepts a `Transaction`, and `inTransaction(transaction, callback)` gives the callback **no handle** to route a statement through the transaction's client. The transaction surface is unreachable for reads by construction.
- Multi-page readers exist in tree today, and none carries a consistency context. The **live, shipped** one is the integration pipeline loop: `plugins/plugin-integration-core/lib/pipeline-runner.cjs` pages `while (page < maxPages)`, calling `context.sourceAdapter.read({ …, cursor })` and advancing `cursor = readResult.nextCursor`. Read through `data-source-sql-readonly-source-adapter.cjs`, the adapter's **non-watermark (offset) branch** — the default path, since pipeline-runner supplies a watermark config only in `incremental` mode — parses the cursor as a row offset, issues the select with **no `orderBy` at all** (`orderBy` is set only on the watermark path), emits `nextCursor = String(offset + records.length)` on a full page, and reports `done: !fullPage`. That is a real multi-page OFFSET read over **live** data — no ordering, no snapshot, separate implicit transactions on possibly different connections per page (the pool-per-call path above) — terminating on a `SHORT_PAGE`-style stop that §3.2 shows is only a proof under a fixed snapshot. **This exposure is not hypothetical; it ships today**, and it is precisely the exposure B1c exists to close with a sound execution context. `DataSourceManager.copyData` is a second, dormant instance of the same shape: an `offset += batchSize` loop over `sourceAdapter.select(sourceTable, { where, limit: batchSize, offset })` with no `orderBy` and no consistency context (its only in-tree callers today are unit-test assertions in `packages/core-backend/tests/unit/data-source-readonly.test.ts` — verified by tree grep for `.copyData(`).

**Therefore an ordering key proves total order only — not snapshot stability across pages.** With a certified unique, non-NULL, stable key, a concurrent insert, delete, or key-value change between page 1 and page 2 still yields a skipped or duplicated row, under OFFSET **and** under keyset paging (§6 gives the exact failure modes). The owner-ratified conclusion this document exists to implement, stated without softening:

> **`PAGED_READ` certification requires BOTH a certified unique/stable ordering key AND a certified consistency mechanism that spans the whole page sequence.**

B1a/B1b deliver the first half (key qualification per dialect). B1c is the second half: the **page-sequence execution context**.

A small honesty note on the current surface: `BaseDataAdapter.resolveEffectiveLimit` rejects an over-max limit with the message "…paginate with limit+offset instead" — the codebase currently *directs* callers toward exactly the pattern whose completeness is uncertified. Changing that wording or behaviour belongs to the gated enforcement slice (B2), not to B1c; it is recorded here only so the gap is not read as an endorsement.

## 2. Verified fact base (symbols, `origin/main`)

| Fact | Where verified |
|---|---|
| `select()`/`query()` take no transaction/connection; pool-per-call execution | `DataSourceManager.select`, `DataSourceManager.query`, `PostgresAdapter.query` (`this.pool.query`), `MySQLAdapter.query` (`this.pool.execute`), `MSSQLAdapter.query` (`this.pool.request().query`) |
| Adapter transaction surface exists but is unreachable for reads | `BaseDataAdapter.beginTransaction/commit/rollback/inTransaction`; `PostgresAdapter.beginTransaction` (`pool.connect()` + `BEGIN`, default isolation); `inTransaction` callback signature `() => Promise<R>` |
| Per-page row bound is adapter-enforced | `resolveEffectiveLimit` (omit ⇒ `DATA_SOURCE_MAX_ROWS = 10000` cap; over-max ⇒ throw); route default `DATA_SOURCE_DEFAULT_LIMIT = 1000` at `POST /api/data-sources/:id/select` (`packages/core-backend/src/routes/data-sources.ts`) |
| MSSQL fabricates an ordering for bare OFFSET | `MSSQLAdapter.select`: `ORDER BY ${orderBy ?? '(SELECT NULL)'} OFFSET … ROWS FETCH NEXT … ROWS ONLY` — a syntax-satisfying, **non-deterministic** order (its deletion is a ratified B2 item; see the line doc) |
| A shipped multi-page OFFSET read with no order and a live-data short-page stop | `pipeline-runner.cjs`: `while (page < maxPages)`, `cursor = readResult.nextCursor`; `data-source-sql-readonly-source-adapter.cjs#read()` offset branch: `selectOptions.offset` from the cursor, `orderBy` set only on the watermark path, `nextCursor = String(offset + records.length)` on a full page, `done: !fullPage`; adapter self-declares `offsetPagingOnly: true` in its read guardrails |
| Probe strategy claim is per-strategy, values-free evidence | `postgresTotalOrderProbeStrategy` (`snapshotSemantics: 'single_statement_mvcc'`); probe evidence carries `checkedKeyColumnCount` / `duplicateGroupsFound` / `nullKeyRowsFound` and the strategy identity — never key values or field names |
| Trust is object identity | module-private `trustedProbeStrategyRegistries` WeakSet + `createProbeStrategyRegistry`; `PROBE_STRATEGY_UNBOUND` fail-closed-by-name |
| Capability vocabulary (frozen) | `gip-profile-certification-contracts.cjs`: `GIP_ACQUISITION_MODES = [BOUNDED_READ, PAGED_READ, SEALED_EXPORT, CHANGE_FEED]`; `GIP_CONSISTENCY_PROOFS = [SOURCE_SNAPSHOT_TXN, IMMUTABLE_SNAPSHOT_TOKEN, MONOTONIC_VERSION_PIN]`; `GIP_CONTINUATION_LIFETIMES = [SINGLE_REQUEST, CONNECTION_BOUND, DURABLE_TOKEN]`; `GIP_COMPLETENESS_PROOFS = [SHORT_PAGE, DECLARED_TOTAL, SIGNED_MANIFEST]` |
| Cross-dimension legality + recovery derivation already shipped | `assertCertificateCrossDimensionLegal` (rules 1–4, `ILLEGAL_CAPABILITY_COMBINATION`); `deriveRecoveryStrategy` — `BOUNDED_READ ⇒ WHOLE_RERUN`, `SEALED_EXPORT ⇒ CHUNK_RESUME`, durable-anchor `DURABLE_TOKEN ⇒ PAGE_RESUME`, "everything else (connection-bound snapshot …) ⇒ WHOLE_ROUND_RESTART" |

**Status of `PAGED_READ_LEGAL_COMBINATIONS`:** the frozen two-row table is the owner-ratified B1a contract (line doc §3.3) and is being landed by the B1a slice, which is **in flight in a parallel lane at the time of writing — the symbol is not yet on `origin/main`** (verified by `git grep` against `origin/main`). This document takes the ratified rows as its input contract and must be re-checked against the landed B1a symbol before any B1c implementation gate.

**Status of `orderingKeySpec`:** same treatment. The ordering-key field that **is** shipped on `origin/main` is the certificate's `orderingKeyRequirement` (`gip-profile-certification-contracts.cjs` — schema key, digest material, deep-cloned on freeze; verified by `git grep`). `orderingKeySpec` is the **new approved-config-layer symbol introduced by the in-flight B1a slice** and is **not yet on `origin/main`** (a `git grep` against `origin/main` returns nothing). Where §6 names `orderingKeySpec`, it names the ratified B1a contract shape, not a shipped symbol; it must be re-verified against the landed B1a symbol before any B1c implementation gate.

The two `PAGED_READ_LEGAL_COMBINATIONS` rows — and B1c's job is to give each row a real, certifiable execution mechanism — are:

| consistency proof | continuation lifetime |
|---|---|
| `SOURCE_SNAPSHOT_TXN` | `CONNECTION_BOUND` |
| `IMMUTABLE_SNAPSHOT_TOKEN` | `DURABLE_TOKEN` |

`MONOTONIC_VERSION_PIN` is deliberately unmapped for `PAGED_READ` in v1 (a version pin **detects** drift; it does not make pages mutually consistent), while remaining legal where already ratified in other modes (`CHANGE_FEED + MONOTONIC_VERSION_PIN + DURABLE_TOKEN`). Any other `PAGED_READ` combination is a closed rejection — **never a silent downgrade to `BOUNDED_READ`**.

## 3. The seam — a page-sequence execution context

### 3.1 Contract shape (design; implementation later-gated)

B1c introduces one seam: a **page-sequence execution context** that holds exactly **one certified consistency context across all pages of one read run**. Sketch (shape only — field names indicative, to be frozen at the implementation gate):

```
openPageSequence({ resolution, qualification, pageSequenceStrategy… })  →  context
context.readPage(…)                                                     →  one page
context.close(outcome)                                                  →  terminal
```

Design invariants, each inherited from an already-ratified pattern:

1. **Entry only through the B1a resolver.** The context is opened from the deep-immutable, server-derived resolution object (full six-field tuple) and a currently-valid qualification — never from caller-supplied fields. Mirrors the probe path: no cached caller-side tuple is honoured.
2. **Dialect mechanics come from a server-registered `pageSequenceStrategy`**, bound per `actionProfileVersion`, trusted by **object identity** (module-private WeakSet), mirroring `createProbeStrategyRegistry` / `trustedProbeStrategyRegistries`. An unbound profile fails closed by name (the `PROBE_STRATEGY_UNBOUND` pattern). The strategy declares its **sequence-level** snapshot claim — a new claim, distinct from and never inferred from the probe's `snapshotSemantics` (a `single_statement_mvcc` probe claim does **not** transfer to a sequence).
3. **One consistency context per run, matching exactly one legal-combination row.** Row 1 pins one connection with an open snapshot transaction; row 2 addresses an immutable snapshot by token. The context never mixes rows and never re-establishes its snapshot (§5.3).
4. **Closed lifecycle, no stuck absorbing state:** `OPEN → READING → COMPLETED | ABORTED`. Every non-terminal state has a bounded lifetime (§5.2) whose expiry forces `ABORTED`. There is no state from which the run can neither finish nor be reclaimed.
5. **Read-only and statement-bounded**, composing the existing guards: each page statement remains subject to the A5 per-page bound (`resolveEffectiveLimit`) and to a read-only guard of the `assertReadOnlySql` kind on the context's only execution path. B1c proposes **no change** to `DATA_SOURCE_MAX_ROWS` or `DATA_SOURCE_DEFAULT_LIMIT` (ceiling changes are separately owner-gated).
6. **Values-free evidence.** Sequence evidence carries counts, closed status tokens, and strategy identity (pages read, rows read, snapshot-claim identity, termination reason) — never key values, row content, or field names. See §5.4 for the continuation-token tension and its resolution.

### 3.2 Row 1 — `SOURCE_SNAPSHOT_TXN + CONNECTION_BOUND` (same-connection snapshot transaction)

One dedicated connection is checked out for the whole sequence; a snapshot-isolation transaction is opened on it; every page statement runs on **that connection inside that transaction**; the transaction ends and the connection is released at `COMPLETED`/`ABORTED`. What the strategy must certify per dialect is §4. Structural notes:

- This is a **new execution path**, not a parameter on `select()`. The existing `select()`/`query()` stay pool-per-call and untouched; the context owns its pinned client directly (the way `PostgresAdapter.beginTransaction` already returns a dedicated `PoolClient`, and `MySQLAdapter` already uses `pool.getConnection()` for its transactional paths). Whether the seam lives beside the B1b restricted probe-executor seam in core-backend, with qualification/contract logic staying in the GIP layer, follows the line doc's dependency direction; the split is an implementation-gate decision.
- The recovery contract is **already derived** by the shipped matrix: `deriveRecoveryStrategy` sends connection-bound snapshot reads to `WHOLE_ROUND_RESTART`. A lost context can never be resumed — only the whole round restarted on a **new** snapshot, reported as such.
- Under a fixed snapshot, `SHORT_PAGE` becomes a sound sequence-termination proof: the readable set is immutable for the sequence's lifetime, so "a page shorter than the limit" genuinely means exhaustion — which it does **not** mean on live data. The consistency context is what upgrades `SHORT_PAGE` from heuristic to proof; this interlock should be stated in the certificate combination when the implementation slice freezes it.

### 3.3 Row 2 — `IMMUTABLE_SNAPSHOT_TOKEN + DURABLE_TOKEN` (token-addressed immutable snapshot)

The source itself holds an **immutable snapshot addressable by an opaque token**; every page statement addresses that token; the token (and therefore the readable state) survives connection loss, which is exactly why the ratified matrix grants this row `PAGE_RESUME`. Structural notes:

- **None of the three in-scope RDBMS dialects offers this natively as a base-feature, cross-connection primitive** (§4). The row's realistic producers are source classes with native snapshot addressing (time-travel / "as of" reads over system-versioned data, storage-level snapshots) or an agent that **materializes** a snapshot — which converges with the sealed-snapshot direction (§7). Whether a given source can mint such a token is decided **per capability spike, never per database brand**.
- Token discipline: the token is minted by the source/strategy, treated as opaque by the platform, carried only in run execution state, and authenticated at the trust boundary the same way qualification lifecycle fields are — a keyed MAC of the `computeEnvelopeMac` kind, so a tampered or foreign token fails closed. Token expiry/revocation at the source ⇒ `ABORTED` (§5.3), never silent re-snapshot.

### 3.4 What is NOT a consistency context

Named explicitly so the rejection surface stays closed:

- **An ordering key** (even certified unique/stable/non-NULL) — proves total order, not cross-page stability (§1).
- **`MONOTONIC_VERSION_PIN`** — detects drift after the fact; abort-on-drift is a weaker, different contract that is deliberately not a v1 row and would need its own ratification.
- **Retry/backoff loops, "re-read page 1 and compare", row-count reconciliation** — detection heuristics, not mechanisms; they cannot make two pages mutually consistent.
- **A new snapshot per page** (the status quo) — each page is internally consistent and the sequence is not.

## 4. Per-dialect certification analysis

The PG probe strategy's `single_statement_mvcc` claim **does not transfer** to any sequence claim, on the same dialect or any other. Each dialect strategy must certify its own sequence-level claim, with its own spike evidence. This section records what each engine documents, what it costs, and what a certification spike must actually prove. Engine-behaviour statements below are documentation-level knowledge; **every one of them must be re-proven by the certification spike against the deployed engine version and driver before any implementation gate** — none is taken on authority.

### 4.1 PostgreSQL — `REPEATABLE READ` snapshot transaction (row 1); snapshot export (out of scope for v1)

**Documented guarantee.** A `REPEATABLE READ` transaction takes one MVCC snapshot and every plain `SELECT` in it reads that snapshot; a **read-only** `REPEATABLE READ` transaction does not incur isolation-conflict aborts (serialization failures in RR arise on write conflicts; `SERIALIZABLE` is deliberately not requested — snapshot stability is the whole requirement, and `SERIALIZABLE` adds abort risk with no benefit to a read-only sequence). The snapshot is established at the transaction's **first statement, not at `BEGIN`** — the executor must therefore define the sequence's snapshot instant as its first page read (or an explicit cheap establishing statement) and record it in evidence.

**Cost / lifetime.** The open snapshot holds back `xmin`: vacuum cannot reclaim tuples deleted after the snapshot for as long as the sequence runs — a long sequence causes table/index bloat pressure on the **source** database. The pinned connection is unavailable to the pool. Operator-side timeouts (`idle_in_transaction_session_timeout`, `statement_timeout`) and version-dependent snapshot-age mechanisms can kill the transaction mid-sequence; all of them must surface as `ABORTED`, never as a silent new snapshot.

**To be certified by spike.** (a) Same-connection pinning through the real `pg` pool path (client checkout for the context's lifetime, no interleaved statements from other work); (b) positive control: a row inserted/deleted/key-updated by a second connection mid-sequence is invisible to the open sequence and visible to a fresh one; (c) negative control: killing the pinned backend mid-sequence produces `ABORTED`, not a quietly re-established context; (d) behaviour of the deployed PG major with respect to snapshot-age termination — **to be confirmed by spike** (this mechanism has changed across PG majors; do not assume either presence or absence).

**Snapshot export** (`pg_export_snapshot()` / `SET TRANSACTION SNAPSHOT`) lets **other connections of the same database** join the exporter's snapshot — but the snapshot lives only while the **exporting transaction stays open**, so it is still connection-anchored, not durable: it widens row 1 to parallel readers; it does **not** realize row 2. Out of scope for v1; recorded to prevent it being mistaken for a durable token later.

### 4.2 SQL Server — `SNAPSHOT` isolation (row 1); `OFFSET…FETCH` is syntax, not consistency

**Documented guarantee.** Transaction-level `SNAPSHOT` isolation (row-versioned; readers do not block writers) gives every statement in the transaction one point-in-time view — the row-1 analog. As with PostgreSQL (§4.1), the snapshot instant is **not** `BEGIN TRANSACTION` but the first statement that accesses data inside the transaction; the executor must define the sequence's snapshot instant the same way on this engine too (first page read, or an explicit cheap establishing statement) and record it in evidence. Two structural differences from PostgreSQL, both load-bearing:

1. **It is opt-in per database**: `SNAPSHOT` isolation requires the database option `ALLOW_SNAPSHOT_ISOLATION ON`, a customer-DBA decision with tempdb version-store cost. The default locking `READ COMMITTED` gives **no statement-level point-in-time view at all** (a scan under locking read committed can miss or double-read rows moved by concurrent updates), and `READ_COMMITTED_SNAPSHOT` (when enabled) gives **statement-level** snapshots only — neither spans a sequence. Consequence: even the **single-statement** analog of `single_statement_mvcc` is not a given on this engine — which is precisely why B1b must certify its own probe claim, and B1c its own sequence claim, per deployment. The strategy's preflight must **probe the database options** (they are discoverable per database) and fail closed if the required option is off — never assume, never fall back to a weaker isolation level silently.
2. **`OFFSET…FETCH` requires an `ORDER BY` syntactically** — which the current adapter satisfies with the non-deterministic `(SELECT NULL)` fabrication (§2). Syntax-level ordering is not consistency; under a certified context the certified key supplies the real `ORDER BY` and the fabrication is deleted by the gated B2 slice.

**Cost / lifetime.** An open snapshot transaction holds row versions in the **tempdb version store**; long sequences grow it and can degrade the whole instance, not just the read. Connection pinned as in row 1 generally. Additionally the `mssql` driver executes pool-per-call by default (`pool.request()`), so the strategy needs a dedicated-connection execution object — **whether the deployed `mssql` package can pin one session for a sequence of independent statements (e.g. via its transaction object) is to be confirmed by spike**.

**Row 2 candidate.** System-versioned temporal tables offer `FOR SYSTEM_TIME AS OF` reads addressable by a timestamp — a potential per-**object** durable token where the customer schema already maintains system versioning. This is a per-capability question (does THIS object hold history, with what retention?), never a per-brand answer — **to be confirmed by spike** if a concrete customer class wants it. Database snapshots (`CREATE DATABASE … AS SNAPSHOT`) are administratively heavy and belong to the sealed-export conversation, not to a per-run token.

### 4.3 MySQL / InnoDB — `REPEATABLE READ` consistent-read snapshot (row 1)

**Documented guarantee.** InnoDB `REPEATABLE READ` gives plain `SELECT`s in a transaction a **consistent read snapshot** established at the first read — or explicitly at transaction start with `START TRANSACTION WITH CONSISTENT SNAPSHOT`, which the strategy should prefer for a deterministic snapshot instant. All subsequent plain `SELECT`s in the transaction read that snapshot — the row-1 analog. **The isolation level is a precondition, not a given, and must be probed exactly as §4.2 probes the SQL Server database options.** `REPEATABLE READ` is only the *engine default*; the effective level is session state (`transaction_isolation` can be overridden globally, per session, or by the deployment/pool/DSN), and `WITH CONSISTENT SNAPSHOT` is documented as effective **only under `REPEATABLE READ`** — under `READ COMMITTED` the modifier is silently inert (at most a warning), each `SELECT` takes its own statement-level snapshot, and the sequence is **not** snapshotted while looking exactly as if it were. The strategy's preflight must therefore explicitly establish the level for the sequence transaction (`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`, next-transaction scope, or the session-level equivalent), verify it by probing the session's effective isolation (`@@transaction_isolation`), and **fail closed if `REPEATABLE READ` cannot be proven — never assume the engine default, never fall back to a weaker level silently.** Further caveats the strategy must design around: the consistent snapshot covers **plain `SELECT`s only** (locking reads see current versions — the context's read-only guard already excludes them, and the B1c guard must keep excluding `FOR UPDATE`/`FOR SHARE` exactly as `assertReadOnlySql` does); and **DDL on a read table mid-sequence** breaks the transaction — surfaced as `ABORTED`.

**Cost / lifetime.** The open read view blocks **purge** of undo history: history-list length grows for the sequence's lifetime, degrading the source instance — the InnoDB analog of PG's vacuum holdback. Server-side `wait_timeout` can drop the pinned connection mid-sequence ⇒ `ABORTED`. The `mysql2` pool does expose dedicated connections (`pool.getConnection()`, already used by the adapter's transactional paths), so pinning has an existing driver primitive; its session semantics under the deployed driver version are **to be confirmed by spike**.

**Row 2.** No native cross-connection snapshot token in base MySQL — row 2 is not realizable natively; a source-class spike (agent-materialized snapshot) would be the route, converging with §7.

### 4.4 What every dialect strategy must certify (uniform obligations)

Per dialect, the B1c certification spike must produce, minimally:

1. the exact session-establishment statement sequence (isolation level, read-only declaration where the engine supports it, snapshot-instant determinism);
2. a **positive control**: mid-sequence external insert + delete + key-update, proven invisible to the open sequence and visible to a fresh one (the discriminating pair — an all-fail-closed harness that never observes the difference proves nothing);
3. a **loss control**: every context-loss channel the engine offers (connection kill, timeout, DDL, option flip, token expiry) proven to surface as `ABORTED` with a closed reason — never a silently re-established snapshot;
4. the resource-cost envelope (what the open context holds back on the source, and the operator knobs that bound it);
5. the sequence-level snapshot claim string the strategy will declare (the sequence analog of `snapshotSemantics`), entering evidence and the qualification digest material exactly as the probe strategy identity does today.

## 5. Resource honesty and failure semantics

### 5.1 A pinned snapshot is a real cost, stated plainly

Row 1 pins one connection from the **source's** connection budget for the whole sequence, and holds a snapshot the engine must service: PG vacuum holdback, InnoDB purge lag, SQL Server tempdb version-store growth. These are costs on the **customer's** database, not ours. A page-sequence read is therefore never "just N cheap selects" — it is a declared, bounded occupancy of the source.

### 5.2 Bounds (all mandatory, all closed-rejection on breach)

- **`maxPageSequenceLifetimeMs`** — wall-clock ceiling for the whole sequence; expiry ⇒ `ABORTED`.
- **`maxPages` and per-page limit** — per-page rows stay under the existing A5 chain (`resolveEffectiveLimit`, `DATA_SOURCE_MAX_ROWS`); the sequence declares a page ceiling up front. No ceiling change is proposed or authorized here.
- **Per-page statement timeout** — a single slow page must not consume the sequence lifetime silently.
- **Concurrent-context cap** — a small, explicit ceiling on simultaneously open contexts per source; acquisition beyond the cap is a **closed rejection at open time** (no unbounded queueing), because each open context is a pinned connection and pool exhaustion on the source is the direct failure mode.
- Concrete ceiling values are deployment policy, set at the implementation gate — not invented in this design.

### 5.3 Lost context ⇒ ABORT. Never continue on a new snapshot.

If the consistency context is lost mid-sequence — connection dropped, transaction killed by a timeout, DDL broke the read view, database option flipped, snapshot token expired or revoked — the run **ABORTS with a closed reason**. Re-opening a context and continuing from page k would splice two snapshots into one result set: exactly the silent-inconsistency class B1c exists to make inexpressible. The recovery contract is already derived by the shipped matrix (`deriveRecoveryStrategy`): row 1 (`CONNECTION_BOUND`) ⇒ `WHOLE_ROUND_RESTART` — a **new run on a new snapshot, reported as a new run**; row 2 (`IMMUTABLE_SNAPSHOT_TOKEN + DURABLE_TOKEN`) ⇒ `PAGE_RESUME` — legitimate only because the token re-addresses the **same** immutable state. B1c adds no third path.

### 5.4 Continuation tokens vs the values-free discipline

A keyset continuation watermark **is** ordering-key values — a genuine tension with the line's values-free rule. And the shipped surface does **not** meet the sealed discipline today: the sql-readonly adapter's watermark cursor is **unsealed** base64url JSON (`encodeWatermarkCursor` — prefix + `Buffer.from(JSON.stringify(payload)).toString('base64url')`) whose payload carries the ordering key's field **name** and last-row **value** (plus tiebreaker name and value), and `decodeWatermarkCursor` shape-checks only (`v === 1`, `mode` is a string) — **no MAC**, so any holder can read and forge it. The partial mitigation already in tree deserves credit: `pipeline-runner.cjs#buildCursorRunDetails` redacts watermark cursors from persisted run details (`nextCursor: null`, `nextCursorRedacted: true`). B1c's obligation is therefore to **supersede or seal that existing surface, not merely to preserve a discipline that does not yet exist there**. The B1c rule, structural not promissory: the watermark lives only in **run execution state**; if it ever crosses a trust boundary it travels as an opaque, keyed-MAC-sealed token (the `computeEnvelopeMac` pattern — tamper ⇒ closed rejection); it **never** enters evidence, audit records, error payloads, or logs, which carry counts and closed tokens only (`pagesRead`, `rowsRead`, termination reason, strategy identity); and the migration or sealing of the existing unsealed `encodeWatermarkCursor` surface is an explicit implementation-gate item — a certified sequence must not leave a parallel unsealed cursor channel standing. The harness for the implementation slice must include a sentinel-value leak test: seed key values with sentinels and assert the serialized evidence/error surface contains none of them.

## 6. Keyset vs OFFSET

Stated plainly: **keyset (seek) pagination on the certified ordering key is strictly better than OFFSET for both correctness and cost, and OFFSET remains supported only where a consistency context makes it sound.**

- **Cost.** Page k by OFFSET scans and discards `offset` rows — O(total) work per page, quadratic over the sequence; keyset seeks the key index at the watermark — O(page) work per page. On the engines in scope this is not a micro-optimization; it is the difference between a bounded read and a source-side load spiral on large objects.
- **Correctness without a context — both fail, differently.** OFFSET arithmetic drifts under any concurrent insert/delete before the cursor (skip or duplicate). Keyset kills the *arithmetic* drift class (the watermark is a value, not a position) but **not** the consistency class: a row inserted behind the watermark is never visited; a key-update moving a row across the watermark skips or duplicates it. This is the precise sense in which the ordering key alone was never sufficient — **neither paging style substitutes for the consistency context**.
- **Correctness with a context — both can be made sound; keyset stays cheaper.** A snapshot fixes **which rows are visible**; it does **not** oblige two separate `SELECT … OFFSET k` statements to return those rows in the same relative order — plan changes, parallelism, and scan-start position are all free to differ between statements. OFFSET is therefore sound only under a snapshot **and** a deterministic total `ORDER BY` on the certified key **on every page statement**. The trap is reachable in-tree: `MSSQLAdapter.select` still fabricates `ORDER BY (SELECT NULL)` (§2), which would satisfy the syntax inside a certified `SNAPSHOT` transaction while leaving the order non-deterministic — an implementer could run that fabrication inside a certified context believing it sound. With both conditions met, OFFSET is *correct* but still O(total) per page; keyset is correct and O(page). Hence the design rule: the certified execution path **prefers keyset on the certified key** (the B1a `orderingKeySpec` — in-flight symbol, §2 status note); OFFSET is tolerated only inside a certified context **and** only with the certified key's total `ORDER BY` on every page statement (compatibility for callers that cannot carry a watermark), and bare OFFSET-without-order outside any context remains the fail-fast target of the gated B2 enforcement slice — B1c neither implements nor pre-empts that guard.
- Keyset requires exactly what B1a/B1b certify: a unique, stable, non-NULL, totally-ordered key with deterministic direction per field (the B1a `orderingKeySpec` closed schema — in-flight, not yet on `origin/main`; the shipped certificate field today is `orderingKeyRequirement`, §2 status note). NULL-key and duplicate-key objects already fail the qualification probe (`ORDERING_KEY_NULL_FOUND` / `ORDERING_KEY_DUPLICATE_FOUND`), so every certified sequence has a keyset-capable key by construction. Multi-field keys page by tuple comparison; where an engine's tuple-comparison support is in doubt, the dialect strategy certifies its expansion — an implementation-gate detail, flagged for the spike.

## 7. Convergence — sources with no context route to `SEALED_EXPORT`

A source class that can offer **no** cross-page consistency context — no snapshot transaction, no addressable immutable snapshot, no stable cursor — cannot certify `PAGED_READ` at all. Its route is `SEALED_EXPORT` (sealed snapshot: materialize once, then read the sealed artifact with `SIGNED_MANIFEST` completeness, `CHUNK_RESUME` recovery — both already ratified in the shipped contracts). Two owner-ratified qualifiers, restated because they are easy to erode:

- The routing decision is made **per capability spike** — "does THIS source hold durable snapshots / stable cursors?" — **never uniformly per database brand**. The same engine brand may certify row 1 as a direct SQL source in one deployment and be sealed-export-only behind a bridge in another.
- Sealed export is the **preferred exit for the non-paginatable class, not the sole exit for SQL sources** — a direct SQL database may certify `PAGED_READ` once the B1c executor exists.

## 8. Fences

B1c is **design-only**. This document authorizes nothing: no runtime, no arming, no wiring, no flag, no migration, no page-size ceiling change, no enforcement. Implementation of the page-sequence executor is a later, separate owner gate, entered with this design plus the per-dialect spike results (§4.4). The line doc's fences (§6 there) apply unchanged; where this document and the line doc disagree, the line doc wins.

## 9. Open points — explicitly unconfirmed, to be resolved by spike

1. **PostgreSQL snapshot-age termination behaviour on the deployed major** (presence, threshold semantics) — to be confirmed by spike.
2. **`pg` pool client-pinning discipline** for a context's lifetime under the production pool configuration — to be confirmed by spike.
3. **SQL Server: per-database `ALLOW_SNAPSHOT_ISOLATION` / `READ_COMMITTED_SNAPSHOT` posture at each customer** — must be probed per database at certification time; assumed nowhere.
4. **`mssql` driver session pinning** — whether a dedicated session can host a sequence of independent read statements under the deployed package — to be confirmed by spike.
5. **SQL Server temporal `FOR SYSTEM_TIME AS OF` as a row-2 token** (per-object history posture, retention) — per-capability spike only.
6. **MySQL: `START TRANSACTION WITH CONSISTENT SNAPSHOT` semantics under the deployed `mysql2` driver**, the effective-isolation probe (`@@transaction_isolation` must prove `REPEATABLE READ`, else closed rejection — §4.3), `wait_timeout` interaction, and DDL-break surfacing — to be confirmed by spike.
7. **Engine-version matrix**: every §4 documentation-level claim re-proven against the deployed engine versions before the implementation gate.
8. **Multi-field keyset tuple-comparison support per engine** (row-constructor comparison vs expanded predicate) — dialect-strategy spike detail.
9. **Whether any in-scope source class can genuinely mint an `IMMUTABLE_SNAPSHOT_TOKEN`** — no native candidate exists in the three base engines; agent-materialized snapshots converge with the sealed-snapshot spike, whose feasibility is itself a gated M2 item.
10. **`PAGED_READ_LEGAL_COMBINATIONS` as landed** — B1a is in flight; the frozen symbol, its rows, and its rejection reason must be re-verified against `origin/main` before B1c implementation review (this document was written against the ratified spec, not a landed symbol).
11. **`orderingKeySpec` as landed** — same B1a re-verification obligation: the symbol is not on `origin/main` at the time of writing (the shipped certificate field is `orderingKeyRequirement`); §6's uses must be re-pointed at the landed symbol before implementation review.
12. **The line document's merge** — `database-system-integration-line-design-and-verification-20260724.md` is in open PR #4590, not on `origin/main`; every citation of it here must be re-confirmed against the merged content before the B1c implementation gate.

## 10. References

- `docs/development/database-system-integration-line-design-and-verification-20260724.md` — the line's single design-and-verification document: slice order, ratified B1 findings, fences. Referenced by name; not restated here. **Not yet on `origin/main` — open PR #4590 at the time of writing (see preamble).**
- `plugins/plugin-integration-core/lib/gip-binding-qualification-spike.cjs` — probe strategies, values-free evidence, WeakSet trust, envelope MAC.
- `plugins/plugin-integration-core/lib/pipeline-runner.cjs` + `plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs` — the shipped multi-page OFFSET read (§1) and the unsealed watermark cursor with its run-details redaction (§5.4).
- `plugins/plugin-integration-core/lib/gip-profile-certification-contracts.cjs` — frozen capability vocabularies, `assertCertificateCrossDimensionLegal`, `deriveRecoveryStrategy`, `orderingKeyRequirement`.
- `packages/core-backend/src/data-adapters/` — `DataSourceManager.ts`, `BaseAdapter.ts`, `PostgresAdapter.ts`, `MySQLAdapter.ts`, `MSSQLAdapter.ts` (pool-per-call reads, A5 bounds, transaction surface).
- `packages/core-backend/src/routes/data-sources.ts` — `POST /api/data-sources/:id/select` (route-level default limit).
