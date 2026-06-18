# 多维表剩余门控开发 TODO — 2026-06-18

> Status: **CURRENT GATED TODO**.
> Pair: `multitable-gated-remainder-development-plan-20260618.md`.
> Grounding: `origin/main` (live-main, 2026-06-18). Completed + on `main`: **2a** (`#2832`/`#2838`/`#2849`), **2b through S3** (`#2836`/`#2841`/`#2847`). `#2825` remains open (final CRDT comment tails) — **comment-tail hygiene only**, not a main-grounding line to update here.
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
- [x] CRDT comment hygiene documenting the real seed/bridge/frontend boundary (`#2823`; `#2825` PR head closes the final internal JSDoc/dateTime comment tails, pending merge).
- [x] Runtime conclusion: no non-gated multitable remainder is open.

## 1. 2a · Live CRDT Remaining Field Types

> **CLOSED 2026-06-18** (select/date #2832, duration #2838, dateTime #2849). The checkboxes below were satisfied per type — lazy `coerceText` dual-reader; the strdate real-DB golden covers select/date/dateTime; duration has its own FE + flush proof. Retained as history; no remaining 2a work. Active remainder is now **2b** and **2c** only.

### 1.1 `select` / `date` / `dateTime`

- [x] **2a RESOLVED — full scalar set shipped (2026-06-18).** The speculative per-type migration/UX gate
  checkboxes that were here are obsolete (the shipped path differed from them) and have been removed:
  - [x] `select` / `date` — lazy `coerceText` dual-reader (read Y.Text-or-plain, write plain, lazy
    convergence; no big-bang migration) + strdate real-DB corruption golden (#2832).
  - [x] `dateTime` — canonical-UTC-ISO value invariant + persisted-doc golden (#2849).
  - [x] `duration` — commit-on-confirm LWW + defer-remote-while-dirty + real-DB no-corruption (#2838).

  No remaining 2a work; the full scalar set is collaborative. See §1 of the plan doc for the as-shipped design.

## 2. 2b · #18 Phase-2 Conditional Permission Rules

> **COMPLETE — S1–S4 (2026-06-18).** S1 #2836, S2 #2841 (wired into the #18 seam, flag-off inert), S3 #2847, S4 #2861 (content-keyed parse cache, staleness-free — DB reads not cached). All slices shipped; sub-items below retained as history. The only remaining multitable arc is **2c** (owner-gated on source-of-truth).

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

## 3. 2c · Gated Arc Not Started

### 3.1 `#16` Person Field → True Org-Member Directory

- [!] Gate: owner decision on directory source of truth and assignability semantics.
  - [ ] Decide source: internal users, directory sync member groups, external identity metadata, or hybrid.
  - [ ] Decide whether `restrictToMemberGroupIds` is a hard validator.
  - [ ] Decide inactive/deleted user behavior.
  - [ ] Decide historical out-of-scope values: readable-only vs forced cleanup.
  - [ ] Decide picker explanation UX.

- [ ] 16-S0 Design-lock.
  - [ ] Lock stored value shape as unchanged unless a migration is explicitly designed.
  - [ ] Lock legacy link-backed person coexistence.
  - [ ] Lock API/import/automation/Yjs parity requirements.

- [ ] 16-S1 Backend validator and resolver.
  - [ ] Shared person validator for REST, bulk edit, import, form, automation, and Yjs write paths.
  - [ ] Real-DB positive assignment test.
  - [ ] Real-DB negative restricted-group assignment test.
  - [ ] Real-DB inactive/deleted user characterization.

- [ ] 16-S2 Frontend picker.
  - [ ] Filter to assignable members.
  - [ ] Explain empty/disabled states.
  - [ ] Browser picker evidence.

- [ ] 16-S3 Parity hardening.
  - [ ] API route tests.
  - [ ] Import/bulk tests.
  - [ ] Automation/form/Yjs tests.

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

Use one of these when opening the next arc (2a is complete and 2b is shipped through S3 — those gates are closed, not next options):

- **Unlock 2c / #16 person directory:** choose directory source of truth and assignability semantics.
- **Unlock 2b-S4 (rule-engine perf / caching):** only on large-rule-set demand; `2b` is otherwise shipped through S3 — a perf follow-up, not a fresh security gate.
- **Revisit grid performance:** opt into D2 high-scale harness/re-baseline work first; row virtualization stays closed unless the verdict flips.
