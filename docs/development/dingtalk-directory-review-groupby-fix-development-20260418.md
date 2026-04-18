# DingTalk Directory Review GroupBy Fix Development

Date: 2026-04-18

## Summary

This change fixes a live PostgreSQL error on the DingTalk directory review path:

```text
column "l.local_user_id" must appear in the GROUP BY clause or be used in an aggregate function
```

The failure happened when loading grouped review/account records after joining:

- `directory_accounts a`
- `directory_account_links l`
- `users u`
- `directory_account_departments ad`
- `directory_departments d`

The grouped query already selected `u.id AS local_user_id` and grouped by
`u.id`, but the review classification logic still referenced
`l.local_user_id` directly inside grouped `CASE` expressions.

PostgreSQL does not treat `u.id` as an implicit substitute for
`l.local_user_id` in a grouped expression, so the query failed at runtime.

## Code Changes

Updated `packages/core-backend/src/directory/directory-sync.ts` in both:

- `listDirectoryReviewItems()`
- `getDirectoryReviewItem()`

### Before

Grouped review SQL used:

- `WHEN a.is_active = FALSE AND l.local_user_id IS NOT NULL THEN ...`
- `WHEN l.local_user_id IS NULL THEN ...`

### After

Grouped review SQL now uses the grouped alias source consistently:

- `WHEN a.is_active = FALSE AND u.id IS NOT NULL THEN ...`
- `WHEN u.id IS NULL THEN ...`

The same replacement was applied to the grouped `ORDER BY` branch used by
`listDirectoryReviewItems()`.

## Why this is the correct fix

This is intentionally narrower than adding `l.local_user_id` to `GROUP BY`:

- the query already projects the linked local user identity via `u.id`;
- the review UI only needs to know whether a linked local user exists, not to
  distinguish between `l.local_user_id` and `u.id`;
- `u.id` is already part of the grouped select, so using it avoids widening
  the grouping contract unnecessarily.

## Test Changes

Updated `packages/core-backend/tests/unit/directory-sync-review-items.test.ts`:

- added a regression assertion for the review list SQL text
- added a regression assertion for the single review item SQL text

The new checks verify that grouped review SQL now references `u.id` rather
than `l.local_user_id` inside the grouped `CASE` expressions.

## Deployment Note

This round did not deploy the fix to a remote environment.

It produced a clean hotfix branch and verification evidence only. Deployment
should happen after review/merge so the running DingTalk directory UI stops
hitting the grouped query error on live traffic.
