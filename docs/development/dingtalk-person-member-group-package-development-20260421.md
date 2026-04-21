# DingTalk Person Member Group Package Development

Date: 2026-04-21
Branch: `codex/dingtalk-person-member-group-package-20260421`

## Goal

Package the stacked DingTalk personal member-group recipient enhancements into one clean `main`-based branch so the feature can be reviewed and deployed without depending on a three-PR stack.

## Included Slices

- dynamic record-derived member-group recipients
- member-group recipient field chips
- member-group field path warnings

## Scope

- no new runtime feature beyond the stacked slices
- no migration changes
- package and roll forward the existing work onto `main`

## Implementation Notes

- Cherry-picked stacked heads onto a fresh branch from `main`:
  - `372f4aa8d`
  - `487019a74`
  - `181443436`
- Added package-level development and verification docs for the consolidated branch.

## Outcome

The full DingTalk personal member-group recipient line now exists as a single `main`-based branch suitable for one PR, instead of requiring review and merge in stack order.
