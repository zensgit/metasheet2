# Multitable Windows Bootstrap Module Path Fix Design

Date: 2026-04-07

## Problem

`run17` fixed the PowerShell + Node v24 `node -e` parsing issue by writing short-lived `.cjs` files, but the helper still wrote those files into `%TEMP%`. On Windows, Node resolves `require('bcryptjs')` relative to the entry script location, so the temporary script could no longer see the packaged app's `node_modules`.

## Decision

Keep the `.cjs` execution model, but move the temporary script location into the packaged project root under `.tmp/node-bootstrap`.

## Scope

- Update `scripts/ops/multitable-onprem-bootstrap-admin.ps1` only.
- Keep UUID generation, PostgreSQL discovery, and bcrypt hashing logic unchanged.
- Update the Windows deployment doc to explain why the helper now uses a package-local temp directory.

## Expected Outcome

- `bootstrap-admin.bat` works on Windows Server 2022 with Node v24.
- `bcryptjs` resolves from the packaged project's `node_modules`.
- The helper still avoids inline `node -e`, so the earlier PowerShell parsing fix remains intact.
