# PLM Workbench Audit Return Path Collaborative Snapshot Design

## Background

`buildPlmWorkbenchRoutePath(...)` is used to build `returnToPlmPath` for audit entry flows. Before this change it serialized the raw normalized workbench query snapshot, including local-only preset identities such as:

- `bomFilterPreset`
- `whereUsedFilterPreset`

Those keys are browser-local state. Carrying them into `auditReturnTo` made saved audit views and copied audit URLs depend on local presets that may not exist when the path is reopened elsewhere.

## Decision

Route paths used for audit return navigation should use the same collaborative snapshot transport already used by workbench team-view sharing:

- strip `workbenchTeamView`
- strip local-only preset ids
- preserve concrete filter values such as `bomFilter`, `bomFilterField`, `whereUsedFilter`, `whereUsedFilterField`

Implementation:

- change `buildPlmWorkbenchRoutePath(...)` to serialize `normalizePlmWorkbenchCollaborativeQuerySnapshot(...)`

## Expected Outcome

- audit return links remain portable across browsers and sessions
- reopening a saved audit view no longer causes a self-cleaning route pivot just because a local preset id is missing
- actual workbench filter state still survives the round-trip
