# ADR — Spike 2: Mirror Publication (atomic visibility × stable record id)

- Status: DRAFT / design spike (not production wiring)
- Baseline: frozen @ main `c5a4a94f7`
- Scope: design only. No application code modified. Migration SQL is a DRAFT, not run, and lives under this spike dir, not the real migrations dir.
- Charter §三 acceptance: all 10 criteria addressed in the "Acceptance mapping" section.

---

## 1. Context

A *mirror* is a system-owned sheet whose rows are a projection of some upstream source
(another base, an external system, a computed rollup). Publishing a new **generation** of the
mirror must be **atomic for readers**: any reader sees either the complete old generation or the
complete new generation, never a half-applied batch. Simultaneously, **record ids must stay
stable** for rows that survive across generations.

### Why record-id stability is the hard constraint

`meta_records` uses a random surrogate PK:

```
CREATE TABLE meta_records (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,   -- random, NOT derived from business key
  sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  ...
)
```
(`packages/core-backend/src/db/migrations/zzzz20260404153000_repair_meta_core_schema.ts:20-29`)

Contrast this with sheets/fields, which have **deterministic** ids:
`stableMetaId = sha1(parts).slice(0,24)` → `getObjectSheetId(projectId,objectId)`
(`packages/core-backend/src/multitable/provisioning.ts:130-147`). Records have no such derivation —
their id is random and can only be *preserved*, never *recomputed*. So "stable id across
generations" is only achievable by **matching** a next-generation row to the prior row on a
business key and **reusing** the existing `meta_records.id`.

### Every consumer that keys on `meta_records.id`

A naive publish = `DELETE FROM meta_records WHERE sheet_id=$1` + re-`INSERT` mints **new random
ids** and breaks all of these:

| Consumer | Keys on | Read path (cited) | Breakage if id changes |
|---|---|---|---|
| Inbound links (other sheets pointing *at* mirror rows) | `meta_links.foreign_record_id` — **`text NOT NULL`, no FK** | schema `...zzzz20260404153000...ts:36`; store/read `multitable/records.ts:389,408` | **Silent dangling reference.** No cascade fires (no FK), old string now points to nothing. |
| Outbound links (mirror row → other sheet) | `meta_links.record_id` — FK `ON DELETE CASCADE` | schema `...ts:35`; `records.ts:781,903` | Rows cascade-deleted on the DELETE; must be rebuilt. |
| Cross-table LOOKUP | matches **data value**, not id: `WHERE sheet_id=$1 AND data->>$2=$3` | `multitable/formula-engine.ts:233` | Survives id churn *iff* the keyed data column is preserved — but see rollup/formula below. |
| Formula recalc for a record | `WHERE id=$1 AND sheet_id=$2` | `formula-engine.ts:264` | Recalc target lost; stale/incorrect derived values. |
| Records list / view / API | `FROM meta_records ... sheet_id` | `multitable/query-service.ts:306,377` | Reader observes empty set mid-DELETE (visibility hole). |
| Automation triggers / dedup | record id + applied-marker tables | `multitable/automation-service.ts:2715,2847`; `automation-action-applied` migration | Every rebuilt row looks "new" → duplicate/half-batch events. |
| Recycle bin / restore | `meta_records_trash.record_id` | `zzzz20260617120000_create_meta_records_trash.ts`; `record-service.ts:937-957` | Hard-delete floods trash with churn; restore keyed to dead ids. |
| History / revisions / registry | `record_id` (no FK, by design) | `records.ts:545` comment; approval projection service | Revision lineage forks on every publish. |

The hard-delete semantics reinforce this: record delete is a **hard** `DELETE FROM meta_records`
that copies to `meta_records_trash` in the same txn (`record-service.ts:957`, trash migration
header `:5-10`). A delete+rebuild publish would push a full generation through the recycle bin on
every cycle — semantically wrong and unbounded growth.

**Conclusion:** the publish algorithm must be a keyed **diff** (create / update-in-place preserving
id / inactivate), never delete+rebuild. That is the shared core of options A and B; option C avoids
churn differently (a generation column) at the cost of touching every read path.

---

## 2. Decision

**Adopt Option A — internal staging store, publish (upsert-diff) into the existing mirror sheet.**

The user-facing mirror sheet (`meta_sheets` row at the deterministic `getObjectSheetId`) is *always
the current generation*. A separate, non-user-visible **staging** table accumulates the candidate
next generation; a **publish** transaction computes `diffGenerations(prev, next, keyOf)` and applies
it to `meta_records` as a single atomic upsert batch:

- **creates** → `INSERT` new rows (new uuid — these are genuinely new business keys).
- **updates** → `UPDATE meta_records SET data=..., version=version+1 WHERE id=$existingId`
  (**id preserved** — matched by business key). Only rows whose data actually changed.
- **inactivates** → business keys absent from the next generation. v1 default: **soft**
  (`UPDATE ... SET data = data || '{"__mirror_inactive":true}'`) so inbound `foreign_record_id`
  references never dangle; a retention job later hard-deletes via the normal
  `record-service.deleteRecord` path (trash-backed) once no live reference remains.

The whole diff-apply runs in **one transaction**, so `query-service` readers (`FROM meta_records`)
see the complete old snapshot until COMMIT, then the complete new one — atomic visibility with no
new column and no read-path change. A `mirror_binding.active_generation_id` column records *which
sealed generation is live*, for observability, recovery, and retention — **the plan binds the
published generation id, not the staging id** (acceptance #9).

### Why A over B and C

| | **A — staging → upsert into live sheet** (chosen) | **B — dual physical sheet + active-sheet switch** | **C — generation column in same table** |
|---|---|---|---|
| Record-id stability | Preserved by keyed diff; ids never move | Preserved *only if* rows copied by key into the standby sheet — but `sheet_id` differs per physical sheet, so id must be carried explicitly and standby ids must be reserved | Trivially preserved — row is never rewritten, only its `generation_id` visibility bit |
| Atomic visibility | One upsert txn; COMMIT is the switch | Flip one `binding.active_sheet_id` pointer — cleanest atomicity | Flip `active_generation_id`, but **every reader must filter `generation_id`** |
| Read paths touched | **Zero** — sheet id unchanged, ids unchanged | Indirection layer: everything resolving a sheet id must go through the binding pointer (records API, view, formula `sheetId` args, link `foreignSheetId`, export, SDK, OAPI) | **Every** read path must inject `AND generation_id = $active`: records API, view, `formula-engine.ts:233/264`, link/lookup, aggregation, `automation-service`, export, SDK, OAPI |
| Inbound `foreign_record_id` (no FK) | Safe — id stable, soft-inactivate keeps string resolvable | Safe only if standby reuses the same id under a different `sheet_id`; link store also encodes `foreignSheetId` (`field-codecs.ts:295-319`) which would flip | Safe — id and sheet_id both stable |
| LOOKUP by data value (`formula-engine.ts:233`) | Correct — one live row per key | Correct after flip | **Wrong unless filtered** — `LIMIT 1` could return an inactive-generation row |
| Storage | 1× live + transient staging | 2× steady-state (both physical sheets resident) | N× (all retained generations coexist in one table; bloats every `sheet_id` scan) |
| Rollback on failure | Txn ABORT — nothing published | Don't flip pointer; standby discarded | Delete staged generation rows; risk if partially read |
| Retention/cleanup | Normal trash-backed delete of inactivated rows | Drop standby sheet | Delete old-generation rows (large DELETE, vacuum pressure on hot table) |
| Blast radius | Lowest — localized to publish txn | Medium — new binding indirection is load-bearing for all reads | Highest — a single missed read path leaks cross-generation rows (correctness + privacy) |

**C is rejected for v1** exactly because it requires a `generation_id` filter injected into *every*
read path — records API, view, formula (`formula-engine.ts:233,264`), link/lookup, aggregation,
automation (`automation-service.ts`), export, SDK, OAPI. A single missed path silently leaks an old
or half-built generation to a reader. That is a correctness-and-isolation footgun disproportionate
to v1.

**B is rejected as heavier than needed:** it moves the atomicity to a clean single-pointer flip, but
the `sheet_id` of a row changes between physical sheets, so (i) `meta_links.foreignSheetId`
(`field-codecs.ts:295-319`) and every `sheetId`-taking read path must resolve through the binding
indirection, and (ii) steady-state storage doubles. B stays as the documented fallback if a future
requirement needs O(1) publish independent of generation size (see §5).

**A wins** because it changes **zero read paths** (same sheet id, same record ids), gets atomic
visibility for free from a single upsert transaction, and keeps the invariant "the user table is
always the current generation." Its cost — publish is O(changed rows) and holds a write lock for the
txn — is acceptable at v1 scale and is exactly what the benchmark plan (acceptance #7) sizes.

---

## 3. Alternatives considered (trade-offs)

Covered in the decision matrix above. Summary of the trade the choice accepts:

- **A accepts** a per-publish write transaction proportional to the number of changed rows, and a
  brief row-level write lock on touched rows. It does **not** block readers (MVCC: readers see the
  pre-COMMIT snapshot).
- **A rejects** the O(1)-flip atomicity of B and the zero-rewrite property of C, judging neither
  worth their blast radius at v1.

## 4. Consequences

Positive:
- No migration to any read path; mirror rows are indistinguishable from ordinary rows to every
  consumer (links, lookup, formula, view, automation, export, SDK, OAPI).
- Record ids are stable by construction; inbound `foreign_record_id` strings (no-FK) never dangle.
- Rollback is a transaction abort; restart recovery is driven by `mirror_binding.publish_status` +
  the sealed generation snapshot.

Negative / obligations:
- Publish cost grows with changed-row count; large first-generation loads are effectively bulk
  inserts (size with the benchmark plan).
- Requires a **mutex** so refresh/publish/propose/apply for one binding never interleave
  (acceptance #10) — modeled as `mirror_binding.lock_token` + advisory lock in the draft SQL.
- Inactivated rows accumulate until the retention job runs; retention must go through the
  trash-backed delete path, not raw `DELETE`, to preserve recycle-bin/restore semantics.

## 5. Open questions

1. **keyOf source of truth.** Which field(s) form the business key per mirror? Proposal: a
   `mirror_binding.key_field_ids text[]` config; `keyOf(row)=join(data[fieldId] for id in
   key_field_ids)`. Must be validated non-null/unique at refresh time.
2. **Inactivation policy.** Soft-inactivate (default, safe for inbound links) vs. hard-delete via
   trash. When is it safe to hard-delete an inactivated row — only when no `meta_links.foreign_record_id`
   references it? Needs a reference-count probe.
3. **LOOKUP + inactive rows.** `formula-engine.ts:233` does `LIMIT 1` with no active filter. If a
   soft-inactivated row shares a key with a live row, ordering matters. Proposal: exclude
   `data->>'__mirror_inactive'` in the mirror's own lookups, or guarantee one-live-row-per-key.
4. **Concurrency granularity.** Per-binding mutex is assumed sufficient; confirm no cross-binding
   publish ordering constraints (e.g. mirror-of-a-mirror).
5. **version semantics.** `meta_records.version` is used for optimistic concurrency
   (`VersionConflictError`, `record-service.ts:132`). Publish bumps version on update — confirm this
   does not race user edits to a mirror row (mirrors should be read-only to users; enforce?).
6. **Generation retention depth.** How many sealed generations to keep for audit/rollback before the
   staging/generation tables are pruned (acceptance #8).

---

## Acceptance mapping (Charter §三, all 10)

1. **Only complete old OR new** — single upsert transaction; readers on `FROM meta_records`
   (`query-service.ts:306,377`) see the pre-COMMIT MVCC snapshot until COMMIT. §2.
2. **Unchanged record id stable** — `diffGenerations` matches on `keyOf` and reuses the existing
   `meta_records.id` for updates; only genuinely-new keys mint a uuid. Prototype `diffGenerations`.
3. **Link/lookup/formula/view unbroken** — id + sheet_id unchanged ⇒ zero read-path change;
   inbound no-FK `foreign_record_id` strings stay resolvable (§1 table).
4. **Automation no dup/half-batch** — publish emits one post-commit event per changed row keyed by
   the stable id; unchanged rows emit nothing (diff `unchanged` bucket). No delete+rebuild churn.
5. **Publish failure rollback** — publish runs in one txn; failure ⇒ ABORT ⇒ nothing visible;
   state machine `fail` → `failed`. Prototype `publishReducer`.
6. **Restart recovery** — `mirror_binding.publish_status` + sealed generation snapshot let a
   restarted worker resume/abort a `proposed`/`approved` plan idempotently. Draft SQL + state machine
   `resume`.
7. **Scale benchmark plan** — see benchmark section below.
8. **Old-gen retention + cleanup** — `mirror_generation` rows retained N deep; inactivated records
   cleaned via trash-backed delete. Draft SQL `mirror_generation`, open Q6.
9. **Plan binds published gen not staging** — `propose` records `generation_id` of the *sealed*
   generation, asserted `!== stagingId`. Prototype `propose` guard + test.
10. **Concurrency mutex** — per-binding `lock_token` / pg advisory lock guards
    refresh/publish/propose/apply. Prototype `acquireLock` + draft SQL.

### Benchmark plan (acceptance #7)

- **Dimensions:** generation size (1e3 / 1e4 / 1e5 / 1e6 rows), churn ratio (0% / 1% / 10% / 100%
  changed), inbound link fan-in (0 / 10 / 100 links per row).
- **Metrics:** publish txn wall-time, lock-hold duration, WAL bytes, reader p99 during publish
  (concurrent `query-service` list), post-publish autovacuum backlog.
- **Method:** seed a mirror sheet, snapshot as gen N, mutate `churn%` rows, run publish; assert (a)
  reader never observes a partial set, (b) unchanged-row ids identical pre/post (id-stability probe),
  (c) publish time scales ~O(changed rows), not O(total rows).
- **Thresholds (proposed):** publish < 2 s for 1e4 changed rows; reader p99 delta < 20 ms during
  publish; zero id drift on unchanged rows. Promote to Option B if O(1) publish becomes required
  above ~1e6-row generations.
