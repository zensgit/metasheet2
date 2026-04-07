# Multitable Sheet Admin Model Development

Date: 2026-04-07

## Scope

This slice introduces a dedicated `admin` sheet access level for multitable sheet-scoped permissions.

The goal is to separate:

- `write`: schema and record editing for a sheet
- `write-own`: record-only authoring limited to own rows
- `admin`: share management and sheet deletion

Out of scope:

- base-scoped permission sources
- sheet creation parity
- changing the existing `write-own` user-only rule

## Runtime Changes

- Added `admin` to the multitable sheet permission access-level model.
- Extended managed sheet permission code handling to include:
  - `spreadsheet:admin`
  - `spreadsheets:admin`
  - `multitable:admin`
- Updated sheet permission scope resolution so `canManageSheetAccess` is granted by sheet-scoped `admin`, not by sheet-scoped `write`.
- Kept read and write parity behavior unchanged for:
  - `read`
  - `write`
  - `write-own`
- Allowed sheet permission authoring endpoints to rely on resolved sheet capabilities instead of route-level global RBAC guards.
- Allowed sheet deletion through sheet-scoped `admin` when sheet-scoped assignments exist.
- Preserved existing fallback behavior for legacy/global flows where no sheet-scoped assignments exist.

## Frontend Changes

- Added `admin` to multitable sheet permission frontend types and client normalization.
- Updated the sheet permission manager to expose `Admin` as an access-level option.
- Clarified UI copy so the access manager states that admin includes sharing and sheet deletion.
- Kept `write-own` excluded from role subject options.

## Contract Changes

- Updated multitable OpenAPI enums to include `admin` for:
  - sheet permission access levels
  - sheet permission update payloads
  - sheet permission update responses

## Tests Updated

- Reworked sheet permission integration tests so permission authoring is now admin-scoped.
- Added admin-specific authoring coverage.
- Added admin-based sheet deletion coverage.
- Updated frontend permission manager tests to cover the new admin option.
