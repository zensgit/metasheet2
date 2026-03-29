# Attendance Admin Nav Shortcuts Design

Date: 2026-03-29

## Goal

Extend the already-landed attendance admin navigation UX without adding left-rail clutter:

- remember `focused` vs `show all` mode per workspace/org scope
- add keyboard previous/next section switching
- keep the interaction centered on the existing right-side sticky current-section bar

## Scope

Frontend only.

Files in scope:

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/attendance/useAttendanceAdminRail.ts`
- `apps/web/src/views/attendance/useAttendanceAdminRailNavigation.ts`
- focused tests under `apps/web/tests`

## Design Choices

### 1. Persist focus mode where other rail preferences already live

`useAttendanceAdminRail.ts` already owns org-scoped local storage for:

- collapsed groups
- recent sections
- last active section

So the new `focused/show all` preference is stored there too, keyed by the same scoped storage model.

This avoids introducing a second persistence seam in `AttendanceView.vue`.

### 2. Put keyboard navigation in the navigation composable

`useAttendanceAdminRailNavigation.ts` already owns:

- section registration
- hash sync
- restore-from-hash
- section scrolling

Keyboard `Alt+ArrowUp` / `Alt+ArrowDown` is implemented there so it reuses the same `scrollToAdminSection()` path as click navigation.

### 3. Do not steal keys from forms

Attendance admin is form-heavy. Keyboard switching explicitly no-ops while the target or active element is:

- `input`
- `textarea`
- `select`
- `button`
- `contentEditable`

That keeps section switching from interfering with typing and inline editing.

### 4. Surface the shortcut where the user is already looking

The sticky current-section bar now includes the shortcut hint and continues to host:

- previous/next pager
- focus/show-all toggle

No new control surface is added to the left rail.

## Claude Code Note

Claude Code was actually invoked during this slice. The useful boundary advice was:

- persist focused/show-all in `useAttendanceAdminRail.ts`
- place keyboard navigation in `useAttendanceAdminRailNavigation.ts`
- keep the feature inside the right sticky current-section bar

The final implementation follows that boundary.
