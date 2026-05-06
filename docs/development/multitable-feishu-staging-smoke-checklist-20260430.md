# Multitable Feishu RC Staging Smoke Checklist - 2026-04-30

## Preconditions

- [ ] Staging is deployed from `origin/main >= 08f4ff920`.
- [ ] Tester has an admin account for the test base.
- [ ] Test base contains at least one sheet with 20+ records.
- [ ] Browser console and backend logs are available to capture failures.
- [ ] A real `.xlsx` fixture is available with text, number, date, select-like, and empty cells.
- [ ] If email smoke is required, staging has an operational email provider configured.

Record exact staging evidence:

- Staging URL:
- Deployed commit:
- Tester:
- Test base id:
- Test sheet id:
- Browser:
- Backend log source:

## Optional API Smoke Helper

Run this before manual browser smoke to collect repeatable backend/API evidence:

```bash
API_BASE="<staging-url>" \
AUTH_TOKEN="<redacted>" \
CONFIRM_WRITE=1 \
ALLOW_INSTALL=1 \
EXPECTED_COMMIT="<deployed-main-sha>" \
pnpm verify:multitable-feishu-rc:api-smoke
```

Expected artifacts:

- `output/multitable-feishu-rc-api-smoke/<timestamp>/report.json`
- `output/multitable-feishu-rc-api-smoke/<timestamp>/report.md`

This helper covers API health, auth, template availability/install, batch field creation, record create/patch, conditional-formatting persistence, and public-form submit. It does not replace the manual UI checks below.

## Smoke 1 - Basic Sheet Lifecycle

- [ ] Create a base.
- [ ] Create a sheet.
- [ ] Create grid, form, kanban, gallery, calendar, timeline, gantt, and hierarchy views.
- [ ] Add a normal text field and one record.
- [ ] Edit the record in grid.
- [ ] Open record drawer.
- [ ] Add a comment.
- [ ] Refresh browser and confirm record/comment persist.

## Smoke 2 - XLSX Import / Export

- [ ] Import `.xlsx` from `MetaImportModal`.
- [ ] Confirm column mapping screen appears.
- [ ] Confirm record count after import matches expected row count.
- [ ] Confirm imported dates and numbers preserve usable values.
- [ ] Export `.xlsx` from toolbar.
- [ ] Reopen exported file in Excel or WPS.
- [ ] Re-import exported file into a scratch sheet and compare row/field count.
- [ ] Record whether backend xlsx routes are unavailable or not used.

## Smoke 3 - Field Types

- [ ] Create currency field and save `1234.56`.
- [ ] Create percent field and save `0.255`.
- [ ] Create rating field and save a 3-star value.
- [ ] Create url field and save `https://example.com`.
- [ ] Create email field and save `user@example.com`.
- [ ] Create phone field and save `+86 138 1234 5678`.
- [ ] Create longText field and save multiline content.
- [ ] Create multiSelect field with at least three options and save two selected options.
- [ ] Refresh page and verify all values persist.
- [ ] Verify invalid url/email/phone values are rejected.

## Smoke 4 - Conditional Formatting

- [ ] Add number rule: value `> 100`, red background.
- [ ] Add select or multiSelect rule: contains selected option, green background.
- [ ] Add text rule: contains `urgent`, apply to row.
- [ ] Reorder rules and confirm first-match behavior.
- [ ] Disable a rule and confirm style is removed.
- [ ] Refresh page and confirm rules persist.

## Smoke 5 - Formula Editor

- [ ] Create formula field.
- [ ] Insert a field token from the UI.
- [ ] Insert a function from the catalog.
- [ ] Save a valid formula.
- [ ] Confirm evaluated value appears in grid.
- [ ] Try an unknown field token and confirm diagnostics block or warn as designed.
- [ ] Refresh page and confirm formula expression persists.

## Smoke 6 - Filter Builder / View Config

- [ ] Add text contains filter.
- [ ] Add number comparison filter.
- [ ] Add boolean true/false filter.
- [ ] Add select or multiSelect option-backed filter.
- [ ] Use `isEmpty` or `isNotEmpty` and confirm no value input is required.
- [ ] Save filter config to view.
- [ ] Refresh page and confirm filter persists.

## Smoke 7 - Gantt View

- [ ] Configure start date field.
- [ ] Configure end date field.
- [ ] Configure title field.
- [ ] Configure progress field.
- [ ] Confirm scheduled records render as bars.
- [ ] Confirm records missing dates appear in unscheduled/placeholder area.
- [ ] Select a Gantt row and confirm record drawer opens.

## Smoke 8 - Hierarchy View

- [ ] Configure parent link field.
- [ ] Configure title field.
- [ ] Create a root record.
- [ ] Create a child record using `+ Child`.
- [ ] Confirm tree expands/collapses.
- [ ] Confirm orphan handling matches selected mode.
- [ ] Select a tree node and confirm record drawer opens.

## Smoke 9 - Public Form

- [ ] Enable public form share.
- [ ] Open public form URL in an unauthenticated/incognito browser.
- [ ] Submit a valid record.
- [ ] Confirm success page appears.
- [ ] Confirm submitted record appears in authenticated sheet.
- [ ] Submit invalid field data and confirm validation error appears.

## Smoke 10 - Automation `send_email`

- [ ] Create automation rule with `send_email` action.
- [ ] Configure recipients, subject template, and body template.
- [ ] Save rule.
- [ ] Trigger rule with a record event.
- [ ] Confirm automation log records success or a clear provider/config failure.
- [ ] If provider is configured, confirm email delivery.

## Failure Capture Template

For every failed smoke item, record:

- Smoke item:
- Sheet/view/record id:
- Expected:
- Actual:
- Browser console:
- Backend log excerpt:
- Screenshot or artifact path:
- Severity: P0/P1/P2
