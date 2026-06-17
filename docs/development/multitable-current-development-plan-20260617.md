# 多维表当前开发计划 — 2026-06-17

> Status: **CURRENT ROUTING PLAN**.
> Grounding: `origin/main@4c5244532` (`docs+chore(multitable): correct recycle-bin contract for #2794 + untrack node_modules`).
> Purpose: replace the stale "what next?" routing in the 2026-06-10/2026-06-15 ledgers. This file does **not** rewrite historical design-locks; it is the current source of truth for choosing the next multitable development slice.

## 0. How to read the older plans

The following documents remain useful as history and detailed evidence, but they are no longer safe as a direct TODO list:

- `multitable-benchmark-refresh-ladder-20260615.md` — macro benchmark ladder. Since then, the A2/A3/A4/A5/B1/B4/B5/B6 lines have mostly shipped.
- `multitable-remaining-goal-dev-verification-20260615.md` — useful autonomous/browser/owner gate taxonomy, but its open-slice map has been overtaken by later PRs.
- `multitable-ai-field-staged-arc-development-plan-20260610.md` + `multitable-ai-field-staged-arc-todo-20260610.md` — still useful for AI staging history; M0-M3 are closed and later AI rings need fresh per-ring opt-in.
- `multitable-formula-over-lookup-followups-development-plan-20260610.md` + `multitable-formula-over-lookup-followups-todo-20260610.md` — still useful for FOL-3..9 gated follow-ups; FOL-1/FOL-2 are closed.
- `multitable-field-read-gate-tracker-20260602.md` — field-read gate regression tracker; mostly a completed security ledger, not a product-feature backlog.

Rule: for new work, start from this file and `multitable-current-development-todo-20260617.md`; open the historical docs only for details after a current TODO points to them.

## 1. Major lines already closed

These items appeared as open or partial in older ledgers, but are closed on current `origin/main`:

| Area | Current state |
|---|---|
| A2 export column/selected-row selection | Shipped in `#2635`: `MetaExportDialog`, selected-row scope, format choice, and export payload wiring over already-masked `grid.rows`. A separate all-dataset/server-side export is a demand-gated follow-up, not the A2 gap. |
| A3 linked-record expand/peek | Shipped in `#2722`: clickable linked-record chips with peek popover. |
| A4 public-form logic depth | Shipped in `#2727`: pages, URL prefill, redirect/confirmation plumbing, with later form-context security hardening in `#2789`. A future `required-if` validation rule would be a separate validation slice. |
| A5 conditional-format scale | Shipped from design to browser verification: data bar (`#2637/#2639/#2640`), color scale + icon set (`#2664/#2680`), browser lane and contrast closeout (`#2689/#2694/#2695`). |
| B1 button/action field | Shipped through first side-effecting action: backend contract, grid/drawer render, config UI, run route, `send_notification`, and dedicated `canSendNotification` (`#2645/#2648/#2653/#2657/#2699/#2703/#2716/#2768/#2784`). |
| B4 dashboard non-chart widgets | Shipped in `#2725`: metric/text/filter widgets. The filter widget is intentionally presentational; cross-panel dashboard filtering/drill-down remains demand-gated. |
| B5 longText in-cell mention | Shipped in `#2726`: authenticated host-fed people mention in the rich longText editor. |
| B6 comment reactions | Shipped in `#2673/#2674`, with browser verification lane coverage. |
| Dashboard BI v2/v2-d | Complete through date-axis x series; deferred only synthetic missing buckets and series-count cap. |
| Cross-base Phase A/B/C | Complete per `multitable-crossbase-program-completion-20260614.md`. |
| Formula-over-lookup common path | A-min, create/submit/import, A-full, FOL-1 realtime/Yjs invalidation, and FOL-2 dry-run hydration are closed. |
| Rollup expansion | Count-all/unique, string/boolean reducers, filter condition + builder, and runtime guards are closed (`#2755/#2785/#2765/#2772/#2776/#2790`). |
| Record recycle bin | Closed through trash table/list/restore + write-own/field-mask hardening + docs cleanup (`#2791/#2794/#2798`). |
| Recent field/security follow-ups | `#2789` anonymous form-context config leak fix and `#2793` native-person summary egress lock are closed. |
| AI quota / hierarchy residuals | `#2623` AI quota overshoot and `#2523` hierarchy parent downgrade guard are merged; do not list them as open. |

## 2. Current development tiers

### Tier 1 — actionable with a small design-lock or direct scoped implementation

| Key | Item | Why it remains | Suggested next step |
|---|---|---|---|
| P1 | Native person `restrictToMemberGroupIds` enforcement | The person field stores the group restriction config, but assignment validation currently enforces sheet membership rather than configured member groups. This is a behavior change, so it needs an explicit product decision. | Short design-lock, then backend validation + picker filtering + real-DB tests. |
| P2 | Open stale PR/doc hygiene | Several old PRs are now superseded by landed work (`#2495`, `#2508`, `#2522`; `#2499` is near-duplicate of template dry-run work). | Close/replace with references to this current plan; only salvage unique content if any. |
| P3 | Minor chart/dashboard deferred polish | Synthetic missing-date-bucket fill and series-count cap are explicitly deferred. They are not bugs, but are bounded enhancements if a dashboard need appears. | Demand-gated implementation PR only if requested. |
| P4 | Server-side all-dataset export | Current A2 exports selected columns/rows from permission-masked grid data. A server-side "export all matching rows" flow would need pagination/filter/sort semantics and a fresh contract. | Design-lock only if users need full-dataset export beyond visible/selected grid rows. |
| P5 | Form `required-if` validation | A4 shipped layout/prefill/redirect; conditional requiredness is validation semantics, not just presentation. | Design-lock shared rule vocabulary with field visibility before code. |
| P6 | Dashboard linked filters / drill-down | B4 filter widget is presentational and local; linked cross-panel filters change chart query semantics. | Demand-gated dashboard design-lock. |

### Tier 2 — high-value product arcs, but require owner/ops input first

| Key | Item | Gate | Suggested next step |
|---|---|---|---|
| A1 | Grid virtualization / row windowing | Requires S5b 50k/100k staging baseline to anchor the performance budget. | Operator run first; then design-lock the virtualization contract. |
| B2 | AI rings beyond the shipped manual shortcut/formula-assist base | Each ring changes AI behavior/scope; auto-trigger remains charter-gated. | Pick one ring: auto-trigger, translate-table, sentiment/tagging, NL-to-filter, etc.; design-lock first. |
| B3 | Native synced/external-source table | XL scope; touches integration/K3 boundaries and source-of-truth semantics. | Owner decision + design-lock before code. |
| C1 | Production SMTP real-send acceptance | Code/harness exists; blocked on real SMTP env + dual-confirm ops setup. | Ops credential gate, then smoke acceptance. |
| C2 | Template PM/SME content package | Engine and template mechanics exist; remaining work is domain content. | PM/SME content lane, not core runtime work. |

### Tier 3 — security/governance arcs, demand-gated

| Key | Item | Why gated |
|---|---|---|
| G1 | Private-record / row-level read-deny model | `#2787` deliberately documents current semantics as sheet-level visibility + record-level write/admin elevation. A true read-deny model requires new semantics, migration/contract, and every read surface. |
| G2 | Row-level conditional permission rules | Security-sensitive rule engine. Needs owner-approved model and adversarial review lane. |
| G3 | Dedicated notify permission follow-up beyond full-write/admin derivation | `canSendNotification` now exists and derives from full write/admin, excluding write-own. A stricter independent permission code would be a rollout/provisioning decision. |

### Tier 4 — deep deferred technical arcs

| Key | Item | Status |
|---|---|---|
| FOL-3 | Recursive / multi-hop derived propagation | Track C gate; no concrete multi-hop requirement yet. |
| FOL-4 | Formula-to-formula propagation | A2-full gate. |
| FOL-5 | Lookup/rollup materialization | Storage/contract gate. |
| FOL-6 | Parser arithmetic / exact multi-value lookup math | Parser/engine gate; current joined-string semantics are intentionally pinned. |
| FOL-7 | Yjs recompute path | Demand-gated collaboration path. |
| FOL-8 | Related-table automation/webhook trigger on materialized changes | Automation-domain opt-in. |
| FOL-9 | Frontend off-page invalidation strategy | Demand-gated UX/realtime strategy. |
| A6 remainder | Branch-local wait/join-any/delay-result-backwrite remainder | Follow the automation A6 docs; do not mix into multitable feature slices opportunistically. |

## 3. Recommended next choices

1. **Smallest clean product slice:** P1 person `restrictToMemberGroupIds` enforcement. It is bounded, useful, and does not need ops/browser infrastructure beyond existing test lanes.
2. **Highest product impact:** A1 grid virtualization, but only after S5b staging baseline.
3. **Strategic differentiation:** B2 next AI ring, one ring at a time.
4. **Security expansion:** G1 private-record read-deny only if the product wants private records; otherwise keep the current `#2787` contract.

## 4. Execution discipline

- Before coding, re-ground on a fresh worktree from `origin/main`; do not trust the canonical stale checkout.
- Every runtime slice: design-lock where semantics change, fail-first test, implementation, adversarial review, CI, verification note.
- Every browser-visible slice: use the existing Chromium browser verification lane when visual/interaction behavior matters.
- Keep old plans historical. Do not edit them to make them "current"; update this current plan/TODO instead.
