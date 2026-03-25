# Multitable UAT Sign-Off Template

Date: 2026-03-23  
Scope: customer or controlled pilot acceptance for the multitable/platform package

## Project Metadata

- Customer:
- Environment:
- Host or URL:
- Package version:
- On-prem gate stamp:
- Release-bound report:
- UAT date:
- Recorder:

## 1. Access And Roles

| Role | Account | Login OK | Notes |
| --- | --- | --- | --- |
| Admin |  | [ ] |  |
| Coordinator |  | [ ] |  |
| Data entry user |  | [ ] |  |
| Reviewer |  | [ ] |  |

## 2. Core Multitable Flows

| ID | Scenario | Expected Result | PASS / FAIL | Evidence Path |
| --- | --- | --- | --- | --- |
| MT-UAT-01 | Open grid view | Grid loads and records are visible |  |  |
| MT-UAT-02 | Open form view | Form loads without broken fields |  |  |
| MT-UAT-03 | Import sample CSV / TSV | Import preview appears and import completes |  |  |
| MT-UAT-04 | Repair people mismatch | `Select person` or `Select people` resolves the mismatch |  |  |
| MT-UAT-05 | Search imported record | Search returns the expected row |  |  |
| MT-UAT-06 | Assign person from grid or drawer | Assigned person stays visible after save or refresh |  |  |
| MT-UAT-07 | Upload attachment | Upload completes and file is visible again after reopen |  |  |
| MT-UAT-08 | Add and resolve comment | Comment thread updates correctly |  |  |
| MT-UAT-09 | Conflict retry | Retry or reload path preserves the intended latest value |  |  |
| MT-UAT-10 | Legacy form submit | Legacy submit path still creates a record |  |  |

## 3. Deployment And Safety Checks

| Check | Expected | PASS / FAIL | Notes |
| --- | --- | --- | --- |
| Product mode | `PRODUCT_MODE=platform` |  |  |
| JWT secret | Non-default value |  |  |
| Database URL | Valid and not placeholder |  |  |
| Redis URL | Valid and not placeholder |  |  |
| Attachment storage path | Writable and documented |  |  |
| On-prem release gate | Explicit report attached |  |  |
| Release-bound pilot report | Attached and matches package |  |  |

## 4. Evidence Pack

Record the exact files used during acceptance:

- Handoff root:
- Readiness report:
- Handoff report:
- Release-bound report:
- On-prem gate report:
- Verify report (`.tgz`):
- Verify report (`.zip`):

## 5. Issues

| ID | Severity (P0/P1/P2) | Description | Repro | Owner | Status |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |
|  |  |  |  |  |  |

## 6. Sign-Off

- [ ] Acceptance complete, suitable for controlled rollout
- [ ] Follow-up issues remain, do not expand rollout yet

Recommendation:

- 

Signatures:

- Customer owner:
- Delivery owner:
- Product owner:
- Date:
