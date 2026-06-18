# 多维表剩余门控开发 TODO — 2026-06-18

> Status: **CURRENT GATED TODO**.
> Pair: `multitable-gated-remainder-development-plan-20260618.md`.
> Grounding: `origin/main` (live-main, 2026-06-18). Completed + on `main`: **2a** (`#2832`/`#2838`/`#2849`), **2b complete through S4** (`#2836`/`#2841`/`#2847`/`#2861`), **2c complete S2–S4** (`#2866`/`#2867`/`#2869`/`#2874`, source = B; S4-as-shipped = read-only **cell/summary** inactive cue — the **picker-chip** historical affordance is a separate optional polish, open as `#2877`, pending an owner land-or-close decision, **not** part of this claim). **All planned development (2a/2b/2c) is done; active *planned* remainder is empty — the lone open item is the `#2877` owner decision (§5).** The earlier comment/ledger tail PRs `#2825` + `#2857` are closed as superseded by `#2859` (this reconciliation).
> Supersedes: `multitable-current-development-plan-20260617.md` and `multitable-current-development-todo-20260617.md` for current multitable remainder routing.
> Legend: `[x]` closed · `[ ]` todo after opt-in · `[!]` gate requiring owner/design decision · `[~]` roadmap pool, not current remainder.

## 0. Closed Lines That Must Not Re-Enter The Backlog

- [x] `#18` static row-level read-deny foundation.
- [x] `#18` all-surface enforcement.
- [x] `#18` authoring UI.
- [x] `#18` flag endpoint positive and negative GET authz tests (`#2819`).
- [x] Live scalar CRDT for `number`, `currency`, `percent`, `boolean`.
- [x] Live scalar CRDT for `rating`, `multiSelect` (`#2821`).
- [x] Live scalar CRDT for `select` + `date` (`#2832`), `duration` (`#2838`), `dateTime` (`#2849`, 2a-DT-S2 canonical-UTC-ISO invariant) — **2a COMPLETE; full scalar set collaborative, no type deferred** (2026-06-18).
- [x] CRDT comment hygiene documenting the real seed/bridge/frontend boundary (`#2823`; the final internal JSDoc/dateTime comment tails landed via `#2859`. The earlier `#2825`/`#2857` PR heads are **closed as superseded by `#2859`** — no comment-tail PR is pending merge).
- [x] Runtime conclusion: no non-gated multitable remainder is open.

## 1. 2a · Live CRDT Remaining Field Types

> **CLOSED 2026-06-18** (select/date #2832, duration #2838, dateTime #2849). The checkboxes below were satisfied per type — lazy `coerceText` dual-reader; the strdate real-DB golden covers select/date/dateTime; duration has its own FE + flush proof. Retained as history; no remaining 2a work. (2b and 2c are now also complete — the active remainder is empty.)

### 1.1 `select` / `date` / `dateTime`

- [x] **2a RESOLVED — full scalar set shipped (2026-06-18).** The speculative per-type migration/UX gate
  checkboxes that were here are obsolete (the shipped path differed from them) and have been removed:
  - [x] `select` / `date` — lazy `coerceText` dual-reader (read Y.Text-or-plain, write plain, lazy
    convergence; no big-bang migration) + strdate real-DB corruption golden (#2832).
  - [x] `dateTime` — canonical-UTC-ISO value invariant + persisted-doc golden (#2849).
  - [x] `duration` — commit-on-confirm LWW + defer-remote-while-dirty + real-DB no-corruption (#2838).

  No remaining 2a work; the full scalar set is collaborative. See §1 of the plan doc for the as-shipped design.

## 2. 2b · #18 Phase-2 Conditional Permission Rules

> **COMPLETE — S1–S4 (2026-06-18).** S1 #2836, S2 #2841 (wired into the #18 seam, flag-off inert), S3 #2847, S4 #2861 (content-keyed parse cache, staleness-free — DB reads not cached). All slices shipped; sub-items below retained as history. **2c is now also COMPLETE** (#2866/#2867/#2869/#2874; S4-as-shipped = read-only cell/summary cue — the picker-chip affordance #2877 is separate, owner decision pending) — see §3. All planned development (2a/2b/2c) is done; active *planned* remainder is empty (lone open item = #2877 owner decision).

- [x] Gate: owner-approved rule model and threat model — settled (S1–S3 built on it).
  - [ ] Decide rule language and field/operator matrix.
  - [ ] Decide whether predicates can reference current user, groups, roles, time, or related records.
  - [ ] Decide fail-closed behavior for malformed/deleted/unsupported fields.
  - [ ] Decide admin/owner bypass.
  - [ ] Decide read-only vs read/write/admin scope.
  - [ ] Decide evaluation timing: SQL pushdown, post-filter, materialized, or hybrid.
  - [ ] Decide audit/explainability requirements.

- [x] 2b-S0 Security design-lock — settled (S1–S3 build on the locked rule model).
  - [ ] Enumerate every read surface inherited from static `#18`.
  - [ ] Include trash list/restore in the surface sweep.
  - [ ] Include summaries, export, aggregate/dashboard, search/filter, link picker, and single-record GET.
  - [ ] Define side-channel rules: no hidden-field existence/change leaks.

- [x] 2b-S1 Parser/evaluator (#2836).
  - [ ] Pure evaluator with no DB side effects.
  - [ ] Per-field-type operator compatibility tests.
  - [ ] Malformed rule fail-closed tests.
  - [ ] Deleted/hidden predicate field tests.

- [x] 2b-S2 Backend enforcement (#2841 — wired into the #18 seam, flag-off inert).
  - [ ] Real-DB list/view/single-record tests.
  - [ ] Real-DB summary subset tests.
  - [ ] Real-DB export and aggregate/dashboard tests.
  - [ ] Real-DB link picker and trash tests.
  - [ ] CI allowlist confirmation; do not infer from green jobs.

- [x] 2b-S3 Authoring UI (#2847, + text-type operator allowlist fix).
  - [ ] Rule builder preserves aliases/case/unsupported fields without silent loss.
  - [ ] Browser evidence for create/edit/delete rule flows.
  - [ ] i18n labels through typed modules.

- [x] 2b-S4 Performance/caching (#2861 — content-keyed parse cache; staleness-free, DB reads not cached).
  - [ ] Large fixture query evidence.
  - [ ] Rule-change invalidation tests.
  - [ ] Field-change invalidation tests.

## 3. 2c · COMPLETE — `#16` Person Org-Member Directory

### 3.1 `#16` Person Field → True Org-Member Directory

- [x] Source-of-truth **DECIDED = B** (member-group directory) — design-lock #2860. Assignability locked:
  `restrictToMemberGroupIds` is a hard validator; out-of-scope historical values readable, not newly assignable.

- [x] **16-S0 Design-lock** — source B + assignability semantics (#2860).
- [x] **16-S1 Backend validator + resolver** — fail-closed person validator across all write paths
  (#2833 validator + route-parity hardening #2854, real-PG) + `resolvePersonAssignableDirectory` resolver,
  source B (#2866, unit + real-DB).
- [x] **16-S3 Frontend picker UX** — `canEditRecord`-gated directory endpoint (#2867) + `MetaPersonPicker` wired
  to it (#2869); offers exactly what the validator accepts; stored chips preserved (not dropped).
- [x] **16-S4 Inactive / historical handling** — deactivated stored assignees shown read-only with a muted cue,
  not re-assignable; out-of-scope historical values preserved (#2874, backend `inactive` flag + FE **cell-renderer** chip cue; the **picker-chip** cue is #2877, owner decision pending).

## 4. Roadmap Pool — Not Current Remainder

These are future candidates or reopen-only lines. They are not open work in the current closure ledger:

- [~] Server-side all-dataset export.
- [~] Form `required-if` validation.
- [~] Dashboard linked filters / drill-down.
- [~] Dashboard missing-date buckets / series-count cap.
- [~] Grid virtualization / row-windowing: D2 baseline verdict already excludes the frontend DOM/memory bottleneck and says not to open a grid-virtualization PR. Reopen only if a future D2 high-scale re-baseline flips that verdict.
- [~] AI rings beyond the shipped base.
- [~] Native synced / external-source tables.
- [~] FOL deep follow-ups: multi-hop, formula-to-formula, materialization, Yjs recompute, automation trigger.
- [~] Automation A6 remainder.

## 5. Owner Unlock Prompts

No active multitable development *arc* remains — **2a, 2b (through S4 `#2861`), and 2c (through S4 `#2874`) are all complete and closed; none is a "next option".** Two pre-identified owner decisions remain (neither is active planned work):

- **[!] Decide `#2877` (2c-S4 picker-chip affordance):** a green, display-only PR marking already-selected-but-no-longer-assignable chips inside `MetaPersonPicker` — the one S4 surface `#2874` left out (cell/summary cue only). **Land** to extend the cue to the picker, or **close** as out-of-scope (then S4 is scoped to read-only cell/summary only). Owner's call; do not act without it.
- **[~] Revisit grid performance:** opt into D2 high-scale harness/re-baseline work first; row virtualization stays closed unless the verdict flips.
