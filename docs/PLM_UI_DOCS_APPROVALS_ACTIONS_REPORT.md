# PLM UI Documents & Approvals Actions Report

## Goal
Improve document/approval usability with quick actions and dedicated deep links.

## Changes
- `apps/web/src/views/PlmProductView.vue`
  - Added document action column with copy ID and copy download link.
  - Added approval action column with product switch + copy ID + approve/reject/history buttons.
  - Added approval comment input (required for rejection).
  - Added approval history panel for ECO approval records.
  - Added deep-link panels for documents/approvals and a preset for both.
  - Added panel-level deep-link buttons for documents and approvals.
  - Autoload respects documents/approvals panels.

- `scripts/verify-plm-ui-regression.sh`
  - Approvals locator refined to target the approvals panel header to avoid deep-link option collisions.
  - Approval action/history presence recorded in regression report.

## Behavior Notes
- Document action buttons appear when the “操作” column is enabled.
- Approvals support jumping back to a product or copying the approval ID without leaving the panel.
- Approve uses optional comment; reject requires a non-empty comment.
- Approval history panel shows stage/status/comment/user timestamps for the selected ECO.

## Verification
- UI regression: `docs/verification-plm-ui-regression-20260122_164425.md`
- Screenshot: `artifacts/plm-ui-regression-20260116_113652.png`
