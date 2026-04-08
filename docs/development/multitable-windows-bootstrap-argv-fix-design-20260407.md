# Multitable Windows Bootstrap Argv Fix Design

Date: 2026-04-07

## Problem

`run19` fixed the PowerShell + Node v24 parsing and module-resolution issues, but `bootstrap-admin.bat` can still hash the wrong password because temporary `.cjs` execution changes `process.argv` layout compared with `node -e`.

Under `node -e`, the first user argument is `process.argv[1]`. Under `node <script>.cjs`, the first user argument is `process.argv[2]` because `process.argv[1]` becomes the script path.

## Decision

Normalize `process.argv` inside `Invoke-NodeCapture` before executing the injected script body by removing the temporary script-path slot. This preserves the old `node -e` indexing contract for every embedded helper script.

## Scope

- Update `scripts/ops/multitable-onprem-bootstrap-admin.ps1`
- Keep the package-local `.tmp/node-bootstrap` execution model
- Do not touch SQL, PostgreSQL discovery, or the bootstrap wrappers

## Expected Outcome

- Existing embedded scripts can keep using `process.argv[1]`, `process.argv[2]`, etc.
- bcrypt hashing receives the real round/password arguments again
- Future inline helper scripts do not need per-script argv fixes
