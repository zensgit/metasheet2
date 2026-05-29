# Multitable View-Config Re-Save Guard Design (2026-05-29)

- **Slice**: follow-up to priority-#2 (b) (#2052 design / #2059 impl).
- **Status**: design-lock candidate. Implementation is a separate opt-in.
- **Grounding**: drafted from `origin/main` at `2aa34bb83`.
- **Goal**: prevent read-path redaction from silently corrupting persisted view filters when a field-denied user re-saves a view.

## 1. Problem

#2059 redacts saved-view filter literals at every readback by omitting `filterInfo.conditions[].value` when the condition references a field the requester cannot read. That is correct for read safety, but it creates a write-path edge:

1. A view is persisted with a filter condition such as `{ fieldId: "FLD_SECRET", operator: "is", value: "salary-120k" }`.
2. A user with `canManageViews=true` but `field_permissions.visible=false` for `FLD_SECRET` reads the view.
3. The readback keeps `{ fieldId, operator }` but omits `value` (`redactViewConfigFilterLiterals`, `univer-meta.ts:2308`).
4. `MetaViewManager` hydrates that as `value: item.value` (`MetaViewManager.vue:823`) and renders the input as empty (`:338`).
5. The manager's dirty-state serializer and PATCH payload path both carry `value: condition.value` (`:846`, `:1081`); when that value is `undefined`, the JSON request omits the key.
6. `PATCH /views/:viewId` currently persists `parsed.data.filterInfo` directly as `nextFilter` (`univer-meta.ts:5203`) and overwrites `meta_views.filter_info` (`:5236`).

Result: a no-op edit, such as changing a view title or card setting, can erase the hidden filter literal that the user was not allowed to see. This is not a read leak, but it is silent data corruption caused by the read-redaction contract.

## 2. Scope

In scope:

- `PATCH /api/multitable/views/:viewId` only. This is the path that updates an existing saved view and has an original `filter_info` row to preserve.
- `filterInfo.conditions[].value` only. This follows #2059's value-only model.
- Denied means the same #2059 composite: layer-2 `property.hidden` plus layer-3 `field_permissions.visible=false`, with layer-1 `view.hidden_field_ids` still display-only.
- Preserve an existing literal when the incoming condition is a redacted echo of the same saved condition and has no `value` key.

Out of scope:

- `POST /views`: there is no prior saved literal to preserve. Existing `canManageViews` create semantics stay unchanged.
- Changing whether a field-denied `canManageViews` user may explicitly write a new literal for a denied field. If the incoming condition includes its own `value`, this slice treats it as explicit writer intent and preserves existing behavior; the response remains redacted.
- Frontend redesign such as disabled redacted inputs, redacted badges, or condition IDs.
- Full field-definition strip, other layer-2-only read sites, RBAC/auth/integration-core.

## 3. Contract

Add a pure server-side merge helper, conceptually:

```ts
mergeRedactedFilterInfoForUpdate({
  incomingFilterInfo,
  currentFilterInfo,
  allowedFieldIds,
})
```

Rules:

1. If the request omits `filterInfo`, keep the existing `filter_info` unchanged, as today.
2. If a condition's `fieldId` is allowed, trust the incoming condition.
3. If a condition's `fieldId` is denied and the incoming condition has its own `value` key, trust the incoming condition. This preserves the pre-existing `canManageViews` write behavior and avoids adding a new product policy in this guard slice.
4. If a condition's `fieldId` is denied and the incoming condition has no `value` key, compare it with the condition at the same array index in the current DB filter.
5. If that same-index current condition has the same `fieldId` and `operator` and has a `value` key, copy the current `value` into the incoming condition before persisting.
6. If that same-index current condition has the same `fieldId` and `operator` and also has no `value` key, allow the incoming condition as-is. This preserves normal unary filters such as `isEmpty` / `isNotEmpty`, which have no literal to protect (`MetaViewManager.vue:995-998`).
7. If a denied incoming condition has no `value` and cannot be matched safely by same index plus `fieldId` and `operator`, reject the update with `400 VALIDATION_ERROR`. Do not persist a missing literal, and do not guess by field/operator across the whole list.
8. If a denied condition is removed from the incoming list, it is removed. The guard must not resurrect removed conditions.

Why index plus `(fieldId, operator)`:

- There are no stable condition IDs today.
- `MetaViewManager` preserves condition order during ordinary edits.
- A global "unique by field/operator" fallback can cross-fill the wrong literal when duplicates exist.
- Rejecting ambiguous or structurally changed redacted conditions is safer than silently corrupting data.

## 4. Implementation Shape

`PATCH /views/:viewId` already loads the current row before writing (`univer-meta.ts:5191`). The implementation should:

1. Resolve capabilities and enforce `canManageViews` as today.
2. Compute `allowedFieldIds` for the writer using the same #2059 helper path (`loadAllowedFieldIds`) before constructing `nextFilter`.
3. If `parsed.data.filterInfo !== undefined`, pass `parsed.data.filterInfo`, `normalizeJson(row.filter_info)`, and `allowedFieldIds` through the merge helper.
4. Persist the merged filter info in the existing `UPDATE meta_views` call.
5. Cache the unredacted merged view (`metaViewConfigCache.set(viewId, view)`) and return `redactViewConfigFilterLiterals(view, allowedFieldIds)` as today.

This keeps the cache invariant from #2059: cached view configs are unredacted; redaction is per-response and pure.

## 5. Verification Matrix

All permission-path tests should be real-DB integration tests. Mock-pool tests can cover helper edge cases, but they are not sufficient for the field-scope path.

- **R1 fail-first corruption proof**: Seed a view with a denied field condition containing a unique literal. Read it as a `canManageViews` but field-denied user and confirm the response omits `value`. PATCH the same view with the redacted condition and an unrelated setting change. Assert DB `meta_views.filter_info` still contains the original literal, and the response still omits it.
- **R2 visible field still updates**: A condition on an allowed field updates its `value` normally.
- **R3 denied explicit write remains current behavior**: If the same user submits an explicit `value` for a denied field, the DB stores that submitted value and the response redacts it. This pins the scope boundary: this slice is a preservation guard, not a new denied-field write policy.
- **R4 remove means remove**: If the denied condition is absent from the incoming `conditions[]`, it is removed from `filter_info`; the guard must not resurrect it.
- **R5 structural mismatch rejects**: If a denied condition arrives without `value` but the same array index no longer has the same `fieldId` and `operator` in the current DB filter, return `400 VALIDATION_ERROR` and leave DB state unchanged.
- **R6 property.hidden path**: Repeat preservation for a layer-2 `property.hidden=true` field with no layer-3 denial. #2059 redacts it, so this guard must preserve it too.
- **R7 layer-1 stays display-only**: A readable-but-view-hidden field keeps normal write behavior; no preservation guard should trigger just because the field is in `hidden_field_ids`.
- **R8 cache/response invariant**: After a preserved update, a fully allowed user can read the literal, while the denied writer's immediate response remains redacted.
- **R9 unary denied condition remains valid**: A denied `isEmpty` / `isNotEmpty` condition with no current `value` key can be re-saved without rejection and without manufacturing a value.

Fail-first requirement:

- R1 and R6 must fail on unmodified `origin/main` because the DB literal is overwritten/removed after PATCH.

## 6. Risks And Non-Goals

- A user can still intentionally edit a denied-field literal by submitting a `value`. That is pre-existing `canManageViews` write behavior and should not be changed accidentally in this guard slice. If product wants "field-denied users cannot author denied-field filter literals", that is a separate policy slice.
- Without condition IDs, the server cannot distinguish every reorder/duplicate scenario. This design chooses safe preservation for ordinary unchanged redacted conditions and rejects unsafe structural changes.
- Frontend may still render redacted values as empty inputs. A later UX slice can add a "value hidden by permissions" badge or disable the value input for redacted conditions, but the server-side guard is the data-safety backstop.

## 7. Landing Checklist

- [x] Design-lock drafted.
- [ ] Implement pure merge helper + `PATCH /views/:viewId` wiring.
- [ ] Add real-DB tests R1-R9 with fail-first evidence for R1/R6.
- [ ] Run `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/multitable-viewconfig-resave-guard.test.ts`.
- [ ] Run backend type-check / PR CI.
- [ ] Keep #2059 docs unchanged unless implementation discovers a different contract.
