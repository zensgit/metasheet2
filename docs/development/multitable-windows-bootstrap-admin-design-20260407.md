# Multitable Windows Bootstrap Admin Design

Date: 2026-04-07

## Problem

`multitable` on-prem packages already ship Windows-native deploy wrappers, but a pure Windows Server install still lacked a Windows-native admin bootstrap path. Field teams could deploy the package and start PM2, yet had no packaged PowerShell helper to create the first admin account without bash or WSL.

## Fix

- Add `scripts/ops/multitable-onprem-bootstrap-admin.ps1`.
- Generate packaged root wrappers:
  - `bootstrap-admin.bat`
  - `bootstrap-admin-runXX.bat`
- Include the new helper in package build + verify gates.
- Update Windows deployment docs to point operators at the new bootstrap wrapper after `deploy.bat`.

## Why this is the smallest safe change

- No backend runtime behavior changes.
- No deploy flow changes for Linux or WSL users.
- No changes to the existing SQL bootstrap logic beyond porting it to PowerShell for Windows operators.
- The new wrapper only fills the missing Windows-only bootstrap gap.
