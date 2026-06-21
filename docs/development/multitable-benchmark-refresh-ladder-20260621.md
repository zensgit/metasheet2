# Multitable benchmark refresh ladder — 2026-06-21

> Rolling refresh of `multitable-benchmark-refresh-ladder-20260615.md` after the 1b record-set formula arc
> shipped and after a **per-lane verification pass against `origin/main`**. The headline: the 20260615
> ladder materially **over-counted the remaining gaps** — three of its "gaps" are already shipped. Verify
> each lane against main before building.

## 1. Shipped since the 20260615 ladder

- **Filter-by-link** — filter records by a linked-record's display value, permission-safe (denied link →
  "does not match", excluded before display materialization).
- **1b cross-record formula arc (complete):** `RELSUMIF` (#2978), `RELAVGIF`/`RELCOUNTIF` (#2995),
  `RELLOOKUP` (#2998), `RELVALUES` (#3001). Relation-scoped criteria aggregation + single-row lookup +
  array return. Each: materialize-at-write + **per-reader read-leak taint** (a denied foreign target/criteria
  drops the field on read) + `#PERM!`/`#LIMIT!`/`#N/A` sentinels + caps + foreign-write fan-out + real-DB
  leak gates. NOT whole-sheet `SUMIF` parity — whole-sheet scan stays a separate gated extension.
- **A5 full-column conditional-format scale stats** (#3004) — color-scale/data-bar gradients span the whole
  filtered column (server min/max via `/view-aggregate?statsFields`), stats gated on the masked aggregate
  field set (a denied numeric column returns no min/max — leak-gate proven).

**Open, held on a decision:** **#3003** export "all rows" — fixes the 50-row client-page data-loss (routes
through the mask-preserving full-sheet route; field+taint mask proven for xlsx+csv). Held on a product call:
"all rows" currently = the **entire sheet**, not the **view-filtered** subset (route applies view
hidden-fields but not the row filter). Options on the PR: (A) respect the view filter, (B) relabel "entire
sheet" + add "export filtered view", (C) accept full-sheet.

## 2. Staleness corrections (verified on `origin/main` 2026-06-21)

The 20260615 ladder listed these as gaps; they are **already shipped** — do not rebuild:

- **B6-a comment reactions** — `zzzz20260615190000_create_meta_comment_reactions` migration + `MetaCommentReactions.vue` + client API + composable. DONE (storage + API + UI).
- **A2 export column/row picker** — `MetaExportDialog.vue` (per-column checklist over visible columns + row scope), shipped by #2635, wired in `MultitableWorkbench.vue`. DONE (the *full-sheet/filter* refinement is the separate #3003 above).
- **A4 form-logic depth** — `form-layout.ts` implements multi-**page** forms; `MetaFormView.vue` (labeled "A4") implements **prefill** + post-submit **redirect**. Pages/prefill/redirect are DONE. **Only `required-IF` (conditional-required) remains.**

Lesson (now 3×): the audit drifts faster than the code; **verify each candidate lane against main before building** — blind ladder-building has wasted-build risk.

## 3. Genuine remaining gaps

**Ungated / buildable now (small):**
- **A4-rIF** conditional-required (`required-IF`) — a field required only when a condition holds; reuse the existing field-visibility-rule condition vocabulary + the form's submit validation. Small, FE-led.
- **B4** dashboard-level filters / cross-filtering — *verify depth first* (per-panel filters + some dashboard-filter code already exist; confirm what's actually missing).
- **Export filtered-view** — the #3003 follow-up (export the current view's filtered rows, full set).

**Decision-gated (need an owner call — each unlocks a lane):**
- **#3003** export semantic (A/B/C above).
- **B1-S1** button `send_notification` — real sink vs no-op framework vs fold into `update_record`.
- **A1** grid row virtualization — run the S5b 50k/100k staging perf baseline first (the prerequisite).
- **B3** external-source sync (XL) / **B7** row-level rule-based permissions (security-sensitive) — opt-in.
- **A3** inline linked-record expand-to-edit — needs a design-lock (expand vs nested).

## 4. Decision bottleneck

Engineering bandwidth is no longer the constraint on the high-value lanes — owner decisions are. The fastest
unlocks: the **#3003 export semantic** and the **B1-S1 sink** + **A1 perf-baseline** calls. Any one → that
lane builds immediately, with the established discipline (verify-against-main → fail-first leak gate where
permission-sensitive → full non-watch suite + structural guards → real-DB goldens → drive-to-merge).

## 5. Process notes

- Pre-push gate is `CI=true pnpm --filter @metasheet/core-backend test` (non-watch) — bare `pnpm test` enters vitest watch and cannot gate.
- Structural guards that must stay green on any record-data-egress change: egress-coverage, stored-data taint-chokepoint, record-lock disposition.
- Cross-record/permission-sensitive features: materialize-at-write is safe only paired with the per-reader read taint mask; every such field needs a fail-first read-leak golden.
