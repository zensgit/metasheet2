# Multitable Windows Bootstrap Bcrypt Root Dependency Design

Date: 2026-04-07

## Problem

`run18` moved the bootstrap helper's temporary `.cjs` files into the packaged project root, but `bootstrap-admin.bat` can still fail under pnpm strict mode because `bcryptjs` is only declared in `packages/core-backend/package.json`, not in the packaged root `package.json`.

The Windows bootstrap helper executes from the packaged root, so `require('bcryptjs')` needs to resolve from the root workspace dependencies as delivered to the customer.

## Decision

Add `bcryptjs` to the root `package.json` dependencies so the packaged root install always exposes it to the Windows bootstrap helper.

## Scope

- Update root `package.json`
- Refresh `pnpm-lock.yaml`
- Leave the existing PowerShell helper behavior unchanged

## Expected Outcome

- `bootstrap-admin.bat` works on Windows Server 2022 under pnpm strict mode
- the packaged root install resolves `bcryptjs` without relying on nested workspace layout
