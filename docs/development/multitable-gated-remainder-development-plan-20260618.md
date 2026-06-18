# 多维表剩余门控开发计划 — 2026-06-18

> Status: **CURRENT GATED REMAINDER PLAN**.
> Grounding: `origin/main` (live-main, 2026-06-18). Completed since the prior snapshot and now on `main`: **2a** scalar-type extensions (`#2832` / `#2838` / `#2849`) and **2b** dynamic rule-engine **complete through S4** (`#2836` / `#2841` / `#2847` / `#2861` parse cache). The earlier comment/ledger tail PRs `#2825` + `#2857` are closed as superseded by `#2859` (this reconciliation).
> Supersedes: `multitable-current-development-plan-20260617.md` and `multitable-current-development-todo-20260617.md` for current multitable remainder routing.
> Pair: `multitable-gated-remainder-todo-20260618.md`.
> Rule: this is a closure ledger for the current multitable mainline. Every item below is gated. Do not start runtime work from this document without an explicit opt-in for that gate.

## 0. Precise Boundary

The current multitable mainline has no non-gated residual runtime work.

Closed and removed from the active remainder:

- `#18` row-level read-deny: foundation, all-surface enforcement, authoring UI, and flag endpoint tests are complete. The flag endpoint includes positive and negative GET authz locks.
- Live scalar CRDT user-usable edit path: `number`, `currency`, `percent`, `boolean`, `rating`, `multiSelect`, and now `select` + `date` (#2832), `duration` (#2838), and `dateTime` (#2849, canonical-UTC-ISO value invariant) are live. **2a is COMPLETE — the full scalar field set is collaborative; no scalar type remains deferred.** (Updated 2026-06-18 after #2849; §1 retained below as history.)
- CRDT comment hygiene: the repository documents that the backend bridge is a generic plain-value collector, which is not the same as a field type being product-open in the editor.
- **2b · #18 phase-2 conditional permission rules — COMPLETE.** S1 parser/evaluator (#2836), S2 backend read-deny enforcement wired into the #18 seam flag-off-inert (#2841), S3 authoring UI + API (#2847), and S4 content-keyed parse cache (#2861). All slices shipped.
- **2c · #16 Person field → org-member directory — COMPLETE.** Source-of-truth DECIDED = **B (member-group directory)** (owner pick via design-lock #2860). S2 resolver `resolvePersonAssignableDirectory` (#2866), S3a `canEditRecord`-gated directory endpoint (#2867), S3b `MetaPersonPicker` wired to it — offers exactly what the validator accepts (#2869), S4 inactive/historical display cue — stored-but-deactivated assignees shown read-only, never re-assignable (#2874). Built on the fail-closed assignment enforcement (#2833 + #2854). All slices shipped.

**The active remainder is EMPTY — all planned development (2a, 2b, 2c) is complete.**

Everything else belongs to a future roadmap pool, not to this closure ledger. See Appendix A. (2a closed #2851; 2b closed S1–S4 after #2836/#2841/#2847/#2861; 2c closed S2–S4 after #2866/#2867/#2869/#2874 — all 2026-06-18.)

## 1. 2a · Live CRDT Remaining Field Types

> **STATUS: CLOSED (2026-06-18).** All field types named below are now live: `select` + `date` (#2832), `duration` (#2838, commit-on-confirm), and `dateTime` (#2849, 2a-DT-S2 — canonical-UTC-ISO value invariant + `coerceText` dual-reader; design-lock `multitable-2a-datetime-live-crdt-designlock-20260618.md` / #2843). The migration gate below was satisfied per type (lazy `coerceText` dual-reader; the strdate real-DB golden covers select/date/dateTime; duration has its own FE + flush proof). Section retained as history; no remaining 2a work.

### 1.1 Current Contract

`YjsSyncService` seeds a fresh record doc from `meta_records.data` by stored value shape:

- string values seed as `Y.Text`;
- non-string atomic values seed as plain values under the `fields` Y.Map;
- `null` / `undefined` stay absent.

The product editor enables scalar Yjs binding for the **full scalar field set**:

`number`, `currency`, `percent`, `boolean`, `rating`, `multiSelect`, `select`, `date`, `duration`, and `dateTime` (#2849).

**2a is COMPLETE — no scalar type remains REST-only for collaborative editing** (updated 2026-06-18 after #2832 / #2838 / #2849). The seed shape + frontend binding now cover the full set; the backend bridge collects generic plain values consistent with that. (§1.2/§1.3 below are retained as history of the per-type gates that have since been resolved.)

### 1.2 `select` / `date` / `dateTime` Gate

**Gate:** persisted-doc migration.

These fields are string-stored atomics today. Existing Yjs docs can already hold their field keys as `Y.Text`. Flipping the seed or frontend binding directly to plain-value LWW would make old docs expose a `Y.Text` object where the product expects a string, which is a corruption risk.

Required owner/design decisions before implementation:

1. **Migration strategy**
   - Lazy migration when a record doc opens.
   - Offline / admin migration over persisted snapshots and updates.
   - Dual-reader compatibility layer that accepts old `Y.Text` and new plain values for a defined window.
   - Or a different explicit strategy.
2. **Rollout compatibility**
   - How mixed old/new clients behave during deployment.
   - Whether old persisted docs are rewritten before any frontend scalar binding ships.
   - Whether rollback must preserve old `Y.Text` docs or can tolerate already-migrated plain values.
3. **Date semantics**
   - `date` must preserve the canonical stored date string.
   - `dateTime` must preserve the existing local-input conversion contract and avoid timezone drift.
4. **Corruption golden**
   - Real Postgres fixture with persisted Yjs state containing `Y.Text` for `select`, `date`, and `dateTime`.
   - After migration + edit, `meta_records.data` must still contain the same native stored shapes: string select value, date string, dateTime string.
   - The golden must fail if a `Y.Text` object, stringified object, `[object Object]`, or incompatible nested Yjs type reaches `patchRecords`.

Recommended implementation slices after the gate opens:

| Slice | Scope | Verification |
|---|---|---|
| 2a-S1 | Design-lock the migration strategy and corruption model. | Design review only; no runtime. |
| 2a-S2 | Build migration / dual-reader helper behind tests. Do not enable frontend scalar binding yet. | Unit tests for old/new doc shapes; real-DB persisted-doc corruption golden. |
| 2a-S3 | Flip seed / activation for one pilot string-stored type, likely `select`. | Real-DB seed + flush + old-doc migration; frontend active/inactive path tests; browser edit smoke. |
| 2a-S4 | Extend to `date` and `dateTime` once date semantics are proven. | Date/dateTime round-trip, timezone edge, persisted-doc migration golden. |

Non-goals:

- Do not change stored cell data shapes.
- Do not opportunistically rewrite unrelated `string` fields.
- Do not infer migration success from mocked Yjs-only tests; persisted-doc corruption must be proven against the real DB path.

### 1.3 `duration` Gate

**Gate:** local-buffer UX.

`duration` is not blocked by the same `Y.Text` migration problem. It is blocked because the editor has an intentional local text buffer for `h:mm` input. Live re-derivation from a remote plain value can interrupt typing, cursor position, and partially valid input.

Required owner/design decisions before implementation:

1. **Editing semantics**
   - Keep REST-only for active duration editing.
   - Commit-on-confirm LWW: local buffer stays local while typing; Yjs only updates on confirm.
   - Live collaborative draft channel separate from the persisted `fields` value.
2. **Conflict behavior**
   - What happens when a remote duration change arrives while the user has an unconfirmed local buffer.
   - Whether to show a conflict affordance, defer remote display, or overwrite on blur.
3. **Input validity**
   - How partially valid buffers such as `1:`, `:30`, or localized formats behave under live updates.

Recommended implementation slices after the gate opens:

| Slice | Scope | Verification |
|---|---|---|
| 2a-D1 | Duration UX design-lock with explicit conflict behavior. | Browser interaction plan; no runtime. |
| 2a-D2 | Implement chosen duration binding strategy. | jsdom component tests + real-browser typing/cursor smoke. |
| 2a-D3 | Real-DB no-corruption proof. | Flush path preserves numeric/stored duration shape and rejects invalid values through existing validation. |

Non-goals:

- Do not make live duration collaboration by silently removing the local buffer.
- Do not accept a test that only clicks a valid final value; the risk is interruption during typing.

## 2. 2b · #18 Phase-2 Permission Rule Engine

> **STATUS (2026-06-18): COMPLETE (S1–S4).** S1 parser/evaluator, fail-closed (#2836); S2 conditional read-deny enforcement wired into the static-#18 seam, flag-off inert (#2841); S3 authoring UI + API (#2847); **S4 content-keyed parse cache (#2861) — staleness-free (DB reads are NOT cached; the per-read rules load is the freshness guarantee).** §2.1–§2.4 retained as history.

### 2.1 Current Contract

The shipped `#18` line is static row-level read-deny:

- foundation and feature flag;
- all-surface enforcement;
- authoring UI;
- flag endpoint positive and negative authz;
- real-DB coverage.

Phase-2 is not "finish #18"; it is a new security model: conditional / dynamic field-predicate permission rules.

### 2.2 Gate

**Gate:** owner-approved rule model and threat model.

Required decisions before implementation:

1. **Rule language**
   - Which fields can participate in predicates.
   - Which operators are allowed per field type.
   - Whether predicates can reference dynamic user attributes, member groups, roles, current time, or related records.
2. **Default behavior**
   - Fail-closed vs fail-open on malformed rules, missing fields, deleted fields, or unsupported operators.
   - Admin / owner bypass semantics.
3. **Scope**
   - Read-only rules first, or read + write + admin together.
   - Record-level only, or field-level visibility/editability as well.
4. **Evaluation timing**
   - Query-time SQL pushdown.
   - Post-query filtering.
   - Cached materialization.
   - Hybrid strategy.
5. **Auditability**
   - Whether denied rows need explainability in the UI.
   - Whether permission rule changes require audit events.

Recommended implementation slices after the gate opens:

| Slice | Scope | Verification |
|---|---|---|
| ✅ 2b-S0 | Security design-lock and adversarial threat model. (Settled — S1–S3 built on the locked rule model.) | Owner sign-off; no runtime. |
| ✅ 2b-S1 | Pure evaluator + parser, no route wiring. **(#2836)** | Unit matrix per field type/operator; malformed rule fail-closed. |
| ✅ 2b-S2 | Backend enforcement for the same read surfaces covered by static #18. **(#2841 — wired into the #18 seam, flag-off inert)** | Real-DB golden over list, single record, view, summaries, export, aggregate/dashboard, search/filter, link picker, trash list/restore. |
| ✅ 2b-S3 | Authoring UI for conditional rules. **(#2847, + text-type operator allowlist fix)** | Frontend tests + browser evidence; no silent rule loss on edit. |
| ✅ 2b-S4 | Performance and caching pass. **(#2861 — content-keyed parse cache; staleness-free, DB reads not cached.)** | Unit cache cases (hit / equals-direct / content-change re-parse / 200-rule set parsed once across 50 reads / cyclic bypass). |

Security invariants:

- Permission checks must not leak whether a hidden field exists or changed.
- Rule evaluation must not expose hidden predicate field values through error messages, counts, ordering, or timing-sensitive "this field exists" responses.
- Every new read path added after static #18 must be included in the phase-2 surface sweep before merge.

Non-goals:

- Do not fold phase-2 into a small patch on the static read-deny line.
- Do not introduce a rule DSL without a parser/evaluator golden and a real-DB route golden.
- Do not assume the current grant/additive row-permission model can express these rules without a new contract.

## 3. 2c · COMPLETE

### 3.1 `#16` Person Field → True Org-Member Directory

> **COMPLETE 2026-06-18.** Source-of-truth **DECIDED = B (member-group directory)** (owner pick, design-lock #2860). Shipped: fail-closed assignment enforcement (#2833 + route-parity #2854); S2 directory resolver `resolvePersonAssignableDirectory` (#2866); S3a `canEditRecord`-gated directory endpoint (#2867); S3b `MetaPersonPicker` wired to it (#2869); S4 inactive/historical display cue (#2874). All slices shipped — 2c is closed. The "Gate / Required decisions / slice" detail below is the original decomposition, retained as history.

Current state:

- Native `person` fields exist as first-class fields.
- `restrictToMemberGroupIds` is a **hard fail-closed validator** (sheet members ∩ allowed groups), enforced across all write paths (#2833 + #2854), with the directory resolver shipped (source B, #2866).
- No remaining 2c work — S3 picker-UX (filter to assignable, #2867/#2869) and S4 inactive/historical handling (out-of-scope values readable, not newly assignable, #2874) both shipped; detail below retained as history.

Gate:

Owner decision on the org directory source of truth and product semantics.

Required decisions:

1. **Directory source**
   - Internal `users` table only.
   - Directory sync member groups.
   - Hybrid directory with external identity provider metadata.
2. **Assignability**
   - Whether `restrictToMemberGroupIds` becomes a hard validation rule.
   - How inactive/deleted users behave in existing records.
   - Whether historical values outside the restriction remain readable but not newly assignable.
3. **Picker UX**
   - Filtering, empty states, disabled users, group labels.
   - Whether the picker explains why a user is unavailable.
4. **API / import / automation parity**
   - REST writes, bulk edit, import, form submit, automation actions, and Yjs writes must share the same validator.

Recommended slices after the gate opens:

| Slice | Scope | Verification |
|---|---|---|
| 16-S0 | Design-lock person directory source and assignability semantics. | Owner sign-off; no runtime. |
| 16-S1 | Backend directory resolver + person value validator shared by all write paths. | Real-DB positive/negative assignment tests; legacy value read parity. |
| 16-S2 | Frontend picker filtering and explanation. | Component tests + browser picker smoke. |
| 16-S3 | API/import/automation/Yjs parity locks. | Route tests and integration tests through each write path. |

Non-goals:

- Do not change stored person value shape without a migration design.
- Do not make picker-only filtering the enforcement mechanism.
- Do not reinterpret legacy link-backed person fields as native person fields.

## 4. Recommended Planning Sequence

Because every remaining item is gated, the default action is **hold**.

**2a is complete and 2b is complete through S4 (`#2861`) — those gates are closed, not next options.** The remaining gated next options:

1. **2c / #16 person-directory — COMPLETE** (source = B; S2 #2866, S3a #2867, S3b #2869, S4 #2874). No in-progress product arc remains in this ledger.
2. **D2 high-scale re-baseline harness work** — only if the product wants to revisit large-table performance after the existing D2 verdict; this is not a grid-virtualization slice.

Do not open more than one security-sensitive runtime arc at the same time.

## Appendix A. Roadmap Pool, Not Current Remainder

The following are future candidates or reopen-only lines. They are not remaining work in the current closure ledger:

- server-side all-dataset export;
- form `required-if` validation;
- dashboard linked filters / drill-down;
- dashboard missing-date buckets and series-count caps;
- grid virtualization / row-windowing: `docs/development/multitable-perf-gate-d2-baseline-verdict-20260525.md` already excludes `B_frontend_dom_memory_bound`; DOM and heap were flat across 1k -> 10k, the grid already windows the DOM, and the verdict says not to open a grid-virtualization PR. Only a future D2 high-scale re-baseline that flips this verdict should reopen the idea;
- AI rings beyond the shipped base;
- native synced / external-source tables;
- FOL deep follow-ups such as multi-hop propagation, formula-to-formula, materialization, Yjs recompute, and automation triggers;
- automation A6 remainder.

Each requires a separate opt-in and should get its own plan/TODO when selected.
