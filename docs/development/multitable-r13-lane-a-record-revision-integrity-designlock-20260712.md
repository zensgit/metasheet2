# Multitable R13 Lane A — record revision integrity(所有用户数据写入口 → revision 完备)+ double-layer mutation-site revision-policy guard — DESIGN LOCK (**PROPOSED**)

- **Status**: **PROPOSED — 2026-07-12. NOT ratified.** Docs only: this document changes no code, ships no flag, adds no migration, and authorizes no implementation. The owner GO'd the R13 Lane A *direction* with **three hard constraints** (umbrella framing, three-count denominator, double-layer guard — all incorporated below and marked 【owner-directed】); the remaining decisions in **§5** still await explicit owner ratification, and this document rules none of them itself.
- **Position in the R12/R13/R14 restructure**: the Global History / Time Machine line is re-scoped as **R12 = engineering close-out**, **R13 = Feishu-gap closure in three parallel lanes (A/B/C)**, **R14 = product route decision (owner-gated)**. This document is **R13 Lane A only**: *not every write to `meta_records` produces a `meta_record_revisions` row* — the correctness gap beneath every Feishu-benchmark history feature. Lane B (T-state page / deleted-after-T preview) and Lane C (retention+Reset coexistence / >5000-row async) are **separate tracks** (§7).

## Relationship to #4187 【owner-directed — Constraint 1】

**R13 Lane A is an UMBRELLA, not a rival lock. There are not two competing design locks:**

- **#4187 (D-1c) = the specific defect + its evidence = the FIRST PROVEN INSTANCE** — form-submit EDIT, reproduced end-to-end on real Postgres through real routes, with executed data loss.
- **R13-A (this document) = the class-wide unified revision POLICY for ALL write entries** — the enumeration of every entry, the disposition of each, and the guard that keeps the enumeration true.
- **On conflict, R13-A's ratified policy wins; runtime may land site-by-site (刀-by-刀).**

#4187 is subsumed as one instance under this umbrella: its defect analysis, blast radius, and per-site evidence grades are **incorporated by reference, not re-litigated**; its open decisions (OD-1/OD-2/OD-3) are absorbed into §5 so the owner rules **once**, at the policy level, and the instance inherits the ruling.

- **Provenance**: every `file:line` below was **re-verified by read this session against `origin/main` @ `e15bf8e2c`** (D-1c's audit was @ `087ffa47a`; the mutation surface is line-for-line unchanged between the two). Empirical (executed) evidence grades are **inherited from D-1c §3** and labelled as such — this document adds **no new runtime execution** (it is docs-only) and does not upgrade any source-verified claim to "measured".
- **One-sentence thesis**: the final acceptance criterion —「**所有用户数据写入口都产生正确 revision**」— is a **universal** claim, and a universal claim can only be *proven* by **exhaustive enumeration or a chokepoint**, never by spot-checks; spot-checks can only refute it. §2 is the enumeration; §3 is the guard that keeps the enumeration true tomorrow; §3's convergence target is the chokepoint that eventually makes the enumeration unnecessary for new code.

---

## §0 Why Lane A is the load-bearing lane

`reconstructRecordsAtT` (`packages/core-backend/src/multitable/record-reconstructor.ts:34-70`) derives record existence **and data** purely from `meta_record_revisions` — it never reads `meta_records`. Everything R13/R14 wants to build (PIT view, revert/reset, record history, version restore, and any future base-wide restore) sits on that primitive. A write that skips the revision is therefore not "missing an audit row" — it makes history **lie**, and D-1c executed the worst consequence: a sheet revert at a T *after* such a write **destroys the member's data irrecoverably** (#4187 §3). Lane B and Lane C both *consume* revisions; Lane A is what makes the substrate trustworthy. That is why the guard, not any single fix, is Lane A's real deliverable.

**The infra already exists — the gap is routing, not schema.** Verified this session:

- `meta_record_revisions` is live on main with `batch_id` (LOCK-12 batching) and `restored_from_version` (R11 back-reference) — `record-history-service.ts:86-121` (`recordRecordRevision`, the **single emitter**; 13 call sites, enumerated below).
- Tombstone infra (`meta_records_trash`, `meta_field_value_tombstones`, inbound-link tombstones) is live (D-2, 4c-2/4c-3).
- `RecordRevisionSource` (`record-history-service.ts:10`) is an open union already declaring `'public-form'` and `'plugin'` — `'public-form'` is still a **dead slot** (nothing emits it).

So Lane A adds **zero tables and zero migrations**. It routes the writers that bypass the emitter, and then guards the routing.

---

## §1 The verified mutation surface — three counts, one denominator 【owner-directed — Constraint 2】

**File count is NOT the metric.** A single file hosts several mutation paths; a single raw statement can serve several business paths; and migration statements are not business paths at all. The three counts, kept separate:

| Count | Value @ `e15bf8e2c` | What it is | Role |
|---|---|---|---|
| **Files containing raw `meta_records` writes** | **9 runtime source files + 2 migration files** | where the statements live | locating metric only — never the denominator |
| **Raw SQL mutation statements** | **36 in runtime `src`** (+2 in one-shot migrations) | every literal `UPDATE / INSERT INTO / DELETE FROM meta_records` (word-bounded, so `meta_records_trash` / `meta_record_revisions` are excluded; comments excluded) | the **structural guard's** inventory unit (§3 layer 1) |
| **Reachable business mutation paths** | **31** (8 A + 12 B + 9 C + 2 D, §2) | distinct business operations that mutate record rows | **THE FINAL DENOMINATOR** —「所有用户数据写入口」is measured against *this*, and the **behavioral guard** (§3 layer 2) pins each path |

Counting rules for paths (stated so the number is reproducible, not vibes): one business operation = one path even when it compiles to several statements (flag-on/flag-off variants, insert/update legs, unset/set templates); conversely one statement hosting several distinct business operations = several paths. Both directions occur:

- **statements > paths**: plugin `deleteRecord` is 2 statements (`records.ts:684` flag-on / `:755` flag-off) but **one** path; bulk PATCH is 2 statement templates (`record-write-service.ts:971/:979`) in one loop; PIT-reset-revert is 2 templates (`univer-meta.ts:10395/:10403`); People-sync, route lock/unlock, and automation lock each pair 2 statements to one operation.
- **paths > statements**: the **one** bulk-PATCH statement family serves **two** business paths — grid/API bulk patch AND the record-version restore family (the three restore routes funnel through `patchRecords` with `restoredFromVersion`); the **one** `applyResultWritebackPatch` statement (`automation-service.ts:2818`) serves both the same-base and cross-base writeback callers (counted as one path, two entries, because the mutation and its policy are the single shared helper).
- **statements that are no path at all**: the 2 migration statements (`db/migrations/zzzz20260430163000…`, `zzzz20260516113000…`) are one-shot repairs with no user actor — registered `migration-only`, outside the denominator. **No dead/unreachable statement was found among the 36 runtime statements** (each sits in a live route/service/executor); if one is ever found, its registry disposition is `explicitly-non-revisioning: dead — <evidence>`, never silence. (`side-door-delete-trash.ts` writes only `meta_records_trash` and is out of scope by the word boundary.)

A path "writes a revision" **iff its enclosing function calls `recordRecordRevision(...)`** for that write. Indirect emission was ruled out by D-1c §7a (the only `multitable.record.*` event subscribers are `webhook-event-bridge.ts` and `automation-triggers.ts`; neither writes revisions) — re-confirmed by this session's call-site grep: the 13 emitter call sites are exactly `automation-executor.ts:2365`, `record-service.ts:706/845/1125/1392`, `record-write-service.ts:998`, `records.ts:650/771`, `univer-meta.ts:6454/10178/10416/10498`, plus the definition at `record-history-service.ts:86`.

---

## §2 Per-path classification — **the core of this document**

Legend — **拟定 disposition** is what this lock *proposes* the guard registry will say; every disposition is subject to owner ratification. "Bumps version" matters because the codebase already treats the version bump as the marker of an authoritative user write (`formula-engine.ts:340-342`: *"No version bump: formula values are derived, not an authoritative user edit."*).

### Bucket A — user-data mutation path, **NO revision today** → 拟定 `revisioned`(8 paths / 8 statements; the gap)

| # | Path | Site (`packages/core-backend/src/…`) | Verb | Bumps version | Writes revision today | Evidence grade |
|---|---|---|---|---|---|---|
| A1 | **form-submit EDIT** (authenticated member via form-view edit link; anonymous barred at `:14199-14204`) | `routes/univer-meta.ts:14423` | UPDATE | yes | **NO** | **executed** (D-1c §3: PIT lie + destructive revert + audit hole, all through real routes) |
| A2 | **plugin-SDK `patchRecord`** | `multitable/records.ts:507` | UPDATE | yes | **NO** | **executed** (D-1c §3 sibling spot-check: PIT lie reproduced) |
| A3 | **automation `update_record`** action (shipped, unflagged) | `multitable/automation-executor.ts:2217` | UPDATE | yes | **NO** (file's only emitter `:2365` is inside `executeDeleteRecord`) | source-verified |
| A4 | **automation `create_record`** action | `multitable/automation-executor.ts:2475` | INSERT | v1 | **NO** | source-verified |
| A5 | **plugin-SDK `createRecord`** | `multitable/records.ts:546` | INSERT | v1 | **NO** | source-verified |
| A6 | **form-submit CREATE** — same handler as A1; reachable **anonymously** via public form (`created_by` explicitly NULL for anonymous at `:14477`); D-1 §6's deferred "D-1b" | `routes/univer-meta.ts:14470` | INSERT | v1 | **NO** | source-verified |
| A7 | **approval `resultWriteback`** patch (`applyResultWritebackPatch`; same-base + cross-base callers share this one helper) | `multitable/automation-service.ts:2818` | UPDATE | yes | **NO** (file contains zero `recordRecordRevision` references) | source-verified |
| A8 | **attachment-delete** — strips the attachment id out of the record's cell; a real user-data edit inside an existing `pool.transaction` (`:15675`) | `routes/univer-meta.ts:15693` | UPDATE | yes | **NO** | source-verified |

> The delete-history asymmetry D-1c called out stands re-verified: D-1 gave the automation and plugin lanes **delete** revisions (`automation-executor.ts:2365`, `records.ts:650/771`) but never `create`/`update` — so an automation- or plugin-born record has a **delete revision with no birth**. A2/A3/A4/A5 close that.

### Bucket B — user-data mutation path, **revision already emitted** → 拟定 `revisioned`(12 paths / 14 statements)

| Path | Statement(s) | Revision at |
|---|---|---|
| REST single create | `multitable/record-service.ts:679` | `:706` (`create`/`rest`) |
| REST single delete (trash rows `:873/:881` are `meta_records_trash`, not this table) | `record-service.ts:892` | `:845` (`delete`/`rest`, pre-generated anchor id) |
| trash restore (re-INSERT) | `record-service.ts:1087` | `:1125` (`create`/`rest`) |
| REST single patch | `record-service.ts:1385` | `:1392` (`update`/`rest`) |
| bulk PATCH (grid/API) | `record-write-service.ts:971` + `:979` (unset+set / set-only templates, one loop) | `:998` (`update`, shared `batchId`) |
| record-version restore family (3 restore routes → `patchRecords`, `restoredFromVersion` set) | same statements as bulk PATCH | `:998` — **the miniature proof that the chokepoint model works**: a second business path through an already-revisioned funnel inherited the revision for free |
| plugin-SDK `deleteRecord` (D-2 flag-on / flag-off variants) | `records.ts:684`, `:755` | `:650`, `:771` (`delete`/`plugin`) |
| automation `delete_record` | `automation-executor.ts:2410` | `:2365` (`delete`/`automation`) |
| 4c-1 lossy-retype revert (sheet-wide cell rewrite) | `routes/univer-meta.ts:6429` | `:6454` (one revision per changed cell, shared batch) |
| PIT resurrect (re-INSERT) | `univer-meta.ts:10168` | `:10178` (`create`/`restore`) |
| PIT reset revert | `univer-meta.ts:10395` + `:10403` (two templates) | `:10416` |
| PIT reset delete | `univer-meta.ts:10528` | `:10498` |

### Bucket C — system/schema/metadata op → 拟定 `explicitly-non-revisioning`(9 paths / 12 statements; one-line justification each, as the registry will require)

| Path | Statement(s) | Bumps version | Justification (one line, as it would appear in the registry) |
|---|---|---|---|
| formula recompute materialization | `multitable/formula-engine.ts:345` | **no** | derived value, no user actor; deliberately no version bump — re-derivable from inputs, not an authoritative edit |
| relation-aggregation same-record materialization | `routes/univer-meta.ts:2960` | **no** | same posture as formula recompute (its `lock-exempt` marker says so verbatim) |
| relation-aggregation fan-out materialization | `univer-meta.ts:3855` | **no** | same as `:2960` |
| auto-number CREATE-FIELD backfill (batched) | `multitable/auto-number-service.ts:101` | **no** | system-derived sequence stamp under advisory locks; not user content |
| system People-sheet directory sync | `univer-meta.ts:5173` (INSERT) + `:5189` (UPDATE) | v1 / **yes** | system-owned directory sheet mirrored from the users table; not a user edit surface — but the `:5189` version bump opens version-sequence holes, see OD-A5 |
| `createSeededSheet` demo preset rows | `univer-meta.ts:5807` (`ON CONFLICT DO NOTHING`) | as given | hardcoded template content at sheet birth, not caller data |
| field-delete column strip (`data - fieldId`) | `univer-meta.ts:6151` | **no** | schema op; captured instead by `recordConfigRevision` + field-value tombstones (4c-2) |
| record LOCK/UNLOCK (route) | `univer-meta.ts:16261` / `:16275` | **yes** | lock columns only, `data` untouched; not a data edit — but the bumps open version-sequence holes, see OD-A5 |
| automation `lock_record` LOCK/UNLOCK | `automation-executor.ts:3412` / `:3422` | **yes** | same as above |

### Bucket D — **待 owner 裁决**(2 paths / 2 statements; the guard cannot classify these, a human must)

| Path | Statement | The tension |
|---|---|---|
| 4c-2 field-undelete **rehydration** — writes **captured user cell values** back sheet-wide from `meta_field_value_tombstones`, **no version bump, no record revision** (config side captured by `recordConfigRevision` at `:6502`) | `routes/univer-meta.ts:6521` | Its structural mirror `:6429` (lossy-retype revert) does the same class of sheet-wide field-value rewrite and **does** emit one revision per cell, explicitly rationalized as C5 history completeness. Why does one field-value restore emit and its mirror not? Only the 4c-2 design intent can rule. **Note: this is also the one known site that writes user data *without* a version bump — the site any version-bump-based lint would miss** (D-1c §7a's declared hole). → OD-A3 |
| approval **projection upsert** onto a system-owned projection sheet, continuously re-materialized from the approval-instance table | `multitable/approval-record-projection-service.ts:223` (`INSERT … ON CONFLICT DO UPDATE`, bumps version on conflict) | Derived projection whose source of truth is elsewhere; PIT of that system sheet would simply be empty. Leans `explicitly-non-revisioning`, but it *does* bump version on a `meta_records` row, so it must carry an explicit disposition, not slip through. → OD-A3 |

**Reconciliation: paths 8+12+9+2 = 31; statements 8+14+12+2 = 36 — both totals close against the exhaustive grep. There is no unclassified statement and no unclassified path.**

---

## §3 The guard — **DOUBLE-LAYER, no nearby-regex** 【owner-directed — Constraint 3】

**Why a proximity regex is disqualified up front.** "Every `meta_records` write has a nearby `recordRecordRevision`" is a *source-text* assertion, and source text ≠ behaviour: delete the revision call inside one branch while another call elsewhere keeps the pattern satisfied, and the regex stays green while the revision silently stops landing. The rank-8 lock guard's own header concedes the same limit for itself ("*a GUARDED label without a real guard call elsewhere is separately anchored by … the real-DB canaries*"). Whatever ships must make a **missing revision row observable**, not a missing string. The owner's directed architecture:

### Layer 1 — structural: AST / call-graph inventory + disposition registry

A guard (unit-level, DB-free, so it runs in the **required `test(20.x)` unit step** — same enforcement surface as the rank-8 guard, cannot be skip-greened) that:

1. **Inventories every direct `meta_records` mutation** across the whole backend `src` tree — **AST-based, not line-regex**: parse each runtime `.ts` (TS compiler API / ts-morph), walk template/string literals passed to query functions for word-bounded `UPDATE / INSERT INTO / DELETE FROM meta_records`, plus builder forms (`updateTable/insertInto/deleteFrom('meta_records')`) pre-emptively. AST beats the rank-8 line-regex on: multi-line/concatenated SQL, statements built from fragments, and mapping each statement to its **enclosing function** — the call-graph hook that lets the registry key sites by `file:function` (refactor-stable) instead of raw line numbers, and lets a reviewer trace statement → enclosing function → route/action registration = business path. Two mandatory deltas from rank-8 either way: **`INSERT INTO meta_records` is matched** (rank-8 deliberately omits INSERT because you cannot lock a nonexistent record; a *revision* guard must catch creates — `action:'create'` is what makes a record exist to `reconstructRecordsAtT` at all), and the word boundary keeps `meta_records_trash` / `meta_record_revisions` out of scope. *Honest limit:* full semantic reachability analysis is out of scope — the call-graph obligation is "statement → enclosing function → registered surface", verified per-site at registry-authoring time by a human, then held stable by the guard.
2. **Requires every inventoried site to be registered** with exactly one disposition: **`revisioned` | `explicitly-non-revisioning` | `migration-only`** (the `db/migrations` tree is `migration-only` wholesale, per the rank-8 precedent). Each `explicitly-non-revisioning` entry carries its one-line justification (§2 bucket C column). **A new direct `meta_records` write that is not in the registry ⇒ CI RED.** An entry whose site no longer exists ⇒ also RED (the registry cannot rot into an over-approximation).
3. **Enforces the convergence red line: no new raw writes, period.** The registry is **frozen as a shrink-only set**: a diff that *adds* a registry entry for a new raw mutation site fails the guard — new record-write features MUST go through the unified chokepoint (§3 convergence). The only legal registry transitions are *removal* (site migrated into the chokepoint or deleted) and *disposition correction under owner sign-off*.

### Layer 2 — behavioral: one real-DB golden per `revisioned` runtime path, four obligations each

For **each** `revisioned` path in §2 (all 8 A-paths once fixed, and all 12 B-paths retrofitted where existing suites don't already meet this bar), ONE real-DB golden that drives the **real route/service** (never hand-rolled SQL for the path under test) and proves **all four**:

1. **live row correct** after the write (`data`, `version`, `modified_by` where applicable);
2. **revision row correct** — `action`, `version` (= the post-write `RETURNING version`), `source`, `actorId`, and **full-row `snapshot`, never the patch** (pinned by a two-field record — D-1c's G4 trap: `snapshot: patch` passes on single-field records and truncates every real one);
3. **`reconstructRecordsAtT` correct BOTH before AND after the mutation** — `T > write` returns the post-write value at the post-write version, **and** `T < write` still returns the pre-write value (the new revision must not corrupt earlier T) — point-in-time reconstruction holds on both sides;
4. **neuter this site's revision write ⇒ this site's golden goes RED** — the per-site mutation positive control proving the golden binds *the revision*, not something incidental. Method-level spies are inadmissible anywhere in these four (a spy proves a call, not a row).

The registry maps each `revisioned` site → its golden file; the structural guard cross-checks the mapped file exists and names the site key, so an "emitted" claim without a binding golden is RED. Existing bucket-B suites (e.g. `multitable-d1-delete-revision-parity-realdb.test.ts`) count **only where they already meet the four-point bar**; the registry audit will surface which B-paths need retrofits — that surfacing is a feature, not overhead.
**CI wiring (two-point, mandatory)** for every new real-DB golden: `packages/core-backend/vitest.config.ts` exclude **and** the `plugin-tests.yml` run-list, or it silently never runs (precedent: `…d1-delete-revision-parity-realdb.test.ts` at `vitest.config.ts:189` + `plugin-tests.yml:273`).

### Convergence target — the unified chokepoint + the migration list(刀-by-刀)

End state: **all NEW record writes go through a single unified write chokepoint** that emits the revision unconditionally (natural home: `record-write-service`, which the version-restore family already proved inherits revisions for free — §2 bucket B). **Existing** raw writes enter a **migration list** — the registry itself — and are converged **刀-by-刀**, each conversion a separate opt-in rung that deletes its raw statement, routes through the chokepoint, keeps its Layer-2 golden green, and shrinks the registry. **No new raw writes can be added** (Layer 1 item 3 enforces this from day one). The chokepoint is *not* a precondition: it is the direction the shrink-only registry converges toward. Honest complexity, recorded not hidden: the 9 writer families run in materially different transaction/permission contexts (plugin SDK carries no actor; automation runs inside `withTransaction` with cross-base gates; univer-meta routes hold their own `pool.transaction`; the projection service manages its own client + advisory lock) — which is exactly why convergence is 刀-by-刀 with per-lane transaction proofs, never a big-bang.

### Transitional state for known-broken sites(→ OD-A4)

At guard-landing time the not-yet-fixed bucket-A sites are `revisioned`-**obligated** but cannot pass Layer 2 (they emit nothing). Proposed: they sit in the registry as `revisioned` with a `pending: <burn-down id>` annotation — a **frozen, shrink-only pending set** (adding a new pending ⇒ RED; only pending → green transitions allowed), so the guard lands *first* and the debt is enumerable in CI instead of aspirational (ratchet precedent: #3811). The alternative — guard refuses to land until all 8 A-paths are fixed — queues the class-closer behind five instance-fixes. Owner rules (OD-A4).

### Honest residual holes, stated not hidden

1. A contributor can register a genuinely-should-revision site as `explicitly-non-revisioning` with a plausible reason. No guard can adjudicate reason *quality* — its job is to force the decision to be **explicit, one-lined, and reviewable in a single-file diff**, never silent. Mitigation, not proof: the §6 review rider flags any non-revisioning entry whose SQL writes `data` or bumps `version` as requiring positive justification against the bucket-C precedents.
2. The version-bump fingerprint is *not* part of the soundness argument — `univer-meta.ts:6521` (bucket D) writes user data with **no** bump and would evade any bump-based lint. The registry does not have this hole (it forces a disposition on every site regardless of bump), which is why the policy is registry-over-fingerprint.
3. Dynamically assembled SQL that never yields a recognizable `meta_records` mutation token would evade even the AST inventory. No such pattern exists today (all 36 statements are literal); smoke bounds + review discipline are the mitigation. Recorded, not solved.

---

## §4 Lane A fix surface(**proposed, not authorized** — all inside *existing* transactions, zero migrations)

| Path | Change | Notes |
|---|---|---|
| **A1** form-submit EDIT (`univer-meta.ts:14423`) | exactly D-1c §4 — incorporated by reference, not re-litigated: `RETURNING version, data` (one-word statement change), then one `recordRecordRevision` (`action:'update'`, full post-merge `snapshot`, `version` from RETURNING) inside the existing `pool.transaction` (`:14396`) | atomic by construction (rolls back together); `source`/`actorId` per OD-A2 |
| **A6** form-submit CREATE (`univer-meta.ts:14470`) | after the INSERT (already `RETURNING id, version`): one `recordRecordRevision` (`action:'create'`, `snapshot` = the inserted `patch`, `version:1`) in the same transaction | **anonymous public submit is real here** (`created_by` NULL at `:14477`) ⇒ `actorId: null` is legitimate and `source:'public-form'` is *exactly* accurate for this branch — which resolves D-1c's OD-2 coupling note in the "source describes the surface" direction **if** the owner rules that way (OD-A2) |
| **A8** attachment-delete (`univer-meta.ts:15693`) | `RETURNING version, data` on the existing UPDATE, then one `recordRecordRevision` (`action:'update'`, `changedFieldIds:[fieldId]`, `patch:{[fieldId]: nextIds}`, full-row `snapshot`) inside the existing `pool.transaction` (`:15675`) | actor always known (authenticated; `getRequestActorId(req)` already on the UPDATE at `:15697`) |

**A2/A3/A4/A5/A7 are audited, tabled, and enter the registry as the frozen pending set — their fixes are explicitly *separate opt-in rungs* (刀-by-刀), not smuggled into Lane A's first PR** (staged-opt-in discipline; and D-1's own history argues for narrow rungs with per-lane transaction proofs — the automation lane's transaction boundary must be re-verified at fix time, not assumed from D-2's later state). Priority among them when commissioned: A2/A3 first (A2 is *executed*-grade; A3 is a shipped unflagged authorized-UI path).

**No flag** (D-1c §4 stance, inherited): there is no world in which "history silently omits a user's write" is the desired default; a default-OFF flag would ship a known-wrong default. **No backfill** (D-1c OD-5 stance, inherited): repairing pre-fix history would require fabricating `created_at` for revisions never taken — the "no heuristic backfill" red line stands; forward-only, declared honestly in the eventual PRs.

---

## §5 待 owner 裁决(this lock rules nothing; the three GO constraints are treated as directed and are NOT re-opened here)

| OD | Question | Options | Draft recommendation (**advisory only**) |
|---|---|---|---|
| **OD-A1** | **Lane A fix scope** — and the **#4187 OD-1 interlock** | (i) A1 only (D-1c OD-1(a)); (ii) **A1+A6+A8** (the owner's named Lane A surface = D-1c OD-1(b) + attachment-delete); (iii) full 8-path sweep in one arc (D-1c OD-1(c)) | **(ii)**, with A2/A3/A4/A5/A7 as the frozen pending set converged 刀-by-刀 (A2/A3 first). Record the ruling as *also* answering #4187's OD-1, per the umbrella rule (R13-A policy wins; #4187 inherits) |
| **OD-A2** | **`source` semantics** (absorbs #4187 OD-2/OD-3) | Does `source` describe the **surface** (form endpoint ⇒ `'public-form'` for both A1+A6) or the **actor** (A1 authenticated ⇒ `'rest'`/new value; A6 anonymous ⇒ `'public-form'`)? A8: `'rest'` vs a new value. `actorId`: carry when known (A1/A8 always; A6 when authenticated) | surface-semantics: `'public-form'` for A1+A6 (fills the declared-but-dead enum slot; provenance is what History Center wants), `'rest'` for A8 (an authenticated REST edit; do not mint a value per endpoint); always carry a known `actorId` — an audit trail should not discard a known actor |
| **OD-A3** | **Bucket-D dispositions** | `univer-meta.ts:6521` rehydration: `revisioned` (mirror of `:6429`, which emits per-cell) vs `explicitly-non-revisioning` (config-side capture suffices)? `approval-record-projection-service.ts:223`: exempt system projection vs revisioned? | `:6521` → **revisioned** leans correct by the `:6429` mirror argument, but needs the 4c-2 intent — genuinely the owner's; `:223` → **explicitly-non-revisioning** (derived projection, system sheet, source of truth elsewhere), with its one-line justification in the registry |
| **OD-A4** | **Pending-set legality** (transitional state, §3) | allow `revisioned`+`pending` (frozen shrink-only; guard lands first) vs guard refuses to land until all 8 A-paths are fixed | **allow the pending set** — otherwise the class-closer queues behind five instance-fixes, inverting Lane A's priority; the frozen list makes the debt enumerable in CI rather than aspirational |
| **OD-A5** | **Version-sequence holes from system bumps** | People-sync `:5189`, lock/unlock ×4 (`:16261/:16275`, executor `:3412/:3422`), projection `:223` all bump `version` with no revision ⇒ those versions 404 in `restore-preview` (`VERSION_NOT_FOUND`) and gap the sequence. Stop bumping? Emit metadata revisions? Accept + document? | **accept + document** in Lane A (they are *not* PIT data-correctness bugs — `data` is untouched or system-owned); record as a named known-issue so R14's product decision sees it. Changing lock/unlock version semantics is its own compatibility question, out of Lane A |
| **OD-A6** | **Chokepoint home + first converged path** | ratify `record-write-service` as the unified chokepoint's home (it already emits + already funnels two business paths), and pick the first 刀 (recommendation: A2 plugin `patchRecord` — executed-grade defect, smallest permission surface) vs defer the home decision until the registry lands | ratify the home now (it costs nothing pre-implementation and stops drift), first 刀 = A2 |

---

## §6 Verification(the guard's own effectiveness must be provable)

All items below are **specified, not written** — they land with the implementation PRs, after ratification, per the line's fail-first + mutation-proven convention.

**V1 — Layer-1 positive controls (mandatory in the guard's first PR):**
- fixture with an unregistered `UPDATE meta_records` ⇒ inventory reports it (**the guard bites**);
- fixture with an unregistered `INSERT INTO meta_records` ⇒ reported (**the INSERT delta actually works** — the leg rank-8 lacks);
- fixture with a multi-line / concatenated mutation statement ⇒ reported (**the AST upgrade actually beats the line-regex**);
- correctly registered fixture ⇒ passes; registry entry whose site no longer exists ⇒ RED; **new registry entry added ⇒ RED** (the shrink-only convergence rule bites);
- live-tree smoke bounds (statement count ≥ known floor, ≤ ceiling) — a broken walk or parser cannot pass silently by enumerating nothing;
- **repo-level mutation rehearsal** (run once, recorded in the PR's verification MD, not committed as a permanent diff): add a raw write to a scratch copy of a runtime file ⇒ RED; add a new pending annotation ⇒ RED; remove an existing entry without removing its site ⇒ RED.

**V2 — Layer-2 goldens, four obligations each (§3), each with its own positive control:** fail-first for the A-paths (assert RED against the unfixed site before the fix lands); the same harness carries a **normal-path control record** (D-1c G0) so a green run is meaningful; A6-specific: the anonymous leg asserts `actor_id IS NULL` **and** the row still lands (fail-closed against "no actor ⇒ skip revision" shortcuts); A8-specific: full-row snapshot pinned by a two-field record. Obligation 4 (neuter ⇒ RED) is executed and recorded per site in the rung's verification MD.

**V3 — acceptance criterion restated as the only provable form:**「所有用户数据写入口都产生正确 revision」is accepted **iff**, over the **reachable-business-mutation-path denominator (31 today)**: (1) Layer 1 inventories every raw statement and every one is registered; (2) the pending set is empty *or* explicitly accepted by the owner as the frozen remainder; (3) every `revisioned` path has a four-obligation golden that its own neutering kills; (4) every `explicitly-non-revisioning` path carries its one-line justification; (5) no new raw write can enter (shrink-only registry). Spot-checks, review assertions, and "we looked at all of them once" (this document included) prove nothing durable — **§2 is true today at `e15bf8e2c` and starts rotting the moment a new writer lands; the guard is what keeps it true.**

**Review-checklist rider** (for the guard PR's description, non-CI): any *proposed* `explicitly-non-revisioning` disposition whose SQL writes `data` or bumps `version` must argue against the bucket-C precedents explicitly; reviewers treat a generic "system op" reason as a rejection.

---

## §7 明确不做(named, separate tracks — not silently absorbed)

- **R13 Lane B** — T-state page / deleted-after-T preview(独立 lane,另有其锁): consumes revisions; not touched here.
- **R13 Lane C** — retention 与 Reset 共存 / >5000 行异步(独立 lane): retention interplay with revision completeness is Lane C's problem even though Lane A creates more revisions; named, not solved.
- **R14** — base-wide restore / config-revision product route(owner-gated product decision): Lane A only guarantees the substrate R14 would stand on.
- **No new permission/RBAC model** — every fix rides existing route auth; the guard grants nothing.
- **No migrations, no schema change, no flag, no backfill** (§4).
- **`meta_links` edge history** — #4187 OD-4, still deferred: a link-only form edit remains invisible to record history even after Lane A. Recorded, out.
- **Version-sequence hole remediation for system bumps** — OD-A5's "accept + document" unless the owner rules otherwise.
- **The chokepoint implementation itself** — its *policy* (convergence target, shrink-only registry, no new raw writes) is locked here; its build is 刀-by-刀 rungs, each a separate opt-in.
- **yjs-bridge** — `'yjs-bridge'` is a declared source value, but no yjs writer issues raw `meta_records` SQL today (the 36-statement inventory is exhaustive); if one appears, Layer 1 is exactly what catches it unregistered.

## §8 What this document does NOT claim

- It adds **no new executed evidence** — A1/A2's executed grades are D-1c §3's, inherited with attribution; A3–A8 remain source-verified. Do not cite this table as "measured" beyond those two.
- It does **not** claim the registry is sound against a dishonestly-justified `explicitly-non-revisioning` entry (§3 hole 1) or dynamically-assembled SQL (§3 hole 3) — both recorded openly.
- It does **not** claim `record-write-service` can absorb all writers today (§3 convergence states why it is 刀-by-刀).
- It does **not** claim the 31-path denominator is eternally correct — it is correct at `e15bf8e2c`; Layer 1 is what keeps the denominator honest.
- It does **not** rule any OD — including the bucket-D dispositions its own table proposes. **PROPOSED throughout; nothing here is ratified, and no implementation is authorized by this document.**

## §9 实施排布(ratify 后才排;此处仅记建议顺序)

1. **Rung 1 — A1+A6+A8 revisions + their four-obligation goldens** (extends #4187's designed surface; smallest pending remainder = 5).
2. **Rung 2 — the double-layer guard** (Layer-1 AST inventory + registry across all 36 statements / 31 paths + V1 self-tests + frozen pending set; Layer-2 registry↔golden cross-check; B-path retrofit audit surfaced as an explicit worklist).
3. **Rungs 3+ — pending burn-down, 刀-by-刀** (A2/A3 first, then A4/A5/A7), each a separate opt-in with its own per-lane transaction proof and four-obligation golden; each 刀 may simultaneously converge its path into the chokepoint (OD-A6), shrinking the registry.

Per the line's convention: hot-core files (`univer-meta.ts`, `automation-executor.ts`) ⇒ independent adversarial review with mutation proofs mandatory; one PR per rung; no auto-merge armed on any held rung.

---

*References: umbrella instance #4187 (D-1c) `multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md`; D-1 lock `multitable-global-history-d1-uncaptured-delete-revision-pit-correctness-design-lock-20260708.md`; D-2 lock `multitable-global-history-d2-side-door-delete-recoverability-design-lock-20260709.md`; rank-8 guard `packages/core-backend/tests/unit/multitable-record-lock-guard.guard.test.ts`; emitter `packages/core-backend/src/multitable/record-history-service.ts`.*
