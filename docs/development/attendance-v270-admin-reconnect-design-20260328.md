# Attendance v2.7.0 Admin Reconnect Design

## Goal

Close the remaining Run21-era admin regressions without reopening the large monolithic admin page design:

- restore template-version detail viewing
- restore import-batch diagnostics and rollback/retry triage
- restore the structured rule preview lab on the live admin page

The page keeps the current focused-section shell and split-section architecture. This slice only reconnects high-value admin capabilities that were still present in the extracted section implementations.

## Scope

### 1. Import batch diagnostics

Replace the inline import-batch table block in the live admin page with the richer extracted section component:

- `AttendanceImportBatchesSection.vue`
- `useAttendanceAdminImportBatches.ts`

This restores:

- rollback impact estimate
- retry guidance
- mapping viewer
- selected item detail
- richer batch inbox filtering and saved views

### 2. Template version details

Keep the current live template library layout, but restore the missing version-detail affordance:

- add a `View` action for each template version
- show selected version metadata and JSON detail inline

This is the smallest safe reconnect because the version fetch contract already exists and does not require broader section replacement.

### 3. Rule preview lab

Reconnect the highest-value part still missing from the structured rule builder:

- preview action on current builder state
- sample event builder
- scenario presets
- preview summary/recommendations
- draft vs resolved config comparison
- selected preview row detail

This is intentionally landed inside the existing rule-set block in `AttendanceView.vue` rather than by swapping in the old section component wholesale. That keeps the current live page structure stable and avoids reintroducing duplicated rule/group/template shells.

## Design Choices

### Reuse current live page state first

The live page already owns:

- rule-set form state
- rule-builder state
- rule-template loading/saving state
- import-batch loading state

So this slice reuses those refs and only restores the missing derived UI and workflow wiring.

### Keep preview side-effect-light

The preview lab uses builder-derived draft config for preview requests. It does not overwrite the builder with resolved config on each preview. That keeps the lab useful as a comparison tool and avoids surprising edits during experimentation.

### Prefer focused regression coverage

Instead of adding broad E2E for the whole admin console, the regression spec locks the exact reconnect points:

- template version detail
- import-batch diagnostics
- structured rule preview lab

## Non-goals

This slice does not address:

- approval-flow `400` request-body follow-up
- rule-set create `400` follow-up beyond current live reconnect
- `400` vs `404` semantic normalization across all attendance routes
- login redirect flash
