# W7 `resultWriteback` UI — design-lock (2026-06-29)

> Status: **design-lock (pre-implementation)**. Grounding: `origin/main` @ `15038b6fc`.
> Scope: **frontend-only** — expose the *already-shipped* approval-result backwrite config in the
> `start_approval` automation action editor. **Does not touch runtime, rejection backwrite, or
> cross-base.** Implementation is a separate PR, gated on approval of this lock.

## 1. Why this is a small, safe slice

The W7 approval-result backwrite is **not "to be designed" — it is shipped** on `main`. What is
missing is only the authoring surface: today a user can configure the mapping *only* by
hand-writing the action-config JSON. This slice adds the UI for the existing contract. Nothing
about the write path, its guards, or its semantics changes.

### Already shipped (the backend contract this UI targets)
- **Runtime** — `AutomationService.writeApprovalResultBack` (`automation-service.ts`): on the
  **approved** transition only, writes a *fixed* outcome→field mapping onto the **source** record —
  `transition.toStatus → statusField`, `actor.id → approverField`, `occurredAt → completedAtField`.
  Lock-guarded (`ensureRecordNotLocked`), values-constrained (system outcome values only, never
  user-templated strings), best-effort (a locked/missing record logs + skips, never crashes the
  resume; the skip is surfaced on the step result as `backwriteSkipped`), same-base only, with a
  depth-guarded `record.updated` fan-out. Non-approved transitions go to
  `failApprovalBridgeExecution` (the backwrite never runs on reject/cancel/revoke).
- **Config contract** — `validateActionConfig` (the `config.resultWriteback` block): when present it
  **must be an object**; each of `statusField` / `approverField` / `completedAtField`, if present,
  **must be a non-empty string**; and it **must map at least one** of the three. (So an *empty*
  `resultWriteback: {}` is rejected — this matters for §4's omit-when-empty rule.)
- **Field-type contract** — `resultWritebackFieldTypeError`: `statusField` → `string` / `longText` /
  `select` (and a `select` target **must include the written outcome option**, e.g. `approved`);
  `approverField` → `string` / `longText`; `completedAtField` → `string` / `longText` / `dateTime`.
- **Save-time fail-fast** — `assertResultWritebackFields` runs at `createRule` / `updateRule`, so a
  config whose target fields are missing or mis-typed is **rejected at save**, not just at runtime.

**Principle: the backend is the final arbiter.** The UI is authoring convenience only; every rule
the editor can save is independently re-validated server-side. The UI must never be the gate.

## 2. The gap (and a latent round-trip bug this must fix)

The `start_approval` editor block (`MetaAutomationRuleEditor.vue`, the `action.type === 'start_approval'`
section) renders **`templateId` + `formDataMapping`** only. Two problems:

1. **No `resultWriteback` surface** — it is authorable only as raw JSON.
2. **The save round-trip is lossy for `resultWriteback` today.** `buildActionPayload`'s
   `start_approval` branch **rebuilds the config from scratch** as `{ templateId, formDataMapping }`
   — it does **not** spread `...config`. So if a rule has a hand-authored `resultWriteback` and the
   user merely opens it in the editor and saves, **`resultWriteback` is silently dropped**. Any UI we
   add therefore *must* also make `buildActionPayload` emit `resultWriteback`, or the new block won't
   persist. (`draftConfigFromAction` does spread `...config`, so the *load* side preserves it; the
   loss is purely on save.)

   **The from-scratch rebuild is intentional, not an oversight — so the fix is explicit-carry, not a
   blanket spread.** `draftConfigFromAction` produces a *UI-only* `formDataMappingPairs` **array** of
   draft rows; the persisted config uses the `formDataMapping` **object**. `buildActionPayload`
   reconstructs from the managed keys precisely so those draft rows never leak into what's saved. A
   naive `...action.config` spread would "fix" the drop by persisting draft UI state — wrong. The
   correct fix is to **assemble `resultWriteback` explicitly** alongside `templateId`/`formDataMapping`
   (§4), carrying only validated config, never draft scaffolding.

This makes "existing JSON → UI → save → JSON unchanged" a **correctness** requirement, not a nicety.

## 3. UI design

Add an **optional "审批结果写回 / Approval-result writeback"** sub-block to the `start_approval`
config, after the form-data mapping. It is three optional field pickers — nothing else:

```
审批结果写回 (可选)            Approval-result writeback (optional)
  状态字段   [ <select source field> ]   statusField     → toStatus
  审批人字段 [ <select source field> ]   approverField   → actor id
  完成时间   [ <select source field> ]   completedAtField→ completedAt
```

- Each picker is a `<select>` over **`fields`** (the rule's current source-sheet fields — the same
  list the `formDataMapping` value picker already uses). Empty option = "not written".
- **Type filter is a HINT, never a GATE — and the current configured value is always preserved in the
  options.** Each picker's option set is the type-compatible source fields (`string`/`longText`/`select`
  for status, `string`/`longText` for approver, `string`/`longText`/`dateTime` for completedAt) **PLUS
  the currently-configured field id** — always present and selected, even when that field has been
  deleted, retyped to an incompatible type, or is otherwise absent from the current `fields`, rendered
  as a marked "当前值 / 未知字段 / 不兼容" option. Compatibility is a *visible hint* only; the picker
  never *excludes* the current value and never blocks save. **`assertResultWritebackFields` remains the
  authority** — the UI does not re-implement the `select`-must-include-`approved` check.

> **P2 (must-fix — why the current value MUST stay in the options):** if a picker listed only
> type-compatible fields, a configured-but-now-incompatible/deleted/missing target would fall out of
> the options, the `<select>` would silently render **empty**, and an unedited save would then trip
> §4's omit-when-empty rule → **the backwrite config is silently deleted** rather than rejected by the
> backend. That is exactly the lossy round-trip this PR exists to prevent, re-introduced through the
> type filter. Preserving the current value as a selectable option closes it: "empty" then
> unambiguously means "the author chose none," and a stale/incompatible target is carried back verbatim
> for the backend to fail-fast.
- Stable `data-field` hooks for tests: `resultWritebackStatusField` / `…ApproverField` /
  `…CompletedAtField`.
- **Job-mode unchanged** — `start_approval` already force-locks `executionMode: workflow_job_v1`
  (06-28 slice); this block adds no execution-mode concern.
- **i18n** — route the new labels through the established `meta-automation-labels` module
  (`automationLabel('resultWriteback.*', isZh)`), the repo's single i18n extension point for this
  editor, rather than extending the inline `isZh ? … : …` ternaries the 06-28 block used. (Surfaced
  as an explicit choice for review; the inline pattern is the local-consistency alternative.)

## 4. Round-trip (the contract that makes it correct)

- **Load** (`draftConfigFromAction`, `start_approval`): read
  `config.resultWriteback.{statusField,approverField,completedAtField}` into the three editable
  bindings (empty string when absent). Continue to spread `...config` so nothing else is disturbed.
- **Save** (`buildActionPayload`, `start_approval`): assemble `resultWriteback` from the three
  pickers and **include it in the emitted config**, with these rules:
  - emit only the **non-empty** fields (each a trimmed non-empty string);
  - if **all three are empty, omit the `resultWriteback` key entirely** (do **not** emit `{}` — the
    backend rejects an empty mapping). This makes "no writeback configured" round-trip to *absence*,
    not to an invalid empty object.
  - **omit-when-empty is safe *only because* the current value is never dropped from the picker
    (§3 P2):** a picker reads empty **iff** the author actively cleared it, never because a configured
    value couldn't be displayed. So an unchanged load → save carries every original field id back
    **verbatim** — a stale/incompatible/missing target reaches the backend and is rejected by
    `assertResultWritebackFields` (fail-fast), and is **never** silently omitted by the UI.
- **Guarantee:** for any saved config — *including one whose target fields are now incompatible-typed,
  deleted, or absent from the current sheet* — *load → save with no edits* yields an **identical**
  `resultWriteback` (and the all-empty → omitted case). The **two** fail-first tests in §5 lock this.

## 5. Test plan

- **Render** — selecting `start_approval` renders the writeback block; the three pickers list the
  source-sheet fields.
- **Save-shape** — setting pickers ⇒ saved `config.resultWriteback` has exactly the chosen
  `{statusField?, approverField?, completedAtField?}`; setting **none** ⇒ `resultWriteback` is
  **absent** from the saved config (asserts the omit-when-empty rule, i.e. not `{}`).
- **Round-trip / lossy-drop fail-first** — load a rule carrying `resultWriteback`, save without
  edits, assert the saved `config.resultWriteback` is unchanged. **Fail-first:** without the
  `buildActionPayload` change, this test must go RED (saved config drops `resultWriteback`) — proving
  the test exercises the real bug, not a tautology.
- **Stale/incompatible round-trip fail-first (P2)** — load a rule whose `resultWriteback` targets a
  field that is **incompatible-typed, deleted, or absent** from the current `fields`; save **without
  editing**; assert the saved `config.resultWriteback` **still carries the original field id** (it must
  **not** become absent/omitted). **Fail-first:** with a type-filtered picker that drops the current
  value, this goes RED (value renders empty → save omits it) — proving the picker-preserves-current-
  value rule (§3 P2) is what saves the config, and that the backend (not the UI) is what rejects a
  stale target.
- **Type hint (advisory)** — a non-conforming target is hinted but the UI does **not** block save;
  the spec asserts the hint, not a UI-side rejection (the backend save-validation owns rejection;
  not duplicated here).
- **No regression** — existing `templateId` / `formDataMapping` render, save, and backfill specs stay
  green; `vue-tsc -b` exit 0.

## 6. Explicit non-goals (named, each a separate later opt-in)

- **Runtime** — already shipped; untouched.
- **Rejection backwrite (next, #3)** — writing back on `rejected` / `cancelled` / `revoked` needs a
  *product* decision first: does a non-approved outcome write back **and continue the tail**, or write
  back **and still fail** the bridge? That semantic must not be smuggled into this UI PR.
- **Cross-base backwrite (#4)** — writing to a record in another base is a security arc
  (permission / lock / audit / target-resolution re-lock), not a small UI extension.
- **`requester` mode UI** — a separate v2 surface. Note: `buildActionPayload` also currently drops a
  hand-authored `requester` on save (same from-scratch rebuild); this slice does **not** add a
  `requester` UI. But because the writeback half-fix would otherwise make the `requester` drop *more*
  surprising (a config with both would partially survive — `resultWriteback` persists while
  `requester` silently vanishes), the implementation **should carry `config.requester` through if
  present** (explicit pass-through, no UI). One cheap line that keeps the save lossless for any
  backend-valid config, not just the keys this slice surfaces.

## 7. Gated TODO (🔒 until this lock is approved → ⬜ when GO → ✅ when landed)

- 🔒 **D1** — writeback sub-block in the `start_approval` editor: three `<select>` pickers over
  `fields`, with `data-field` hooks.
- 🔒 **D2** — `buildActionPayload`: assemble `resultWriteback` (explicit-carry, not a `...config`
  spread); **omit the key when all empty** (fixes the lossy round-trip / avoids the rejected empty
  `{}`); also pass `config.requester` through if present (§6).
- 🔒 **D3** — `draftConfigFromAction`: backfill `config.resultWriteback` into the three pickers.
- 🔒 **D4 (P2 must-fix)** — picker options = type-compatible fields **+ the currently-configured value**
  (always preserved + marked, never excluded by the type filter); type is a hint, not a gate. Guarantees
  "empty = author cleared it," so omit-when-empty can't silently delete a stale/incompatible config.
- 🔒 **D5** — `meta-automation-labels` keys for the new labels (i18n extension point).
- 🔒 **D6** — specs: render · save-shape (incl. omit-when-empty) · round-trip lossy-drop **fail-first**
  · **stale/incompatible round-trip fail-first (P2)** · no-regression · `vue-tsc -b` green.

## 8. Landing

This design-lock is the opt-in artifact. **Implementation is a separate PR**, opened only on
explicit GO against this lock. Brand-neutral: states MetaSheet principles; benchmarked internally,
no external product names in the contract.
