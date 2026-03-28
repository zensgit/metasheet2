# Attendance On-Prem v2.7.0 Post-Deploy Checklist Design

Date: 2026-03-28

## Goal

Define the shortest credible post-deploy acceptance checklist for an already deployed `v2.7.0` attendance on-prem environment.

The goal is not to replace the full UAT template. The goal is to give operators a fast acceptance path immediately after deployment.

## Design choices

### 1. Keep the checklist short

The checklist is intentionally limited to:

- package identity
- service health
- login and product mode
- API smoke
- upload/idempotency/export
- a small UI walkthrough

This keeps it usable as a deployment acceptance step instead of expanding into a customer-wide UAT workbook.

### 2. Reuse existing repository checks

The checklist does not invent new acceptance logic. It reuses existing repository assets:

- `attendance-onprem-healthcheck.sh`
- `attendance-smoke-api.sh`
- `attendance-smoke-api.mjs`
- the existing 30-minute verification doc
- the existing UAT signoff template

That keeps operator wording aligned with current deployment tooling.

### 3. Add one version-specific check

Older docs were still version-agnostic or referred to older package names.

This checklist adds an explicit first step:

- confirm the deployed package really comes from `metasheet-attendance-onprem-v2.7.0.zip` or `.tgz`

That closes the exact confusion that occurred when source release `v2.7.0` existed but deployable on-prem assets had not yet been published.

### 4. Distinguish acceptance from root-cause debugging

The checklist includes a short failure section, but only the first-line commands:

- env check
- backend logs
- nginx logs

Deep incident triage remains outside scope.

## Intended operator outcome

After running this checklist, an operator should be able to answer one concrete question:

`Is this deployed v2.7.0 attendance on-prem environment fit for go-live or customer handoff?`

If all checks pass, the answer is yes.
