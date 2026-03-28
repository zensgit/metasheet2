# PLM Workbench Default No-op Feedback Design

## Background

`archive / restore` already distinguish state no-op feedback from permission denial, but `set default / clear default` still collapsed both cases into a generic `当前...不可...`.

That meant:

- already-default entries did not say they were already default
- non-default entries did not say there was nothing to clear

## Decision

Keep existing readonly / pending-management / archived branches unchanged, but add state-specific no-op feedback once the target is manageable and not archived:

- `set default` on an already-default entry -> `...已设为默认。`
- `clear default` on a non-default entry -> `当前...尚未设为默认。`

## Why

This aligns default toggles with the interaction model already used by archive/restore and makes “no change needed” distinguishable from “you are not allowed”.
