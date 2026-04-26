# Wave M-Feishu-1 Staging Verification Checklist — 2026-04-26

## Purpose

Manual smoke verification on staging for the 3 lanes shipped in Wave
M-Feishu-1 (#1178 / #1179 / #1180). Unit + integration tests passed in CI
(143 tests total: 14 + 51 + 64 + 14 frontend); this checklist covers the
**gaps unit tests cannot reach**: real DB persistence, real browser
rendering, real file I/O, real user interactions.

Estimated effort: ~30-45 minutes for one operator on a single staging
tenant.

## Pre-flight

- [ ] Staging deployment is at `main >= 2b765035e` (i.e., includes all 3
  merge commits).
- [ ] At least one staging multitable base + sheet exists with at least
  10 sample records.
- [ ] Tester has admin permissions on the test base (required to add
  fields, change view settings, configure conditional-formatting rules).

## Lane MF1 — Excel `.xlsx` import / export

### Import (browser-side parse)

- [ ] **Small file (< 1MB, ~100 rows)**: import via `MetaImportModal` →
  field mapping editor shows all source columns → confirm import →
  expected number of rows lands in target sheet.
- [ ] **Edge: column-name case mismatch**: source has `Customer Name`,
  target field is `customer name` → mapping editor still pairs them via
  case-insensitive match.
- [ ] **Edge: extra source column with no target field**: shows up as
  "unmapped" in the mapping editor; does NOT block import; column is
  dropped on write.
- [ ] **Edge: target field with no source column**: shows in mapping
  editor as "unmapped target"; rows imported with that field as `null`.
- [ ] **Truncation warning**: prepare a file with > 50,000 rows or > 100MB
  → preview step shows truncation warning slot rendered (test the warning
  surface, not the actual cap behaviour, since we hit it by design).
- [ ] **Date / datetime cells**: Excel-formatted dates round-trip into
  the target date field correctly (no timezone shift, no Excel epoch
  bug).
- [ ] **Number cells with currency formatting**: `¥1,234.56` in Excel
  round-trips into a `currency` field correctly.

### Export

- [ ] **Click "Export XLSX" in toolbar** → browser triggers download with
  filename like `<sheet-name>.xlsx`.
- [ ] **Reopen exported file in Excel** → headers + data match what's in
  the sheet.
- [ ] **Round-trip integrity**: export → re-import → record count + field
  values identical (modulo formatting normalization).

### Backend route layer (deferred)

- [ ] N/A — backend route layer is deferred to follow-up PR (per #1178
  notes). Frontend uses existing CSV backend route with same payload
  shape.

## Lane MF2 — 6 new field types

For each new type, exercise create / read / update / delete in the UI,
plus persistence (refresh page, value reappears).

### currency

- [ ] Create field type=currency with currency code `CNY`, decimals=2.
- [ ] Enter `1234.56` → renders as `¥1,234.56`.
- [ ] Edit existing cell → numeric input with `¥` prefix.
- [ ] Switch currency code to `USD` → existing rows render with `$`.
- [ ] Refresh page → value persists.

### percent

- [ ] Create field type=percent with decimals=1.
- [ ] Enter `0.255` → renders as `25.5%`.
- [ ] Edit existing cell → percent numeric input.
- [ ] Refresh page → value persists.

### rating

- [ ] Create field type=rating with max=5.
- [ ] Click 3rd star → renders `★★★☆☆`.
- [ ] Click 0th star → renders `☆☆☆☆☆`.
- [ ] Switch max to 10 → existing 3-rating still shows correctly (3 of
  10).
- [ ] Refresh page → value persists.

### url

- [ ] Create field type=url.
- [ ] Enter `https://example.com` → renders as clickable link.
- [ ] Click link → opens in new tab.
- [ ] Enter `not-a-url` → inline validation error (red border, message).
- [ ] Enter `ftp://example.com` → rejected (only http/https allowed).
- [ ] Refresh page → value persists.

### email

- [ ] Create field type=email.
- [ ] Enter `user@example.com` → renders as clickable mailto link.
- [ ] Click link → triggers mail client.
- [ ] Enter `not-an-email` → inline validation error.
- [ ] Refresh page → value persists.

### phone

- [ ] Create field type=phone.
- [ ] Enter `+86 138 1234 5678` → renders as clickable tel link.
- [ ] Enter `(02) 1234 5678` → accepted (regex relaxation from initial
  agent ship).
- [ ] Enter `abc` → rejected.
- [ ] Click link → triggers phone dialer (mobile) or default tel handler.
- [ ] Refresh page → value persists.

### Cross-cutting

- [ ] **Sort by currency / percent / rating**: numeric sort works
  correctly (1.5 < 2.5 < 10.0).
- [ ] **Sort by url / email / phone**: alphanumeric sort works.
- [ ] **Filter "is empty" / "is not empty"**: matches null vs non-null
  cells.
- [ ] **Form view**: form-input renders correctly for all 6 types.

## Lane MF3 — Conditional formatting

### Rule editor

- [ ] Open `ConditionalFormattingDialog` from view config menu.
- [ ] **Add rule for number field, "value > 100, background red"**:
  → save → sheet rows with that field > 100 render with red cell
  background.
- [ ] **Add rule for date field, "is_overdue, background yellow"**:
  → save → past-dated cells render yellow.
- [ ] **Add rule for select field, "value is X, background green"**:
  → save → cells with matching select option render green.
- [ ] **Add rule for text field, "contains 'urgent', applyToRow=true"**:
  → save → entire row renders with the configured row style.
- [ ] **Reorder rules**: use up/down buttons → first-matching-rule-wins
  semantic (a row matching both rules picks the first ordered).
- [ ] **Disable a rule** (toggle enabled=false): rule no longer applies;
  styles update on save.
- [ ] **Hit the 20-rule cap**: try to add a 21st rule → blocked with a
  message.

### Persistence

- [ ] **Refresh page** → rules persist (loaded from view config).
- [ ] **Close + reopen browser** → rules still there.
- [ ] **Different user opens same view** → sees same rules (server-side
  storage, not client-local).

### Render performance

- [ ] **Scroll a 500-row sheet with 5 active rules** → no visible lag;
  cell colors render correctly.
- [ ] **Edit a cell value that changes a rule outcome** → cell
  re-renders to new color immediately on save.

## Cross-lane integration

- [ ] **Use a new field type in a conditional formatting rule**: e.g.,
  rule `currency > 1000 → red` works. (Tests MF2 + MF3 integration.)
- [ ] **Import xlsx data into a sheet that has the new field types
  configured**: numbers map to currency, dates map to date, etc. (Tests
  MF1 + MF2 integration.)
- [ ] **Apply conditional formatting to imported xlsx data**: imported
  rows render with the formatting rules. (Tests MF1 + MF3 integration.)

## Regression checks

- [ ] **CSV import still works** (MF1 added xlsx as a parallel path; CSV
  shouldn't regress).
- [ ] **Existing field types** (text / number / date / select / link /
  attachment) still render and edit correctly.
- [ ] **Existing views** (grid / kanban / form) without conditional
  formatting rules render exactly as before.
- [ ] **Approval workflows that reference multitable rows** (Wave 2)
  still work end-to-end on a sample approval template.

## What this checklist intentionally does NOT cover

- Mobile UX rendering (no mobile staging environment configured today).
- Performance load testing (not in scope for a smoke pass).
- Browser compat matrix (Chrome / Safari / Firefox) — staging assumed
  Chrome unless otherwise specified.
- Localization beyond `zh-CN` (not in MF2's batch 1 scope).

## Sign-off

| Tester | Date | Result |
|--------|------|--------|
|        |      |        |

If any item fails, capture:
- Sheet ID / view ID / row ID where reproduced.
- Browser console output if a JS error.
- Backend log lines if a 4xx/5xx response.
- Screenshot if visual regression.

File issues against the originating PR's "Issues" thread or open a new
issue tagged `wave-m-feishu-1-followup`.
