# Database & System Integration Line — Design and Verification (2026-07-24)

**Status:** §1 is a **RECORD** of landed, verified facts (head-scoped SHAs). §2–§6 are **PROPOSED / design-first / doc-only**.

**Gate (owner, 2026-07-24):** approval of this document unlocks **only the B1a latent contract + harness slice**. It does **not** authorize: runtime enforcement (merging **#4591** / B2), arming or runtime wiring of any GIP profile, telemetry or handshake **wiring**, sealed-snapshot implementation, page-size ceiling changes, or rollout. Each of those is its own owner gate.

This is the line's single design-and-verification document (owner directive: consolidate closeout facts into one MD; stop letting working memos drift). It absorbs and supersedes the session working memos (`/tmp/gip-decision-memo-20260724.md`, `/tmp/b1-paged-read-certification-design-20260724.md` rev‑1) and the retired ad-hoc inventory SQL (NO-GO; §5).

Owner-review absorption markers used below: ⟲P1-a (ordering-key layering), ⟲P1-b (probe ≠ paged execution), ⟲P2-a (frozen combinations / no silent downgrade), ⟲P2-b (latent vs telemetry), ⟲P3-a (sealed snapshot not the sole exit). Codex-review absorptions (2026-07-24) are marked ⟲C1 (M0 exact-SHA package policy — BLOCKING), ⟲C2 (inventory-zero coverage map), ⟲C3 (#4580 re-cut + typed 422 as merge condition), ⟲C4 (orderBy = fail-fast, not stable pagination), ⟲C5 (per-capability routing, not per-brand). Owner ratify-review absorptions (2026-07-24, round 2) are marked ⟲R1 (exact-SHA exits: two-proof-only + freeze the new SHA), ⟲R2 (deep-immutable resolution, not provenance-only), ⟲R3 (full-tuple resolver), ⟲R4 (M1 = evidence only; the §4 order wins), ⟲R5 (combinations scoped to PAGED_READ), ⟲R6 (orderingKeySpec closed schema). Package/decision round (owner, 2026-07-24 late): ⟲R7 (complete-package two-SHA structure), plus three recorded decisions — package policy (b) with a build-only authorization boundary; B1-observability NOT opened early; B2 re-cut now as Draft **#4591**, superseding #4580.

**Doc charter** ⟲Codex: this document is an **execution index + evidence ledger**. Authoritative contracts live in code and their own frozen design docs — referenced here by symbol + SHA, never copied — so this file cannot drift into another competing fact source. Model task cards derived from it must carry **symbol + exact head + acceptance predicate**, not bare line numbers.

---

## 1. RECORD — landed and verified

- **`bridge.bounded_read.v2` MERGED = `7bf2bd7a1`** (PR #4573, squash). **#4565 CLOSED unmerged** — its head `828aeb4d6` carries the pre-hardening fail-open and must never merge.
  - P1a (applied-limit): adapter `read()` verifies the agent-echoed applied limit — `data.limit` present ∧ positive integer ∧ equal to the requested clamp; missing / non-integer / divergent ⇒ fail-closed. `metadata.limit` is sourced from the **verified echo**, so downstream `short_page` reasoning is evidence-backed.
  - P1b (lineage): `profileId`/`actionProfileVersion` bumped to `.v2` — the qualification digest keys on `actionProfileVersion` only, so an authenticated old-v1 qualification now recomputes to `QUALIFICATION_DIGEST_MISMATCH` instead of surviving the hardening.
  - The profile remains **LATENT** (zero runtime consumers, proven by tree-wide grep at merge time). **Agent/protocol-version pin is a hard gate before any activation / arming / runtime wiring** (owner ruling: certification-scoped preflight; NOT the shared adapter; NOT a #4553 digest input).
- **#4583 MERGED = `68bcd9a670`** (data-source read-boundary A-knife):
  - MySQL A5 row bound enforced (previously **none**: an omitted limit issued a whole-table `SELECT`; an over-max limit was served verbatim — `manager.select` passes options straight through, so the adapter is the only chokepoint).
  - **Single frozen adapter registry**: `DEFAULT_ADAPTER_REGISTRY` is the one source; `SUPPORTED_DATA_SOURCE_TYPES` is derived from its keys; both `Object.freeze`d, with mutation-verified negative controls (assignment / replace / delete / push / splice all rejected at runtime).
  - Registry-derived A5 conformance: the suite instantiates from the production registry and derives the SQL set via `isSqlDialect()` — a newly registered SQL adapter is auto-covered (mutation-proven: an unbounded fake adapter grew the suite 11→14 and failed its three A5 cases with zero test edits).
  - Follow-up (P3, no dedicated PR): one freeze negative control keeps a literal six-type anchor (does not participate in coverage derivation); convert to a comment-marked deliberate anchor at next touch of that file.
- **B2 enforcement = #4591 (DRAFT, merges LAST)** ⟲C3 — pure re-cut from current main per owner ruling; **#4580 CLOSED as superseded** (its branch carried the A-half already landed via #4583 and went `DIRTY`). #4591 contents, exactly the owner-listed three: adapter-layer OFFSET-ordering fail-fast guard (offset > 0 without `orderBy` ⇒ fail-closed, all three SQL adapters; registry-derived conformance roster) + **typed closed 422** (`DataSourceOffsetOrderingError` / `DATA_SOURCE_OFFSET_ORDERING_REQUIRED` — previously every non-not-found `/select` failure surfaced as `SELECT_ERROR` 500; the mapping is closed, generic errors still 500, pinned by test) + deletion of MSSQL's non-deterministic `ORDER BY (SELECT NULL)` fallback. **Observability contracts deliberately excluded** (owner ruling — B1-observability slice, own gate). Mutation-verified both ways (guard-neuter reds the fail-closed cases; mapping-removal reds exactly the 422 case); suite 16/16; full unit suite green; `tsc` clean. ⟲C4 honest claim unchanged: fail-fast hardening only — uniqueness, same-order-from-page-1, and same-snapshot remain unproven until B1b/B1c. **Merge order unchanged: LAST** ⟲R4 — after adapter-chokepoint telemetry (B1-observability), the §2-M1 coverage-mapped inventory evidence, and customer migration are complete. M1 itself takes no merge decision.
- **Retired NO-GO**: the ad-hoc inventory SQL — four schema-fact errors (wrong status vocabulary — external-system status is `active/inactive/error`; `integration_pipeline_runs` does not exist, the real table is `integration_runs` per migration 057; no `metrics.pageCount`, real fields are `details`/`rows_read`; `data_sources` shape is inconsistent across migrations ⇒ schema probe first). Replacement: an **in-repo, tested** script run **per customer deployment**, combining DB counts + local `/select` access logs (+ the B1-observability counter once separately authorized). A central-DB count alone cannot prove the absence of on-site HTTP callers.

## 2. M0–M2 acceleration route (owner-set; amendments marked PROPOSED)

**M0 (24–48h, zero product code).** Config owner creates a NEW approved config version (old versions untouched) bound to a provably single-page object — actual rows strictly below the agent-echoed effective limit. Flag-OFF preflight ⇒ `SHORT_PAGE`; then one C-stage flag-ON window; 11-item PASS ⇒ close #4437. ⟲C1 closure claim: that PASS closes #4437 as a **bounded-subset mechanism acceptance** — one tenant, one source; it claims **no large-scale capability**. Stop-loss: if no object can be safely narrowed, stop repeat acceptance and enter the M2 spike.
- ⟲C1 **BLOCKING package-policy decision (owner) — must be made BEFORE M0 runs.** #4437 froze RC-A at release `stock-prep-onprem-rc-a-20260717-d87e086fd` / exact SHA `d87e086fd12…` (2026-07-17, **predates** `7bf2bd7a1`) and forbids repackaging — so rev‑1's precheck "confirm the deployed image includes `7bf2bd7a1`" was **wrong**: it silently swaps the acceptance package against a frozen exact-SHA contract. Worse, the frozen package carries the **pre-hardening adapter**, whose `metadata.limit` is locally fabricated rather than echo-verified — the exact provenance hole #4573 closed — so its `SHORT_PAGE` result alone cannot close a completeness acceptance. ⟲R1 Sound options — **two mutually exclusive exits**: **(a)** keep `d87e086fd` — the old package is acceptable **only** with trusted `DECLARED_TOTAL` or a same-read-bound applied-limit proof; **for the legacy-SQL bridge both are structurally absent** (`DECLARED_TOTAL` is unreachable per the certified `bridge.bounded_read.v2`; the old package carries no in-band applied-limit proof) — so **(a) is empty for this source class**; **(b) recommended: the owner formally revises #4437 — publish, checksum, and FREEZE a new RC-A exact-SHA containing `7bf2bd7a1` — then run the narrowed `SHORT_PAGE` M0.** The config owner can prepare the bounded approved config in parallel under either option.
- ⟲R7 **"New RC-A package" = the COMPLETE on-prem deployment package, NOT the C-stage sidecar.** The sidecar ZIP carries only smoke helpers / PowerShell wrapper / PM2 sample / provenance — it does **not** contain `bridge-agent-readonly-adapter.cjs`; the #4573 fix lives in the server-side plugin. Exit (b) therefore means: build the complete on-prem package at the owner-chosen main SHA (recommended `7bf2bd7a1`, to avoid enlarging the runtime change surface); regenerate manifest + SHA256 + provenance + loopback verification; revise #4437 to record **`serviceRuntimeSha` and `clientHelperSha` separately** — the two smoke helpers are blob-identical between `d87e086fd` and `7bf2bd7a1`, so the helper content hash may carry over, but one `exactSha` must no longer conflate client and server; controlled deploy of the new service package; flag-OFF health verification; only then the bounded-config preflight. **Owner decision recorded — package policy = (b), authorization boundary strict: "build and verify the new complete RC-A package + revise the #4437 pointer" only; NOT deployment, NOT flag-ON — those remain ops-gated steps.**
- `/health` `version` capture (currently `0.1.0`): **asset inventory only** — it records which agent build is deployed; it proves nothing about protocol capability, limit-echo behaviour, or qualification compatibility.

**M1 (3–5 dev days, exactly two dev lines).**
- *Qualification line:* agent/protocol-version **certification-scoped preflight** (hard gate before activation/arming/runtime; does not block #4437).
- *Direct-DB line:* values-free inventory first — and ⟲C2 **"0" only carries migration meaning once the coverage relations and the observation window are explicit.** The evidence set and what each piece covers:
  1. DB inventory (approved configs / pipelines / `integration_runs`) — config-driven plugin reads;
  2. the deployment's full `/select` access log, **with stated retention scope and time window** — ad-hoc HTTP callers, within that window only;
  3. a static tree-wide enumeration of `manager.select` / `adapter.select` callers — in-repo direct entry
     points. ⚠️ **CORRECTED (verified 2026-07-24, independent review + my own re-verification): this group is
     materially LARGER than earlier stated in this document.** Beyond the `/select` route and
     `copyData` (which indeed has no live in-tree caller), there is a **shipped, live multi-page OFFSET
     reader**: `pipeline-runner.cjs` runs `while (page < maxPages)` advancing `cursor = readResult.nextCursor`,
     and the `data-source:sql-readonly` adapter's NON-watermark branch emits
     `nextCursor = String(offset + records.length)` on a full page — so a pipeline over a SQL data source
     pages by OFFSET **with no `orderBy` anywhere on the path**, stopping on a short page
     (`done: !fullPage`) evaluated against LIVE data. Earlier wording in this line implied the offset path
     was merely *reachable*; it is **exercised by shipped pipeline code**. Note the gate precisely: the
     adapter takes the offset branch whenever the request carries no watermark keys (`!hasOwnKeys(request.watermark)`),
     NOT merely when the pipeline mode is non-incremental — so an *incremental* run also pages by offset
     until a watermark has been stored. This raises, not lowers, the priority of the B1a ordering contract
     and the migration that must precede B2;
  4. values-free `unorderedOffsetAttemptCount` at **both** the route and the adapter entries — closes the runtime blind spot, but it is instrumentation. **Owner decision recorded: the B1-observability gate is NOT opened early** — it cannot accelerate #4437 and would add a new runtime deployment surface. M1's inventory therefore rests on items 1–3 and **must state this runtime residual explicitly** in the migration decision, not gloss it; the counter arrives in its §4 slot behind its own gate.

  ⟲R4 **M1 produces inventory evidence only — the B2 merge decision is NOT taken in M1.** Per §4, **#4591** (which superseded #4580) merges **LAST**, and only after adapter-chokepoint telemetry (B1-observability), the coverage-mapped caller inventory, and customer migration are complete: an HTTP access log cannot see plugin-internal or direct adapter callers, so "log-zero" alone can never green-light enforcement. This supersedes the earlier "inventory = 0 ⇒ merge B2" fast path (the conflict between that fast path and the §4 order is adjudicated in favour of §4). Standing rules regardless of counts: new paginated configs must declare a stable **unique** `orderBy` — ⟲C4 **fail-fast hardening, not stable-pagination certification** (presence-only; uniqueness, same-order-from-page-1, and same-snapshot remain unproven until B1b/B1c); any live configs found ⇒ versioned config migration + preflight rejection first; never auto-guess a primary-key order.
- Keep the existing Integration Workbench config/probe/approve UI — **no second connector configurator**. `stock-prep:read/operate` permission split at M1 end; the pilot runs under a controlled admin.

**M2 (only on real-scale evidence from M0/M1).** Ratify scale-D0 first; run the `bridge.sealed_snapshot` feasibility spike; compare "export + signed manifest" vs interactive paging on true change surface; only then decide async job / staging / generation flip / multiset SQL diff. CDC, external write-back, D2 reconciliation, W3 suggestion dates, G1 notifications stay **off** the critical path (frozen).

## 3. B1 design (REVISED — owner findings absorbed)

### 3.0 ⟲B — B1a IS REDONE: six boundaries the first implementation did not meet

**Status of the first B1a attempt (#4596 `774bdb5e6`, #4597 `d0313feec`): HELD, to be redone.** Owner review
found four P1s and two P2s. Every one is verified — three of them by me re-running the reviewer's probe and,
in one case, finding the defect to be *wider* than reported. The slice's own stated goal — *forgery is
inexpressible by construction* — was **not met**. These boundaries are now part of the design, not notes on
an implementation.

**B-1 · A qualification must prove the evidence came from the bound system.**
The first attempt minted and verified a qualification from a **caller-supplied `query` function that never
touched any external system** (its own suite does this at `gip-approved-binding-resolver.test.cjs`
L740-L772, and at L807-L840 one fabricated answer satisfies **two resolutions bound to different systems**).
This was recorded as an accepted "residual". That grading was wrong: **latency does not make an untrue
qualification trustworthy** — a qualification that verifies against evidence never observed on the bound
system is a false qualification whether or not anything consumes it yet. Required boundary: the source
handle is **derived from the resolution's system record by a server-bound source executor**; no caller may
supply the query path. This is a *precondition* of B1a, not a follow-up to it.

**B-2 · System identity comes from a dedicated lossless identity read — not from hashing the config.**
The first attempt hashed the whole system config (`lib/gip-approved-binding-resolver.cjs` L153-L169). The
identity that matters is **endpoint + auth principal + scope**, read by a purpose-built lossless identity
read. That read must **not decrypt credentials** — the first attempt obtained decrypted credentials through
the adapter API and then discarded them, an unnecessarily wide permission surface for an identity derivation.

**B-3 · `canonicalObjectVersion` comes from a first-party canonical object contract registry.**
The first attempt derived it from `systemContentKey + objectKey + fieldMap`, and the code itself admits
(L232-L252) that it **cannot detect source-side schema drift**. A "canonical object version" that cannot
witness the object's schema is not one; it must not be invented locally.

**B-4 · A probe SQL denylist is NOT a security boundary.**
`createProbeStrategyRegistry()` accepts an arbitrary `buildTotalOrderProbeSql`, so SQL-text inspection is the
wrong control surface. Verified — the owner supplied one bypass, and re-running it I found two more of the
same class, all passing the hardened guard while the un-concatenated control is correctly blocked:
```
PASSES   SELECT * FROM dblink('conn', 'DE' || 'LETE FROM x') AS t(x int)
PASSES   SELECT * FROM dblink('c', 'DR'||'OP TABLE x') AS t(x int)
PASSES   SELECT * FROM dblink('c', chr(68)||chr(69)||'LETE FROM x') AS t(x int)
BLOCKED  SELECT * FROM dblink('c', 'DELETE FROM x') AS t(x int)          <- control
```
String concatenation defeats the token list; `chr()` defeats it with no literal keyword at all. The
7-constructs-to-0 result reported for B1b therefore measures resistance to **accidents, not construction**.
Required boundary: **only first-party builders registered by module-private identity**, or a **restricted
structured query constructor**. The denylist may remain as defense-in-depth; it may never be cited as the
boundary.

**B-5 · "Certified" requires a VERIFIED guarantee, not an honest label.**
B1b registered a SQL Server strategy whose own token reads
`no_single_statement_snapshot_under_default_read_committed` — and it still mints a candidate (verified).
Naming the absence of a guarantee does not fail closed; under the engine default it must **refuse
certification**. MySQL's token names three conditions (InnoDB, autocommit, isolation ≥ READ COMMITTED) and
the code checks **none** — they must be established **empirically on the same connection**. B1b's
certification gate does not open until a **real MySQL / SQL Server capability spike** passes.

**B-6 · Two namespace/closure gaps.** ⟲P2 `orderingKeySpec` `fieldId`s are canonical TARGET fields (the
resolver says so at L102-L120) but were passed straight to the SQL builder — a **certified source-column
translation** is required. ⟲P2 The production approved-config allowlist does not accept `orderingKeySpec` or
`actionProfileVersion`, so the hermetic suite never exercised the real **save → approve → re-read → qualify**
loop; B1a is not provable until a real **config v2** carries these fields.

**Owner-set redo order for B1a:** real config v2 → system identity read with no credential decryption →
first-party canonical contract version → server-bound source executor with field translation → remove or
privatise the legacy `probe()` entry point.

**Consequence for this line's status:** the earlier conclusion that *"the remaining critical path is owner
decisions, not engineering"* is **withdrawn** — there is real qualification-authenticity implementation work
remaining, and it is the largest unbuilt item on the line. The on-prem M0 track (complete RC-A package build
+ bounded approved config) is independent of B1a/B1b and may proceed in parallel.

### 3.1 ⟲P1-a — the certificate holds the REQUIREMENT; the config holds the FIELDS

The ratified certificate model already carries **`orderingKeyRequirement`** (contracts §certificate fields) — a capability-level *requirement*, never the customer's concrete columns. The concrete **`orderingKeySpec`** (ordered field list + directions) belongs to the **approved config version** (customer/binding-scoped, immutable per version). rev‑1 of this design put `orderingKeyFields` in the certificate — wrong layer; withdrawn.

**B1a core — server-side approved-binding resolver.** Input: `approvedConfigVersionId` (+ principal for authz). ⟲R3 The server derives the **complete qualification input tuple** — `{ actionProfileVersion, systemContentKey, configContentKey, objectKey, canonicalObjectVersion, orderingKeySpec }` — from the same tenant's approved **binding + config + system** records, and from nothing else. Binding only three fields (rev‑2's `{objectKey, orderingKeySpec, configContentKey}`) was insufficient: **any** digest input left caller-supplied re-opens the forgery as "config A + system-or-profile B". Requirements:
  - at resolution time, re-verify the version is STILL approved — **and still within the caller's tenant and scope** — through the existing **`getForRuntime()`** path (`readSourceConfigStore.getForRuntime`, called with scoped input; throws `NOT_APPROVED` for a non-approved version — approval, tenancy and scope are re-checked at resolution time, never assumed from the id);
  - the server **recomputes `configContentKey` from the immutable version body and compares** — it never blindly trusts a stored column;
  - **both probe and verify** re-enter through the resolver — no cached caller-side tuple is honoured;
  - callers cannot override **any** field of the tuple.

  The prober and the qualification-digest inputs accept ONLY this resolution object. Probe evidence stays values-free (`checkedKeyColumnCount` only — field names never enter evidence), so none of these forgeries could be detected after the fact — they must be **inexpressible**, not detectable.
- ⟲R2 **The resolution is deep-immutable, not merely provenance-checked.** WeakSet identity proves where the object came from; it does NOT stop a caller mutating a nested array (e.g. an `orderingKeySpec` entry) inside the probe's **async query window** — a shallow `Object.freeze` leaves nested structures writable. The resolution is therefore built as an **owned clone in the strict canonical-JSON domain, recursively frozen** — Proxy / accessor properties / sparse arrays / symbol keys **rejected** (`deepCloneFrozenCanonical` in `gip-canonical-json` is the reference primitive). **Mandated harness negative control:** mutate the ORIGINAL field array from inside the async query callback and prove the probe still uses the parse-time copy.
- Trust is **object identity** (module-private WeakSet), mirroring the existing probe-strategy registry pattern — a hand-built resolution object is refused.
- Owner adjudication recorded: `configContentKey` being a digest input is **necessary but not sufficient**; the resolver is what turns it into an actual binding.

⟲R6 **`orderingKeySpec` closed schema (frozen in B1a — a contract slice ships an implementable schema, not a slogan):**
- canonical `fieldId`s only — never raw SQL, expressions, or aliases;
- non-empty; duplicate `fieldId`s rejected;
- `direction ∈ {ASC, DESC}` only;
- every `fieldId` must resolve through the SAME approved config version's field mapping — unresolvable ⇒ closed rejection;
- NULLability is deliberately NOT a schema check: NULL keys stay **fail-closed at the qualification probe** (the duplicate/NULL probes), where they are observable against the live source.

### 3.2 ⟲P1-b — a probe certifies ORDER; it does not certify PAGING

`single_statement_mvcc` (and any B1b analog) certifies exactly **one probe statement** under one snapshot claim. It says nothing about a page *sequence*: `DataSourceManager.select()` is pool-per-call — no transaction or connection spans two pages today, and transaction objects cannot be passed into `select()`/`query()`.

Consequences, stated as scope:
- **B1b** (MySQL/MSSQL strategies) closes **total-order qualification** for those dialects — nothing more.
- **PAGED_READ certification additionally requires a page-sequence execution seam**: one certified consistency context spanning all pages (same-connection snapshot transaction, or a token-addressed immutable snapshot), with dialect-certified semantics and its own profile gate. That is **B1c**, design-first, not implied by B1a+B1b.
- Probe-execution seam note: probe SQL uses `GROUP BY`/`HAVING` shapes the structured facade cannot express, so B1b needs a **restricted internal probe-executor seam** — accepts ONLY strategy-minted statements (object-identity trust), read-only, statement-bounded, never reachable from HTTP input. Per the owner's dependency direction, core-backend contributes this bounded seam and nothing else; qualification definitions stay in the GIP layer.

### 3.3 ⟲P2-a — frozen legal combinations; rejection, never silent downgrade

"`PAGED_READ` ⇒ consistency proofs non-empty" is too weak. The certifiable combinations are a **FROZEN table** (extending the existing scale-D0 §2 cross-dimension legality pattern), ⟲R5 **named `PAGED_READ_LEGAL_COMBINATIONS` and consulted ONLY when `acquisitionMode === 'PAGED_READ'`** — it is not a global gate over all modes:

| consistency proof | continuation lifetime |
|---|---|
| `SOURCE_SNAPSHOT_TXN` | `CONNECTION_BOUND` |
| `IMMUTABLE_SNAPSHOT_TOKEN` | `DURABLE_TOKEN` |

`MONOTONIC_VERSION_PIN` is deliberately **unmapped for `PAGED_READ`** in v1: a version pin *detects* drift; it does not make pages mutually consistent — abort-on-drift is a weaker, different contract that would need its own ratification before appearing here. ⟲R5 It **remains legal where already ratified in other modes** — specifically, the ratified `CHANGE_FEED + MONOTONIC_VERSION_PIN + DURABLE_TOKEN` combination is untouched. **Mandated harness negative-control pair:** the existing `CHANGE_FEED` combination still certifies, while an out-of-table `PAGED_READ` combination is refused.

Any other `PAGED_READ` combination ⇒ **closed rejection at certification time** (e.g. `PAGED_READ_COMBINATION_UNSUPPORTED`). **Never silently downgrade to `BOUNDED_READ`**: the profile is refused; a caller that wants bounded semantics certifies a separate bounded profile (the `bridge.bounded_read.v2` pattern — one door per capability).

### 3.4 ⟲P2-b — contracts may be latent; counters cannot

`unorderedOffsetAttemptCount` only means something as **runtime instrumentation**, and a capability handshake is only real at a **wired endpoint** — both are incompatible with "latent" by definition. Therefore B1a freezes the **contract shapes only**, with hermetic harness tests:
- counter: name + values-free semantics (counts only, no identifiers);
- handshake: request/response schema — `clientBuild` / `connectorProtocolVersion` / `profileId` / `configVersion` → `READY` / `UPGRADE_REQUIRED` / `CONFIG_MIGRATION_REQUIRED`, version-incompatible ⇒ refuse to run.

**Wiring either is B1-observability — a separate runtime-authorization gate.** Nothing in B1a touches a live path.

### 3.5 ⟲P3-a — sealed snapshot's true scope

Sealed export is the **preferred** exit for the bridge / big-data / non-paginatable class (#4437's blocker class). It is **not** the sole exit for SQL sources: a direct SQL database may certify `PAGED_READ` once the B1c connection-bound snapshot reader exists. rev‑1's "multi-page consistency ⇒ sealed-export territory" is corrected to per-source-class — and ⟲C5 the routing decision is made **per capability spike** (does THIS source hold durable snapshots / stable cursors?), never uniformly per database brand.

## 4. Slice order (owner-ratified)

1. **B1a** — config normalization (`orderingKeySpec` closed schema in the approved config version, §3.1⟲R6) + server-side approved-binding resolver (full six-field tuple, deep-immutable, §3.1⟲R2/⟲R3) + qualification input binding (resolution-object-only, probe AND verify) + `PAGED_READ_LEGAL_COMBINATIONS` contract (§3.3⟲R5) + closed errors + hermetic harness. Latent.
2. **B1b** — MySQL / MSSQL total-order probe strategies: each with its own certified SQL builder + snapshot-semantics claim, registered per `actionProfileVersion`; unbound ⇒ `PROBE_STRATEGY_UNBOUND` (existing, fail-closed by name). PostgreSQL reuses the shipped reference strategy.
3. **B1c** — cross-page snapshot/session executor: design + per-dialect certification of a page-sequence consistency context.
4. **B1-observability** — counter + field-client handshake **wiring**. Separate runtime gate.
5. **Customer migration** — in-repo inventory script per deployment; migrate any live configs to the versioned shape.
6. **B2 = #4591 enforcement** (adapter ordering guard + typed closed 422 + MSSQL fallback deletion). **LAST.** (#4580 CLOSED as superseded — see §1.)

## 5. Implementer landmines (session-verified; read before touching)

- **apps/web error-code tripwire**: `integrationErrorCodeLabels.spec.ts` pins the bridge-adapter error-code array (`length===4` + set equality). A new adapter-owned code requires the FE mirror in the same PR.
- **Agent/protocol version must NOT enter the #4553 qualification digest** (`actionProfileVersion` is the certified single version identity). It is a certification-scoped preflight (owner ruling).
- **The PG probe builder is PG-shaped** (double-quoted identifiers, `LIMIT 1`, `::int` casts) — not portable. MySQL (backticks/`LIMIT`) and MSSQL (brackets/`TOP`/`OFFSET…FETCH`, different isolation story) need their own certified builders (B1b).
- **Trust is object identity** (module-private WeakSet) for strategy registries and the B1a resolver — never duck-type or "brand" objects with public fields.
- **`/select` error mapping** (`routes/data-sources.ts`): the catch maps only "not found" → 404; everything else → 500. The closed-422 mapping is IMPLEMENTED in #4591 (`DataSourceOffsetOrderingError` → 422, closed: generic errors still 500).
- **Inventory scripts: schema-probe FIRST.** Real run table = `integration_runs` (migration 057); there is no `metrics.pageCount` (real fields `details`/`rows_read`); `data_sources` shape varies across migrations. Central-DB counts cannot prove the absence of on-site `/select` callers — per-deployment access logs are required.
- **The offset path is EXERCISED, not merely reachable** — `pipeline-runner.cjs`'s `while (page < maxPages)`
  loop pages the `data-source:sql-readonly` adapter's non-watermark branch via `nextCursor = offset + n`,
  with no `orderBy`. Any statement that the exposure is limited to `copyData` (no live caller) is WRONG.
- **#4580's branch carried the pre-split A-half** — RESOLVED: re-cut from current main as #4591; #4580 CLOSED as superseded. Do not revive the old branch.
- **Bridge feeder test fixtures must echo `data.limit`** — adapter v2 fail-closes without the echo (a fixture that omits it is not "the real agent", which always echoes).
- **Do not raise the 500 single-page bound; do not wire the latent GIP profile** — both owner-gated.

## 6. Fences

Nothing in this document authorizes: runtime enforcement (#4591/B2), arming or runtime wiring of any GIP profile, telemetry/handshake wiring, sealed-snapshot implementation, page-size ceiling changes, CDC / external write-back / D2 / W3 / G1 work (frozen), or rollout. Approval of this document unlocks **B1a (latent contract + harness) only**; every later slice re-enters its own gate.
