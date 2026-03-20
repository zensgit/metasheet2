Scope: Day 3 triage for the Feishu-style multitable internal pilot  
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable`

# Day 3 Triage

Date: 2026-03-20  
Moderator: Codex  
Teams reviewed: internal pilot teams  
Build under review: `v2.5.0` pilot package

## Executive Summary

Day 3 conclusion: the shipped `v2.5.0` pilot package is not the right validation baseline.

Confirmed problems:
- packaged environment is missing `bcryptjs`
- attachment upload path is still missing the effective `multer` runtime dependency in the tested package
- the deployed package does not include the backend fixes for `#532`, `#533`, and `#534`

Required action:
- rebuild and redistribute from the fix branch as `v2.5.1`
- ask pilot teams to rerun the blocked checks
- target rerun time is within `30 minutes` after the corrected package is available

## Impact

Affected pilot areas:
- attachment upload
- comment lifecycle
- normal user comment permissions
- confidence in Day 3 pilot evidence

Immediate consequence:
- any Day 3 result collected from the old `v2.5.0` package should be treated as invalid for go/no-go purposes where it depends on these paths

## Issue Mapping

| Issue | Severity | Why it matters for Day 3 |
| --- | --- | --- |
| `#532` | P2 | Comment lifecycle is incomplete without the backend comment update/delete path |
| `#533` | P2 | Attachment verification is blocked when the packaged environment cannot load upload dependencies |
| `#534` | P2 | Normal-user collaboration evidence is invalid if comment permissions are not present in the deployed build |

## Root Cause Summary

The pilot package under test lagged behind the fix branch in two ways:
- dependency layer mismatch: packaged runtime did not contain the expected `bcryptjs/multer` dependency state
- code layer mismatch: the package did not include the already prepared backend fixes for `#532/#533/#534`

This is a packaging/version selection issue, not a new product-surface regression discovered after those fixes landed on the branch.

## Decision

Day 3 decision:
- do not continue validating blocked scenarios on the old `v2.5.0` package
- rebuild from the fix branch as `v2.5.1`
- redeploy
- rerun the affected pilot checks immediately after deployment

## Required Rerun Scope

After `v2.5.1` is deployed, rerun at minimum:
1. attachment upload and hydration
2. comments create, update, resolve, delete
3. non-admin user comment permissions

Reference execution doc:
- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/pilot-day3-rerun-checklist-20260320.md`

Reference results doc:
- `/Users/huazhou/Downloads/Github/metasheet2-multitable/docs/deployment/pilot-day3-results-template-20260320.md`

## Release Guidance

Requested package action:
- source branch: `codex/multitable-fields-views-linkage-automation-20260312`
- target package version: `v2.5.1`
- purpose: corrected pilot rebuild

Expected pilot turnaround:
- pilot team can complete the blocked rerun within `30 minutes` after receiving the corrected package

## Sign-off

- Engineering triage owner: Codex
- Recommended next step: rebuild package and rerun blocked Day 3 checks
