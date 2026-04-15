# DingTalk Directory Ops Node20 Typecheck Development - 2026-04-15

## Scope

This follow-up fixes the remaining `Plugin System Tests / test (20.x)` failure on [#876](https://github.com/zensgit/metasheet2/pull/876).

The failing path was not backend logic. It was frontend type-checking in:

- [apps/web/src/views/DirectoryManagementView.vue](/tmp/metasheet2-dingtalk-directory-ops/apps/web/src/views/DirectoryManagementView.vue:1562)

## Root Cause

`normalizeReviewItems()` spread `unknown` values directly and then accessed nested properties like:

- `item.recommendations`
- `item.recommendationStatus`
- `item.actionable`

GitHub Actions on Node 20 runs `vue-tsc -b`, which rejected that code with:

- `TS2698: Spread types may only be created from object types`
- `TS2339` on the nested review-item properties

## Fix

`normalizeReviewItems()` now narrows each incoming item first:

- coerces the unknown item into `Record<string, unknown>` only after an object check
- narrows `recommendationStatus` and `actionable` separately
- keeps the existing runtime behavior for recommendation arrays and actionable flags

This is a type-safety fix only. It does not change queue behavior.

## Claude Code CLI

`Claude Code CLI` remains callable in this environment and was re-checked during the PR follow-up phase.
