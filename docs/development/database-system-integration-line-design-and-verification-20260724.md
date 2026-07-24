# Database & System Integration Line — Design and Verification (2026-07-24)

**Status:** §1 is a **RECORD** of landed, verified facts (head-scoped SHAs). §2–§6 are **PROPOSED / design-first / doc-only**.

**Gate (owner, 2026-07-24):** approval of this document unlocks **only the B1a latent contract + harness slice**. It does **not** authorize: runtime enforcement (merging #4580 / B2), arming or runtime wiring of any GIP profile, telemetry or handshake **wiring**, sealed-snapshot implementation, page-size ceiling changes, or rollout. Each of those is its own owner gate.

This is the line's single design-and-verification document (owner directive: consolidate closeout facts into one MD; stop letting working memos drift). It absorbs and supersedes the session working memos (`/tmp/gip-decision-memo-20260724.md`, `/tmp/b1-paged-read-certification-design-20260724.md` rev‑1) and the retired ad-hoc inventory SQL (NO-GO; §5).

Owner-review absorption markers used below: ⟲P1-a (ordering-key layering), ⟲P1-b (probe ≠ paged execution), ⟲P2-a (frozen combinations / no silent downgrade), ⟲P2-b (latent vs telemetry), ⟲P3-a (sealed snapshot not the sole exit).

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
- **#4580 DRAFT** (= **B2 enforcement, merges LAST**): adapter-layer OFFSET-ordering guard (offset > 0 without `orderBy` ⇒ fail-closed, all three SQL adapters) + deletion of MSSQL's non-deterministic `ORDER BY (SELECT NULL)` fallback. Pre-merge obligations: **re-cut on current main** (the branch still carries the now-landed A-half), add the **closed 422** mapping for `/select` config errors (today an unordered-offset rejection surfaces as 500), and the §2-M1 per-deployment exposure check.
- **Retired NO-GO**: the ad-hoc inventory SQL — four schema-fact errors (wrong status vocabulary — external-system status is `active/inactive/error`; `integration_pipeline_runs` does not exist, the real table is `integration_runs` per migration 057; no `metrics.pageCount`, real fields are `details`/`rows_read`; `data_sources` shape is inconsistent across migrations ⇒ schema probe first). Replacement: an **in-repo, tested** script run **per customer deployment**, combining DB counts + local `/select` access logs (+ the B1-observability counter once separately authorized). A central-DB count alone cannot prove the absence of on-site HTTP callers.

## 2. M0–M2 acceleration route (owner-set; amendments marked PROPOSED)

**M0 (24–48h, zero product code).** Config owner creates a NEW approved config version (old versions untouched) bound to a provably single-page object — actual rows strictly below the agent-echoed effective limit. Flag-OFF preflight ⇒ `SHORT_PAGE`; then one C-stage flag-ON window; 11-item PASS ⇒ close #4437 (one tenant, one source, pilot). Stop-loss: if no object can be safely narrowed, stop repeat acceptance and enter the M2 spike.
- PROPOSED prechecks: (a) confirm the deployed image includes `7bf2bd7a1` so acceptance evidence reflects the hardened adapter; (b) capture the agent `/health` `version` (currently `0.1.0`) in the window evidence as the qualification-line baseline.

**M1 (3–5 dev days, exactly two dev lines).**
- *Qualification line:* agent/protocol-version **certification-scoped preflight** (hard gate before activation/arming/runtime; does not block #4437).
- *Direct-DB line:* values-free inventory first. If approved `data-source:sql-readonly` configs = 0 **and** the pilot deployment's `/select` access log shows no `offset>0`-without-`orderBy` callers ⟲(central counts alone are insufficient — owner's prior P1), re-review and merge #4580 with the 422 rider; new paginated configs must declare a stable **unique** `orderBy` — **declaration-level until B1b/B1c**: the merged guard enforces *presence* of an order, not *uniqueness* (stated residual). If > 0: versioned config migration + preflight rejection first; never auto-guess a primary-key order.
- Keep the existing Integration Workbench config/probe/approve UI — **no second connector configurator**. `stock-prep:read/operate` permission split at M1 end; the pilot runs under a controlled admin.

**M2 (only on real-scale evidence from M0/M1).** Ratify scale-D0 first; run the `bridge.sealed_snapshot` feasibility spike; compare "export + signed manifest" vs interactive paging on true change surface; only then decide async job / staging / generation flip / multiset SQL diff. CDC, external write-back, D2 reconciliation, W3 suggestion dates, G1 notifications stay **off** the critical path (frozen).

## 3. B1 design (REVISED — owner findings absorbed)

### 3.1 ⟲P1-a — the certificate holds the REQUIREMENT; the config holds the FIELDS

The ratified certificate model already carries **`orderingKeyRequirement`** (contracts §certificate fields) — a capability-level *requirement*, never the customer's concrete columns. The concrete **`orderingKeySpec`** (ordered field list + directions) belongs to the **approved config version** (customer/binding-scoped, immutable per version). rev‑1 of this design put `orderingKeyFields` in the certificate — wrong layer; withdrawn.

**B1a core — server-side approved-config resolver.** Input: `approvedConfigVersionId` (+ principal for authz). The server loads that ONE immutable approved version and derives `{ objectKey, orderingKeySpec, configContentKey }` from it alone, returning a frozen resolution object. **The prober and the qualification-digest inputs accept ONLY this resolution object** — callers can no longer supply `keyColumns` or `configContentKey` independently. This closes the mix-and-match forgery (probing with config A's `configContentKey` but field set B) **by construction**, which matters because probe evidence is values-free (`checkedKeyColumnCount` only — field names never enter evidence), so the mismatch could never be detected after the fact.
- Trust is **object identity** (module-private WeakSet), mirroring the existing probe-strategy registry pattern — a hand-built resolution object is refused.
- Owner adjudication recorded: `configContentKey` being a digest input is **necessary but not sufficient**; the resolver is what turns it into an actual binding.

### 3.2 ⟲P1-b — a probe certifies ORDER; it does not certify PAGING

`single_statement_mvcc` (and any B1b analog) certifies exactly **one probe statement** under one snapshot claim. It says nothing about a page *sequence*: `DataSourceManager.select()` is pool-per-call — no transaction or connection spans two pages today, and transaction objects cannot be passed into `select()`/`query()`.

Consequences, stated as scope:
- **B1b** (MySQL/MSSQL strategies) closes **total-order qualification** for those dialects — nothing more.
- **PAGED_READ certification additionally requires a page-sequence execution seam**: one certified consistency context spanning all pages (same-connection snapshot transaction, or a token-addressed immutable snapshot), with dialect-certified semantics and its own profile gate. That is **B1c**, design-first, not implied by B1a+B1b.
- Probe-execution seam note: probe SQL uses `GROUP BY`/`HAVING` shapes the structured facade cannot express, so B1b needs a **restricted internal probe-executor seam** — accepts ONLY strategy-minted statements (object-identity trust), read-only, statement-bounded, never reachable from HTTP input. Per the owner's dependency direction, core-backend contributes this bounded seam and nothing else; qualification definitions stay in the GIP layer.

### 3.3 ⟲P2-a — frozen legal combinations; rejection, never silent downgrade

"`PAGED_READ` ⇒ consistency proofs non-empty" is too weak. The certifiable combinations are a **FROZEN table** (extending the existing scale-D0 §2 cross-dimension legality pattern):

| consistency proof | continuation lifetime |
|---|---|
| `SOURCE_SNAPSHOT_TXN` | `CONNECTION_BOUND` |
| `IMMUTABLE_SNAPSHOT_TOKEN` | `DURABLE_TOKEN` |

`MONOTONIC_VERSION_PIN` is deliberately **unmapped** in v1: a version pin *detects* drift; it does not make pages mutually consistent — abort-on-drift is a weaker, different contract that would need its own ratification before appearing here.

Any other combination ⇒ **closed rejection at certification time** (e.g. `PAGED_READ_COMBINATION_UNSUPPORTED`). **Never silently downgrade to `BOUNDED_READ`**: the profile is refused; a caller that wants bounded semantics certifies a separate bounded profile (the `bridge.bounded_read.v2` pattern — one door per capability).

### 3.4 ⟲P2-b — contracts may be latent; counters cannot

`unorderedOffsetAttemptCount` only means something as **runtime instrumentation**, and a capability handshake is only real at a **wired endpoint** — both are incompatible with "latent" by definition. Therefore B1a freezes the **contract shapes only**, with hermetic harness tests:
- counter: name + values-free semantics (counts only, no identifiers);
- handshake: request/response schema — `clientBuild` / `connectorProtocolVersion` / `profileId` / `configVersion` → `READY` / `UPGRADE_REQUIRED` / `CONFIG_MIGRATION_REQUIRED`, version-incompatible ⇒ refuse to run.

**Wiring either is B1-observability — a separate runtime-authorization gate.** Nothing in B1a touches a live path.

### 3.5 ⟲P3-a — sealed snapshot's true scope

Sealed export is the **preferred** exit for the bridge / big-data / non-paginatable class (#4437's blocker class). It is **not** the sole exit for SQL sources: a direct SQL database may certify `PAGED_READ` once the B1c connection-bound snapshot reader exists. rev‑1's "multi-page consistency ⇒ sealed-export territory" is corrected to per-source-class.

## 4. Slice order (owner-ratified)

1. **B1a** — config normalization (`orderingKeySpec` in the approved config version) + server-side resolver + qualification input binding (resolution-object-only) + frozen legal-combination contract + closed errors + hermetic harness. Latent.
2. **B1b** — MySQL / MSSQL total-order probe strategies: each with its own certified SQL builder + snapshot-semantics claim, registered per `actionProfileVersion`; unbound ⇒ `PROBE_STRATEGY_UNBOUND` (existing, fail-closed by name). PostgreSQL reuses the shipped reference strategy.
3. **B1c** — cross-page snapshot/session executor: design + per-dialect certification of a page-sequence consistency context.
4. **B1-observability** — counter + field-client handshake **wiring**. Separate runtime gate.
5. **Customer migration** — in-repo inventory script per deployment; migrate any live configs to the versioned shape.
6. **B2 = #4580 enforcement** (adapter ordering guard + MSSQL fallback deletion + 422 rider). **LAST.**

## 5. Implementer landmines (session-verified; read before touching)

- **apps/web error-code tripwire**: `integrationErrorCodeLabels.spec.ts` pins the bridge-adapter error-code array (`length===4` + set equality). A new adapter-owned code requires the FE mirror in the same PR.
- **Agent/protocol version must NOT enter the #4553 qualification digest** (`actionProfileVersion` is the certified single version identity). It is a certification-scoped preflight (owner ruling).
- **The PG probe builder is PG-shaped** (double-quoted identifiers, `LIMIT 1`, `::int` casts) — not portable. MySQL (backticks/`LIMIT`) and MSSQL (brackets/`TOP`/`OFFSET…FETCH`, different isolation story) need their own certified builders (B1b).
- **Trust is object identity** (module-private WeakSet) for strategy registries and the B1a resolver — never duck-type or "brand" objects with public fields.
- **`/select` error mapping** (`routes/data-sources.ts`): the catch maps only "not found" → 404; everything else → 500. The closed-422 rider belongs with #4580.
- **Inventory scripts: schema-probe FIRST.** Real run table = `integration_runs` (migration 057); there is no `metrics.pageCount` (real fields `details`/`rows_read`); `data_sources` shape varies across migrations. Central-DB counts cannot prove the absence of on-site `/select` callers — per-deployment access logs are required.
- **#4580's branch still carries the pre-split A-half** — re-cut on current main before its review.
- **Bridge feeder test fixtures must echo `data.limit`** — adapter v2 fail-closes without the echo (a fixture that omits it is not "the real agent", which always echoes).
- **Do not raise the 500 single-page bound; do not wire the latent GIP profile** — both owner-gated.

## 6. Fences

Nothing in this document authorizes: runtime enforcement (#4580/B2), arming or runtime wiring of any GIP profile, telemetry/handshake wiring, sealed-snapshot implementation, page-size ceiling changes, CDC / external write-back / D2 / W3 / G1 work (frozen), or rollout. Approval of this document unlocks **B1a (latent contract + harness) only**; every later slice re-enters its own gate.
