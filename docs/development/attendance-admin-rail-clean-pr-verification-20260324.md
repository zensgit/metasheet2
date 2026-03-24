# Attendance Admin Rail Clean PR Verification 2026-03-24

## Branch Under Verification

- Branch: `codex/attendance-admin-rail-clean-20260324`
- Base: `origin/main`

## Verified Change Set

The clean branch contains only the attendance admin rail frontend extraction and the smallest utility dependency closure required to compile on top of `main`.

Verified files:

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/attendance/AttendanceAdminRail.vue`
- `apps/web/src/views/attendance/useAttendanceAdminRail.ts`
- `apps/web/src/views/attendance/useAttendanceAdminRailNavigation.ts`
- `apps/web/src/utils/error.ts`
- `apps/web/src/utils/timezones.ts`
- `apps/web/tests/AttendanceAdminRail.spec.ts`
- `apps/web/tests/useAttendanceAdminRail.spec.ts`
- `apps/web/tests/useAttendanceAdminRailNavigation.spec.ts`
- `apps/web/tests/attendance-admin-anchor-nav.spec.ts`
- `apps/web/tests/attendance-import-batch-timezone-status.spec.ts`
- `apps/web/tests/utils/error.spec.ts`

## Local Validation

### Focused Frontend Test Suite

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/useAttendanceAdminRailNavigation.spec.ts \
  tests/useAttendanceAdminRail.spec.ts \
  tests/AttendanceAdminRail.spec.ts \
  tests/attendance-admin-anchor-nav.spec.ts \
  tests/attendance-import-batch-timezone-status.spec.ts \
  tests/utils/error.spec.ts \
  --watch=false
```

Result:

- Passed
- `6 files / 31 tests passed`

### Type Check

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- Passed

### Production Build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

- Passed
- Only the existing large chunk size warning was emitted

## Runtime Behavior Confirmed

The validated clean branch preserves the behavior previously developed on the larger attendance branch:

- grouped left admin rail for the long attendance management page
- quick-find filtering
- recent shortcuts
- current section summary
- hash deep-link restore
- copy-current-link support
- org-scoped persistence for collapsed groups, recent shortcuts, and last section
- last-section restore when no explicit hash exists
- compact rail behavior on narrow viewports
- active section sync between content scroll and rail state
- null-safe batch preview snapshot context rendering

## Clean Branch Packaging Notes

This verification was performed on a dedicated clean worktree created from `origin/main`.

To make the clean worktree runnable locally, shared `node_modules` symlinks were reused from the main repository checkout. Those local symlinks are not part of the change set and must not be committed.

## Claude Code Verification Note

Claude Code CLI was explicitly rechecked during this cleanup pass.

Observed local state:

- binary: `/Users/huazhou/.local/bin/claude`
- version: `2.1.74 (Claude Code)`
- current shell `claude auth status`: `loggedIn: false`

The desktop Claude installation exists under `~/Library/Application Support/Claude`, but the current shell CLI is not reading a usable login session from `~/.config/claude`, which currently resolves to an empty symlinked directory. Because of that mismatch, implementation and verification were completed with local code/tests instead of depending on Claude CLI execution.

## Merge Readiness

From a local verification standpoint, this clean branch is ready to review:

- focused tests pass
- type-check passes
- production build passes
- change set is limited to the admin rail slice plus required frontend utility dependencies
