# DingTalk lifecycle canary — separate ops GO (not auto-enabled)

**Date:** 2026-07-24  
**Related locks:**  
- `dingtalk-directory-admission-activation-lifecycle-design-20260723.md` Rev 4.2  
- `dingtalk-deprovision-reactivation-and-evidence-chain-design-20260723.md` Rev 4.2  

## What is NOT enabled by merge

| Flag / action | Default after code land | Requires |
|---------------|-------------------------|----------|
| `DIRECTORY_PENDING_ACTIVATION_ENABLED` | **OFF** | Explicit owner **ops GO** + canary plan |
| `AUTH_LOGIN_USE_ALIASES` (T2b cutover) | **OFF** | Admin password-alias readiness gate + ops GO |
| `DIRECTORY_DEPROVISION_ENABLED` | **OFF** (writer no-op when false) | Ops GO after D1–D7 goldens green |

## Canary sequence (when authorized)

1. Staging: migrate T1→T2a→T3→D* schemas; leave pending-create OFF.  
2. T2a backfill + review collision report.  
3. Confirm ≥1 active admin has alias; enable `AUTH_LOGIN_USE_ALIASES` on staging only.  
4. Enable pending-create for a single test org; exercise admit → activate.  
5. Deprovision canary with `enabled=true` on non-prod first.  
6. Production enablement only after staging sign-off — **separate GO**, not PR merge.

## Owner note

Implementation PRs may land default-off code. **Merging code ≠ authorizing traffic.**
