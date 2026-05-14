# DingTalk P4 Release Readiness Gate Totals Design

Date: 2026-04-30

## Goal

Make the release-readiness report answer "how many gates are already clear" without forcing operators to count rows in the gate table.

## Change

- Add `gateTotals` to `release-readiness-summary.json`.
- Count `total`, `passed`, `failed`, and `skipped` gates.
- Render the same totals near the top of `release-readiness-summary.md`.
- Keep existing overall status behavior unchanged:
  - any failed gate means `fail`;
  - skipped regression planning means `manual_pending`;
  - all passing gates means `pass`.

## Operator Impact

Operators can now distinguish these states immediately:

- `2/2 passed, 0 failed, 0 skipped`: safe to proceed to final smoke.
- `1/2 passed, 1 failed, 0 skipped`: fix the failed gate first.
- `1/2 passed, 0 failed, 1 skipped`: plan-only/manual-pending state; execute the skipped gate before release.
