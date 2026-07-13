# Multitable Global History — D-1c: form-submit **EDIT** writes no record revision — DESIGN LOCK (**RATIFIED**)

- **Status**: **RATIFIED — 2026-07-13 (owner), post re-review.** Process completed exactly as the owner ordered: rulings OD-1…OD-6 encoded (§0.5) → `HISTORY_INCOMPLETE` hard-lock encoded (§0.6) → independent re-review (`/tmp/pr4187-rereview-claude-20260713.md`: 2 P1 + 1 P2, all folded back — §0.6 user-authored-field projection, zero-revision rule, goldens G-HI-3/G-HI-4, §5 OD-4 reconciled; A1–A8 audit verified 8/8) → owner reviewed the revised lock and **ratified with two text amendments** (both applied): header → RATIFIED, and §0.6's golden timing = *before the corresponding runtime merge* (not before ratify).
- **Implementation authorization & sequence (owner 2026-07-13)**: **§0.6 `HISTORY_INCOMPLETE` implements FIRST and alone** (shared preview/execute precheck · execute re-check · polluted history ⇒ zero writes). Only after §0.6 lands does the sweep proceed, **strictly as the ruled FIVE slices**: form → plugin → automation → approval → attachment, with the **OD-6 guard (#4227) landing last**. The pre-existing R13 lane PRs (#4216/#4219/#4220/#4227) stay **Draft — 不合、不 rebase** until their turn; **(b) 三车道交付 is NOT accepted**; their code is recyclable subject to the owner's per-PR required fixes (#4216 concurrent-delete fail-closed + golden; #4219 attachment split out, `source='attachment'`; #4220 approval split out, `source='approval'`; #4227 robust scanning + stable site IDs). *(Historical note: an earlier header prematurely read RATIFIED under a 3-lane plan; that was walked back, corrected to 5 slices, re-reviewed, and only then ratified — the audit trail lives in the PR.)*

## §0.5 Owner rulings (2026-07-13, RATIFIED — see Status) + audit confirmation

**Audit confirmation (primary-source, origin/main).** 37 `meta_records` write sites; **exactly 8 genuine user-data content paths write no revision** (owner's "8, not 2" — CONFIRMED), plus a **9th** config-lane residual (whole-sheet FK-cascade drop, `univer-meta.ts:12519` — routes to the *config* guard, not this record guard). The 8 = §7a's A1–A8. Two draft errors corrected below. The record-DELETE lane is **fully closed** (all 4 named delete surfaces write revisions).

| OD | RULING (owner 2026-07-13) | as-encoded |
|---|---|---|
| **OD-1** scope | **Full bucket-A A1–A8 sweep, split into FIVE independent runtime slices** (owner: 「全量 bucket-A(A1–A8），但分 **5 个独立 runtime slice**」). Not EDIT-only; **not** 3 lanes. Each slice independently verifies txn boundary · actor · source · revision shape · PIT correctness — **not one hot-core PR**. | **Execution order (owner-fixed):** ① **form** = A1 EDIT (`univer-meta.ts:14423`) + A6 CREATE (`:14470`) → ② **plugin** = A2 update (`records.ts:507`) + A5 create (`:546`) → ③ **automation** = A3 update (`automation-executor.ts:2217`) + A4 create (`:2475`) → ④ **approval** = A7 resultWriteback (`automation-service.ts:2818`) → ⑤ **attachment** = A8 attachment-delete cell-strip (`univer-meta.ts:15693`). Owner separated **approval (④)** and **attachment (⑤)** into their **own** slices — do not fold ④ into automation or ⑤ into form. |
| **OD-2** source | **`source` = the WRITE ENTRY POINT, not the auth identity** (owner). Per-surface: form → `'public-form'`, plugin → `'plugin'`, automation → `'automation'`, approval → `'approval'`, **attachment → `'attachment'`**. | corrects the earlier draft which set attachment to `'rest'` — owner ruled `'attachment'`. `'approval'` may need adding to the `RecordRevisionSource` union alongside the existing `'public-form'` slot. |
| **OD-3** actor | **Known actor MUST be written** (owner). Authenticated form EDIT carries the member actor; **anonymous form CREATE → `actorId = null`**; **must NOT fabricate a `system` actor** for an actor-less path. | audit: form CREATE/EDIT anonymous-reachable (`created_by/modified_by` NULL on public path); plugin/automation/approval actor per token/context. |
| **OD-4** link edges | **link-EDGE history is a SEPARATE design-lock — NOT folded into D-1c** (owner: 「link-edge history 单独设计锁。不混入 D-1c，但必须明确仍未解决」). It must be explicitly recorded as **STILL UNSOLVED**, and **no link-only change may be claimed to have complete history**. *Distinct from the record `data` snapshot:* the link-field ids live in `meta_records.data` (`patch[fieldId]=ids` at `univer-meta.ts:14306`), so they are captured by the ordinary bucket-A revision snapshot like any other cell — that part IS in the form slice. What is **deferred** is the edge-level `meta_links` history (its own lock). Do NOT claim edge-level completeness here. | supersedes the earlier "IN SCOPE lane A, do NOT defer" encoding, which contradicted the owner ruling. |
| **OD-5** old history | **Forward-only. Do NOT fabricate `created_at` for revisions never taken.** | mirrors D-2 §1.2 no-heuristic-backfill red line. |
| **OD-6** guard | **Commission the revision-disposition CI guard, covering INSERT/UPDATE/DELETE** (the rank-8 lock guard ignores INSERT). Separate rung. Matrix (audit §2): **22 must-write / 15 exempt**; guard fires on the 8. Sheet-cascade (#9) → *config* guard. | **`univer-meta.ts:6521` field-undelete rehydration: owner ruling = SHOULD WRITE REVISION** (audit flagged it debatable-EXEMPT; owner directs it MUST-WRITE). **`approval-record-projection-service.ts:223` derived projection: EXEMPT** (explicitly marked). |

**Corrected §0 CREATE risk (was understated):** a record **created before reset-T** via an uncaptured path (CREATE writes no revision) is **absent** from `reconstructRecordsAtT` (`record-reconstructor.ts:34`) → `computeSheetReset` (`univer-meta.ts:10031-10037`) pushes it to the delete-set **unconditionally** (it cannot tell "created after T" from "created before T but uncaptured") → **Reset-to-T DESTROYS a record legitimately present at T**. So CREATE is **destructive**, not merely "incomplete history" — the §0 table's original "kept / non-destructive" is the wrong case.

**Per-slice proof obligation (all FIVE slices):** real entry-point golden · same-txn `recordRecordRevision` with **full snapshot** · PIT-correct after fix · failure rolls back (no half-write) · **source mutation → test red** · the slice's `source` value is asserted. Transaction-boundary is **re-verified per slice** (D-1「偏差1」: these lanes were not uniformly transactional; D-2 §0 says they now are — prove it per slice, don't assume).
- **Provenance**: independent audit finding, then **verified primary-source against `origin/main` @ `087ffa47a`** and **reproduced end-to-end on real Postgres 14** (§3). **Every file:line below was read, not inferred.** Behavioural claims are labelled by their evidence grade throughout — **executed** (the D-1c defect itself, its full blast radius, and sibling A2) vs **source-verified** (siblings A3–A8) vs **by construction** (the T8-2 reset leg). §8 states exactly what is *not* claimed. Do not let a source-verified claim be cited as measured.
- **Why it needs a ruling and is not self-drivable**: the defect sits in the **public-form subsystem that the D-1 lock deliberately deferred** (D-1 §6「相邻缺口」/ §7「出界」: *「public-form 创建-revision(§6,待确认)」*). D-1 deferred the **CREATE** half. The **EDIT** half described here is named in **no document at all**. Implementing it without a ruling would end-run D-1's deferral — hence: prove it, design it, **stop**.
- **One-sentence problem**: the **authenticated** form-submit EDIT branch (`packages/core-backend/src/routes/univer-meta.ts:14423`) raw-`UPDATE`s `meta_records` and bumps `version` 1→2 while writing **no record revision** — so `reconstructRecordsAtT`, the read primitive beneath the PIT view and the sheet revert/reset, reports the record's **pre-edit** value at *every* T after the edit, and a sheet revert to a timestamp **after** the edit (which should be a no-op) **silently and irrecoverably destroys the member's edit**.
- **⚠️ The audit that produced this lock found the bug is NOT one site — it is a class of EIGHT** (§7a). Form-submit EDIT is the instance I reproduced end-to-end with full blast radius; **plugin-SDK `patchRecord` was then reproduced too**, and six more sites carry the identical fingerprint by source. **Most consequentially: D-1 closed only the *delete* half of the automation/plugin side doors — those two lanes still emit *nothing* for `create` and `update`.** That reframes the scope question (**OD-1**) from "EDIT-only or +CREATE?" into "how wide is the sweep?", and it is the single most important thing in this document for the owner to rule on.

---

## §0.6 `HISTORY_INCOMPLETE` — fail-closed integrity precheck (owner hard-lock, 2026-07-13)

The owner's headline addition, and the reason the lock is **not ratifiable until it is written in**. OD-5 forbids repairing already-polluted rows (no speculative backfill). This precheck is the fail-closed counterpart: **while a record's history is untrustworthy, no destructive recovery operation may act on it.** It protects existing polluted data *before* the five slices backfill the write entry points — so it lands first, not as a byproduct of finishing them.

**The hard-lock, verbatim from the owner (2026-07-13):**

1. **Unified refusal.** When a record's **current live data is inconsistent with its latest revision snapshot**, the PIT-Revert / Reset **preview** and **execute** paths return a unified **`HISTORY_INCOMPLETE`**. On that signal: **no execute token is generated, and no write occurs.** (Shared precheck — preview and execute call the same function.)

2. **Compare CONTENT, not version — and compare it over USER-AUTHORED fields only.** The precheck compares the **authoritative data content**, not merely `version`. Two false-positive classes are excluded by construction (both inside the owner's 「不得误报」 intent):
   - **version-only changes** — lock/unlock bump `version` via a lock-disposition path without touching `data`;
   - **derived-field materialization**(re-review P1-A)— formula / rollup / lookup / auto-number engines write computed keys into `data` **without** a version bump or a revision **by design** (`formula-engine.ts:345`, cross-record fan-out `univer-meta.ts:3855`, `auto-number-service.ts:101`; even a *healthy* create snapshots the user `patch` in-txn and materializes formula keys post-commit, `record-service.ts:706`). A full-`data` comparison would therefore flag **every healthy record on every formula sheet** — bricking revert/reset. ⇒ **The comparator projects both sides (live `data` and the latest revision snapshot) onto the sheet's user-authored/writable field ids** — the field set whose type is NOT a derived type (formula / rollup / lookup / auto-number; the implementation slice pins the exact type list from `field-codecs`) — and compares only that projection.

3. **Zero-revision records are HISTORY_INCOMPLETE — and the precheck must enumerate LIVE rows**(re-review P1-B). A live record with **no revisions at all** (the uncaptured-CREATE fingerprint, A4/A5/A6) has no snapshot to compare — it is *trivially* inconsistent with its (non-existent) latest revision, and per the owner's rule it must refuse. This case is **fail-open if unspecified**: `computeSheetReset` (`univer-meta.ts:10024-10034`) pushes live rows **absent** from the reconstructed state into the delete-set, so a precheck that iterates only the *reconstructed* set never sees them and the reset **silently deletes** them — the exact harm §0.6 exists to prevent (§0.5's corrected CREATE risk). ⇒ **The precheck iterates the LIVE row set of the affected scope** (not the reconstruction): for each live row, no revision ⇒ `HISTORY_INCOMPLETE`; else compare per item 2.

4. **Execute re-checks.** `execute` **must re-run the precheck**, not trust the preview's result — an uncaptured write can appear in the window **between** preview and execute (TOCTOU). A preview that passed does not license an execute that skips the check. (The existing `previewIdentity` scopeHash guard does NOT cover this: it is computed from revision-derived state and is structurally blind to uncaptured writes — verified by the re-review.)

5. **Real-DB goldens (all four mandatory — they gate the CORRESPONDING RUNTIME MERGE, not ratification; owner amendment 2026-07-13):**
   - **G-HI-1 · Polluted → refused, zero writes.** A record whose live user-authored `data` disagrees with its last revision snapshot ⇒ **both** preview **and** execute return `HISTORY_INCOMPLETE`, **and a post-assertion proves zero rows were written / no token minted** (not just that the response was an error — prove the DB is untouched).
   - **G-HI-2 · Version-only, data-consistent → NOT refused.** A record whose `version` moved by a lock/unlock (data identical to snapshot) ⇒ the precheck **passes**, and the revert/reset proceeds normally.
   - **G-HI-3 · Formula-sheet healthy record → NOT refused**(positive control for item 2's projection). A record on a formula sheet created/edited through the NORMAL captured path — live `data` carries materialized formula keys the snapshot lacks — ⇒ the precheck **passes**. Without this leg, G-HI-1+G-HI-2 both pass a refuse-everything implementation (G-HI-2's lock/unlock case is data-identical, so it never exercises the projection).
   - **G-HI-4 · Zero-revision live record → refused, zero writes**(pins item 3). A live row with no revisions inside the reset scope ⇒ **both** preview and execute return `HISTORY_INCOMPLETE` with zero writes — proving the precheck enumerates live rows and the silent-delete path is closed.

**Placement:** shared precheck consumed by both `computeSheetReset` / PIT-revert preview and their execute counterparts (the `reconstructRecordsAtT` consumers named in §2). Slice ordering: **§0.6 lands FIRST** (it needs none of the five write-path fixes; it only needs the data-vs-snapshot comparator), guarding live data during the multi-slice backfill.

**What §0.6 is NOT:** not a backfill (OD-5 forbids that); not a `version`-equality check and not a full-`data` diff (item 2 projects to user-authored fields — derived keys excluded); not blind to never-captured rows (item 3 enumerates LIVE rows); not preview-only (item 4). It refuses to act on untrustworthy history; it does not try to reconstruct it.

---

## §0 Why this is NOT the CREATE half D-1 already deferred

This distinction is the whole reason the document exists, and it is load-bearing for OD-1.

| | **CREATE** (form-submit new record) — `univer-meta.ts:14470` | **EDIT** (form-submit existing record) — `univer-meta.ts:14423` |
|---|---|---|
| Shape of the gap | a **missing tail** — the record has *no* revision at all, so it simply has no history before its first revision | a **hole in the middle of the chain** — the record **has** history, and that history **lies** about it |
| PIT consequence | record is **absent** from `reconstructRecordsAtT` (existence is derived purely from revisions) | record is **present** with **stale data and a stale version** |
| Revert/reset consequence | **⚠️ CORRECTED (§0.5, owner P2):** non-destructive ONLY when created **after** T. When created **before** reset-T with an uncaptured create, reconstruction finds no revision ≤ T ⇒ absent from `stateMap` ⇒ `computeSheetReset` (`univer-meta.ts:10031-10037`) pushes it to the delete-set **unconditionally** ⇒ **Reset-to-T DESTROYS a record legitimately present at T.** | record is classified as **drifted from T** ⇒ a revert **writes the stale value back over it** |
| Worst outcome | history *incomplete* **AND** (Reset-to-post-create-T) **committed member data DESTROYED** — same destructive class as EDIT, not milder | history is *wrong*, and acting on it **destroys committed member data** |
| Document status | **explicitly deferred** by D-1 §6/§7 (pre-named there as "D-1b") | **named nowhere** |

A missing tail is a *coverage* gap. A hole in the middle is a *correctness* gap: the difference between "history doesn't know about this record" and "history confidently returns the wrong value for a record it does know about, and the restore machinery acts on that wrong value."

---

## §1 The defect (primary-source, `origin/main` @ `087ffa47a`)

**The write.** `packages/core-backend/src/routes/univer-meta.ts:14423-14431`, inside `router.post('/views/:viewId/submit', …)` (route opens at `:14145`, closes at `:14666`):

```
// lock-guarded: form-submit EDIT (B2) — ensureRecordNotLocked enforced just above.
const updateRes = await query(
  `UPDATE meta_records
   SET data = data || $1::jsonb, updated_at = now(), version = version + 1, modified_by = $4
   WHERE id = $2 AND sheet_id = $3
   RETURNING version`,
  [JSON.stringify(patch), recordId, view.sheetId, getRequestActorId(req)],
)
```

**The omission.** There is **no `recordRecordRevision(...)` call anywhere in the route's 14145–14666 span** — for either the EDIT branch or the CREATE branch. Verified by enumerating every call site in the backend:

```
$ git grep -n "recordRecordRevision(" origin/main -- packages/core-backend/src
  multitable/automation-executor.ts:2365      multitable/record-service.ts:706, 845, 1125, 1392
  multitable/record-history-service.ts:86     multitable/record-write-service.ts:998
  multitable/records.ts:650, 771              routes/univer-meta.ts:6454, 10178, 10416, 10498
```

— none in `[14145, 14666]`.

**Why that is fatal.** `reconstructRecordsAtT` (`packages/core-backend/src/multitable/record-reconstructor.ts:34-70`) derives record existence **and data** *purely* from `meta_record_revisions` (`:49-55`):

```
SELECT DISTINCT ON (record_id) record_id, action, snapshot, version
FROM meta_record_revisions
WHERE sheet_id = $1 AND created_at <= $2 …
ORDER BY record_id, created_at DESC, version DESC, id DESC
```

It never reads `meta_records`. A mutation that does not emit a revision is therefore **invisible to it forever** — the latest revision `<= T` stays the *pre-edit* one, at *any* T, including T = now.

**Reachability.** The branch is entered whenever the request body carries `recordId`. The route's own zod schema declares it (`univer-meta.ts:14152-14153`):

```
const schema = z.object({
  recordId: z.string().min(1).optional(),
  expectedVersion: z.number().int().nonnegative().optional(), …
})
```

> **Correction to the reported finding.** The audit cited this contract as `FormSubmitInput.recordId` at `types.ts:903`. **No symbol named `FormSubmitInput` exists anywhere in the repository** (`grep -rn "FormSubmitInput" packages/` → 0 hits). The *substance* of the reachability claim is nevertheless correct — it is carried by the route's inline zod schema above, not by a named exported type. Cited accurately here.

It is **authenticated-only** — anonymous public-form submits are explicitly refused a `recordId` at `univer-meta.ts:14199-14204`:

```
if (effectivePublicAccessAllowed && parsed.data.recordId) {
  return res.status(400).json({ … 'Public forms do not support updating an existing record' })
}
```

So the actor is a **logged-in member with `canEditRecord`** using a form-view edit link. **The actor is always known** — which matters for OD-2 (`source`/`actorId`).

**Prior art on this exact line.** The rank-8 record-lock guard (`packages/core-backend/tests/unit/multitable-record-lock-guard.guard.test.ts:5-8`) exists because *"the record lock was advisory on three un-enumerated write paths (automation `update_record`, **form-submit EDIT**, attachment-delete)"*. **This same branch has already burned this line once**, for the lock. It is now burning it a second time, for revisions. That is the strongest available argument for OD-6.

---

## §2 Blast radius (driven through the real routes — §3; every row labelled by evidence grade)

`reconstructRecordsAtT` has exactly **three** route consumers (`git grep` on `origin/main`):

| # | Consumer | Route | Effect of the gap | Severity | Proven? |
|---|---|---|---|---|---|
| 1 | T7 **PIT view** (`univer-meta.ts:8303`) | `GET /sheets/:sheetId/point-in-time` | shows the **pre-edit** value + **stale version** at a T *after* the edit | read-only **lie** | ✅ executed |
| 2 | T8-1 **sheet revert** (`univer-meta.ts:9955`, `computeSheetRevert`) | `POST /sheets/:sheetId/revert-preview` + `/revert-execute` | revert to a T *after* the edit is **not a no-op**: it proposes and then **performs** overwriting the live value with the stale one | **DESTRUCTIVE — irrecoverable data loss** | ✅ executed (`revertedCount: 1`) |
| 3 | T8-2 **sheet reset** (`univer-meta.ts:10028`, `computeSheetReset`) | `POST /sheets/:sheetId/reset-preview` + `/reset-execute` | same stale target from the same primitive | **DESTRUCTIVE** | ⚠️ **by construction** (same primitive, same `stateMap` shape) — I executed revert, **not** reset. Stated honestly; see §8. |

**Two further consumers are affected, but *not* via `reconstructRecordsAtT`** — they read `meta_record_revisions` directly, so the missing row hurts them differently. Both proven:

| # | Consumer | Effect |
|---|---|---|
| 4 | Record history timeline / History Center (`multitable/history-projection.ts:235,418,458,578,624`) → `GET /sheets/:sheetId/records/:recordId/history` | the member's edit appears **nowhere**. The timeline shows only `version 1 (create)` while the live row sits at `version 2`. **Audit hole**: "who changed this field?" answers *nobody*. |
| 5 | Record **version-restore** (`univer-meta.ts:9225, 9316, 9443, 9645, 9793` — all `WHERE version = $N`) | `POST /sheets/:sheetId/records/:recordId/restore-preview` with `targetVersion: 2` ⇒ **`404 VERSION_NOT_FOUND: "No revision at version 2"`**. The member's own edit is **not an offerable restore target**, and version 2 is a permanent hole in the version sequence. |

**Correction to the reported finding (attribution).** The reconstructor's own header (`record-reconstructor.ts:4-5`) says it is the primitive behind *"restore-preview (T5-2)"*. That is loose: the **record-level** restore-preview (`univer-meta.ts:9198`) reads a specific revision by version (`:9225`, `WHERE version = $3`) and does **not** call the reconstructor. The reconstructor's restore-family consumer is the **sheet-level** revert/reset (rows 2–3). Both surfaces are affected — but by different mechanisms, and the one-pager must not misattribute.

### Worst realistic user-visible outcome (concrete, not inflated)

> A member fixes a value through a form-view edit link. Days later an operator uses **Revert-to-T** to undo an unrelated bad change, choosing a timestamp **after** the member's fix — the choice that *should* preserve it. The preview shows the member's record as "will be reverted" (`visibleRevertCount: 1`), the operator confirms, and the fix is **overwritten by the pre-edit value**. The new value now exists in **no revision, no trash row, and no version** — the revert emits a `source='restore'` revision whose snapshot is the *reverted* (old) data, and no pre-image of the destroyed value is stored anywhere. **It is unrecoverable.** The member's record history shows no trace that the edit ever happened.

This is **verified**, not projected (§3): after the executed revert, a `LIKE '%v2-edited-via-form%'` scan across `snapshot` **and** `patch` of **every** revision for that record returns **0 rows**.

**Honest bounding of the severity.** The destructive legs require an operator with `canManageSheetAccess` to actively run a sheet revert/reset (`univer-meta.ts:10082`, `:10122` — a sheet-admin cap, above plain record-write). This is **not** a self-triggering or attacker-triggerable bug: nothing corrupts data on its own. The read-only lie (PIT view) and the audit hole (rows 4–5) are, by contrast, **unconditional and continuous** — they are wrong for every form-edited record from the moment of the edit, with no operator action at all.

**This blast radius is not specific to form-submit.** Every bucket-A site in §7a feeds the *same* `reconstructRecordsAtT` and therefore inherits this *entire* table — the PIT lie, the destructive revert/reset, and the audit hole. The consequence is that the exposure is **much wider than a form-view edit link**: it includes every record ever written by an **automation `update_record`** (a shipped, unflagged, authorized-UI path — A3) and by the **plugin SDK** (A2, reproduced). Scoping this to "the form-submit path" understates it, and OD-1 exists so the owner is the one who decides how much of it to close.

---

## §3 Reproduction — real Postgres 14, real routes (executed 2026-07-12)

**Harness fidelity.** Every mutation under test is driven through the **real Express route** (`univerMetaRouter()` mounted on a real app, real `poolManager` pool) — **no hand-rolled SQL for the path under test**. Hand-rolling the `UPDATE` would only have proven "an UPDATE without a revision diverges" (trivially true), not "the handler skips the revision."

**Environment**: isolated Docker `postgres:14` on a non-default port (55439); migrations applied with **CI's exact `MIGRATION_EXCLUDE`** (`plugin-tests.yml:179`); all migrations green.

**Positive control (proves the harness is trustworthy, not merely passing).** The same harness, same sheet, a record edited through the **normal** path (`PATCH /records/:recordId`):

```
CONTROL B  live = {"data":{"…":"ctrl-v2"},"version":2}
CONTROL B  revisions = [{"v":1,"a":"create","s":"rest"},{"v":2,"a":"update","s":"rest"}]
CONTROL B  reconstructRecordsAtT(now) = {"exists":true,"data":{"…":"ctrl-v2"},"version":2}   ✅ correct
```

**The defect** — same sheet, record edited through `POST /views/:viewId/submit` with `recordId` + `expectedVersion`:

```
form-submit EDIT status = 200 {"ok":true,"data":{"mode":"update","record":{"version":2,"data":{"…":"v2-edited-via-form"}}}}
VICTIM A   live      = {"data":{"…":"v2-edited-via-form"},"version":2}
VICTIM A   revisions = [{"v":1,"a":"create","s":"rest"}]                      ← *** NO REVISION WRITTEN ***
VICTIM A   reconstructRecordsAtT(T AFTER the edit)
                     = {"exists":true,"data":{"…":"v1-original"},"version":1}  ← *** HISTORY LIES ***
```

Live row = `v2-edited-via-form` @ version **2**. `reconstructRecordsAtT` = `v1-original` @ version **1**. **The reported divergence reproduces exactly.**

**Blast radius, through the real consumer endpoints, with `asOf` strictly AFTER the edit:**

```
PIT VIEW   A(victim)  = {"…":"v1-original"}    ← stale (should be v2-edited-via-form)
PIT VIEW   B(control) = {"…":"ctrl-v2"}        ← correct

REVERT-PREVIEW(asOf AFTER the edit) → 200
  summary = {"visibleRevertCount":1,…}
  records = [{"recordId":"<VICTIM>","fieldIds":["<FLD>"]}]     ← only the victim; control untouched

REVERT-EXECUTE → 200 {"records":[{"recordId":"<VICTIM>","status":"reverted","newVersion":3}],"revertedCount":1}
VICTIM A   live AFTER revert-execute = {"data":{"…":"v1-original"},"version":3}   ← *** EDIT DESTROYED ***
VICTIM A   ALL revisions after revert
  = [{"v":1,"a":"create","s":"rest","snap":{"…":"v1-original"}},
     {"v":3,"a":"update","s":"restore","snap":{"…":"v1-original"}}]              ← version 2 never existed
>>> revisions anywhere containing the member edit value = 0                       ← *** UNRECOVERABLE ***
```

**Audit hole, through the real endpoints:**

```
record-history  → 200, items = [ { version:1, action:"create", source:"rest", … } ]   ← the edit is absent
restore-preview(targetVersion=2) → 404 {"code":"VERSION_NOT_FOUND","message":"No revision at version 2"}
```

**Sibling spot-check (A2) — plugin-SDK `patchRecord` (`records.ts:507`), same harness, same sheet.** Run to validate that §7a's source-level classification is real and not a paper exercise:

```
SIBLING plugin live      = {"data":{"…":"sib-v2-via-plugin"},"version":2}
SIBLING plugin revisions = [{"v":1,"a":"create","s":"rest"}]                    ← *** NO REVISION ***
SIBLING plugin reconstructRecordsAtT(after) = {"data":{"…":"sib-v1"},"version":1}  ← *** SAME PIT LIE ***
```

**The class is confirmed empirically on 2 of its 8 sites.** The remaining six are source-verified only (§8).

**Environment health (neighbours, same DB, same run):** `multitable-record-reconstructor-realdb` + `multitable-form-submit-trigger` = **11/11 passed**; `multitable-d1-delete-revision-parity-realdb` = **8/8 passed**. The environment is healthy; the divergence above is the code, not the harness.

> The harness is a scratch artifact and is **deliberately not part of this PR** (docs-only, zero runtime). Its assertions are transcribed into the goldens of §6, where they belong — pinned only *after* ratification, and shaped by the owner's OD rulings.

---

## §4 Fix surface (minimal — **proposed, not authorized**)

**One call site.** Inside the existing `pool.transaction(...)` at `univer-meta.ts:14396`, after the `UPDATE` at `:14423-14431`, emit exactly one revision.

Three properties make this **strictly simpler than D-1**, and they are worth stating because they *remove* an open decision D-1 had to wrestle with:

1. **The path is already transactional.** The handler runs inside `pool.transaction` (`:14396`). D-1's two lanes had **no outer transaction**, which forced its「偏差 1」compromise (delete-then-emit, fail-safe degradation, no atomicity golden in the original shape). Here the revision can be emitted **atomically in-transaction** — a failed revision insert rolls back the `UPDATE`. **No half-state is possible, and no fail-safe degradation argument is needed.**
2. **The snapshot is already at hand.** `reconstructRecordsAtT` reads `snapshot` as the **full record data**, not a patch (`record-reconstructor.ts:63`). The `UPDATE` performs `data = data || $1::jsonb`, so the post-merge full row must be captured — the statement's `RETURNING` clause currently returns only `version` (`:14428`) and would need `RETURNING version, data`. This is a **one-word change to an existing statement**, not a new query.
3. **The version is already correct.** `nextVersion` is already read from `RETURNING version` (`:14432`) — the revision's `version` is exactly that value, so the version sequence closes with no hole.

**Sketch** (illustrative; the exact `source`/`actorId` shape is **OD-2/OD-3** and is the owner's to rule):

```
const updateRes = await query(`UPDATE meta_records SET … RETURNING version, data`, …)
nextVersion = Number(updateRes.rows[0]?.version ?? serverVersion)
await recordRecordRevision(query, {
  sheetId: view.sheetId,
  recordId,
  version: nextVersion,
  action: 'update',
  source: <OD-2>,                       // 'public-form' | 'rest' | new value
  actorId: getRequestActorId(req),      // always known — the branch is authenticated-only
  changedFieldIds: Object.keys(patch),
  patch,
  snapshot: updateRes.rows[0]?.data,    // full post-merge row (NOT the patch)
})
```

**Not a flag.** Consistent with D-1 §3 and the D-6 precedent, this is a pure correctness fix: there is no world in which "history silently omits a member's edit" is the desired default. **No new environment flag is proposed.** (If the owner nonetheless wants one, it ships **default-OFF** and its enablement is a separate operator rung — but note that a default-OFF flag here means *shipping a known-wrong default*, which is why this lock does not recommend one.)

**Behaviour change to declare honestly in the eventual PR** (mirroring D-1 §3): after the fix, form-edited records will **correctly** reflect their edits in PIT/revert/reset and will **stop** being spuriously reverted. Existing already-polluted history is **not** retro-repaired — see **OD-5**.

---

## §5 Open decisions — ✅ RULED (see §0.5/§0.6); the questions + advisory drafts below are HISTORICAL

> **⚠ SUPERSEDED (2026-07-13).** The owner has ruled OD-1…OD-6; the authoritative rulings are in **§0.5**, and the `HISTORY_INCOMPLETE` hard-lock is **§0.6**. This section is preserved as the record of the *questions posed and the draft advisory recommendations* — **the draft recommendations below are NOT the decision** and in several places the owner ruled against them (OD-1: owner chose the full A1–A8 sweep as **5 slices**, not the draft's "(b) as immediate rung"; OD-4: owner ruled link-edge history a **separate deferred lock**, not the draft's "in scope, do not defer"; OD-2 attachment source = `'attachment'`, not the draft's leanings). Read §0.5/§0.6 for what was decided; read below only for how the questions were framed.

| OD | Question | Options | Draft recommendation (**advisory only**) |
|---|---|---|---|
| **OD-1** | **Scope — HOW WIDE IS THE SWEEP?** This is the decision everything else hangs off, and §7a changed its shape. The bug is **8 sites**, not one. The CREATE branch (`:14470`) sits ~47 lines below the EDIT branch **in the same handler** and is equally revision-free (D-1 §6/§7 deferred it as "D-1b"). And **automation + plugin `create`/`update` (A2–A5) are the same bug** — D-1 fixed only those lanes' *delete* half. | (a) **EDIT-only (A1)** — the tightest possible fix; respects D-1's deferral to the letter; leaves the same handler half-fixed, six known-broken sites live, and a second/third PR inevitable. (b) **Whole form-submit handler (A1+A6)** — closes one route atomically; *reopens* D-1's deferral. (c) **Full bucket-A revision-parity sweep (A1–A8)** — closes the class; largest blast radius, touches hot core (`automation-executor`), and each lane needs its own transaction-boundary proof (D-1's「偏差 1」showed those lanes are **not** uniformly transactional; D-2 §0 later established they now are — that must be **re-verified per lane**, not assumed). | **(b) as the immediate rung, (c) as an explicitly-commissioned follow-on** — with (c)'s A2/A3 (automation + plugin `update`) prioritized, because those are *proven* (A2) or near-certain PIT-poisoners on **already-shipped, unflagged, authorized-UI paths**. I deliberately do **not** recommend folding (c) into this PR: it would put a hot-core multi-lane refactor behind a correctness fix that is ready now, and D-1's own history is the argument for landing narrow rungs with per-lane proofs. **But the owner should know that choosing (a) or (b) leaves a proven PIT-poisoning bug (A2) live in the plugin SDK**, and should choose that knowingly, not by default. |
| **OD-2** | **Which `source`?** `RecordRevisionSource` (`record-history-service.ts:10`) **already declares `'public-form'`** — and **nothing in the entire backend emits it** (`git grep "'public-form'"` in `src` returns exactly two hits: the type declaration, and an unrelated URL-segment check at `univer-meta.ts:5660`). It is a **dead enum slot**, exactly like `'automation'`/`'plugin'` were before D-1 filled them. | (a) `'public-form'` — fills the declared-but-dead slot, consistent with D-1's precedent of reusing the enum. **But the name is misleading**: this branch is *authenticated-member-only*, and anonymous public forms are explicitly barred from it (`:14199-14204`). (b) `'rest'` — accurate (an authenticated HTTP write) but loses the provenance that this came through a form view. (c) a **new** value, e.g. `'form-edit'`. | **(a)**, with the caveat stated plainly. D-1 set the precedent that the declared slots are meant to be filled, and provenance ("this came from a form") is the useful signal for History Center. If the owner finds the name actively misleading, **(c)** is clean and cheap (the type is an open union — `\| string`). I do **not** recommend (b). |
| **OD-3** | `actorId` provenance | The branch is authenticated-only, so `getRequestActorId(req)` is always populated. Should the revision carry it (making the member accountable in History Center), or be actor-less? | **Carry it.** An audit trail whose entire purpose is answering "who changed this" should not discard a known actor. No real tension here — flagged only because it interacts with OD-2's naming. |
| **OD-4** | **`meta_links` side-effects — ✅ RULED (owner 2026-07-13, authoritative in §0.5): edge-level link history = a SEPARATE deferred design-lock, explicitly UNSOLVED.** The draft's factual claim below was still WRONG and stays corrected: ~~a link-only form edit (`patch` empty ⇒ no `UPDATE`, no version bump)~~ — **FALSE.** Audit (source-verified): the link branch runs `patch[fieldId] = ids` at `univer-meta.ts:14306`, so `patch` is **non-empty** ⇒ control **enters** the UPDATE at `:14423`, writes the ids into `data`, and **bumps version**. A link edit **is** a real `meta_records.data` mutation, UNCAPTURED like every other bucket-A site. | **Per the owner ruling (§0.5 OD-4):** the form slice captures link-field **ids** exactly as ordinary `data` in the revision snapshot — nothing more. **Edge-level `meta_links` history is NOT in this lock**; it is a separate future design-lock, and no link-only change may be claimed to have complete history until that lock lands. *(An earlier revision of this cell read "IN SCOPE for lane A … restoration-consistency golden … Do NOT defer" — that contradicted the ruling and is superseded; re-review P2.)* |
| **OD-5** | **Existing polluted history** | Records already form-edited on prod carry a live row whose `version`/`data` disagree with their last revision. The fix is **forward-only** — it does not repair them. A later normal-path write *incidentally* heals PIT for `T ≥` that write (the next revision's snapshot is the full current row), but the intervening window stays wrong forever, and the destroyed-by-revert cases are gone for good. | (a) forward-only, document it (D-1's stance). (b) a backfill/reconciliation rung. | **(a)** — a backfill would have to *invent* a `created_at` for a revision that was never taken, which is precisely the "no heuristic backfill, ever" red line D-2 §1.2 already drew for anchors. Do not fabricate history. Say so in the PR. |
| **OD-6** | **The systemic guard (see §7)** | Should a **revision-disposition guard** — the direct analogue of the rank-8 lock-disposition guard — be commissioned, forcing every `meta_records` mutation site to declare `// revision-emitted:` / `// revision-exempt:`? | **Yes — and §7a upgraded this from "nice hardening" to "the actual finding."** Eight live sites, found by hand, years apart, three separate audits (rank-8, D-1, this one), each fixing the sinks it happened to look at. The *instance* is D-1c; the *bug* is that nothing forces a new `meta_records` sink to declare a revision disposition. Commission it as a **separate rung** (not bundled into D-1c) — §7 states the honest complexity, including that it is **not** a free extension of the rank-8 guard (that scanner ignores `INSERT`, which a revision guard must cover). |

> **OD-2 is coupled to OD-1 — worth ruling on them together.** My "`'public-form'` is a misleading name" caveat holds **for the EDIT branch**, which is authenticated-only. But if the owner rules OD-1 = (b) or (c), the **CREATE** branch (A6) is also fixed — and *that* branch **can** be a genuinely anonymous public-form submission, where `'public-form'` is exactly accurate. So the real question underneath OD-2 is: **does `source` describe the *surface* (the form endpoint) or the *actor* (the auth level)?** If the surface — `'public-form'` is right for both branches and the caveat dissolves. If the actor — the two branches want *different* sources. The lock does not presume; the owner rules.

**Unlock phrasing, for reference** (mirroring D-1 §8): 「ratify D-1c EDIT-only」/「ratify D-1c + CREATE(D-1b)」/「ratify D-1c + 委托 revision-disposition guard」/「ratify 全量 bucket-A sweep」.

---

## §6 Goldens that would pin the fix (**specified, not written** — they land with the implementation, after ratification)

Fail-first and mutation-proven, per the line's convention. Real-DB, driving the **real route** (never hand-rolled SQL for the path under test).

| # | Scenario | Assertion |
|---|---|---|
| **G0** | **POSITIVE CONTROL** — a **normal-path** edit (`PATCH /records/:id`) on the same sheet in the same harness | emits `action:'update'`, and `reconstructRecordsAtT(now)` returns the **new** value @ the **new** version. *Without this leg the suite would still pass if the reconstructor were broken in the other direction; it is what makes a green run mean something.* |
| **G1** | form-submit EDIT via `POST /views/:viewId/submit` (`recordId` + `expectedVersion`) | a revision row exists with `action:'update'`, `version` = the post-`UPDATE` version, `source` per **OD-2**, `actorId` per **OD-3** |
| **G2** | `reconstructRecordsAtT(T > edit)` | returns the **post-edit** data **and** the post-edit `version` (today: pre-edit data @ pre-edit version) |
| **G3** | `reconstructRecordsAtT(T < edit)` | still returns the **pre-edit** data — the new revision must not corrupt earlier T (D-1's D1-3 shape) |
| **G4** | **snapshot is the FULL merged row, not the patch** | edit **one** field of a two-field record ⇒ the revision's `snapshot` contains **both** fields. *Pins the `data || patch` merge trap in §4.2 — a naive `snapshot: patch` passes G1/G2 on a single-field record and silently truncates every real one.* |
| **G5** | **the destructive leg** — `revert-preview` at `asOf` **after** the edit | proposes **zero** reverts for that record (`visibleRevertCount: 0`). *This is the golden that actually pins the data loss; G2 alone would pass a fix that emitted a revision with the wrong `version`.* |
| **G6** | **audit trail** — `GET …/records/:id/history` | the form edit appears as an item; `restore-preview(targetVersion: <the form version>)` no longer 404s |
| **G7** | **atomicity** (available here, unlike D-1) | inject a failure into the revision INSERT ⇒ the whole transaction rolls back: the record is **not** updated and **no** revision exists. **No half-state.** Because the path is already inside `pool.transaction` (`:14396`), this is a *real* golden, not D-1's degraded substitute. |
| **G8** | **mutation** | delete the `recordRecordRevision(...)` call ⇒ **G1, G2, G5, G6 all go red**. A guard that cannot be neutered into redness is not a guard. |

**Wiring (mandatory, per the line's two-point convention).** A new real-DB golden file must be added in **both** places or it silently never runs: `packages/core-backend/vitest.config.ts` **exclude** list (so the no-DB job cannot skip-green it) **and** the `plugin-tests.yml` run-list. Precedent verified this session: `multitable-d1-delete-revision-parity-realdb.test.ts` appears at `vitest.config.ts:189` **and** `plugin-tests.yml:273`.

---

## §7 The systemic question — a **revision-disposition guard** (OD-6)

**The pattern.** `meta_records` mutation sites are audited *by construction* for the **record lock** — `tests/unit/multitable-record-lock-guard.guard.test.ts` walks the whole `src` tree and **fails** on any `UPDATE`/`DELETE` site lacking an explicit `// lock-guarded:` / `// lock-exempt:` / `// lock-mgmt:` marker. Its header states its own origin: the lock had been *"bolted on one sink at a time, and new sinks silently bypassed it."*

**Revisions are in exactly that pre-guard state today — and §7a proves it quantitatively.** D-1 fixed two sinks (automation-delete, plugin-delete) one at a time; D-1c would fix a third; **§7a found five more**. That is **eight live sites**, discovered by three independent human audits (rank-8, D-1, this one), each closing only the sinks it happened to be looking at, each shipping with the rest still open. There is **no structural guard** that would have caught any of them.

That is the definition of the whack-a-mole the rank-8 guard was built to end — **for the lock**. The identical whack-a-mole is running, unguarded, **for revisions**, and it has been running longer.

**A revision-disposition guard would prevent the class**: every `meta_records` mutation site must carry `// revision-emitted:<why>` or `// revision-exempt:<why>`, or CI goes red. A new sink cannot be added silently.

**The honest complications** — this is a recommendation, not a slam-dunk, and the owner should rule with these in view:

1. **It is *not* a free extension of the rank-8 guard.** That guard's `MUTATION_RE` (`:93-94`) matches only `UPDATE meta_records` / `DELETE FROM meta_records` — **`INSERT INTO meta_records` is deliberately not matched** (you cannot lock a record that does not exist). A *revision* guard **must** cover INSERT, because creates need `action:'create'` revisions. It is a **new scanner**, sharing only the shape.
2. **"revision-exempt" is a genuinely fuzzier category than "lock-exempt."** Lock-exempt is crisp: *no user actor*. Revision-worthiness is a judgment call at every system sink — does a formula recompute deserve a revision? An auto-number backfill? A field-drop that strips a key from every row's `data`? Reasonable engineers will disagree, and a guard that forces a marker without a crisp rule risks becoming a rubber stamp (`// revision-exempt: system op` on everything).
3. **It will surface a non-trivial backlog on day one.** The marker sweep will force a disposition ruling on ~30 existing sites (§7a) — that is the *point*, but it is real work and must be scoped as its own rung, **not** smuggled into D-1c's correctness fix.

**Recommendation: yes, commission it — as a separate, explicitly-scoped rung, after D-1c lands.** It is the only proposal here that addresses the *class* rather than the instance, and the rank-8 guard is proof the pattern works in this codebase. But it is a **guard-design task with a real judgment problem at its centre** (complication 2), and pretending otherwise would be exactly the kind of inflation this line does not want.

### §7a Sibling audit — every `meta_records` mutation site, by revision disposition

Method: every `UPDATE` / `INSERT INTO` / `DELETE FROM meta_records` site in `packages/core-backend/src` (migrations excluded) was enumerated and its **enclosing function** read. A site emits a revision **iff its own enclosing function contains one of the 13 `recordRecordRevision(...)` call sites** — indirect emission was ruled out: the only subscribers to `multitable.record.created/updated/deleted` are `webhook-event-bridge.ts:36-38` and `automation-triggers.ts:88-90`, and **neither writes revisions**.

#### Bucket A — user-data mutation, **NO revision** — the bug class (8 sites)

| # | Site | What it is | Bumps `version` | Status |
|---|---|---|---|---|
| A1 | `routes/univer-meta.ts:14423` | **form-submit EDIT** | yes | **REPRODUCED end-to-end** (§3) — this lock |
| A2 | `multitable/records.ts:507` | **plugin-SDK `patchRecord`** | yes | **REPRODUCED** (§3, spot-check): live `sib-v2-via-plugin`@v2, revisions `[create v1]`, `reconstructRecordsAtT` → `sib-v1`@v1 |
| A3 | `multitable/automation-executor.ts:2217` | **automation `update_record`** action | yes | source-verified — the file's only emitter (`:2365`) is inside `executeDeleteRecord` |
| A4 | `multitable/automation-executor.ts:2475` | **automation `create_record`** action | INSERT v1 | source-verified |
| A5 | `multitable/records.ts:546` | **plugin-SDK `createRecord`** | INSERT v1 | source-verified |
| A6 | `routes/univer-meta.ts:14470` | **form-submit CREATE** | INSERT v1 | source-verified — D-1 §6's deferred "D-1b", **in the same handler as A1** |
| A7 | `multitable/automation-service.ts:2818` | **approval `resultWriteback`** patch (same-base `:2696` / cross-base `:2762`) | yes | source-verified — the file contains **zero** `recordRecordRevision` references |
| A8 | `routes/univer-meta.ts:15693` | **attachment-delete** strips the deleted attachment id out of the record's cell | yes | source-verified — `SET data = data \|\| $1::jsonb, … version = version + 1`; a real user-data edit |

> **The most consequential single line in this document:** **D-1 fixed only the *delete* half of the side doors.** It added `delete` revisions to the automation lane (`:2365`) and the plugin lane (`:650`/`:771`) — but **never added `create` or `update` revisions to those same lanes** (A3, A4, A5, A2). The result is *worse than silence*: an automation- or plugin-created record has **no create revision**, so `reconstructRecordsAtT` never sees it exist at all — yet if automation later deletes it, D-1 dutifully writes **a `delete` revision, with a full snapshot, for a record that has no `create` revision**. The history of such a record is a delete with no birth.

#### Bucket B — user-data mutation, **has revision** — correct (12 sites)

`record-service.ts:679`→`706` (REST create) · `:892`→`845` (REST delete) · `:1087`→`1125` (trash restore) · `:1385`→`1392` (REST patch) · `record-write-service.ts:971`/`979`→`998` (bulk patch) · `records.ts:684`→`650` & `:755`→`771` (plugin delete, D-1/D-2) · `automation-executor.ts:2410`→`2365` (automation delete, D-1) · `univer-meta.ts:6429`→`6454` (lossy-retype revert, one revision per changed cell) · `:10168`→`10178` (PIT resurrect) · `:10395`/`10403`→`10416` (PIT reset revert) · `:10528`→`10498` (PIT reset delete).

#### Bucket C — system/schema/metadata op, revision-free **by design** (11 sites)

`auto-number-service.ts:101` (auto-number backfill) · `formula-engine.ts:345` + `univer-meta.ts:2960`, `:3855` (formula / relation-aggregation materialization) · `univer-meta.ts:5173`/`5189` (system People-sheet sync) · `:5807` (`createSeededSheet` — a hardcoded demo preset at sheet birth, **not** caller content) · `:6151` (`dropFieldCascade` — captured instead by `recordConfigRevision` + field-value tombstones) · `:16261`/`16275` and `automation-executor.ts:3412`/`3422` (lock/unlock — **columns only, `data` untouched**; note these *do* bump `version`, so they open version-sequence gaps, but they are **not** a PIT *data*-correctness bug).

#### Bucket D — needs a human ruling (2 sites)

- **`univer-meta.ts:6521` — `recreateFieldFromConfig` (field-undelete rehydration).** It writes **captured user cell values** back into records (`SET data = data || jsonb_build_object($3::text, t.value) FROM meta_field_value_tombstones t`) with **no version bump and no revision**. Its structural sibling at `:6429` (lossy-retype revert) does the same class of sheet-wide field-value rewrite and **does** emit one revision per changed cell (`:6454`), explicitly rationalized as *"C5 history completeness … what makes the lossy revert itself undoable."* **Why does one field-value restore emit and its mirror not?** Only someone who knows the 4c-2 design intent can rule.
- **`approval-record-projection-service.ts:223` — `reconcile()` projection upsert.** Bumps `version` and rewrites `data`, so it trips the fingerprint — but it is a **derived projection** continuously re-materialized from the approval-instance table (the real source of truth), on a system-owned sheet. Leans "C by design"; PIT of that system sheet would simply be empty. Owner's call.

#### The lint rule that falls out — and its one honest hole

All 8 bucket-A sites share the fingerprint **"writes `data` + bumps `version` (or inserts v1) + no `recordRecordRevision`"**, while every legitimately-derived bucket-C op (formula, relation-agg, auto-number, field-drop) **deliberately declines to bump `version`** — `formula-engine.ts:345` says so in as many words: *"No version bump: formula values are derived, not an authoritative user edit."* **The codebase already treats the version bump as the marker of an authoritative user write.** That makes *"`data` changed + `version` bumped + no revision, on a user-authored sheet"* a precise, mechanical detector for this entire class.

**Its hole, stated plainly:** **D-bucket `:6521` is exactly the site that would slip through it** — it restores real user data *without* bumping `version`. So the fingerprint is an excellent 8/8 detector for the known class and **not** a soundness proof. A marker-based guard (the rank-8 shape) does not have this hole, because it forces a *human disposition on every site* rather than inferring one — which is the argument for the marker guard over a clever lint.

---

## §8 What this does **NOT** claim

- **It does not claim the T8-2 reset path was executed.** I executed **revert** (`revert-preview` + `revert-execute`). Reset (`computeSheetReset`, `:10028`) consumes the **same** `reconstructRecordsAtT` output in the same shape, so it is affected **by construction** — but I did not drive it, and I will not dress an inference as a measurement.
- **It does not claim all eight bucket-A sites were executed.** **Two were: A1** (form-submit EDIT, full blast radius incl. executed data loss) and **A2** (plugin-SDK `patchRecord`, PIT divergence). The other six (**A3–A8**) are **source-verified only** — enclosing function read, emitter absence confirmed, indirect emission ruled out. They carry the identical fingerprint and feed the identical reconstructor, so I believe they are the same bug; but "believe, with the source in front of me" is not "executed", and §7a labels each one accordingly. **Do not let anyone cite A3–A8 as measured.**
- **It does not claim the §7a lint fingerprint is sound.** It is an 8/8 detector for the *known* class and explicitly **misses D-bucket `:6521`**. That hole is stated in §7a, not buried.
- **It does not claim the bug is attacker-triggerable or self-triggering.** The destructive legs need an operator with `canManageSheetAccess` to run a sheet revert/reset. Nothing corrupts data unprompted. The **read-only** lie and the **audit hole** are, however, unconditional and need no operator at all.
- **It does not claim the CREATE half is newly discovered.** D-1 §6 named it. This document's contribution on that front is only the **evidence** that it lives in the same handler as the EDIT half, and the **question** (OD-1) of whether to close them together.
- **It does not claim `'public-form'` is the right `source`.** It claims only, and verifiably, that the slot is **declared and dead**, and that the branch is **authenticated-only** — which makes the name arguably wrong. That is a decision (OD-2), not a finding.
- **It does not claim link-edge history is covered.** OD-4 is explicitly deferred, not solved. A link-only form edit remains invisible to history even after D-1c.
- **It does not claim the existing polluted production history can be repaired.** It cannot, without fabricating timestamps (OD-5).
- **It ratifies nothing.** Status is **PROPOSED**. Every recommendation in §5 is advisory and several are deliberately flagged as reversible by the owner.

---

## §9 Out of scope

Link-edge revision/tombstone capture (OD-4); backfill or repair of already-polluted history (OD-5); the revision-disposition guard **implementation** (OD-6 — recommended as a *separate* rung); any environment flag or flag flip; trash/recoverability semantics (that is D-2's territory and this lock does not touch it); `4d` (never promised); the CREATE half **unless** the owner rules OD-1 = (b).

---

## §10 Implementation routing (only after ratification)

Per OD-1 this is **NOT a single call site** — it is the full A1–A8 sweep across **five independent slices** (§0.5), plus **§0.6 `HISTORY_INCOMPLETE` which lands FIRST**, plus the **OD-6 revision-disposition guard as a separate rung**. Sequence, owner-fixed:

0. **§0.6 precheck** (fail-closed `HISTORY_INCOMPLETE`) — first, guards live data during the backfill.
1. **form** (A1 EDIT + A6 CREATE) → 2. **plugin** (A2 + A5) → 3. **automation** (A3 + A4) → 4. **approval** (A7) → 5. **attachment** (A8).
6. **OD-6 guard** (separate rung; covers INSERT/UPDATE/DELETE).

Each slice is its **own PR** on a strong-model lane with **independent adversarial review** (per-slice: real entry-point golden + same-txn full-snapshot + PIT-correct + rollback + source asserted + txn-boundary re-verified, D-1 §8 convention). Do **not** bundle the five into one hot-core PR — the whole point of the 5-slice split is per-slice txn/actor/source/PIT proof. OD-4's edge-level `meta_links` history is a **separate deferred lock**, not part of this routing; the form slice captures link-field ids as ordinary `data`, nothing more.
