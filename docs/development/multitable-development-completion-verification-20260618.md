# 多维表开发完成度核验 — 2026-06-18

> Status: **VERIFICATION** of the `/goal` "complete all development per the plan/TODO MD".
> Grounding: `origin/main@9f68ed67c`, code-anchored (not doc-marker — stale-marker traps this session, see §5).
> Authoritative plan: **`multitable-gated-remainder-development-plan-20260618.md` (#2828)**, which **supersedes** `multitable-current-development-plan/todo-20260617.md` (#2801).
>
> ### ⟳ REFRESHED 2026-06-18 (re-verified on `origin/main@0c6e8a8d9` — supersedes §0/§2/§6 below for current status)
> Since this doc's first draft, two gates advanced:
> - **2a · live-CRDT field types — COMPLETE.** dateTime shipped (2a-DT-S2 #2849, canonical-UTC-ISO invariant) on top of select/date (#2832) + duration (#2838); the full scalar set is collaborative, no type deferred. Closed in the ledger by #2851.
> - **2b · conditional permission rules — COMPLETE through S4** (S1 #2836, S2 #2841 wired into the #18 seam flag-off-inert, S3 authoring UI+API #2847, S4 content-keyed parse cache #2861). No remaining 2b work.
>
> **FINAL VERIFIED STATE: no non-gated multitable runtime work is open; 2a + 2b are fully shipped and 2c is through S2.** The **only in-progress arc is 2c** (person org-directory): source-of-truth **DECIDED = B member-group directory** (design-lock #2860), with the fail-closed assignment enforcement (#2833 + #2854) and the S2 directory resolver (#2866) shipped. 2c is **no longer source-blocked**; what remains is **S3 picker-UX + S4 inactive/historical handling**. #17 grid-virtualization is verdicted not-needed (reopen-only). The accurate live ledger is `multitable-gated-remainder-development-plan/todo-20260618.md`. The §0/§2/§6 below are retained as the original session-closeout snapshot (when 2a/2b were still open).

## 0. Headline

Per the current authoritative plan (#2828), updated for the work shipped since: **the multitable mainline has no non-gated residual runtime work; 2a + 2b are fully shipped and 2c is through S2.** 2a (live CRDT — full scalar set) is COMPLETE (#2832/#2838/#2849); 2b (conditional permission rules) is COMPLETE through S4 (#2836/#2841/#2847/#2861 parse cache); 2c #16 person directory has **source-of-truth decided = B** (design-lock #2860) with the fail-closed assignment enforcement (#2833 + #2854) and S2 directory resolver (#2866) shipped — remaining is S3 picker-UX + S4 inactive/historical handling. Everything from #2801's P3–P7 list remains a **future roadmap pool** (#2828), not active remainder.

So "complete all development" resolves to: the planned arcs are **built + verified + on main**; the **only in-progress arc is 2c** (source already decided = B; remaining S3 picker-UX + S4 inactive/historical), with #17 grid-virtualization reopen-only — neither to be built autonomously. (§2/§6 below are updated to this state; the original snapshot is preserved in git history.)

## 1. Completed this session (code-anchored)

| Item | Status | Evidence |
|---|---|---|
| **P1 — native person `restrictToMemberGroupIds` / org-member assignment enforcement** | **DONE on main** (not by me) | Landed via **#2833** ("#16 person field org-member directory — fail-closed assignment validator", `fe7cdde3b`). `record-write-service.ts` on main carries the per-field restrict resolution + fail-closed validator. My parallel build (PR #2831) was **redundant** — built against an older main before #2833 merged — and is **closed**; the moot e2e follow-up #2837 is closed. |
| **P2 — stale PR hygiene** | **DONE (me)** | Closed #2495, #2508, #2522 (superseded docs PRs) and #2499 (near-duplicate of the merged #2503 template dry-run). All four CLOSED. |

## 2. The actual remainder — all GATED (#2828)

None of these is autonomously buildable; each needs an explicit owner opt-in + the listed design decisions.

| Arc | Scope | Gate / owner decisions required |
|---|---|---|
| **2a · Live CRDT — COMPLETE (full scalar set)** | Open every scalar field type to live collaborative editing | **DONE — no scalar type remains REST-only.** `select` + `date` (#2832, lazy `coerceText` dual-reader), `duration` (#2838, commit-on-confirm LWW), and `dateTime` (#2849) all bind via `useYjsScalarCell`. `dateTime` shipped with a **canonical-UTC-ISO value invariant** (the codec normalizes to UTC ISO; the live path preserves that exact form) + a persisted-doc corruption golden — closing the timezone-drift / old-`Y.Text` concern that had deferred it. No remaining 2a gate. |
| **2b · #18 phase-2 conditional permission rules — COMPLETE (through S4)** | Dynamic field-predicate read-deny on top of static #18 | **DONE: S1 evaluator #2836 · S2 enforcement #2841** (wired into the #18 `loadDeniedRecordIds` seam, flag-off inert, fail-closed, admin-bypass, no cardinality leak) **· S3 authoring UI + API #2847 · S4 content-keyed parse cache #2861** (staleness-free; DB reads not cached). S0 rule/threat model settled by those. **No remaining 2b work.** |
| **2c · #16 Person field → org-member directory — through S2 (source decided)** | Deepen the person field into a real org directory | **DONE: fail-closed assignment validator (#2833) + route-parity hardening across all four write paths (#2854, real-PG) + S2 directory resolver `resolvePersonAssignableDirectory`, source = B member-group directory (#2866, unit + real-DB).** Source-of-truth is **DECIDED** (design-lock #2860 → B); `restrictToMemberGroupIds` is a hard rule (sheet members ∩ allowed groups, grandfathered). **Remaining: S3 picker-UX (filter to assignable) + S4 inactive/historical handling (out-of-scope values readable, not newly assignable).** Not source-blocked. |

## 3. Reclassified to future roadmap pool by #2828 (NOT active remainder)

The #2801 items I had queued — **P3** dashboard polish (missing-bucket fill / series cap), **P4** server-side all-dataset export, **P5** form `required-if`, **P6** dashboard linked filters / drill-down, **G3** standalone `multitable:notify` permission code, **B2** next AI ring — are future-pool. A fresh code-check on `origin/main@9f68ed67c` found only incidental matches (no shipped impl), so they remain *unbuilt*, but #2828 does **not** place them in the active closure ledger. Building them now would be working from a superseded plan.

## 4. Externally blocked (unchanged; cannot be completed autonomously)

`A1` grid virtualization (needs the S5b 50k/100k **ops staging** baseline) · `C1` production SMTP real-send (**ops creds** + dual-confirm env) · `C2` template PM/SME **content** package · `B3` native synced/external-source table (XL + **owner** K3-boundary decision).

## 5. Lessons banked this session

- **Re-verify each slice against *current* `origin/main` immediately before building.** P1 was already shipped by a parallel effort (#2833) while I built it against an older main; the whole build was wasted. The canonical checkout is pinned at a stale commit and main moves fast — ground in a fresh `origin/main` worktree *and* re-check right before coding.
- **One lander per worktree, ever.** Two concurrent landers on the same worktree caused a rebase conflict/abort; never background a second.
- **Real-DB-only tests have no local signal** — they cost a full CI round-trip each; budget for that or test the pure logic at the unit layer.

## 6. Conclusion + recommendation

The planned arcs are built, verified, and on main: 2a live CRDT (full scalar set, #2832/#2838/#2849), 2b conditional rules **complete through S4** (#2836/#2841/#2847/#2861), and 2c #16 person-directory **through S2** — enforcement (#2833 + #2854) + directory resolver (source = B, #2866), source-of-truth decided via design-lock #2860. The **only in-progress arc is 2c**, and only its **S3 picker-UX + S4 inactive/historical handling** remain (source-of-truth is no longer open). **#17** grid-virtualization stays reopen-only (verdicted not-needed by the D2 baseline; revisit only on a higher-scale re-baseline). Neither is autonomously buildable; each needs an explicit owner opt-in + the listed decisions. I will not start them without that opt-in.
