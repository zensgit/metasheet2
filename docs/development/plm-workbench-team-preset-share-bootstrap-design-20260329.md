# PLM Workbench Team Preset Share Bootstrap Design

## Context

`BOM / Where-Used team preset` share links previously only serialized:

- panel
- team preset id
- filter value
- filter field

That preserved collaborative preset identity, but it did not preserve enough runtime
context to make a cold start usable.

### Live gaps

- `BOM` shared team preset links did not include `productId / itemNumber / itemType`
- `BOM` shared team preset links did not include `autoload=true`
- `Where-Used` shared team preset links did not include `whereUsedItemId`
- `Where-Used` shared team preset links did not include `autoload=true`

As a result, a fresh open would often hydrate the team preset owner/filter state but fail
to bootstrap the underlying product or where-used data.

## Decision

Extend `buildTeamFilterPresetShareUrl(...)` to accept optional route context and include
the minimum cold-start context needed for each panel:

- `BOM`
  - `productId`
  - `itemNumber`
  - `itemType`
  - `autoload=true` when product identity exists
- `Where-Used`
  - `productId`
  - `itemNumber`
  - `itemType`
  - `whereUsedItemId`
  - `autoload=true` when `whereUsedItemId` exists

## Implementation

### Helper contract

In `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmFilterPresetUtils.ts`:

- add optional `routeContext` to `buildTeamFilterPresetShareUrl(...)`
- serialize panel-specific cold-start context
- keep existing collaborative identity behavior unchanged

### Call sites

In `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue`:

- `BOM` team preset sharing now passes current product route context
- `Where-Used` team preset sharing now passes current product route context plus `whereUsedItemId`

## Expected Outcome

Fresh-open team preset share links now do both:

- preserve the collaborative preset owner/filter identity
- bootstrap the panel's backing runtime context instead of only hydrating route state
