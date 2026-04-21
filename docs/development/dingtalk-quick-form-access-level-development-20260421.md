# DingTalk Quick Form Access Level Development

Date: 2026-04-21

## Scope

This change finishes the DingTalk public-form access state surface for the legacy quick automation form in `MetaAutomationManager`.

## Changes

- Added `data-automation-public-form-access="group"` and `data-access-level` to the DingTalk group quick-form public form access preview.
- Added `data-automation-public-form-access="person"` and `data-access-level` to the DingTalk person quick-form public form access preview.
- Reused the existing `publicFormAccessLevel()` helper so quick form, automation cards, and advanced rule editor use the same access-level semantics.
- Added visual states for quick-form access summaries:
  - `none`
  - `public`
  - `dingtalk`
  - `dingtalk_granted`
  - `unavailable`
- Extended manager tests to assert the emitted access level for group and person quick-form flows.

## User Impact

When a table owner configures a DingTalk group or DingTalk person automation from the quick form, the UI now exposes the selected public form's permission state as structured DOM state and styled status text. This makes it clearer whether the DingTalk message link is fully public, DingTalk-bound, authorization-gated, unavailable, or not selected.

## Notes

- No backend schema or API changes were required.
- `pnpm install --frozen-lockfile` creates local tracked `node_modules` symlink dirtiness in plugin/tool packages in this repository. Those generated workspace artifacts are intentionally excluded from the commit.
