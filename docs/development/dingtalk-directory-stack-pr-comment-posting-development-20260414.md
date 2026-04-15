# DingTalk Directory Stack PR Comment Posting

## Scope

This follow-up records the actual GitHub comment posting step for `#873`.

## Result

Comment URL:

- <https://github.com/zensgit/metasheet2/pull/873#issuecomment-4245309186>

## What Happened

1. The initial `gh pr comment --body-file ...` call posted the full source doc instead of the intended compact reviewer note.
2. A clean temporary body file was prepared with only the final reviewer-facing text.
3. `gh pr comment 873 --edit-last --body-file ...` was used to rewrite the last comment in place.

## Final Comment Shape

- 1 short opening paragraph
- 3 flat bullets
- no roadmap recap
- no duplicated PR summary

## Why This Matters

The purpose of the comment is scope framing:

- align `#873` with the broader Feishu-gap complete report
- prevent reviewers from projecting the full 16-PR / ~685-test totals onto this narrower PR
- focus review on the real boundaries of this DingTalk admin/ops slice
