# Attendance Admin Anchor Deeplink, Grouped Rail, Collapse Persistence, Compact Rail UX, Share Links, Recent Shortcuts, Active-Link Visibility, Last-Section Restore, Org-Scoped Rail State, Scope Badge, And Scope-Change Feedback Verification 2026-03-24

## Scope Verified

This verification covers the twelfth-stage attendance admin navigation follow-up on top of the prior root-admin stabilization branch.

Verified behaviors:

- the left rail renders five stable business-domain groups instead of a 22-item flat list
- groups can be collapsed and re-expanded without breaking anchor behavior
- collapsed group ids persist across remounts through `localStorage`
- `Expand all` and `Collapse all` update grouped navigation state consistently
- compact mode hides the rail behind a toggle until explicitly opened
- compact mode promotes the active group to the first visible group
- the rail can copy the current admin section link through the clipboard API
- the rail surfaces recent admin sections and keeps them ordered by last visit
- recent admin sections persist across remounts through `localStorage`
- the active grouped rail link scrolls back into view when the active admin section changes
- the admin console restores the last active section when the page is reopened without a hash
- collapsed groups, recents, and last-section restore switch buckets when org id changes
- the rail header exposes a scope badge only when the effective org bucket is non-default
- switching org scope shows a short-lived confirmation note inside the rail panel
- quick-find filters the left anchor rail
- count label changes from total-only to visible/total when filtered
- empty-state copy renders when the filter produces no matches
- clicking an anchor updates `window.location.hash`
- loading `/attendance#<section-id>` restores the target section and active rail item even when its group id is persisted as collapsed
- `previewSnapshot.context` absence still does not crash the import batch status path
- the clean branch builds independently because the required timezone helper module is present

## Commands

### Frontend targeted tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-anchor-nav.spec.ts tests/attendance-import-batch-timezone-status.spec.ts --watch=false
```

Result:

- `2` files passed
- `19` tests passed

### Frontend type-check

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- passed

### Frontend production build

```bash
pnpm --filter @metasheet/web build
```

Result:

- passed

## Inherited Backend Baseline

This follow-up does not modify backend code. The backend verification baseline remains the prior clean-branch stabilization commit:

```bash
pnpm --filter @metasheet/core-backend test:integration:attendance
```

Prior result on the parent clean branch:

- `18/18` passed

## Notes

- The grouped rail keeps a flat item list for `IntersectionObserver`, hash validation, and section element resolution. Grouping is purely a render-layer concern.
- Persisted collapse state is sanitized against the current known group ids before reuse, so stale storage does not break the rail.
- Compact mode stays intentionally attendance-local. It is only a presentation layer over the same grouped rail model and does not create a new navigation contract for the rest of MetaSheet.
- The share action deliberately depends on the existing active-section state and clipboard API; it does not introduce a parallel deep-link registry.
- The recent strip deliberately uses the same section ids and click handler as the grouped rail, so it stays a shortcut layer rather than becoming a second navigation tree.
- Active-link visibility is implemented as a separate rail-only scroll sync. The content section scroll and the rail visibility scroll are both expected and verified in the targeted harness.
- Last-section restore is intentionally lower priority than a valid hash. Once restored, it reuses the existing active-section synchronization and therefore surfaces the matching hash as part of the normal rail state model.
- Org-scoped persistence uses the existing `orgId` state as the bucket selector with `default` fallback, so the behavior can be exercised without adding a new admin-only org switcher.
- The scope badge is intentionally absent for the `default` bucket. It is meant to explain cross-org state changes, not add noise to the default case.
- The scope-change note is intentionally local to the rail panel, not the shared admin status block. It confirms the bucket switch without competing with save/load/error feedback.
- The initial hash-restore implementation still double-fired in the unit harness because mount-time restore and later admin-state synchronization could overlap. The final version keeps the bounded next-tick retry helper and adds a non-reentrant restore gate so first-load deep links scroll exactly once.
- `apps/web/src/utils/timezones.ts` is included in this follow-up because `AttendanceView.vue` already imports it. Without the file, the clean branch cannot pass `vue-tsc` or `build` on its own.
