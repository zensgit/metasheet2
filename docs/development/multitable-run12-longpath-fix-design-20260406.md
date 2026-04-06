# Multitable Run12 Long-Path Fix Design

Date: 2026-04-06

## Problem

`deploy.bat` correctly switched to the PowerShell apply helper in `run12`, but field validation on Windows Server 2022 still hit an `Expand-Archive` failure when the temporary extraction directory lived under a deep deploy-root path.

## Fix

- Keep the existing PowerShell-native apply flow.
- Stop extracting into `output/deploy/package-apply-*` under the deploy root.
- Allocate a short-lived extraction directory under the system temp directory instead.

## Why this is the smallest safe change

- No package contract changes.
- No wrapper changes.
- No Linux/WSL flow changes.
- The only runtime difference is a shorter extraction path before the existing copy + migrate + PM2 restart steps run.
