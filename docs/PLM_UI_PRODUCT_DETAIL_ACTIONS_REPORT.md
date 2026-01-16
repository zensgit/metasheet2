# PLM UI Product Detail Actions Report

## Goal
Add quick copy actions for product ID, item number, revision, type, and status in the PLM product detail panel.

## Changes
- `apps/web/src/views/PlmProductView.vue`
  - Added product ID row to the detail grid.
  - Added copy buttons for product ID/number/revision/type/status.
  - New helper methods to normalize and copy product values.
- `scripts/verify-plm-ui-regression.sh`
  - Added assertions for product detail copy actions.

## Behavior
- Copy buttons are disabled if the target value is missing (`-`).
- Copy feedback surfaces via the shared status banner.

## Verification
- UI regression: `docs/verification-plm-ui-regression-20260116_150725.md`
- Screenshot: `artifacts/plm-ui-regression-20260116_150725.png`
