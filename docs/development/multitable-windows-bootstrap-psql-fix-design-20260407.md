# Multitable Windows Bootstrap PSQL Fix Design

Date: 2026-04-07

## Problem

Field validation on Windows Server showed that `bootstrap-admin.bat` still failed in two common environments:

- PostgreSQL was installed, but `psql.exe` was not on `PATH`.
- Node v24 rejected the inline UUID helper that used `require("crypto")`.

## Fix

- Add `PSQL_PATH` / `POSTGRES_BIN_DIR` / `PG_BIN` overrides to `multitable-onprem-bootstrap-admin.ps1`.
- Auto-probe common Windows PostgreSQL install roots such as `C:\Program Files\PostgreSQL\*\bin\psql.exe`.
- Switch UUID generation from `require("crypto")` to `require("node:crypto")` for Node v24 compatibility.
- Document the explicit `PSQL_PATH` override in the Windows deployment guide.

## Why this is the smallest safe change

- No package contract change.
- No deploy-path change.
- The helper still performs the same admin upsert and verification logic; it only becomes more tolerant of real Windows installations.
