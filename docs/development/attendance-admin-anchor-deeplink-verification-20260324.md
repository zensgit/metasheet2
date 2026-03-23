# Attendance Admin Anchor Deeplink Verification 2026-03-24

## Scope Verified

This verification covers the second-stage attendance admin navigation follow-up on top of the prior root-admin stabilization branch.

Verified behaviors:

- quick-find filters the left anchor rail
- count label changes from total-only to visible/total when filtered
- empty-state copy renders when the filter produces no matches
- clicking an anchor updates `window.location.hash`
- loading `/attendance#<section-id>` restores the target section and active rail item
- `previewSnapshot.context` absence still does not crash the import batch status path
- the clean branch builds independently because the required timezone helper module is present

## Commands

### Frontend targeted tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-anchor-nav.spec.ts tests/attendance-import-batch-timezone-status.spec.ts --watch=false
```

Result:

- `2` files passed
- `9` tests passed

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

- The initial hash-restore implementation needed an extra mount-safe restore pass. The final version uses a bounded next-tick retry helper so the deep link is restored reliably on first load and remains deterministic in the unit test harness.
- `apps/web/src/utils/timezones.ts` is included in this follow-up because `AttendanceView.vue` already imports it. Without the file, the clean branch cannot pass `vue-tsc` or `build` on its own.
