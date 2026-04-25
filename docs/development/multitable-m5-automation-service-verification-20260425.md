# Multitable M5 automation-service extraction verification

Date: 2026-04-25
Branch: `codex/multitable-m5-automation-service-20260425`
Base: `origin/main@fa559458b`

## Commands

Run from the worktree root:

```bash
pnpm install --prefer-offline --ignore-scripts
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-automation-service.test.ts \
  tests/unit/automation-routes-wiring.test.ts \
  tests/unit/automation-scheduler-leader.test.ts \
  tests/unit/automation-scheduler-metrics.test.ts \
  tests/unit/automation-v1.test.ts \
  tests/unit/dingtalk-automation-link-validation.test.ts \
  tests/unit/plugin-automation-registry.test.ts \
  tests/unit/multitable-permission-service.test.ts \
  tests/unit/multitable-access.test.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/dingtalk-automation-link-routes.api.test.ts \
  --reporter=dot
```

## Results

### Typecheck

`pnpm --filter @metasheet/core-backend exec tsc --noEmit` → exit `0`.

### Unit tests

```text
Test Files  9 passed (9)
Tests       226 passed (226)
```

Breakdown:

- `multitable-automation-service.test.ts`: 33 / 33 (12 pre-existing + 21
  new M5 helper assertions covering `serializeAutomationRule`,
  `parseDingTalkAutomationDeliveryLimit`, `parseCreateRuleInput`,
  `parseUpdateRuleInput`, `preflightDingTalkAutomationCreate`,
  `preflightDingTalkAutomationUpdate`).
- `automation-routes-wiring.test.ts`: 6 / 6.
- `automation-scheduler-leader.test.ts`: 11 / 11.
- `automation-scheduler-metrics.test.ts`: 10 / 10.
- `automation-v1.test.ts`: 122 / 122.
- `dingtalk-automation-link-validation.test.ts`: 8 / 8.
- `plugin-automation-registry.test.ts`: 4 / 4.
- `multitable-permission-service.test.ts`: 24 / 24 (regression
  sentinel for the M4 surface — unchanged).
- `multitable-access.test.ts`: 8 / 8.

### Integration tests (automation paths)

```text
Test Files  1 passed (1)
Tests       32 passed (32)
```

Breakdown:

- `dingtalk-automation-link-routes.api.test.ts`: 32 / 32. This file
  spies on `validateDingTalkAutomationLinks` and asserts the spy is
  called with the post-normalization payload (`bodyTemplate` /
  `titleTemplate` rather than raw `content` / `title`); it passes
  unchanged because the new
  `preflightDingTalkAutomationCreate` / `preflightDingTalkAutomationUpdate`
  helpers run the same `normalizeDingTalkAutomationActionInputs`
  pipeline at the route boundary.

## LoC delta proof

```
git diff -- packages/core-backend/src/routes/univer-meta.ts | grep -c '^-[^-]'
# 175
git diff -- packages/core-backend/src/routes/univer-meta.ts | grep -c '^+[^+]'
# 21
git diff --stat -- packages/core-backend/src/routes/univer-meta.ts \
                    packages/core-backend/src/multitable/automation-service.ts
# packages/core-backend/src/multitable/automation-service.ts | 290 +++++++++++++++++++
# packages/core-backend/src/routes/univer-meta.ts            | 205 ++-------------
# 2 files changed, 311 insertions(+), 184 deletions(-)
wc -l packages/core-backend/src/routes/univer-meta.ts
# 6971 packages/core-backend/src/routes/univer-meta.ts (was 7134)
```

`univer-meta.ts` shrinks by 154 net lines (−175 / +21);
`automation-service.ts` grows by 290 lines, of which 8 are the new
`VALID_ACTION_TYPES` constant + defensive trigger / action validation
branches inside `createRule` / `updateRule`, and the rest are the new
exported route helpers and their JSDoc. The LoC budget gate
(`deletes > additions on univer-meta.ts`) is satisfied: 175 > 21.

The smaller delta versus M4's −1034 reflects the smaller surface left
in this region — the `AutomationService` class itself was already
extracted; M5 only collapses the route-handler residue.

## Coverage notes

The new `multitable-automation-service.test.ts` cases exercise:

- `serializeAutomationRule`: legacy shape parity, `null name` →
  `''`, `null createdBy` → `undefined`.
- `parseDingTalkAutomationDeliveryLimit`: missing / non-numeric →
  default 50; clamping to `[1, 200]`; flooring inside the valid
  range.
- `parseCreateRuleInput`: well-formed body, fall-back from
  `actions[0]` to top-level `actionType` / `actionConfig`,
  rejection of unknown trigger / action types,
  default `enabled: true` and safe defaults for missing optional
  fields.
- `parseUpdateRuleInput`: returns `null` for empty body / unknown
  fields; only touched fields are returned; objects pass through
  un-stringified; explicit `null` is preserved for `conditions` /
  `actions`; rejection of unknown trigger / action types; legacy
  `notify` and `update_field` action types remain accepted.
- `preflightDingTalkAutomationCreate`: pass-through for non-DingTalk
  actions; `AutomationRuleValidationError` on invalid action config.
- `preflightDingTalkAutomationUpdate`: pass-through when the update
  does not touch action fields (no `getRule` call); returns `null`
  when the existing rule is missing or belongs to a different sheet
  (route maps that to `404 NOT_FOUND`).

The route-shape regression sentinel
(`automation-routes-wiring.test.ts`) and the link-validation
integration sentinel
(`dingtalk-automation-link-routes.api.test.ts`) are both green,
proving the route boundary semantics are unchanged.

## Pre-existing baseline

No pre-existing baseline failures were observed for the automation
paths during this work. The `dingtalk-automation-link-routes.api.test.ts`
suite is the strictest behavioral gate for this extraction and passes
without modification.
