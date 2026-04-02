# PLM Workbench Team View Single Restore Owner Draft Design

## Background

Single `restoreTeamView()` reapplied the restored view and cleared `teamViewName`, but left `teamViewOwnerUserId` untouched. Batch restore already cleared both drafts, and team preset restore followed the same full-cleanup pattern.

## Decision

Make single team-view restore clear both management drafts:

- `teamViewName`
- `teamViewOwnerUserId`

## Why

After restoring an archived team view, the old transfer-owner draft is stale. Keeping it around lets the next transfer action accidentally reuse an owner input that belonged to the archived state instead of the restored target.
