# PLM Workbench Local Preset Share Bootstrap Design

## Context

Local `BOM / Where-Used filter preset` share links previously only transported the encoded
import payload:

- `bomPresetShare`
- `whereUsedPresetShare`
- optional `replace` mode

That was enough to import the preset, but not enough to make a cold start land in the
right runtime context.

### Live mismatch

- `BOM` local preset share links did not preserve `panel=product`
- they did not preserve `productId / itemNumber / itemType`
- they did not preserve `autoload=true`
- `Where-Used` local preset share links did not preserve `panel=where-used`
- they did not preserve `productId / itemNumber / itemType`
- they did not preserve `whereUsedItemId`
- they did not preserve `autoload=true`

As a result, the recipient could import the preset payload, but fresh-open behavior still
lagged behind the now-fixed team preset share path.

## Decision

Upgrade local preset share links to carry the same minimum bootstrap context as the
team preset share flow.

### BOM local preset share

- `panel=product`
- `productId`
- `itemNumber`
- `itemType`
- `autoload=true` when product identity exists

### Where-Used local preset share

- `panel=where-used`
- `productId`
- `itemNumber`
- `itemType`
- `whereUsedItemId`
- `autoload=true` when `whereUsedItemId` exists

## Implementation

### Helper contract

In `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmFilterPresetUtils.ts`:

- extend `buildFilterPresetShareUrl(...)` with optional route context
- keep encoded payload behavior unchanged
- append panel/bootstrap context per preset kind

### Call sites

In `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue`:

- `shareBomFilterPreset()` now passes current product context
- `shareWhereUsedFilterPreset()` now passes current product context and `whereUsedItemId`

## Expected Outcome

Fresh-open local preset share links now:

- still import the shared preset payload
- also reopen the relevant PLM panel with enough context to bootstrap the underlying view
