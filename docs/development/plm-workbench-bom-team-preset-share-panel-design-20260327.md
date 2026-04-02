# PLM Workbench BOM Team Preset Share Panel Design

## Background

`buildTeamFilterPresetShareUrl(...)` used `panel=bom` for BOM team preset share links.

But the workbench deep-link model only recognizes these panel scopes:

- `search`
- `product`
- `documents`
- `approvals`
- `cad`
- `where-used`
- `compare`
- `substitutes`

`bom` is not a valid panel token.

## Problem

When a BOM team preset share URL carries `panel=bom`, the deep-link parser cannot keep that scope.
The current parser falls back to `all` when every token is invalid, so the share link no longer round-trips as an explicit scoped link.

That creates two user-visible mismatches:

- the copied URL claims to target a BOM panel that the app does not actually model
- any later hydration / deep-link parsing can widen the link to the implicit `all` scope instead of preserving a valid explicit scope

## Decision

Normalize BOM team preset share links to `panel=product`.

This matches the existing workbench panel model:

- BOM controls live inside the product workspace
- built-in deep-link presets already represent BOM-focused states through `product` plus BOM query params such as `bomView`

## Implementation

In `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmFilterPresetUtils.ts`:

- keep the public API unchanged
- remap `kind === 'bom' && panel === 'bom'` to `product`
- continue passing through all other explicit panel values unchanged

## Expected Outcome

- BOM team preset share URLs use a valid canonical panel scope
- future deep-link parsing no longer widens `panel=bom` into `all`
- Where-Used team preset share URLs remain unchanged
