# Multitable Base Owner Sheet Create Development

Date: 2026-04-07

## Scope

This slice introduces the first base-admin source for multitable sheet creation.

The goal is narrow:

- allow a base owner to create a sheet under that base without global `multitable:write`

Out of scope:

- a general `base_permissions` model
- base sharing or base admin authoring
- base deletion
- changing sheet creation semantics when `baseId` is omitted

## Runtime Changes

- Removed the route-level `rbacGuard('multitable', 'write')` from `POST /api/multitable/sheets`.
- Resolved request access inside the route.
- Kept the existing global-write path unchanged.
- Added explicit base ownership fallback for explicit `baseId` requests:
  - load `meta_bases.id, owner_id`
  - allow sheet creation if:
    - requester already has global multitable write, or
    - requester matches `meta_bases.owner_id`
- Preserved legacy-base creation behavior:
  - when `baseId` is omitted, global multitable write is still required
- Added a strict forbidden response for unowned base creation attempts without global write.

## Rationale

The repository already had real sheet-scoped ACL sources, but sheet creation still depended only on global multitable write.

There was no existing base-scoped permission table or grant resolver. The only reliable base-level ownership signal already present in the schema was `meta_bases.owner_id`, so this slice uses that as the first base-admin source instead of introducing a new table prematurely.
