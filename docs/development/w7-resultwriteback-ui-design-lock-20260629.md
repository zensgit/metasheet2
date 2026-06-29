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
- **Lightweight, advisory type filter/hint** mirroring the backend type contract (§1): only offer
  (or visibly hint) `string`/`longText`/`select` for status, `string`/`longText` for approver,
  `string`/`longText`/`dateTime` for completedAt. This is a convenience to steer the author toward a
  valid choice; **`assertResultWritebackFields` remains the authority** — the UI does not re-implement
  the `select`-must-include-`approved` check or block save on it.
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
- **Guarantee:** for any backend-valid saved config, *load → save with no edits* yields an
  **identical** `resultWriteback` (including the all-empty → omitted case). This is the fail-first
  test in §5.

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
  hand-authored `requester` on save (same from-scratch rebuild); this slice does **not** address that
  — it is called out here only so the reviewer knows the omission is deliberate, not overlooked.

## 7. Gated TODO (🔒 until this lock is approved → ⬜ when GO → ✅ when landed)

- 🔒 **D1** — writeback sub-block in the `start_approval` editor: three `<select>` pickers over
  `fields`, with `data-field` hooks.
- 🔒 **D2** — `buildActionPayload`: assemble `resultWriteback`; **omit the key when all empty**
  (fixes the lossy round-trip / avoids the rejected empty `{}`).
- 🔒 **D3** — `draftConfigFromAction`: backfill `config.resultWriteback` into the three pickers.
- 🔒 **D4** — advisory type filter/hint per the backend field-type contract (backend stays the
  authority).
- 🔒 **D5** — `meta-automation-labels` keys for the new labels (i18n extension point).
- 🔒 **D6** — specs: render · save-shape (incl. omit-when-empty) · round-trip lossy-drop **fail-first**
  · no-regression · `vue-tsc -b` green.

## 8. Landing

This design-lock is the opt-in artifact. **Implementation is a separate PR**, opened only on
explicit GO against this lock. Brand-neutral: states MetaSheet principles; benchmarked internally,
no external product names in the contract.
