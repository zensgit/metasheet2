# DingTalk No-Email Review Hardening Development 2026-04-21

Branch: `codex/dingtalk-no-email-review-hardening-20260421`

Base: `codex/no-email-user-closure-20260418` (`#916`)

## Scope

This is a stacked hardening slice for the no-email DingTalk user admission and login PR. It addresses the substantive review risks without expanding the user-facing feature surface.

## Changes

- Updated identifier login lookup in `AuthService.getUserByIdentifier()` to keep existing case-insensitive email/username and whitespace-normalized mobile semantics while removing `COALESCE(...)` from the indexed predicates.
- Extended the no-email migration with expression indexes for `lower(email)` and whitespace-normalized `mobile`, in addition to the existing unique `lower(username)` index.
- Changed manual directory binding by local user reference to query two candidates and fail closed with `Local user reference is ambiguous` when the highest matching identifier tier has duplicate rows.
- Tightened login and manual directory binding so a single input matching different users across identifier types is ambiguous. Exact local user ID still wins for manual directory binding.
- Added a shared unique-match helper for directory sync local-user matching so duplicate email/mobile matches are tracked as ambiguous instead of collapsed by `Map`.
- Updated directory sync auto-matching to only select unique email/mobile matches. Ambiguous identifiers now leave the account unmatched for manual review and do not trigger auto-admission.

## Review Notes

- The generated no-email auto-admission username test remains unchanged. The current implementation uses the first 8 characters of the hyphen-stripped account id, so `account-12345678-...` resolves to suffix `account1`.
- No frontend behavior changed in this slice.
- No deployment was performed in this slice.
- Follow-up review on `#969` asked for cross-field ambiguity handling; the branch now fails closed for that case and covers the explicit exact-ID exception.

## Files Changed

- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/db/migrations/zzzz20260418170000_allow_no_email_users_and_add_username.ts`
- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/tests/unit/AuthService.test.ts`
- `packages/core-backend/tests/unit/directory-sync-auto-admission.test.ts`
- `packages/core-backend/tests/unit/directory-sync-bind-account.test.ts`
