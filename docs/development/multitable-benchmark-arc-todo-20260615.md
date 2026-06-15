# Multitable Remaining-Development — Execution Tracker (goal) — 2026-06-15

Type: **execution tracker** for driving the remaining multitable development to
completion as a goal. Not a schedule, not a competing map.

The canonical remaining-dev **map** (honest terminal-gate taxonomy + per-item
verification status) is `multitable-remaining-goal-dev-verification-20260615.md`
(#2650, merged). **This tracker references that map — it does not re-derive it.**
The standing driver is the owner-set goal: multitable driven by 对标并超越 the
leading 多维表格 product; the benchmark evidence lives in the research companion,
not here. This tracker uses MetaSheet's own capability names only.

## 0. Honest completion ceiling

Per #2650 §0, "余下开发" splits by **terminal gate**, and only one tier can be
driven to *done* without a privileged actor:

- **autonomous** — pure backend, unit + tsc closeable → can be built + verified to
  a reviewable draft PR by this session.
- **browser-gated** — backend is autonomous, but the terminal slice (visual /
  interaction) needs a real browser; render/dialog cannot be self-verified.
- **owner/ops-gated** — needs a privileged action (staging baseline, ops creds,
  product charter, security-review lane); no autonomous code path.

So "持续开发直至完成" means: drive the **autonomous** tier to built + verified +
draft-PR'd; design-lock + gate-mark the rest. Merge stays with the owner —
nothing auto-merges; each slice is reviewed.

Markers: ✅ done + merged · 🟦 built, in review (draft PR this session) ·
⬜ ready / in progress · 🔒 gated (own opt-in / prereq).

## 1. Button / action field (B1) — backend COMPLETE, FE gated

| Slice | State | Evidence |
|---|---|---|
| B1-S0 design-lock (exclusion matrix + inert-action + run-API contract) | ✅ | #2645 |
| B1-a0 backend codec + §2 value-field exclusions + write-rejection | ✅ | #2648 |
| B1-a1 executor core — `record_click` inert action + `runSingleAction` seam | ✅ | #2653 |
| B1-a1 route — `button/run` + univer-meta type-map drift fix | ✅ | #2657 |
| B1-b grid / record-detail render (button cell, states) | 🔒 browser-gated | — |
| B1-c FieldManager config UI (create/edit button, bind action, picker) | 🔒 browser-gated | — |

B1 backend is done end-to-end (codec → exclusions → executor seam → authenticated
run endpoint, visible≠executable enforced server-side). Only the two **frontend**
slices remain, both browser-gated (FE `types.ts` still has no `button` member by
design — it lands with B1-b once a browser session can verify render→click).

## 2. Conditional-format range styles (A5) — data-bar done, scale backend in review

| Slice | State | Evidence |
|---|---|---|
| A5 design-lock (scale rule model + security locks + slice plan) | ✅ | #2637 |
| A5-1 data-bar backend contract (`sanitize…ScaleRule` + `buildFieldScaleMap`) | ✅ | #2639 |
| A5-1 data-bar FE mirror + grid render | ✅ | #2640 |
| **A5-2 color-scale + A5-3 icon-set backend + FE mirror** | 🟦 **in review (this session)** | draft PR |
| A5-2 / A5-3 grid render (MetaGridTable) + dialog (ConditionalFormattingDialog) | 🔒 browser-gated | — |

A5-2 + A5-3 are combined into **one** backend PR (they extend the identical
sanitizer / `buildFieldScaleMap` / FE-mirror functions — separate branches would
conflict on those hot functions and stall on merge cadence), with separate test
blocks per kind. Render + dialog stay browser-gated (visual contrast / alignment
need a real browser, per the design-lock's honest verification boundary).

## 3. Export full-fidelity (A2) — masking-flag verification

| Item | State | Note |
|---|---|---|
| A2 export column/row picker | ✅ | #2635 |
| A2 server-side masking-flag verification (+ fix if real) | ⬜ next (this session) | #2650 §4 flagged a possible FE-export bypass of server field masking; verify the `grid.rows`-already-masked claim, fix if the bypass is real |

## 4. Remaining ladder (gated — from #2650 §5)

**browser-gated** (backend autonomous; terminal slice needs a browser): B1-b /
B1-c · A5-2/A5-3 render · A3 inline-link record expand · A4 form-logic depth
(required-if / multi-page / prefill / redirect) · B4 dashboard non-chart widgets ·
B5 longText in-cell @mention · B6 comment emoji reactions.

**owner/ops-gated** (need a privileged action): A1 grid virtualization (owner S5b
staging baseline) · B7 row-level rule permissions (security-review lane) · B2 AI
auto-trigger · B3 native synced tables (owner charter) · C1 SMTP (ops creds) ·
C2 template industry content (PM/SME) · C4 mobile / PWA (no named demand).

## 5. Execution discipline

- **Autonomous tier, in order:** A5-2/A5-3 backend (in review) → A2 masking verify.
  Each = contract-grounded build → adversarial verify → harden → **draft** PR with
  the tests its design-lock pins; reviewed before merge; nothing auto-merges.
- **Re-verify before each build** against `origin/main` AND open PRs/branches — a
  parallel session has been shipping this arc; an in-flight PR won't appear in
  `origin/main`. (This tracker's discipline after two same-arc collisions.)
- **Gated tiers** get design-lock + honest markers, never an auto "verified".

## 6. Cleanup (this session's superseded drafts)

- #2644 (button scope-gate) — **superseded** by the merged design-lock #2645
  (which deliberately chose a different design); close.
- #2641 (飞书 refresh audit, research) — overlaps the merged ladder refresh #2629;
  owner to confirm close vs keep.
- This doc (#2647) — rewritten from the old B1-centric draft into this tracker.

## 7. Re-entry

When the autonomous tier closes, produce the dev + verification MD, then re-run
the refresh audit to re-rank the gated ladder (§4) before opening any browser- or
owner-gated arc — each remains a separate named opt-in.
