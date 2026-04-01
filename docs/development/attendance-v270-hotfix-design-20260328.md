# Attendance v2.7.0 Hotfix Design

## Goal

Close the most visible Attendance regressions reported after the v2.7.0 rollout without broad refactors:

- Keep the admin center readable by focusing the right panel on the clicked left-side section.
- Restore the Run21 UX slices that were missing in v2.7.0:
  - holiday month-calendar management
  - structured rule builder
  - user picker in group membership flows
  - import template field guidance
- Add the missing backend lookup route for rotation rules with consistent UUID semantics.

## Frontend Design

### Admin focus mode

The admin page now supports a focused mode:

- clicking a left rail item activates that section and scrolls it into view
- the page can temporarily switch to "show all sections"
- returning to a section automatically switches back to focused mode

This keeps the content area from showing unrelated blocks while the user is navigating a single admin task.

### Run21 UX regressions restored

The following UI pieces were restored in the existing admin page:

- a user picker field for group/member flows, so a user can be appended directly
- a visible import template guide showing:
  - source
  - import mode
  - suggested CSV header
  - field meanings
  - required fields
  - selected mapping profile details
- a month-calendar style holiday section so dates can be clicked directly
- a structured rule builder section for rule set JSON generation

These are implemented as in-page sections, so they remain aligned with the current admin architecture.

## Backend Design

### Rotation rule lookup

Added `GET /api/attendance/rotation-rules/:id` to the attendance plugin:

- invalid UUIDs return `400`
- valid UUIDs that do not exist return `404`
- successful lookups return the same normalized payload shape as the existing row mapper, via `mapRotationRuleRow(row)`

OpenAPI was updated to match the new route, and a focused integration assertion now covers the happy path.

## Non-goals

This hotfix does not try to redesign the whole Attendance settings experience or rewrite the broader integration suite. It only restores the requested Run21-facing slices and the missing rotation-rule lookup route.
