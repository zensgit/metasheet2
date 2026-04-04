# On-Prem Package Verify Portability

Date: 2026-04-04

## Goal

Keep `scripts/ops/attendance-onprem-package-verify.sh` usable on hosts that do not have `rg` installed.

## Scope

- `scripts/ops/attendance-onprem-package-verify.sh`

## Change

- add a fixed-string search helper that uses `rg` when available and falls back to `grep -F`
- add a regex search helper that uses `rg` when available and falls back to `grep -RInE`
- route Windows entrypoint validation and loopback bundle validation through those helpers

## Why

- the on-prem package verify script should not fail only because `ripgrep` is missing
- the PM2 root-dir guard is now part of package verification, so its implementation should match the portability level of the rest of the script
- this keeps the existing validation behavior while removing an unnecessary tool dependency
