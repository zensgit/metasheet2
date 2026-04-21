# DingTalk Form Share Audience Summary Development

Date: 2026-04-21

## Scope

This change adds a read-only local allowlist audience summary to the form share manager for DingTalk-protected public forms.

## Changes

- Added `data-form-share-allowlist-summary` in `MetaFormShareManager`.
- Added structured count attributes:
  - `data-user-count`
  - `data-member-group-count`
- Added `allowlistAudienceSummary` derived from `allowedUserIds` and `allowedMemberGroupIds`, falling back to resolved subject lists when needed.
- Added UI copy for:
  - no local allowlist limits
  - local user count
  - local member-group count
- Added a compact visual style for the summary badge.
- Extended form-share tests to cover:
  - no local allowlist limits
  - DingTalk granted mode
  - one local user plus one local member group
- Updated the DingTalk operations guide to tell owners to check `Local allowlist limits` before relying on selected-user filling.

## User Impact

When a table owner protects a public form with DingTalk, the form share manager now shows whether access is still broad after the DingTalk check or narrowed to specific local users/member groups. This reduces the chance of assuming DingTalk group membership itself defines who can fill the form.

## Notes

- No backend API or schema changes were required.
- The summary is derived from form share config only; it does not infer DingTalk group roster membership.
