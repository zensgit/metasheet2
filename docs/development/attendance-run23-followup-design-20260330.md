# Attendance Run23 Follow-up Design

## Context

The Run23 product test summary identified four follow-up areas:

1. Admin edit buttons looked visually collapsed in the management tables.
2. CSV import guidance still depended too much on trial-and-error.
3. `engine.templates` authoring syntax was not surfaced in a short operator-facing form.
4. The report also claimed several `GET /:id` attendance routes were missing and referenced a migration conflict around `add_meta_view_config`.

This slice only changes the issues that are still real on current `main`.

## Findings Before Editing

- The current attendance plugin already exposes item routes for:
  - `requests/:id`
  - `holidays/:id`
  - `approval-flows/:id`
  - `rule-sets/:id`
  - `payroll-cycles/:id`
- Current integration tests already lock those endpoints.
- A repository-wide search on current `main` found no `add_meta_view_config` or `meta_view_config` migration artifact to renumber or repair.

Because of that, this slice does **not** add duplicate routes or introduce a speculative migration.

## Scope

### 1. Harden admin table action buttons

Buttons inside `.attendance__table-actions` now declare their own intrinsic size:

- `display: inline-flex`
- `flex: 0 0 auto`
- `min-width: fit-content`
- `min-height: 36px`
- `white-space: nowrap`

This keeps action buttons from collapsing inside flexible table cells.

### 2. Surface import quickstart in the live admin UI

The import template guide now shows a concise single-user quickstart:

- minimum working header:
  - `日期,上班1打卡时间,下班1打卡时间`
- a clarification that multi-user imports still need an employee key or saved mapping profile

This is deliberately small and operator-facing, not a replacement for the deeper DingTalk import notes.

### 3. Surface `engine.templates` syntax in the live rule builder

The structured rule builder now exposes the minimum custom rule shape inline:

- `engine.templates[].rules[]`
- `{ id, when, then }`

This is intended to reduce guesswork before opening the longer template example docs.

### 4. Add concise operator docs

Two lightweight references are added:

- `docs/ATTENDANCE_IMPORT_TEMPLATE_QUICKSTART.md`
- `docs/ATTENDANCE_ENGINE_TEMPLATES_SYNTAX.md`

The existing deeper docs are updated to point at these shorter references first.

## Non-goals

- No new attendance backend routes
- No OpenAPI changes
- No speculative migration renumbering
- No packaging changes
