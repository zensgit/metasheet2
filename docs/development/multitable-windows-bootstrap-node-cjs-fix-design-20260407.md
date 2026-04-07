# Multitable Windows Bootstrap Node CJS Fix Design

Date: 2026-04-07

## Problem

`bootstrap-admin.bat` still fails on Windows Server under Node v24 even after the `node:crypto` fix, because the PowerShell helper invokes inline JavaScript with `node -e`. Field feedback shows Node v24 + Windows PowerShell type-stripping can misparse these inline snippets and abort the bootstrap flow.

## Decision

Replace all `node -e` execution inside `scripts/ops/multitable-onprem-bootstrap-admin.ps1` with short-lived temporary `.cjs` files written into the system temp directory, then execute them with `node <tempfile>.cjs`.

## Scope

- Keep the existing bootstrap behavior unchanged:
  - UUID generation
  - bcrypt password hashing
  - psql discovery
- Do not rename attendance/multitable PM2 helper scripts in this slice.
- Update Windows deployment docs so field teams understand why the helper no longer uses inline Node.

## Expected Outcome

- `bootstrap-admin.bat` works on Windows Server 2022 with Node v24.
- The helper no longer depends on PowerShell-safe inline JavaScript quoting/parsing.
- Packaging and release gates continue to pass without adding new runtime dependencies.
