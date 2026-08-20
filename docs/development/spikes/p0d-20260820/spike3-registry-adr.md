# ADR — External Key Registry (`meta_record_external_keys`)

- **Status**: DESIGN SPIKE — not decided, not built, not wired into any code path.
- **Spike ID**: SPIKE 3 (p0d-20260820)
- **Baseline**: `main @ c5a4a94f7` (2026-08-20)
- **Author**: platform engineering (spike)
- **Deliverables**: this ADR, `spike3-registry-migration.draft.sql`, `spike3-registry-prototype.ts`, `spike3-registry.test.ts` — all under `docs/development/spikes/p0d-20260820/`, none under the real `packages/core-backend/migrations/` or `src/` trees.

## Context

`plugin-integration-core` pipelines (`packages/core-backend/migrations/057_create_integration_core_tables.sql`) move records between external systems (K3 WISE ERP, Yuantus PLM, generic HTTP/Postgres sources — see the `kind` comment at 057:24) and metasheet's own record store (`meta_records`, defined in `packages/core-backend/src/db/migrations/zzz20251231_create_meta_schema.ts:44-51`, `id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text`).

Today, `integration_pipelines.idempotency_key_fields` (057:65, a JSONB array like `['sourceSystem','objectType','sourceId','revision']`) is the only artifact resembling an "external key" concept, and it is pipeline-scoped configuration, not a durable, queryable **registry** of which `meta_records` row a given external business key currently resolves to. There is no table today that answers, for a given `(external_system, object, business_key)`, "which `meta_records.id` is that, right now, authoritatively" — every pipeline run has to re-derive/re-match it, and nothing prevents two different pipeline runs from silently binding the same external key to two different records, or the same record to two different active external keys.

This spike designs that registry: `meta_record_external_keys`.

Two concrete problems it must solve, both named in the spike brief:

1. **Business-key normalization drift.** ERP/PLM business keys ("物料编码" / part numbers) commonly vary in case, whitespace, and leading-zero padding across systems and even across records in the *same* system (`"0007"` vs `"PN-7B"` vs `"pn-7b"`). Two raw strings that are "the same key" to a human must resolve to one canonical form, and a hash of that canonical form must be usable as a fast lookup index — while never trusting the hash alone, because hash collisions (however rare) must not silently merge two genuinely different keys.
2. **Normalization rule upgrades change the canonical form of existing keys.** A future normalization version (e.g., "also NFKC full-width digits" or "also strip leading zeros") can cause two previously-DISTINCT canonical keys to **collapse** onto the same new canonical string. If that collapse involves two *different* records, it is a conflict that must block the upgrade and be resolved by a human — not silently merge two unrelated business records.

### What was read before proposing anything

| File | Lines | What was taken from it |
|---|---|---|
| `packages/core-backend/migrations/057_create_integration_core_tables.sql` | 1-14 | Tenant-scoping convention: `tenant_id NOT NULL`, `workspace_id` nullable, external-system-specific dimensions live in `config` JSONB rather than dedicated columns. `integration_` table-name prefix convention. |
| `packages/core-backend/migrations/057_create_integration_core_tables.sql` | 35-42 | The `COALESCE(workspace_id, '')` expression-index trap: plain `UNIQUE(tenant_id, workspace_id, ...)` allows duplicate rows when `workspace_id IS NULL` because Postgres treats `NULL <> NULL` under default `UNIQUE` semantics, and PG14 (this repo's target) has no `NULLS NOT DISTINCT`. |
| `packages/core-backend/migrations/062_create_integration_read_source_configs.sql` | 1-45, 64-71 | Content-key (`sha256(stable-stringify(...))`) + versioned-family pattern; values-free audit trail convention (`detail JSONB` holds only coarse enums/counters, never business content). |
| `packages/core-backend/migrations/073_create_sealed_export_stock_prep_runtime_authority.sql` | 14-53 | The more recent (post-062) evolution of the scoping trap fix: a `STORED GENERATED` `workspace_scope_key` column instead of repeating `COALESCE(...)` in every index expression. Also: `binding_id TEXT PRIMARY KEY` naming convention, and the "exactly one ACTIVE row per scope" partial-unique-index pattern (`uniq_..._active_binding ... WHERE status = 'ACTIVE'`) that this spike's generation-switch mechanism reuses directly. |
| `packages/core-backend/src/multitable/provisioning.ts` | 130-136 | `stableMetaId(prefix, ...parts)` — deterministic `sha1`-derived, prefix-tagged, length-capped TEXT id pattern already used elsewhere in this codebase for `meta_sheets`/`meta_fields`/`meta_views` ids (130-147). Referenced (not reused as the real PK strategy — see "Alternatives" below) in the prototype's `stableExternalKeyId`. |
| `packages/core-backend/src/db/migrations/zzz20251231_create_meta_schema.ts` | 44-51 | `meta_records.id` is `TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text`. `meta_record_external_keys.record_id` follows this exact type. |
| `packages/core-backend/src/attendance/w4c0-fingerprints.ts` | 37-82 | `canonicalAttendanceJsonV1` — this codebase's existing precedent for "one strict canonical form + a domain-separated sha256 digest of it," reused conceptually (not the same domain/function) for `canonical_key` + `normalized_key_hash`. |
| grep for `normalized_key`, `canonical`, `hash` in `packages/core-backend/src` | — | No existing `normalized_key`/external-key-registry table or column exists anywhere in `src` today (the only "canonical" precedent is the unrelated attendance fingerprint domain above, and `PLMAdapter.ts`'s own unrelated crypto usage). This is a genuinely new schema, not an extension of something that already exists. |

## Decision

Introduce three new tables (full DDL in `spike3-registry-migration.draft.sql`):

1. **`integration_external_key_bindings`** — one row per `(tenant, workspace, external_system, object)` enrolled in registry tracking, pointing at the `meta_sheets.id` it resolves matched records into. This is the scope anchor; it exists because both other tables need *something* stable to hang tenant/workspace scoping and "one active X per scope" off of, and precedent (`integration_sealed_export_stock_prep_bindings`, 073:14-53) already establishes this shape in this exact schema family.
2. **`integration_external_key_registry_generations`** — one row per normalization-rule epoch (`generation_no`, `normalization_version`, lifecycle `building -> active -> frozen -> retired`). Exactly one `active` generation per `binding_id` at a time, enforced by a partial unique index (`uniq_..._active ON (binding_id) WHERE status = 'active'`).
3. **`meta_record_external_keys`** — the registry rows themselves: `record_id` (FK `meta_records.id`), `raw_key`, `canonical_key` (NOT NULL), `normalized_key_hash` (NOT NULL), `normalization_version` (NOT NULL), `state`, `registry_generation_id` (FK, NOT NULL).

### The two uniqueness invariants, and why they're scoped the way they are

```sql
-- "one external key never points to two active records"
CREATE UNIQUE INDEX uniq_meta_record_external_keys_active_canonical
  ON meta_record_external_keys (registry_generation_id, normalized_key_hash, canonical_key)
  WHERE state = 'active';

-- "one active record has at most one active external key"
CREATE UNIQUE INDEX uniq_meta_record_external_keys_active_record
  ON meta_record_external_keys (registry_generation_id, record_id)
  WHERE state = 'active';
```

**Why `(hash, canonical_key)` together, not `hash` alone.** The spike brief requires "allow hash collisions, compare full canonical after hash locate." Indexing on `normalized_key_hash` alone would make two DIFFERENT business keys that happen to share a sha256 digest mutually exclusive at the DB level — an availability bug triggered by an event that is supposed to be merely a performance concern (bucket lookup), never a correctness one. Including `canonical_key` in the same composite index means: the index is still used to locate the candidate bucket cheaply (leftmost-prefix scan on `registry_generation_id, normalized_key_hash`), but two rows only conflict if their FULL canonical strings are also equal. The application-layer contract this backs is implemented verbatim in `classifyUpsert()` (`spike3-registry-prototype.ts`): always recompute the hash from the incoming canonical, scan the bucket, then do a full string compare — never trust the hash as a complete identity.

**Why `registry_generation_id`, not `binding_id`, is the uniqueness scope.** This is the spike's central design decision and the reason `registry_generation_id` exists at all rather than putting `normalization_version` directly on `meta_record_external_keys` and scoping uniqueness to `binding_id`. A normalization-version upgrade must be able to build an entire NEW generation's worth of rows — including rows with `state = 'active'` in the new generation, so the DB is prepared to serve reads the instant the switch happens — **while the OLD generation's rows are still `state = 'active'` too**, because the old generation must keep serving live traffic until the atomic switch. If uniqueness were scoped to `binding_id` alone, the moment the rebuild job inserted the new generation's active row for a canonical key that also has an active row in the old generation, the partial unique index would reject it (or, if the key differs in the old vs. new canonical form for the same record, you'd get a false "two active keys for one record" rejection on the OLD generation's own invariant). Scoping to `registry_generation_id` makes the old and new generations two independent uniqueness universes that only interact at the one moment the "active generation" pointer flips (`integration_external_key_bindings.active_registry_generation_id`, updated inside the same transaction that flips both generations' `status`).

### The upgrade flow (normalization-version bump)

1. **Freeze old generation.** No DDL — `frozen` is a `status` value, not a schema change. New upserts against the binding stop targeting the old generation once step 5 flips the pointer; until then, the old generation keeps accepting writes normally (freezing is a *logical* commitment made at step 5, not step 1 — see "Open questions" on whether a true write-freeze window is needed before rebuild starts).
2. **Rebuild under new normalization.** For every row in the (about-to-be-frozen) active generation, re-derive `raw_key -> normalizeKey(raw_key, newVersion)` and insert into a brand-new `building` generation. This is exactly what `detectCollapse()` (`spike3-registry-prototype.ts`) simulates offline, in-memory, with no DB writes — it groups old rows by their NEW canonical key and classifies each group as `safe` (one distinct `record_id`) or a `conflict` (2+ distinct `record_id`s landed on the same new canonical).
3. **Detect collapse/conflict.** Run `detectCollapse()` (or the DB-backed equivalent of it) against the full old-generation row set. Any `conflicts` group is a hard stop — see "Consequences" below, this is the one case the design refuses to auto-resolve.
4. **Migration report.** Persist the `detectCollapse()` output into `integration_external_key_registry_generations.migration_report` (JSONB) on the new `building` generation row — counts and the conflicting canonical/record-id groups, values-free beyond what's needed to act on it (matching the audit-trail posture already established at `062_create_integration_read_source_configs.sql:64`, "detail... never config content"). A human reviews this report. If there are conflicts, the flow stops here — the new generation stays `building` forever (or is discarded) until someone manually reassigns/retires the conflicting keys in the OLD generation and the rebuild is re-run.
5. **Atomic switch.** One transaction: `UPDATE integration_external_key_registry_generations SET status='frozen', frozen_at=now() WHERE registry_generation_id = <old>`, `UPDATE ... SET status='active', activated_at=now() WHERE registry_generation_id = <new>`, `UPDATE integration_external_key_bindings SET active_registry_generation_id = <new> WHERE binding_id = <binding>`. The two partial unique indexes (`uniq_..._active` on generations, scoped-by-generation indexes on `meta_record_external_keys`) make it impossible for a concurrent reader to ever observe two simultaneously-active generations for one binding.
6. **Plans bound to the old generation go stale.** Any pipeline run, dead-letter replay, or cached lookup that captured `registry_generation_id = <old>` before the switch is now referencing a `frozen` generation. This is deliberate, not a bug to patch around: a `frozen` generation's rows are still fully readable (nothing is deleted), so a stale plan can still be inspected/audited, but the design does not attempt to silently "forward" a stale plan's key lookups into the new generation — that forwarding is exactly the kind of implicit business-key remapping this spike's alias/history decision (below) says v1 does not do automatically.

### Alias / history decision: **v1 rejects auto-renumber; manual migration only**

The spike brief requires an explicit choice between (a) supporting source-side renumber via a full alias/history schema now, or (b) rejecting auto-renumber in v1 with manual-only migration, deferring alias/history to P1.

**Decision: (b).** v1 does not ingest "this business key was renamed from X to Y" events from any source system and does not maintain multiple simultaneously-valid aliases for one record. The only "history" v1 provides is the single-hop `superseded_by_id` column on `meta_record_external_keys`: when an operator manually decides record R's key changed from `raw_key_old` to `raw_key_new`, they retire the old row (`state = 'superseded'`) and insert a new active row for the same `record_id`, and may set `old.superseded_by_id = new.id` as a breadcrumb. That is a manual, two-write operation with no dedicated "rename" verb, no automatic detection, and no multi-hop chain-walking API in v1.

**Why not build the alias/history schema now:**
- **Scope discipline.** The spike brief itself frames alias/history as "P1" work — building it now would be scope creep on a P0 registry spike, and a real alias/history schema (multi-hop rename chains, multiple simultaneously-valid aliases per record, source-event ingestion + idempotency for renumber events) is its own design problem with its own trade-offs (e.g., does an alias participate in the same uniqueness invariants as the primary canonical key? almost certainly yes, which reopens every index decision above).
- **No existing renumber-event source.** Grepping the integration layer, there is no existing pipeline concept of a "key renamed" event distinct from a normal upsert — `integration_pipelines.idempotency_key_fields` (057:65) treats the key fields as stable identity, not as something that changes. Building auto-renumber detection without a defined upstream signal for it would mean guessing "this incoming key must be a rename of that other now-orphaned key" heuristically, which is exactly the kind of silent-merge risk this whole spike exists to prevent (see `classifyUpsert`'s `collision` outcome — it is designed to REFUSE that guess, not attempt it).
- **`superseded_by_id` is enough for the P0 bar.** The stated P0 acceptance criteria are about hash-collision safety, generation-switch atomicity, and the record<->key bijection — none of which require multi-alias support. A single manual-migration breadcrumb column satisfies the "renumber policy explicit" acceptance criterion without prejudging P1's design.

## Alternatives considered

### A. Scope active-uniqueness to `binding_id` directly (no `registry_generation_id` table)
Put `normalization_version` as a plain column on `meta_record_external_keys` and scope both partial unique indexes to `binding_id` instead of a separate generation row.
- **Trade-off gained:** one fewer table; no generation lifecycle to manage.
- **Trade-off lost:** as explained above, this makes it structurally impossible to have both the old and new generation's rows simultaneously `active` during a rebuild, which is required for the "rebuild fully, THEN atomically switch" flow the spike brief asks for. The only alternative under this scheme is an in-place `UPDATE canonical_key/normalized_key_hash/normalization_version` on every existing row, which is neither atomic across many rows nor reviewable via a migration report before commit. **Rejected** — fails the "atomic gen switch" acceptance criterion outright.

### B. Hash-only uniqueness (`UNIQUE(registry_generation_id, normalized_key_hash) WHERE state='active'`)
- **Trade-off gained:** slightly smaller index; simpler mental model ("the hash IS the key").
- **Trade-off lost:** directly violates the "hash collision → two distinct canonicals coexist" acceptance criterion — a real (if rare) sha256 collision between two unrelated business keys would make the second key permanently unable to become active, an availability failure masquerading as a security property nobody asked for at this layer. **Rejected.**

### C. `record_id` as the primary uniqueness anchor, `canonical_key` unconstrained
Only enforce "one record, one active key" and leave duplicate canonical keys across different records to application-layer checks (e.g., pre-insert `SELECT`).
- **Trade-off gained:** avoids ever tuning a composite index; app code has full control of the classify-then-write sequence.
- **Trade-off lost:** a `SELECT`-then-`INSERT` race window under concurrent pipeline runs (two runs upserting the same source object at once, common in retry/replay scenarios per `integration_dead_letters`, 057:150-172) can double-bind a canonical key with no DB-level backstop. The chosen design keeps the `SELECT`-then-decide `classifyUpsert()` step at the app layer for the *classification/telemetry* (so callers get a clear `new`/`match`/`collision` verdict) but backs the actual invariant with the DB unique index as the authoritative race-safe guard — `INSERT ... ON CONFLICT` against the partial unique index is the real concurrency-safety mechanism; `classifyUpsert()` is what decides which branch to take BEFORE attempting the write, and the DB index is what makes a lost race fail loud (`23505`) instead of silently corrupting the bijection. **Partially adopted** — the index exists; `classifyUpsert()` is a pre-flight/telemetry helper, not a substitute for it.

### D. `stableMetaId`-style deterministic id for `meta_record_external_keys.id`
Reuse the `provisioning.ts:130-136` pattern (`sha1(parts.join(':')).slice(0,24)` prefixed) instead of `gen_random_uuid()::text`.
- **Trade-off gained:** idempotent retries could reuse the same id without a round-trip read; matches an existing in-repo convention (`stableExternalKeyId` is included in the prototype to illustrate this, unused by the draft migration).
- **Trade-off lost:** `meta_records.id` itself (the table this registry is keyed off) already uses `gen_random_uuid()::text` (`zzz20251231_create_meta_schema.ts:46`), and every other row-identity column in this registry (`binding_id`, `registry_generation_id`) is a fresh synthetic id, not derived from business content — deriving `id` from `(binding_id, registry_generation_id, canonical_key)` would make the id itself carry a load-bearing meaning (retry-idempotency) that the ADR's open questions (below) flag as unresolved for the real implementation. **Deferred** — kept as an illustrative option in the prototype, not adopted in the draft migration.

## Consequences

**Positive:**
- The record<->external-key bijection is enforced at the database level, not just in application code, closing the concurrent-pipeline-run race described in Alternative C.
- A normalization-version upgrade has a reviewable, blocking checkpoint (the migration report) before any data-visible switch happens — no upgrade can silently merge two records.
- Hash-bucket lookups stay O(1)-ish via the index while never being the sole source of truth for equality.
- Old generations are never deleted, only frozen/retired — full forensic/rollback trail for "what did this pipeline believe was true about key X on date Y."

**Negative / costs accepted:**
- **Three new tables for one registry concept** — more schema surface than a single flat table. Justified by the atomicity requirement (Alternative A), but it is real complexity: every read path needs to resolve "the active generation for this binding" before it can query `meta_record_external_keys` meaningfully (typically one extra indexed lookup or a join).
- **Stale plans after every upgrade are a real operational surface**, not just a footnote. Anything caching a `registry_generation_id` (pipeline run state, dead-letter replay payloads, external client-side caches of a resolved match) must be either generation-aware (re-resolve "the active generation" before acting) or explicitly designed to fail closed against a `frozen` generation. This spike does not design that re-resolution contract for callers — it is listed under "Open questions."
- **v1's manual-only renumber policy pushes real operational toil onto whoever manages a source system that DOES renumber business keys** (common in ERP master-data cleanups). Every such event is a manual two-write operation until P1's alias/history schema exists. This is an accepted, explicit trade-off (see "Alias/history decision"), not an oversight.
- **`normalization_version` is denormalized onto every `meta_record_external_keys` row** even though it is also implied by the row's `registry_generation_id` (via a join to `integration_external_key_registry_generations.normalization_version`). This is deliberate — see 062's "content_key... an identical save is a NO-OP" style of keeping a fast-filterable copy next to a FK — but it is a second place a "which version made this row" answer can live, and the draft migration only guards it with a same-row non-blank CHECK, not a cross-table consistency guarantee (see next section).

## Open questions

1. **Cross-table `normalization_version` consistency.** Should a trigger (or a generated/foreign-key-like constraint, which Postgres doesn't directly support across tables) enforce that `meta_record_external_keys.normalization_version` always equals its `registry_generation_id`'s `normalization_version`, or is "only the rebuild job ever writes this column, so it's write-path-enforced by convention" an acceptable posture for v1 (matching how `tenant_id` denormalization is handled — app-enforced, not DB-enforced — everywhere else in this schema family)?
2. **Write-freeze semantics during rebuild (upgrade flow step 1).** The flow above describes "freeze" as a logical/pointer-flip event at the END of the rebuild (step 5), meaning the OLD generation keeps accepting normal writes WHILE the rebuild reads a snapshot of it. Is a snapshot read (e.g., `SELECT ... FOR SHARE` at a transaction boundary, or reading at a fixed `updated_at` watermark) sufficient, or does a real implementation need a true write-freeze window (reject new upserts against the old generation) between "rebuild starts" and "switch completes" to avoid rebuilding against a moving target? This spike does not resolve that; `detectCollapse()` as written assumes a static snapshot input.
3. **Stale-plan re-resolution contract.** What is the actual API/behavior a caller holding a stale (`frozen`-generation) `registry_generation_id` should get — a typed error forcing re-resolution, a transparent redirect to the new active generation (which reopens the "is this key even the same key under the new normalization" question the whole upgrade flow exists to gate), or something else? Left undesigned.
4. **`integration_external_key_bindings.sheet_id` cardinality.** The draft assumes one `sheet_id` per binding (one external object maps to exactly one metasheet table). Is that always true across the existing `plugin-integration-core` pipeline shapes (057's `integration_pipelines.target_object`), or can one external object fan out to multiple sheets depending on pipeline config — which would mean `sheet_id` doesn't belong on the binding at all?
5. **RLS / DB-level tenant isolation.** This draft follows the existing convention of app-enforced (not Postgres RLS-enforced) tenant scoping, consistent with every other `integration_*` table in this repo today. If a future ADR moves the platform toward RLS, this registry would need to be revisited alongside all its siblings — not a decision this spike makes unilaterally.
6. **Deterministic vs. random `id` for `meta_record_external_keys`** (Alternative D) — left as `gen_random_uuid()::text` for this draft; revisit if idempotent-retry-without-a-read becomes a measured need.

## Acceptance criteria mapping (spike brief -> design)

| Acceptance criterion | Where it's satisfied |
|---|---|
| Hash collision: two distinct canonicals coexist & are distinguishable | `uniq_meta_record_external_keys_active_canonical` indexes `(registry_generation_id, normalized_key_hash, canonical_key)`, not hash alone; `classifyUpsert()` always full-compares canonical after hash-locating candidates. Tested in `spike3-registry.test.ts` ("acceptance: hash collision..."). |
| Normalization upgrade: atomic gen switch + old plans stale | `integration_external_key_registry_generations` lifecycle + `uniq_..._active WHERE status='active'` partial index make the switch a single-transaction, race-safe pointer flip (§Decision, upgrade flow step 5); staleness is a named, accepted consequence (§Consequences), not silently patched over. |
| One external key never points to two active records | `uniq_meta_record_external_keys_active_canonical` (generation-scoped). Tested via `classifyUpsert` collision cases. |
| Renumber policy explicit | §"Alias/history decision" — v1 rejects auto-renumber, manual-only via `superseded_by_id`; full alias/history explicitly deferred to P1 with reasons given. |
