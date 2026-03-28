# PLM Workbench Delete Selection Feedback Design

## Background

Most collaborative actions already surface a selection-required message when no team view or team preset is selected. `deleteTeamView()` and `deleteTeamPreset()` were the remaining outliers and still returned silently.

## Decision

Align both delete handlers with the rest of the management surface:

- no selected team view -> `请选择...团队视角。`
- no selected team preset -> `请选择...团队预设。`

## Why

Silent returns make the delete action feel broken and force the user to infer missing selection state. Matching the rest of the management actions keeps the interaction model predictable.
