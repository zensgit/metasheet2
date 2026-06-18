# 多维表开发完成度核验 — 2026-06-18

> Status: **VERIFICATION** of the `/goal` "complete all development per the plan/TODO MD".
> Grounding: `origin/main@9f68ed67c`, code-anchored (not doc-marker — stale-marker traps this session, see §5).
> Authoritative plan: **`multitable-gated-remainder-development-plan-20260618.md` (#2828)**, which **supersedes** `multitable-current-development-plan/todo-20260617.md` (#2801).
>
> ### ⟳ REFRESHED 2026-06-18 (re-verified on `origin/main@0c6e8a8d9` — supersedes §0/§2/§6 below for current status)
> Since this doc's first draft, two gates advanced:
> - **2a · live-CRDT field types — COMPLETE.** dateTime shipped (2a-DT-S2 #2849, canonical-UTC-ISO invariant) on top of select/date (#2832) + duration (#2838); the full scalar set is collaborative, no type deferred. Closed in the ledger by #2851.
> - **2b · conditional permission rules — shipped through S3** (S1 #2836, S2 #2841 wired into the #18 seam flag-off-inert, S3 #2847; S0 rule/threat model settled by them). Only **2b-S4 (perf/caching)** remains and is **demand-gated**. Ledger refreshed by #2855.
>
> **FINAL VERIFIED STATE: no non-gated multitable runtime work is open.** The entire remainder is **2b-S4 (demand-gated — do only on a real large-rule-set perf need) + 2c (person org-directory, owner-gated on a directory source-of-truth decision; #2833 shipped the assignment-validator part).** The accurate live ledger is `multitable-gated-remainder-development-plan/todo-20260618.md`. The §0/§2/§6 below are retained as the original session-closeout snapshot (when 2a/2b were still open).

## 0. Headline

Per the current authoritative plan (#2828): **the multitable mainline has no non-gated residual runtime work.** The entire remainder is **three gated arcs**, each of which the plan explicitly says must not be started "without an explicit opt-in for that gate." Everything from #2801's P3–P7 list was reclassified by #2828 as a **future roadmap pool**, not active remainder.

So "complete all development" resolves to: the **non-gated** work is done; the **gated** remainder needs **owner opt-in + design decisions per gate** (which only the owner can give) and must not be built autonomously.

## 1. Completed this session (code-anchored)

| Item | Status | Evidence |
|---|---|---|
| **P1 — native person `restrictToMemberGroupIds` / org-member assignment enforcement** | **DONE on main** (not by me) | Landed via **#2833** ("#16 person field org-member directory — fail-closed assignment validator", `fe7cdde3b`). `record-write-service.ts` on main carries the per-field restrict resolution + fail-closed validator. My parallel build (PR #2831) was **redundant** — built against an older main before #2833 merged — and is **closed**; the moot e2e follow-up #2837 is closed. |
| **P2 — stale PR hygiene** | **DONE (me)** | Closed #2495, #2508, #2522 (superseded docs PRs) and #2499 (near-duplicate of the merged #2503 template dry-run). All four CLOSED. |

## 2. The actual remainder — all GATED (#2828)

None of these is autonomously buildable; each needs an explicit owner opt-in + the listed design decisions.

| Arc | Scope | Gate / owner decisions required |
|---|---|---|
| **2a · Live CRDT — `dateTime` only** | Open the last string-stored atomic to live collaborative editing | **`select` + `date` (#2832) and `duration` (#2838) already shipped live-CRDT** (verified: `MetaCellEditor.vue` binds them via `useYjsScalarCell`). `dateTime` is the **sole** remainder, explicitly DEFERRED in `MetaCellEditor.vue:506,517` because the backend codec normalizes it to canonical UTC ISO — binding to plain-value LWW risks timezone drift + old-`Y.Text`-doc corruption. Gate (per #2828's 2a-S4): dateTime canonical/timezone round-trip design + a persisted-doc corruption golden. |
| **2b · #18 phase-2 conditional permission rules** (= #2801's "row-level conditional permission rules", G2) | A new dynamic field-predicate permission model on top of the shipped static row-level read-deny (#18) | **Owner-approved rule model + threat model.** Decisions: rule language/operators, fail-closed defaults, read-only vs read+write+admin, evaluation timing (SQL pushdown / post-query / cached), auditability. Security invariants (no hidden-field existence leak). Slices 2b-S0..S4 after sign-off. Explicitly *not* a small patch on #18. |
| **2c · #16 Person field → true org-member directory** | Deepen the person field into a real org directory | **Owner decision on directory source-of-truth + semantics** (internal `users` / directory-synced groups / external IdP; whether `restrictToMemberGroupIds` becomes a hard rule — partly advanced by #2833; inactive/deleted-user behavior; picker UX). Arc not started. |

## 3. Reclassified to future roadmap pool by #2828 (NOT active remainder)

The #2801 items I had queued — **P3** dashboard polish (missing-bucket fill / series cap), **P4** server-side all-dataset export, **P5** form `required-if`, **P6** dashboard linked filters / drill-down, **G3** standalone `multitable:notify` permission code, **B2** next AI ring — are future-pool. A fresh code-check on `origin/main@9f68ed67c` found only incidental matches (no shipped impl), so they remain *unbuilt*, but #2828 does **not** place them in the active closure ledger. Building them now would be working from a superseded plan.

## 4. Externally blocked (unchanged; cannot be completed autonomously)

`A1` grid virtualization (needs the S5b 50k/100k **ops staging** baseline) · `C1` production SMTP real-send (**ops creds** + dual-confirm env) · `C2` template PM/SME **content** package · `B3` native synced/external-source table (XL + **owner** K3-boundary decision).

## 5. Lessons banked this session

- **Re-verify each slice against *current* `origin/main` immediately before building.** P1 was already shipped by a parallel effort (#2833) while I built it against an older main; the whole build was wasted. The canonical checkout is pinned at a stale commit and main moves fast — ground in a fresh `origin/main` worktree *and* re-check right before coding.
- **One lander per worktree, ever.** Two concurrent landers on the same worktree caused a rebase conflict/abort; never background a second.
- **Real-DB-only tests have no local signal** — they cost a full CI round-trip each; budget for that or test the pure logic at the unit layer.

## 6. Conclusion + recommendation

The non-gated development is complete (P1 already on main; P2 done). The current plan declares **no further non-gated runtime work**; the remainder (2a/2b/2c) is owner-gated by design. To proceed, the owner opens one gate with its decisions — recommended order if desired: **2a `dateTime`** (the lone remaining CRDT field type — design-lock its canonical/timezone round-trip + persisted-doc corruption golden; lowest blast radius) or **2b-S0** (permission rule security design-lock; highest security value). I will not start any gated arc without that explicit opt-in.
