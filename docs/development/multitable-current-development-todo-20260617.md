# 多维表当前开发 TODO — 2026-06-17

> Status: **SUPERSEDED / HISTORICAL TODO SNAPSHOT**.
> Superseded by: `multitable-gated-remainder-development-plan-20260618.md` and `multitable-gated-remainder-todo-20260618.md`.
> Reason: after this file was written, `#18` row-level read-deny completed, scalar CRDT reached the six product-wired types, and the D2 perf verdict was re-applied to move grid virtualization out of active remainder. Use the 2026-06-18 gated remainder docs for current next-work routing.
>
> Former status: **CURRENT TODO**.
> Pair: `multitable-current-development-plan-20260617.md`.
> Grounding: `origin/main@4c5244532`.
> Markers: `[x]` closed · `[ ]` open · `[~]` optional/demand-gated · `[!]` owner/ops/PM gate.

## 0. Closed lines that must not re-enter backlog

- [x] A2 export column/selected-row selection over masked grid rows — `#2635`.
- [x] A3 linked-record peek/expand surface — `#2722`.
- [x] A4 public-form pages/prefill/redirect — `#2727`; anon config leak fixed by `#2789`.
- [x] A5 data bar / color scale / icon set contract + render + config + browser lane — `#2637/#2639/#2640/#2664/#2680/#2689/#2694/#2695`.
- [x] B1 button field through first side-effecting `send_notification` and dedicated notify capability — `#2645/#2648/#2653/#2657/#2699/#2703/#2716/#2768/#2784`.
- [x] B4 dashboard metric/text/filter widgets — `#2725`.
- [x] B5 longText in-cell @mention — `#2726`.
- [x] B6 comment reactions — `#2673/#2674`.
- [x] Dashboard BI v2 through v2-d date-axis x series.
- [x] Cross-base Phase A/B/C.
- [x] Formula-over-lookup through A-full + FOL-1/FOL-2.
- [x] Rollup countall/unique/string/boolean/filter/builder arc — `#2755/#2785/#2765/#2772/#2776/#2790`.
- [x] Record recycle bin / undelete + write-own/field-mask hardening — `#2791/#2794/#2798`.
- [x] Recent security follow-ups: anon form-context config leak `#2789`, native-person personSummaries egress lock `#2793`.
- [x] AI quota overshoot `#2623`; hierarchy parent downgrade guard `#2523`.

## 1. Actionable next slices

- [ ] **P1 Person group restriction enforcement**
  - Decision: should `restrictToMemberGroupIds` be enforced as an assignability rule now?
  - Scope if approved: backend person-value validation, FE picker filtering/hint, real-DB positive/negative tests.
  - Non-goal: changing stored person value shape.

- [ ] **P2 stale PR hygiene**
  - Close/supersede stale docs PRs: `#2495`, `#2508`, `#2522`.
  - Triage `#2499`: either close as near-duplicate of landed template dry-run/detail work or salvage unique content into a fresh doc.
  - Non-goal: re-opening old ladders as active TODO.

- [~] **P3 dashboard polish demand-gate**
  - Synthetic missing date buckets.
  - Series-count cap for multi-series charts.
  - Only do on concrete dashboard user need.

- [~] **P4 server-side all-dataset export**
  - Current A2 is client-side over already-masked `grid.rows`; this is safe but not an all-dataset export.
  - Scope if requested: define filter/sort/page semantics, route through server-side field/read masks, and add real-route tests.

- [~] **P5 form `required-if` validation**
  - A4 shipped pages/prefill/redirect; conditional requiredness remains a validation feature, not a render-only layout feature.
  - Needs design-lock against the existing field-visibility rule vocabulary.

- [~] **P6 dashboard linked filters / drill-down**
  - B4 filter widget is presentational/local today.
  - Linked filters would change dashboard query semantics and should be designed separately.

## 2. Owner / ops / PM gated tracks

- [!] **A1 grid virtualization**
  - Gate: S5b 50k/100k staging baseline.
  - Next action: operator run, then design-lock row-windowing behavior and perf budget.

- [!] **B2 AI rings**
  - Candidate rings: auto-trigger, translate-table, sentiment/tagging, NL-to-filter.
  - Gate: owner picks one ring; design-lock before code.

- [!] **B3 native synced / external-source tables**
  - Gate: owner decision on K3/integration/source-of-truth boundary.
  - Next action: design-lock only.

- [!] **C1 production SMTP real-send acceptance**
  - Gate: real SMTP env + dual-confirm variables.
  - Next action: ops smoke; mostly not code.

- [!] **C2 template PM/SME content package**
  - Gate: domain content.
  - Next action: content lane, not runtime.

## 3. Security / governance gated tracks

- [~] **G1 private-record / row-level read-deny**
  - Current contract is decision A: sheet-level read visibility, record-level write/admin elevation.
  - Only start if product wants private records.
  - Must include every read surface, including trash list/restore.

- [~] **G2 row-level conditional permission rules**
  - Security-sensitive; needs owner-approved model and adversarial review lane.

- [~] **G3 stricter notify permission code**
  - Current `canSendNotification` derives from full write/admin and excludes write-own.
  - A standalone `multitable:notify` code is a future provisioning/rollout decision.

## 4. Deep deferred arcs

- [~] FOL-3 recursive/multi-hop propagation.
- [~] FOL-4 formula-to-formula propagation.
- [~] FOL-5 lookup/rollup materialization.
- [~] FOL-6 parser arithmetic / exact multi-value lookup math.
- [~] FOL-7 Yjs recompute path.
- [~] FOL-8 related-table automation/webhook trigger.
- [~] FOL-9 frontend off-page invalidation strategy.
- [~] Automation A6 remainder: branch-local wait/join-any/delay/timer/result-backwrite per automation docs.

## 5. Next recommended move

Default recommendation:

1. P2 stale PR hygiene if the goal is repo cleanliness.
2. P1 person group restriction enforcement if the goal is a small user-visible/product-completeness slice.
3. S5b -> A1 if the goal is the next high-impact performance arc.

Do not start B3/G1/G2 without explicit owner sign-off; they change product/security semantics.
