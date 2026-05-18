# Multitable Home Recents And Favorites Development

Date: 2026-05-18

Branch: `codex/multitable-home-recents-favorites-20260518`

## Goal

Improve the `/multitable` default entry after the Base search and template quickstart work by making frequently used Bases easier to reopen without adding backend schema, route, or permission changes.

## Scope

In scope:

- Add client-side favorite Base pins on the `/multitable` home Base cards.
- Add client-side recent-open ordering for successfully opened Bases.
- Preserve Base search, template quickstart, create-base, and legacy routing behavior.
- Add focused unit coverage for storage parsing, ordering, and home UI behavior.

Out of scope:

- No backend route, migration, OpenAPI, permission, or template changes.
- No cross-device/server-side favorites.
- No Workbench Base picker changes; this PR only upgrades the default home entry.

## Design

The implementation adds `apps/web/src/multitable/utils/base-local-state.ts` as a small browser-local state utility:

- `metasheet:multitable:favorite-base-ids:v1` stores `string[]` of Base IDs.
- `metasheet:multitable:recent-base-opens:v1` stores `{ baseId, openedAt }[]`.
- Reads are defensive: missing storage, invalid JSON, or malformed entries return an empty state.
- Writes are best-effort and swallowed so private-mode or quota failures do not block navigation.
- `decorateAndSortBases()` filters stored IDs to currently loaded Bases, then sorts favorites first, recent opens by newest timestamp, and untouched Bases by original API order.

`MultitableHomeView.vue` now renders a favorite action per Base card and "收藏" / "最近打开" badges. It calls `rememberRecentBaseOpen()` only after a Base has a resolvable sheet/view target, so failed opens do not pollute local recents.

## Parallel Scout

A read-only scout checked existing storage patterns before implementation. The final PR reused the defensive localStorage approach from existing workflow/attendance utilities while keeping the product scope home-only.

## Files

- `apps/web/src/multitable/utils/base-local-state.ts`
- `apps/web/src/views/MultitableHomeView.vue`
- `apps/web/tests/multitable-base-local-state.spec.ts`
- `apps/web/tests/multitable-home-view.spec.ts`
- `docs/development/multitable-home-recents-favorites-development-20260518.md`
- `docs/development/multitable-home-recents-favorites-verification-20260518.md`

## Risk Notes

- Local favorites/recents are intentionally browser-local and may not roam across devices.
- Stored Base IDs that are no longer accessible are ignored during decoration and sorting.
- This is frontend-only, so no migration or rollback step is needed.

