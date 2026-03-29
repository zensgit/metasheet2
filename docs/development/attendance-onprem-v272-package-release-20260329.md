# Attendance On-Prem v2.7.2 Package Release

Date: 2026-03-29

## Goal

Publish a patch release after the attendance admin navigation follow-up landed in `main`.

The release should ship both a normal GitHub release tag and direct on-prem deployment assets.

## Scope

Operational release only. No product code changes are introduced in this slice.

Artifacts produced:

- `metasheet-attendance-onprem-v2.7.2.zip`
- `metasheet-attendance-onprem-v2.7.2.tgz`
- matching `.sha256` files
- `SHA256SUMS-v2.7.2`
- date-stamped `current` package variants for traceability

## Release Basis

Release target:

- `main@b49746df8d1d80ca07940bac107f757837e1f402`

Why patch:

- the delta after `v2.7.1` is additive and corrective within attendance admin UX
- it does not change the major or minor release contract

## Packaging Choices

### 1. Build from a clean worktree

Packaging is performed from a dedicated worktree based on `origin/main` to avoid pollution from unrelated dirty files in the main checkout.

### 2. Keep both traceable and user-friendly asset names

The package build script emits a dated `current` bundle:

- `metasheet-attendance-onprem-v2.7.2-20260329-current.*`

The release also includes stable aliases for direct deployment:

- `metasheet-attendance-onprem-v2.7.2.zip`
- `metasheet-attendance-onprem-v2.7.2.tgz`

## Claude Code Note

Claude Code was actually invoked during this release continuation for a patch-bump sanity check. It did not return a timely consumable result, so the release decision was based on current tag history, merged scope after `v2.7.1`, and green mainline checks on the target commit.
