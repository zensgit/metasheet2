# P0-D Spike Synthesis & Ratify Recommendation

- **Status**: SYNTHESIS (design spike roll-up — no decision ratified, no code wired)
- **Date**: 2026-08-20
- **Baseline**: `main @ c5a4a94f7` (frozen)
- **Inputs**: `spike1-principal-*`, `spike2-mirror-*`, `spike3-registry-*` (this dir)
- **Purpose**: (1) cross-spike consistency check, (2) per-spike Ratify readiness + missing evidence, (3) the single ordered P0-D decision list for owner/tech-lead, (4) the real-DB integration tests that MUST land before P1.

---

## 0. TL;DR

The three spikes are each internally sound and independently Ratify-able **as isolated schema decisions**, but they were designed in isolation and **share zero references** — `grep` for `principal|writer_grant|actor_id|service_principal` in the spike-2 files returns nothing, and `grep` for `mirror|service_principal|writer_grant` in the spike-3 ADR returns nothing. The identity model (spike 1) that exists specifically to kill bare-string actors is **not wired into** the mirror publisher (spike 2, `proposed_by`/`approved_by` are bare `text` — `spike2-mirror-migration.draft.sql:161-162`) or the registry pipeline writer (spike 3). Two independent "generation" concepts (`mirror_generation`, `integration_external_key_registry_generations`) and two independent notions of "same business row" (`mirror_binding.key_field_ids` raw field-join vs `meta_record_external_keys.canonical_key` normalized) coexist with **no reconciliation**. None of this is a defect *in* a spike; it is the **synthesis-level P0-D decision** that has to be made before any of the three is built.

- **Ratify now (decision-level)**: spike 1, spike 3 — the schema/constraint decisions rest on well-established Postgres mechanisms (composite FK, partial-unique index, `ON CONFLICT`), not on unproven numbers.
- **Gate on a real-DB run before Ratify**: spike 2 — the choice of Option A over B *explicitly hinges* on "publish cost acceptable at v1 scale" (`spike2-mirror-adr.md` §2, §5 Q + benchmark plan), which is unmeasured. Spike 3 additionally needs a real-DB run to settle its one open correctness question (rebuild-against-a-moving-target, ADR open Q2).

---

## 1. Cross-spike consistency

### 1.1 Do principal ↔ writer-grant ↔ mirror-writer align? — **Mechanism yes, wiring NO.**

The mechanism is present and compatible: `writer_grants.target_kind CHECK (target_kind IN ('base','sheet','data_source'))` (`spike1-principal-migration.draft.sql:74-75`) already admits `target_id = <mirror sheet_id>`. A mirror publisher is exactly a non-human principal — spike 1's `kind` enum already lists `system_migration | service` (`spike1-principal-adr.md` §2.1) and a mirror-publish worker fits `service` (or a new `kind='mirror'`).

But the wiring is absent, and it is absent in the precise way spike 1 exists to prevent:

- **Mirror publisher is a bare string.** `mirror_publish_plan.proposed_by text` / `approved_by text` (`spike2-mirror-migration.draft.sql:161-162`) are free text with no FK to `service_principals`. This is the *same* anti-pattern spike 1 diagnoses in `DataSourceManager.assertAccess` and `meta_record_revisions.actor_id` (`spike1-principal-adr.md` §1.1).
- **The publish write has no authorized principal.** Spike 2's apply step does `UPDATE meta_records SET data=…, version=version+1` (`spike2-mirror-migration.draft.sql:186-190`) but never checks a `writer_grant` on the target sheet, and never records who the writer was in `meta_record_revisions.actor_id`. Under spike 1's model, that publish should (a) be performed by a `service_principals` row, (b) require an active (non-revoked) `writer_grants` row with `target_kind='sheet', target_id=<mirror sheet_id>`, and (c) stamp `actor_id = <principal id>` so history resolves (spike 1's whole audit-survives-revocation story, §2.4).

**Alignment verdict**: compatible by construction, unwired by omission. The P0-D synthesis decision is *"the mirror publisher and every integration pipeline writer are `service_principals` holding `writer_grants`; the bare `proposed_by`/`created_by`/`actorId` strings in spikes 2 & 3 are replaced by principal ids."* Recommended: **adopt** as the binding P1 integration contract.

### 1.2 Does mirror generation reference registry generation? — **NO, and today that is defensible but under-specified.**

`mirror_generation` (`spike2-mirror-migration.draft.sql:66`) and `integration_external_key_registry_generations` (`spike3-registry-migration.draft.sql:95`) are **entirely disjoint** — different lifecycles, no FK, no mention of each other. That is correct *as far as it goes*: they solve different problems (publish-atomicity epochs vs normalization-rule epochs).

The unreconciled edge is the **keying function**, not the generation tables directly:

- Spike 2 matches next-gen rows to existing `meta_records.id` by `keyOf(row) = join(data[fieldId] for fieldId in key_field_ids)` — a **raw, un-normalized** field join (`spike2-mirror-migration.draft.sql:32-34`, ADR §5 Q1).
- Spike 3 exists precisely because raw external business keys drift in case/whitespace/zero-padding and must be canonicalized before two strings are treated as "the same key" (`spike3-registry-adr.md` Context §1).

For a mirror **fed from an external system**, these two notions of identity can disagree: spike 2 would mint a new `meta_records.id` for `"0007"` vs `"PN-7B"` while spike 3's registry considers them one canonical key. That produces a duplicate mirror row for a key the registry treats as singular — silently defeating both invariants at once.

**Consistency verdict**: the generation *tables* correctly do not reference each other, but **an externally-fed mirror's `keyOf` MUST resolve through the spike-3 registry's active generation** (`integration_external_key_bindings.active_registry_generation_id`) rather than raw-joining fields. Internally-sourced mirrors (rollups of another base) can keep the raw `key_field_ids`. This is a P0-D decision, listed below.

### 1.3 Does the plan bind BOTH content-key and both generations? — **NO on all three counts.**

`mirror_publish_plan` binds **only** `generation_id` → `mirror_generation(id)` (`spike2-mirror-migration.draft.sql:155`), with the single assertion `generation_id != stagingId` (acceptance #9, ADR §2). It does **not** bind:

1. **A content-key / digest of the sealed snapshot.** Nothing detects that the sealed `mirror_generation_row` set changed between `propose` and `apply`. Spike 3 already establishes the in-repo precedent for this — content-key = `sha256(stable-stringify(...))` (`spike3-registry-adr.md` "What was read", 062 row). Recommend adding `mirror_publish_plan.content_key` bound at propose and re-checked at apply, so approve→apply fails closed if the snapshot mutated.
2. **The registry generation** used to compute the mirror keys (for externally-fed mirrors — see 1.2). A fully-safe plan for such a mirror should pin `registry_generation_id` so a mid-flight normalization switch (spike 3 upgrade flow step 5) invalidates the plan instead of publishing rows keyed under a now-`frozen` normalization.
3. **The publishing principal** (see 1.1) — `proposed_by`/`approved_by` should be principal ids, not text.

Spike 3's own "plan" (a pipeline run / dead-letter replay) binds `registry_generation_id` and is correctly designed to go stale on switch (`spike3-registry-adr.md` upgrade flow step 6), but it likewise binds **neither** the mirror generation **nor** a principal.

**Verdict**: today each plan binds exactly one generation and no content digest and no principal. The synthesis recommendation is to make a publish plan for an **externally-fed** mirror bind the tuple `(mirror_generation_id, registry_generation_id, content_key, publishing_principal_id)`; a plain internal mirror binds `(mirror_generation_id, content_key, publishing_principal_id)`.

---

## 2. Per-spike Ratify readiness

Legend: **Ratify-ready (decision)** = the schema/constraint *decision* can be put to owner now; the remaining work is build-time verification, not a decision blocker. **DB-run-gated** = the decision itself, or an unresolved correctness question inside it, cannot be settled without a real Postgres run.

### Spike 1 — Principal lifecycle — **Ratify-ready (decision). No scale run needed.**

The guarantees are pure DDL semantics that Postgres enforces deterministically: cross-tenant rejection is a composite FK `(principal_id, tenant_id) → service_principals(id, tenant_id)` (`spike1-principal-migration.draft.sql:88-91`); immutability is a `BEFORE UPDATE` trigger (`:110-128`); revoke is `revoked_at` soft-state (`:75`). None of this depends on data volume or novel concurrency. The unit tests exercise the pure authz logic; the DB *mechanisms* are standard.

- **Missing evidence (build-gate, not decision-gate)**: a real-DB test proving the FK actually rejects a cross-tenant grant (`23503`), the trigger actually raises on rebind, and a soft-revoked principal is denied on a *new* write while `meta_record_revisions.actor_id` still resolves to the never-deleted row. These verify the migration, not the decision.
- **Open questions that are genuinely deferrable** (do not block Ratify): `tenant_id` source-of-truth reconciliation (ADR Q1), `actor_id` resolution view (Q2), human-user unification (Q3). The migration deliberately treats `tenant_id` as opaque `NOT NULL text`, which is a safe placeholder.

### Spike 2 — Mirror publication — **DB-run-gated. Ratify the DIRECTION; final A-vs-B choice needs the benchmark.**

The *diff-not-delete-rebuild* core is proven from schema and is not in doubt: `meta_records.id` is random `gen_random_uuid()` (`spike2-mirror-adr.md` §1, citing `repair_meta_core_schema.ts:20-29`) so ids can only be *preserved by keyed diff*, and inbound `meta_links.foreign_record_id` is `text NOT NULL` with **no FK** (`:36`) so delete+rebuild silently dangles. That reasoning is solid and Ratify-able.

What is **not** proven is the specific claim the decision rests on — that Option A's O(changed-rows) publish + single-txn write lock is "acceptable at v1 scale" and that MVCC gives atomic visibility with reader-p99 impact under threshold. The ADR itself scopes this to acceptance #7 and states "Promote to Option B if O(1) publish becomes required." So the decision *A over B* is conditional on numbers that do not yet exist.

- **Missing evidence (decision-gate)**: the benchmark plan in the ADR — publish wall-time across generation size (1e3–1e6) × churn (0–100%) × link fan-in; reader p99 during publish; lock-hold duration; WAL bytes; autovacuum backlog. Plus a real-DB atomic-visibility probe (concurrent reader never observes a partial generation) and an id-stability probe (unchanged keys keep their `meta_records.id`).
- **Recommendation**: Ratify "Option A is the v1 direction, Option B is the documented fallback," and gate the *final* commit on the benchmark clearing the proposed thresholds (publish < 2s / 1e4 changed rows; reader p99 Δ < 20ms).

### Spike 3 — External key registry — **Ratify-ready (schema decision), but DB-run-gated on one correctness question.**

The three-table shape, generation-scoped uniqueness, and composite `(registry_generation_id, normalized_key_hash, canonical_key)` index are Ratify-able: each rests on a mechanism this repo already uses — the "one ACTIVE per scope" partial-unique-index pattern is lifted directly from `073` (`spike3-registry-adr.md` "What was read"), and `ON CONFLICT` against a partial-unique index is the standard race-authority (Alternative C).

Two caveats keep it out of "clean Ratify":

1. **Open Q2 (rebuild against a moving target) is an unresolved correctness question**, not a deferrable nicety. `detectCollapse()` "assumes a static snapshot input and does not itself address concurrent writes during rebuild" (`spike3-registry-adr.md` open Q2). Whether a snapshot read suffices or a true write-freeze window is required cannot be answered without a real-DB concurrency run.
2. **The vitest was never executed in its intended runner** — the spike verified the algorithm via a standalone node script because "vitest itself can't run across the package-root boundary from this repo-relative test location" (spike-3 summary). The `.test.ts` is logically verified but not runner-verified.

- **Missing evidence (build/decision-gate)**: real-DB tests of (a) the single-txn generation switch under a concurrent reader (never two `active` generations for one binding), (b) `INSERT … ON CONFLICT` as the actual double-bind guard under two concurrent pipeline upserts of the same canonical (one wins, other gets `23505`), (c) `detectCollapse` behavior when writes land on the old generation during rebuild (settles Q2).

---

## 3. The single ordered P0-D decision list (for owner / tech-lead)

Ordered by dependency: identity foundation first, then the two consumers, then the cross-spike wiring that binds them.

| # | Decision | Recommended value | Source / risk |
|---|---|---|---|
| 1 | First-class non-human identity model | **Adopt unified `service_principals` (reverse-FK, `kind` discriminator)** over per-object subtype tables | spike1 §2.1 — low risk |
| 2 | Tenant-safety mechanism | **DB-enforced composite FK `(principal_id, tenant_id)`** (not app-checked) | spike1 §2.2 — low risk |
| 3 | `tenant_id` source of truth | **Treat as opaque `NOT NULL text` for P0; reconcile to a canonical tenant (vs `workspace_id` / shard `tenantId`) as a named P1 pre-req** | spike1 open Q1 — defer, don't block |
| 4 | Revocation & audit model | **Soft `revoked_at`, no physical delete, no id reuse; `meta_record_revisions.actor_id` stays FK-less free text (resolvable by lookup)** | spike1 §2.4 — low risk |
| 5 | Rebinding | **Forbidden / immutable `principal_id` via trigger; revoke+recreate** | spike1 §2.3 — low risk |
| 6 | Mirror publish strategy | **Option A (staging → keyed upsert-diff into live sheet) as v1 direction; Option B (dual-sheet flip) documented fallback** — final commit gated on §4 benchmark | spike2 §2 — direction low risk, magnitude unproven |
| 7 | Mirror inactivation | **Soft-inactivate default; trash-backed `deleteRecord` on retention, never raw DELETE** | spike2 §2, open Q2 |
| 8 | Mirror publish plan binding | **Bind sealed `mirror_generation_id` (never staging) AND add a `content_key` digest re-checked at apply** (new) | spike2 acceptance #9 + §1.3 gap here |
| 9 | External key registry shape | **Adopt 3-table design; active-uniqueness scoped to `registry_generation_id`, not `binding_id`** | spike3 Decision — low risk |
| 10 | Hash-collision safety | **Composite `(registry_generation_id, normalized_key_hash, canonical_key)`, never hash-alone; `ON CONFLICT` is the authoritative race guard, `classifyUpsert` is pre-flight only** | spike3 Decision + Alt B/C — low risk |
| 11 | Renumber / alias policy | **v1 manual-only via `superseded_by_id` breadcrumb; full alias/history deferred to P1** | spike3 Alias decision |
| 12 | **CROSS-SPIKE wiring (synthesis)** | **The mirror publisher and every integration pipeline writer are `service_principals` holding `writer_grants (target_kind='sheet'/'data_source')`; bare `proposed_by`/`created_by`/`actorId` strings are replaced by principal ids** | §1.1 — the key synthesis decision |
| 13 | **CROSS-SPIKE keying (synthesis)** | **An externally-fed mirror's `keyOf` resolves through the spike-3 registry's active generation, not a raw `key_field_ids` join; a plain internal rollup mirror keeps the raw join. Its publish plan binds `registry_generation_id` too** | §1.2 / §1.3 — prevents duplicate mirror rows for one canonical key |

Decisions 1–5, 9–11 are **Ratify-now**. Decision 6 Ratifies the direction and defers the magnitude to §4. Decisions 8, 12, 13 are net-new synthesis obligations surfaced by this roll-up and should be Ratified as P1 build contracts.

---

## 4. What MUST be a real-DB integration test before P1 (not unit-provable)

These assert behavior of the Postgres engine / MVCC / triggers / partial-unique indexes / concurrency — none provable by the existing no-DB unit suites.

**Spike 1 (constraint behavior):**
1. Composite FK **rejects** a cross-tenant `writer_grants` INSERT (`23503`) — `spike1-principal-migration.draft.sql:88-91`.
2. `BEFORE UPDATE` trigger **raises** on `principal_id` or `tenant_id` change (`:110-128`).
3. Soft-revoke: a `revoked_at`-stamped principal is **denied on a new write path**, while `meta_record_revisions.actor_id` still **resolves** to the never-deleted principal row (the audit-survives-revocation invariant, §2.4).

**Spike 2 (MVCC, scale — these gate the A-vs-B decision):**
4. **Atomic visibility**: a concurrent `query-service` reader over `meta_records` never observes a partial generation during the publish upsert txn (MVCC snapshot holds until COMMIT).
5. **Id stability**: unchanged-key rows keep the identical `meta_records.id` across publish, and an inbound `meta_links.foreign_record_id` string still resolves post-publish.
6. **Scale benchmark (acceptance #7)** — the go/no-go for Option A: publish wall-time vs (size × churn × link fan-in), reader p99 during publish, lock-hold, WAL/vacuum, against the ADR thresholds.
7. **Rollback / recovery**: publish txn ABORT leaves `active_generation_id` untouched; a restarted worker resumes a `proposed`/`approved` plan idempotently and abandons a mid-`refreshing` staging batch.

**Spike 3 (concurrency, `ON CONFLICT`, the moving-target question):**
8. **Atomic generation switch** under a concurrent reader: the single-txn pointer flip + `uniq_…_active WHERE status='active'` make two simultaneously-`active` generations for one binding impossible; a reader never sees two.
9. **`INSERT … ON CONFLICT`** against the partial-unique index is the real double-bind guard: two concurrent pipeline runs upserting the same canonical → one wins, the other gets `23505`, no double-bind (backs Alternative C).
10. **Rebuild-against-moving-target (settles open Q2)**: run `detectCollapse` while writes land on the old generation; prove a snapshot read either suffices or that a write-freeze window is required — the one unresolved correctness question in the spike.
11. **Runner fix (prerequisite)**: get `spike3-registry.test.ts` actually executing under vitest (currently only node-verified across the package-root boundary), so the collision/classify logic is runner-verified before it becomes real code.

**Cross-spike (the synthesis contracts from §3.12–3.13):**
12. **Authorized publish end-to-end**: a mirror publish performed by a `service_principals` row is rejected when its `writer_grants` on the target sheet is revoked, and every published `meta_records` row carries `actor_id = <principal id>` resolving through spike 1.
13. **Registry-keyed mirror**: an externally-fed mirror whose two raw inputs canonicalize to one key (e.g. `"0007"` / `"PN-7B"`) produces exactly **one** mirror row (no duplicate id) because `keyOf` resolved through the registry's active generation.

---

## 5. One-line recommendation

Ratify decisions **1–5, 9–11 now**; Ratify **6 as a direction** and **8, 12, 13 as P1 build contracts**; do not green-light building spike 2 (final A-vs-B) or spike 3 (rebuild concurrency) until tests **4–10** run on a real Postgres. The single highest-leverage synthesis action is **decision 12** — route every mirror/pipeline write through `service_principals` + `writer_grants` so spikes 2 and 3 stop reintroducing the bare-string actor that spike 1 exists to abolish.
