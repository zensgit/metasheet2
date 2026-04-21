# DingTalk Person Dynamic Recipient Package Development

Date: 2026-04-20
Branch: `codex/dingtalk-person-dynamic-package-20260420`

## Goal

Package the stacked DingTalk personal recipient enhancements into one clean `main`-based branch so the feature can be reviewed and deployed without depending on a five-PR stack.

## Included Slices

- dynamic record-derived recipients
- recipient field picker
- multiple dynamic recipient fields
- recipient field chips
- user-field guardrails and warnings

## Scope

- no new runtime feature beyond the stacked slices
- no migration changes
- package and roll forward the existing work onto `main`

## Implementation Notes

- Cherry-picked stacked heads onto a fresh branch from `main`:
  - `cdc1d5b81`
  - `ace235ad2`
  - `abbafbaac`
  - `fbf7eb0ae`
  - `6b7d6feea`
- Added package-level development and verification docs for the consolidated branch.

## Outcome

The full DingTalk personal dynamic recipient line now exists as a single `main`-based branch suitable for a single PR, instead of requiring review and merge in stack order.
