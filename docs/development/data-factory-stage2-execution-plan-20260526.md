# Data Factory 阶段二 — Execution Plan (gated PR-level view) - 2026-05-26

## Status / purpose

**Execution-planning view, NOT new design, NOT a build authorization.** This doc
expands the already-merged `DF-N0..N4` phasing (#1839) plus the implementation-path
preferences recorded in #1874 into **concrete PR-level steps** — scope, lane, test
strategy, and the gate that unlocks each. It introduces **no new contracts or
architecture**; per #1838's "PAUSE 阶段二 design", further *design* detail still
waits for K3 PoC evidence. Everything here is gated behind **K3 PoC GATE PASS +
an explicit 阶段二 unlock + a separate per-PR opt-in**.

K3 WISE stays a **preset**, not the product center.

## 0. Reading rules (read first)

- **Gate 0 (precondition for everything):** K3 PoC **GATE PASS** + 阶段二 unlock + per-PR opt-in.
- **Current gate status (2026-05-26):** positive K3 Material Save proven 2026-05-25, but the **S3 read/list runtime decision + S4 single-record positive-Save regression are NOT closed**, and Submit/Audit/BOM/multi-record remain blocked → **Gate 0 is NOT passed → zero PRs below start now.**
- **The whole 阶段二 touches `plugin-integration-core`** (plugin-managed SQL + the pipeline runner + routes) — which is exactly what the K3 Stage-1 lock freezes. Each step is therefore explicitly gated behind unlock; none is implied by this doc.
- **Hard locks that persist through every phase:** K3 stays Save-only / one-record; no Submit/Audit/BOM/multi-record K3 push without a separate owner decision; payload redaction mandatory; **never expose an arbitrary-JS / raw-SQL editor to business users**; OpenAPI parity gate; wire-vs-fixture round-trip test for any new serialized field; real-DB golden gate for anything touching permissions.
- ⚠️ **The PoC may reshape DF-N4 / FaaS** (read model, write-back semantics, reference resolution — the open #1838 gating questions). Do **not** pre-build those.

## 1. Current baseline (what already exists — this plan extends, not reinvents)

- **Plugin-managed tables (integration-core's own SQL, guarded by `migration-sql.test.cjs` — NOT core kysely `zzzz` migrations):** `integration_external_systems`, `integration_pipelines`, `integration_field_mappings`, `integration_runs` / `integration_run_log`, `integration_dead_letters`, `integration_exceptions`, `integration_idempotency_key`, `integration_watermarks`.
- **Adapters** (contract = `plugins/plugin-integration-core/lib/contracts.cjs`, 5 methods `testConnection / listObjects / getSchema / read / upsert`): `k3-wise-webapi`, `sqlserver`, `bridge-agent-readonly`, `http`, `metasheet-multitable-target`, `metasheet-staging-source`, `plm-yuantus`.
- `lib/transform-engine.cjs` (clean DSL, whitelisted transforms). `lib/pipeline-runner.cjs` (run + `targetWriteSummaries` capped 50 + sanitized; dead-letter create/replay at ~688–757). Routes via the `ROUTES` table in `lib/http-routes.cjs`.
- **Already shipped (Stage-5 "运行监控"):** DF-N1 read-only monitoring UI (#1848) + DF-N1.5 single manual dead-letter replay (#1857), front-end only.
- **#1839 config objects map onto existing tables:** `ConnectorProfile` ≈ `integration_external_systems`; `MappingRule` ≈ `integration_field_mappings`; `DatasetDefinition` (schema + identity + direction) is the newest piece (partially served today by adapter `getSchema`/`listObjects` + `integration_watermarks`).

## 2. Dependency graph & sequencing

```
Gate 0: K3 GATE PASS + 阶段二 unlock
   │
   ├─▶ DF-N2 provenance ───┐   (nearest, lowest-risk, extends existing tables)
   │                       │
   └─▶ Config layer C ─────┤   (back-end for the operator 5-stage flow #1844; parallel-safe with N2)
                           ▼
                    DF-N3 retry + back-pressure   (changes runtime semantics, heaviest; back-pressure only meaningful once multi-record export unlocks)
                           ▼
                    DF-N4 connector catalog + 2nd ERP   ("通用" proven here by real reuse; needs a 2nd vendor + PoC evidence)
                           ▼
                    FaaS escape-hatch   (阶段二+/阶段三, last; dedicated security review)
```

**Rationale:** N2 follows the just-shipped DF-N1/N1.5 and is lowest-risk; the config layer is the back-end that makes the 5-stage flow usable and is resource-disjoint from N2 (parallel-safe); N3 depends on N2's per-row results to know *what* to retry and carries the highest runtime risk; N4 is the real test of "通用" and requires a 2nd-vendor adapter reusing the same contract; FaaS is heaviest / largest security surface and must wait until the config tier proves "most systems = config only," then only covers the long tail.

## 3. Phase-by-phase PR breakdown

### Phase DF-N2 — Provenance (per-record lineage)
**Unlock:** 阶段二 unlock. **Preference (#1874):** JSONB on existing tables + a by-`rowId` view — **not** a new event table.

| PR | Scope | Lane | Key tests | Lock / gate |
|---|---|---|---|---|
| N2-1 | Freeze `ProvenanceEvent` shape + 11 event-type enum + redaction contract; land OpenAPI component | contracts | schema parity; invalid-enum rejection | docs/contract, no runtime |
| N2-2 | Plugin SQL migration: add a JSONB lineage field on the existing run/exception surface + a by-`rowId` **view**; runner appends a (redacted) event per step | runtime | redaction unit test (no token/password/conn-string); append-per-step; by-`rowId` query returns **cross-run** lineage; **new field round-trips through real wire** (wire-vs-fixture guard) | plugin-local SQL, `migration-sql.test.cjs` guard; zero new connector behavior; inside K3 lock |
| N2-3 | Run-monitoring panel (`IntegrationWorkbenchView`) gains a **per-row lineage timeline** (read-only): expand a row → source_read→…→target_write across runs | frontend | renders timeline; shows no secret | reuses DF-N1 surfaces; read-only |

**Exit:** a record's end-to-end history is queryable by `rowId` across runs, redacted, surfaced read-only — directly deepening the original 阶段二 motivation "对接成功/失败记录".

### Phase Config layer C — formalization (operator 5-stage back-end; parallel-safe with N2)
**Unlock:** 阶段二 unlock. **Note:** extends existing `external_systems` / `field_mappings`, does not rebuild.

| PR | Scope | Lane | Key tests | Lock / gate |
|---|---|---|---|---|
| C-1 | Formalize `ConnectorProfile` / `DatasetDefinition` / `MappingRule` typed contracts + OpenAPI; map onto existing tables, add `DatasetDefinition` (schema/identity/direction) | contracts | parity; contract validation | docs/contract |
| C-2 | `DatasetDefinition` persistence (new `integration_datasets` or table extension); explicit read/write capability (a read-only source cannot silently write) | runtime | **read-only source rejects upsert**; invalid enum rejects (no silent default); capability round-trips | K3 stays Save-only; reference auto-composition stays frozen |
| C-3 | 5-stage stepper UI (数据源→数据集→数据准备→测试发布→运行监控) wiring existing import/clean/dry-run/monitor; stage availability reflects capability | frontend | stepper gating; dry-run-before-write enforced | guided linear flow, **not** a flow canvas |
| C-4 | Mandatory dry-run-before-write guard (client-side, mirrors #1826 C5) | frontend | write disabled until dry-run passes | — |

### Phase DF-N3 — Retry + back-pressure
**Unlock:** N2 done + (multi-record relevance, itself K3-gated) + separate opt-in. **This changes pipeline runtime semantics — highest risk.**

| PR | Scope | Lane | Key tests | Lock / gate |
|---|---|---|---|---|
| N3-1 | `RunPolicy` contract: max rows/run, max/batch, consecutive-failures→pause, 5xx backoff, auth-fail hard stop, validation→dead_letter; per-connector defaults | contracts | parity; policy defaults | docs/contract |
| N3-2 | Bounded retry of **selected** failed rows; new run linked to the original | runtime | **retry excludes prior successes** (#1839 hard lock); idempotency key prevents duplicate writes | changes runtime, own gate review |
| N3-3 | Back-pressure / stop rules in the runner (threshold pause, exponential backoff, auth-fail hard stop) | runtime | each stop rule unit-tested; pause is visible | back-pressure is real only **after multi-record export unlocks** (separate K3 gate) |
| N3-4 | Bulk "retry selected failed rows" UI + run-policy editor + visible pause state | frontend | bulk-select retry; two-step write confirm; policy persists | — |

### Phase DF-N4 — Connector template catalog (+ 2nd ERP)
**Unlock:** N3 done + the 阶段二 roadmap's "2nd ERP" decision (金蝶云星空 / 用友 U8) + opt-in. **"通用" is proven here by real reuse.**

| PR | Scope | Lane | Key tests | Lock / gate |
|---|---|---|---|---|
| N4-1 | Standardize source/target dataset **templates**; make K3 WISE a **preset template** (not a special lane); catalog schema | contracts | parity; template contract | — |
| N4-2 | HTTP JSON / SQL read-only (with allowlist/view guidance) / CSV/Excel templates | runtime | each template passes the same `adapter-contracts.test` conformance | SQL stays an advanced path |
| N4-3 | **2nd-vendor adapter** (the real "通用" proof) — reuse the same contract, do not fork | runtime | the same golden adapter-contract suite passes for vendor 2 | do not pre-build templates the PoC has not validated |
| N4-4 | Connector catalog UI (pick template → configure → use) | frontend | catalog render; template→profile flow | — |

### Phase FaaS escape-hatch (阶段二+ / spans 阶段三, last)
**Unlock:** N4 config tier proven to cover most systems + a real long-tail system config can't express + **a dedicated security review** + opt-in. **Preference (#1874):** host on our own sandbox, **not** Aliyun FC; config tier first, code tier for the long tail only.

| PR | Scope | Lane | Key tests | Lock / gate |
|---|---|---|---|---|
| F-1 | **Security-model RFC:** sandbox boundary, resource limits (CPU/mem/time), secret isolation (author never sees secrets = platform-injected context), allowed SDK surface (HTTP / other connectors / platform read APIs only), threat model | design | — (design PR) | separate gated design |
| F-2 | function-adapter host: load a user module via `plugin-sandbox.ts` / `PluginIsolationManager.ts`, implement `contracts.cjs`'s 5 methods, inject context + managed credentials; worker/process isolation; **long/async timeout (NOT Yida's 10s)** | runtime | sandbox-escape blocked; resource-limit kill; secret not leaked; async timeout | heaviest security surface, multiple separate gates |
| F-3 | Credential / parameter-context management (author references a managed secret, never embeds it) | runtime | secret never enters event payload (ties to N2 redaction) or logs | — |
| F-4 | Connector-authoring surface (upload/edit function, test-connection, deploy) — **integrator/admin only, RBAC-gated, NOT a business-user surface** | frontend | RBAC gate; test-connection runs in sandbox | the business-user surface stays **config-only, always** |
| F-5 | Connector-level logging / quota / governance (the #1838 borrowable) | runtime | quota enforcement; audit trail | — |

## 4. Cross-cutting discipline (every PR)

- **4-lane branches** (contracts → runtime → frontend → integration), baseline-first for hot files; Conventional Commits; single-maintainer self-review + admin-merge.
- **OpenAPI parity gate**, **wire-vs-fixture round-trip** (any new serialized field needs a real-wire integration test), **enum strictness** (invalid value rejects, never silent-defaults), **redaction mandatory** on every provenance/log path, **real-DB golden gate** (`describeIfDatabase`) for anything touching permissions.
- **Migration discipline:** integration-core is **plugin-local SQL** (not the core `zzzz` kysely chain), guarded by `migration-sql.test.cjs`; deploys follow the pending-migration + auth round-trip check (deploy SOP).

## 5. Out of scope / risks

- The **PoC may reshape DF-N4's read model / write-back semantics / reference resolution** (the open #1838 gating questions) — do not pre-build.
- Multi-record / BOM / Submit/Audit = separate owner decisions, not in this plan.
- **FaaS effectively spans roadmap 阶段三** (vendor registry / schema catalog / adapter builder) and 阶段四 (marketplace) — it is not "阶段二 wrap-up"; it sits last and may slip into 阶段三.

## 6. Recommended minimal first move (if only one thing on unlock day)

**Start with N2-2 (the JSONB lineage) as a single PR** — lowest risk, zero new connector behavior, and the most direct payoff for the original 阶段二 motivation (per-record success/fail). Then the config layer C-1/C-2. **Explicitly do not** start with FaaS or DF-N4 (heaviest, furthest, most PoC-dependent).

## See also

- #1838 (direction / gating, incl. the NiFi + Yida-FaaS takeaways) + its 2026-05-26 addendum #1874 (DF-N2 JSONB + FaaS-on-own-sandbox preferences).
- #1839 (run/provenance + core data model + DF-N0..N4 phasing). #1844 (UX/IA 5-stage flow). #1826 (K3 ref-mapping UI contract). #1835/#1709 (read-only unlock decision / read-list track). #1792 (GATE).
- Shipped: #1848 (DF-N1 read-only monitoring) · #1857 (DF-N1.5 single manual replay).
- Locks: K3 PoC Stage-1 lock; K3 GATE Save-path progression (S3 read/list + S4 regression still open).
