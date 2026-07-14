# MetaSheet Time Machine — W0 verification + W0-1 correctness conditions (design & verification)

**Date:** 2026-07-13 · **Status:** VERIFICATION + GAP-ANALYSIS + PLAN (not a completion declaration)
**Scope:** the Global History / Time Machine "trustworthiness" gate (W0) and the corrected `HISTORY_INCOMPLETE` precheck (W0-1, PR #4250).

> This document records **what is verified-landed on `main` today**, the **residual recovery-correctness conditions that remain open**, and the **load-bearing conditions W0-1 must satisfy before it can be ratified**. Every claim below is anchored to code on `origin/main` (`file:line`) or to a runnable golden. It does **not** claim the Time Machine is finished; the remaining line is multi-week and partly owned by a parallel session (see §7).

---

## 1. Verified current state on `main` (2026-07-13)

The **8-path revision gap is substantially closed** and the first fail-closed precheck is wired — landed by a parallel session and verified here via `gh` + `git show origin/main`:

| Item | PR | State | Verified |
|---|---|---|---|
| Form CREATE/EDIT emit public-form revision | #4245 | **MERGED** | slice ① |
| Plugin-SDK createRecord/patchRecord emit revision | #4246 | **MERGED** | slice ② |
| Automation create_record/update_record emit revision | #4247 | **MERGED** | slice ③ |
| Approval resultWriteback emits approval revision | #4248 | **MERGED** | slice ④ |
| Attachment-delete cell-strip emits attachment revision | #4249 | **MERGED** | slice ⑤ |
| D-1c revision-gap design lock | #4187 | **MERGED** | — |
| §0.6 `HISTORY_INCOMPLETE` fail-closed precheck | #4234 | **MERGED**, ratified 2026-07-13 | wired at `univer-meta.ts` revert `:9951` + reset `:10031`, refuses with `HISTORY_INCOMPLETE` `:10079` |
| §0.6 precheck (earlier draft) | #4235 | OPEN (Draft) | **superseded by #4234** — should be closed; port its 13 real-DB goldens into W0-1 |
| W0-1 contiguity + trusted-since design lock | #4250 | OPEN | **REQUEST_CHANGES** — see §3 |
| R13/R14 revision-completeness + parity MD | #4214 | OPEN | now stale relative to landed main; superseded by this doc for W0 |
| T-state (deleted-since-T view + preview/restore) | #4205 | OPEN (docs) | backend **not landed** → P2 FE is blocked on it |

**Already strong (verified in code):** signed preview + CAS + re-enumeration + typed-confirm + transaction atomicity; operator/source/field filters; permission masking; audit-authorized reveal; single-field / single-record / explicit-batch restore; Revert; Reset; trash; tombstone; config history + multi-class config restore. Fine-grained restore already **exceeds** Feishu's public spec (Feishu explicitly does not support restoring a single table/view, and archived records cannot be restored to a chosen historical instant).

---

## 2. The merged precheck (#4234) is a partial guard

The precheck merged in #4234 is a **live-vs-latest (content, not version)** comparator (`history-integrity-precheck.ts`: `latestByRecord` per record `:125`, live-row enumeration `:135`, live `data` vs latest snapshot). It correctly refuses the cases it was specced for — polluted tail, zero-revision live row, live-row-after-delete — but by construction it does **not** yet cover the residual conditions enumerated in §3 (C1–C8): chain-shape holes, ordering under concurrency, deleted-record chains, and the check-vs-write boundary. Until those land it should be treated as a **partial** guard, not a complete one.

The specific residual windows, their reachability, and whether an interim operator-level gate is warranted ahead of W0-1 were provided to the maintainer **directly** (repo is public); this document keeps to the design-level conditions below.

---

## 3. Why #4250 (W0-1) is REQUEST_CHANGES — eight load-bearing conditions

The W0-1 direction (version-contiguity + trusted-since + same-txn re-check) is correct but **insufficient as drafted**. Each condition below is anchored to verified `main` code.

- **C1 — Contiguity is necessary but not sufficient.** A version with no chain entry = an uncaptured data write = the gap. Necessary. But see C2.
- **C2 — Version-contiguity ≠ time-T correctness.** Reconstruction sorts by `created_at`, not version: `DISTINCT ON (record_id) … ORDER BY record_id, created_at DESC, version DESC, id DESC` (`record-reconstructor.ts:54`) with `WHERE created_at <= T`. And `created_at` defaults to `now()` = **transaction-start time** (`zzzz20260430172000_create_meta_record_revisions.ts:18`). Concurrent transactions can therefore produce **version-ascending-but-time-descending** rows; even a fully contiguous v1/v2/v3 chain can select the wrong snapshot for a given T. **W0-1 must add a version↔event-time monotonicity proof, or redefine the PIT time anchor** (e.g. anchor on a monotonic per-record sequence rather than wall-clock `created_at`).
- **C3 — Live-only enumeration misses deleted-record healed-gaps.** The precheck enumerates live rows only (`history-integrity-precheck.ts:135`). But Revert **resurrects** records that existed at T and are now deleted. A deleted record with `v1 / missing v2 / delete v3` can still be resurrected as v1. **W0-1 must cover live + tombstoned/deleted chains.**
- **C4 — `FOR UPDATE` on scope rows does not stop phantom inserts.** Locking existing rows does not block concurrent creation of new records; Reset's delete-set drifts as a result. **W0-1 must adopt one of:** SERIALIZABLE + in-txn re-enumeration; a sheet-level lock all writers honor; or a per-sheet advisory transaction lock. "Scope rows `FOR UPDATE`" alone is insufficient.
- **C5 — The chain criterion must be an exact set, not a count.** There is **no `UNIQUE (sheet_id, record_id, version)`** constraint — only a plain index `idx_meta_record_revisions_sheet_record_version` (`zzzz…172000:23`). So `count(distinct version)` cannot reject conflicting duplicates, out-of-range versions, or a same-version marker+revision pair. **W0-1 must require exactly one canonical chain event per expected version and fail-closed on duplicate/out-of-range** (add the unique constraint).
- **C6 — Trusted-since needs a real anchor + rollout protocol.** Setting `trusted_since = current version` provides no snapshot/checkpoint for that version, so after deploy and before the next write, the record still cannot be reconstructed. **W0-1 must create a data checkpoint at the controlled cutover, handle rolling deployment (old instances still writing across the regime boundary), and persist the watermark so it survives record deletion** (not stored only on `meta_records`).
- **C7 — Marker blast radius must be closed.** `action CHECK (action IN ('create','update','delete'))` (`zzzz…172000:12`) rejects any lock/unlock/checkpoint marker. If W0-1 adopts lightweight-revision markers it **must** migrate the CHECK, close the vocabulary type, and sync History UI, retention, and the reconstructor. Note also that **automation lock/unlock** bumps `version` too, not just the route lock/unlock — both writers need markers.
- **C8 — Execute re-check must be inside the destructive transaction.** Move the execute-path precheck **inside** the same locked transaction as the recovery write (after the C4 fence), so check and write are atomic. Preview may keep its precheck outside a txn.

**Ratify blocker:** #4250 must incorporate C1–C8 before it is landable. Until then, #4234 remains the only (insufficient) guard and §2's residual risk stands.

---

## 4. Corrected W0 implementation order (dependency-sorted)

1. **(owner call) Interim gate** — default-off master flag on `revert-execute` (§2), or accept the residual risk window. *Fable/Sonnet — mechanical, fail-closed.*
2. **Chain-event schema** — `UNIQUE (sheet_id, record_id, version)` (C5); marker vocabulary + `action` CHECK migration + closed type (C7); checkpoint column that survives deletion (C6). *Opus — schema/txn design; zzzz-ordered migration, fresh-DB full-migrate proof.*
3. **Persistent integrity ledger + trusted anchor** covering live + deleted chains (C3, C6). *Opus.*
4. **Two-phase rollout** so old instances cannot write across the regime boundary (C6). *Opus — design; Sonnet — impl.*
5. **Exact contiguity + time-monotonicity + content-consistency checks** (C1, C2, C5). *Opus.*
6. **Re-enumerate + precheck + execute inside SERIALIZABLE / unified scope fence** (C4, C8). *Opus.*
7. **Goldens** — healed-gap, deleted-gap, time-reversal, duplicate-version, concurrent insert/update, watermark, lock + automation-lock. *Sonnet — real-DB, mutation-proven.*
8. **`#4227` revision-disposition guard** converges as markers land; then **`#4205` T-state**. *Sonnet / Fable.*

**Model dispatch rationale (per owner policy):** Opus for the schema/transaction/concurrency/adversarial correctness (steps 2–6); Sonnet for locked-spec implementation and real-DB goldens (steps 1, 7); Fable/Sonnet for mechanical FE and the interim flag.

**Estimates (owner-adopted):** safe-usable Time Machine ≈ **8–12 person-weeks**; strict Feishu-core parity (full version canvas + one-click whole-base restore) ≈ **12–20 pw**; clearly-surpassing (>5000 async job, faithful edge-level link history) ≈ **16–28 pw**. Phased: W0 4–6 · T-state 3–5 · base-wide restore 4–7 · scale & relations 4–8 · launch 1–2.

---

## 5. What is deliberately NOT started (owner constraints)

- **No new recovery flags enabled** — owner: "先把 W0 做成可信闭环；之后 #4205；最后整库恢复." W0-1 must be a trustworthy closed loop first.
- **Base-wide one-shot restore** (Feishu-parity whole-base preview/execute) — gated on the R14 A/B owner decision; not started.
- **Edge-level `meta_links` time history** — an explicitly separate design lock (OD-4); link ids reaching the record snapshot is **not** the same as edge-level link history.
- **No doc-declared completeness** — this MD is a gap-analysis, not a "done" claim.

---

## 6. Verification evidence

### 6.1 Healed-gap counterexample (durable — must become a fail-first test in the W0-1 branch)

Preserved golden (was at `/tmp/r13-w0-healed-gap-golden.txt`; owner flagged `/tmp` is not persistent, so it is embedded here) — this is the **W0-1 acceptance target**, not a report of a live exploit. A record at `version 3` with revisions at **only v1 and v3** (v2 uncaptured): live `data == v3`, so a live-vs-latest comparator **passes** it, but `revert-preview` to `T1 ∈ (v1, v3)` must be refused `409 HISTORY_INCOMPLETE`. W0-1 (contiguity, C1/C2/C5) must make this **green**; a live-vs-latest comparator alone does not.

```js
describe('OWNER P1 healed-gap (design-flaw proof)', () => {
  const HG = `rec_hi_healedgap_${TS}`
  beforeEach(async () => {
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,3)',
      [HG, SHEET, JSON.stringify({ [NAME]: 'hg-v3-healed', [SALARY]: 300 })])
    await rev(HG, 1, 'create', { [NAME]: 'hg-v1', [SALARY]: 100 }, T0)
    await rev(HG, 3, 'update', { [NAME]: 'hg-v3-healed', [SALARY]: 300 }, T2) // NO v2 — uncaptured mid-chain write
    await seedCtrl()
  })
  test('acceptance: revert-preview to a T inside the gap window is refused HISTORY_INCOMPLETE', async () => {
    expect((await recordRow(HG))?.version).toBe(3)
    expect(await revisionCount(HG)).toBe(2)          // version 3 but only 2 revisions ⇒ chain provably incomplete
    const res = await revertPreview(T1)              // T1 ∈ (v1@T0, v3@T2) — the gap window
    expect(res.status).toBe(409)                     // W0-1 (contiguity) refuses; a live-vs-latest comparator alone does not
    expect(res.body?.error?.code).toBe('HISTORY_INCOMPLETE')
  })
})
```

### 6.2 Golden matrix W0-1 must ship (real-DB, mutation-proven, two-point CI-wired)

| Golden | Asserts | Mutation that must red it |
|---|---|---|
| healed-gap (6.1) | gap-window T ⇒ 409, zero writes (revert+reset, preview+execute) | remove contiguity check |
| deleted-gap (C3) | tombstoned record with mid-chain hole ⇒ refused on resurrect | live-only enumeration |
| time-reversal (C2) | version-ascending/time-descending chain ⇒ correct T-snapshot or refuse | sort by version-only |
| duplicate-version (C5) | dup/out-of-range `(record_id, version)` ⇒ fail-closed | count-based criterion |
| concurrent insert/update (C4) | phantom insert between check and write ⇒ caught in-txn | scope-rows `FOR UPDATE` only |
| watermark (C6) | pre-first-write-post-cutover record reconstructs from checkpoint | `trusted_since = version` with no checkpoint |
| lock + automation-lock (C7) | marker-only version bumps ⇒ pass (not false-refused) | remove lock-marker write ⇒ this reds |
| positive control | full healthy chain ⇒ any T passes | (guards against refuse-everything) |

### 6.3 Prior session verification carried forward
- 3 revision lanes (form/plugin/automation) implemented + mutation-proven 2-field merge-trap goldens (now landed as #4245–#4247).
- OD-6 disposition guard #4227 — 14 emitted + 13 exempt + 9 pending markers, INSERT-covering, CI `test(20.x)` green.
- #4234 precheck: 13 real-DB goldens G-HI-1..4 + G-HI-3-link + TOCTOU (spec-faithful to the live-vs-latest spec; insufficient per §3).

---

## 7. Coordination note

A **parallel `zensgit` session** owns the active W0 execution (the merged slices #4245–#4249, the merged precheck #4234, and the open W0-1 lock #4250). GitHub cannot distinguish parallel sessions. To avoid destructive-path races this session did **not** fan out duplicate W0-1 implementation; this document is the non-duplicative deliverable (verification + the C1–C8 correctness spec that moves #4250 from REQUEST_CHANGES toward ratifiable). Recommended: **close superseded #4235** (port its goldens), fold C1–C8 into #4250, and keep this session off the W0 backend impl unless the owner reassigns the lane.
