# Attendance Timezone Selector Groups Design 2026-03-23

## Background

The attendance admin timezone selectors already moved away from raw text input, but the first version still rendered one long flat option list.

That solved validation issues, but it left two UX problems:

1. Operators still had to scan a very long list to find common timezones.
2. The selector did not visually separate high-frequency timezones from the full IANA catalog.

## Goal

Upgrade the shared attendance timezone selector model so that:

1. Common timezones appear first.
2. The full timezone list is grouped by region.
3. Existing saved values still render correctly.
4. Stored payloads remain unchanged and continue to use raw IANA timezone strings.

## Scope

This update applies to the attendance admin selectors already introduced in the previous timezone-selector change:

1. Rule set builder timezone
2. Attendance group timezone
3. Default rule timezone
4. Rotation rule timezone
5. Shift timezone
6. Holiday sync auto timezone
7. Import timezone
8. Optional import group timezone
9. Payroll template timezone

## Shared Design

The shared timezone utility now exposes grouped options in addition to the existing flat label formatter:

1. `buildTimezoneOptionGroups(currentValue)`
2. `formatTimezoneOptionLabel(timezone)`
3. `formatTimezoneOffsetLabel(timezone)`

The grouped builder has three behaviors:

1. Promote current value and browser-local timezone into the leading common bucket when possible.
2. Keep a curated `Common timezones` group for the most frequent attendance admin cases.
3. Bucket remaining options by IANA region such as `Asia`, `Europe`, and `Americas`.

## UX Decision

The grouped selector stays as native `<select>` plus `<optgroup>`.

Reason:

1. It keeps keyboard and browser accessibility behavior intact.
2. It avoids introducing a larger combobox/search component across several admin forms.
3. It is a low-risk second-step improvement on top of the existing selector rollout.

## Compatibility

This update remains backward compatible:

1. Saved timezone values are still raw identifiers such as `Asia/Shanghai`.
2. Unknown current values are still injected into the option list and grouped under `Other / custom`.
3. API payloads and server-side validation do not change.

## Out of Scope

This change does not:

1. Add fuzzy timezone search
2. Infer timezone from organization profile
3. Rework backend timezone semantics
