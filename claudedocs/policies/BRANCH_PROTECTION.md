# Branch Protection Operations Handbook

## Overview

This handbook documents the branch protection policy for `main` branch and provides step-by-step procedures for managing required status checks.

**Repository**: zensgit/smartsheet (metasheet-v2)
**Protected Branch**: main
**Configuration**: `branch-protection.json`
**Last Updated**: 2025-10-29

---

## Current Protection Rules

### Required Status Checks (4 checks)

All PRs targeting `main` must pass these checks before merge:

1. **Migration Replay** ⚡ CRITICAL
   - Validates all database migrations are idempotent
   - Runs migrations twice to ensure no errors
   - Respects MIGRATION_EXCLUDE list

2. **lint-type-test-build** 🎨 IMPORTANT
   - Frontend build validation
   - Linting checks
   - Type checking (for web app)
   - Unit tests

3. **smoke** 🔥 IMPORTANT
   - Basic functionality tests
   - API health checks
   - Integration smoke tests

4. **typecheck** ✅ NEW (Phase 3)
   - TypeScript type safety validation
   - Added to enforce gradual strictness
   - Ensures type errors are caught before merge

### Non-Blocking Checks

These checks run but don't block merges:

- **v2-observability-strict** (informational)
- **Observability E2E** (informational)
- **scan** (security scanning)

---

## Configuration Management

### View Current Configuration

```bash
# Using GitHub CLI
gh api /repos/zensgit/smartsheet/branches/main/protection/required_status_checks

# Using script
cat claudedocs/policies/branch-protection.json
```

### Apply Configuration

```bash
# Interactive mode (with confirmation)
cd claudedocs/policies
bash apply-branch-protection.sh

# Expected output:
# 📋 Branch Protection Configuration Tool
#
# Configuration:
#   Repository: zensgit/smartsheet
#   Branch: main
#   Strict: true
#   Required Checks:
#     - Migration Replay
#     - lint-type-test-build
#     - smoke
#     - typecheck
#
# Apply this configuration? (y/N): y
# 🔧 Applying branch protection...
# ✅ Branch protection applied successfully
```

---

## Common Operations

### 1. Add a New Required Check

**Scenario**: You want to make a new CI check required before merges.

**Steps**:

1. Edit `branch-protection.json`:
```json
{
  "config": {
    "contexts": [
      "Migration Replay",
      "lint-type-test-build",
      "smoke",
      "typecheck",
      "new-check-name"  // Add here
    ]
  }
}
```

2. Update the change log:
```json
{
  "change_log": [
    {
      "date": "2025-10-XX",
      "action": "Added new-check-name to required checks",
      "reason": "Explain why this check is now required",
      "pr": "#XXX",
      "author": "Your Name"
    }
  ]
}
```

3. Apply the configuration:
```bash
bash claudedocs/policies/apply-branch-protection.sh
```

4. Verify:
```bash
gh api /repos/zensgit/smartsheet/branches/main/protection/required_status_checks \
  | jq '.contexts'
```

---

### 2. Remove a Required Check

**Scenario**: A check is too noisy or no longer needed.

**Steps**:

1. Edit `branch-protection.json`:
```json
{
  "config": {
    "contexts": [
      "Migration Replay",
      "lint-type-test-build",
      "smoke"
      // "typecheck" removed
    ]
  }
}
```

2. Update the change log:
```json
{
  "change_log": [
    {
      "date": "2025-10-XX",
      "action": "Removed typecheck from required checks",
      "reason": "Moved to informational-only mode",
      "pr": "#XXX",
      "author": "Your Name"
    }
  ]
}
```

3. Apply and verify (same as above)

---

### 3. Temporarily Bypass (Emergency)

**Scenario**: Critical hotfix needed, but a check is failing.

**⚠️ WARNING**: Only for emergencies. Requires admin access.

**Steps**:

1. **Option A**: Use GitHub UI
   - Go to repository Settings → Branches → main
   - Edit branch protection rule
   - Uncheck "Require status checks to pass"
   - Merge the PR
   - **IMMEDIATELY** re-enable protection

2. **Option B**: Use GitHub CLI (faster)
```bash
# Disable required checks
gh api --method PATCH \
  /repos/zensgit/smartsheet/branches/main/protection/required_status_checks \
  -f strict=false -f 'contexts=[]'

# Merge your PR
gh pr merge XXX --merge

# Re-enable protection
bash claudedocs/policies/apply-branch-protection.sh
```

3. **Document the bypass**:
   - Create incident report
   - Explain why bypass was necessary
   - Document what went wrong with the check
   - Plan to fix the underlying issue

---

### 4. Update Strict Mode

**Scenario**: Control whether branches must be up-to-date before merge.

**Current Setting**: `"strict": true` (branches must be up-to-date)

**To disable strict mode**:
```json
{
  "config": {
    "strict": false  // Allow merges even if not up-to-date
  }
}
```

**Recommendation**: Keep strict mode enabled to prevent merge conflicts.

---

## Troubleshooting

### Check Not Running

**Problem**: Required check not showing up on PR.

**Diagnosis**:
```bash
# 1. Check if CI workflow exists
ls .github/workflows/

# 2. Check workflow trigger configuration
cat .github/workflows/your-workflow.yml | grep -A 5 'on:'

# 3. Check if workflow is enabled
gh workflow list
```

**Solutions**:
- Ensure workflow file exists in `.github/workflows/`
- Verify workflow has `pull_request` trigger
- Check workflow is not disabled
- Verify workflow name matches branch protection config

---

### Check Always Failing

**Problem**: Required check consistently fails on valid PRs.

**Diagnosis**:
```bash
# View recent check runs
gh pr checks <PR_NUMBER>

# View detailed logs
gh run view <RUN_ID> --log
```

**Solutions**:

1. **If check is legitimately failing**:
   - Fix the underlying issue in your PR
   - Don't bypass protection

2. **If check is flaky**:
   - Investigate root cause of flakiness
   - Consider making it non-blocking temporarily
   - Fix flakiness, then re-enable as required

3. **If check configuration is wrong**:
   - Fix the check's workflow configuration
   - Update check expectations

---

### Protection Rule Not Applying

**Problem**: Changes to `branch-protection.json` not taking effect.

**Diagnosis**:
```bash
# Check current GitHub protection
gh api /repos/zensgit/smartsheet/branches/main/protection/required_status_checks

# Compare with local config
cat claudedocs/policies/branch-protection.json | jq '.config'
```

**Solutions**:

1. **Re-run application script**:
```bash
bash claudedocs/policies/apply-branch-protection.sh
```

2. **Check API response**:
   - Look for error messages
   - Verify authentication: `gh auth status`
   - Ensure admin permissions on repository

3. **Manual application via UI**:
   - GitHub → Repository → Settings → Branches
   - Edit main branch protection rule
   - Manually configure required checks

---

## Best Practices

### ✅ DO

1. **Document all changes** in `branch-protection.json` change log
2. **Test new checks** on feature branches before making required
3. **Keep checks fast** (< 5 minutes ideally)
4. **Make checks informational first**, then required after stability proven
5. **Version control** the configuration file
6. **Review regularly** (monthly) to ensure checks are still relevant

### ❌ DON'T

1. **Don't bypass protection** without documenting why
2. **Don't add slow checks** (> 15 minutes) as required
3. **Don't add flaky checks** as required
4. **Don't forget to re-enable** protection after emergency bypass
5. **Don't make all checks required** - be selective
6. **Don't change protection** without team consensus

---

## Check Health Metrics

Track these metrics for each required check:

```yaml
Migration Replay:
  Pass Rate: > 95%
  Avg Duration: < 3 minutes
  Flakiness: < 5%
  Last 30 Days: ✅ Healthy

lint-type-test-build:
  Pass Rate: > 90%
  Avg Duration: < 4 minutes
  Flakiness: < 10%
  Last 30 Days: ✅ Healthy

smoke:
  Pass Rate: > 85%
  Avg Duration: < 2 minutes
  Flakiness: < 15%
  Last 30 Days: ⚠️ Review needed

typecheck:
  Pass Rate: > 80% (new check)
  Avg Duration: < 2 minutes
  Flakiness: TBD
  Last 30 Days: 🆕 Monitoring
```

### Health Thresholds

- **Green**: Pass rate > 90%, flakiness < 10%
- **Yellow**: Pass rate 80-90%, flakiness 10-20%
- **Red**: Pass rate < 80%, flakiness > 20%

**Action Required for Red**:
1. Investigate root cause
2. Make check non-blocking if too flaky
3. Fix underlying issues
4. Re-enable as required once stable

---

## Change History

### 2025-10-29: Phase 3 Type Safety
**Changes**:
- Added `typecheck` to required checks
- Removed `v2-observability-strict` (moved to informational)

**Rationale**: Phase 3 focuses on type safety. Typecheck ensures all PRs maintain type soundness.

**Impact**: PRs with type errors will now be blocked.

---

### 2025-10-28: Phase 2 Observability Adjustment
**Changes**:
- Removed `v2-observability-strict` from required checks

**Rationale**: Check was too strict for Phase 2, causing unnecessary delays. Made informational to allow iteration.

**Impact**: Observability metrics collected but don't block merges.

---

### 2025-10-27: Phase 2 Completion
**Changes**:
- Established core 4 required checks
- Created configuration management system

**Rationale**: Formalize branch protection to support Phase 2 completion and Phase 3 planning.

---

## Related Documentation

- [Branch Protection Config](./branch-protection.json) - Current configuration
- [Apply Script](./apply-branch-protection.sh) - Automated application
- [Phase 3 Kickoff Plan](../PHASE3_KICKOFF_PLAN_20251029.md) - Context for changes
- [Phase 3 Optimization Roadmap](../PHASE3_OPTIMIZATION_ROADMAP.md) - Future improvements
- [GitHub Branch Protection Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

---

## Quick Reference

```bash
# View current protection
gh api /repos/zensgit/smartsheet/branches/main/protection/required_status_checks | jq

# Apply configuration
bash claudedocs/policies/apply-branch-protection.sh

# View PR checks
gh pr checks <PR_NUMBER>

# View check logs
gh run view <RUN_ID> --log

# Emergency disable (ADMIN ONLY)
gh api --method PATCH \
  /repos/zensgit/smartsheet/branches/main/protection/required_status_checks \
  -f strict=false -f 'contexts=[]'
```

---

## Contact

For questions or issues with branch protection:
- Create issue in repository
- Tag: `ci`, `branch-protection`
- Assign to: DevOps team

For emergency bypasses:
- Contact: Repository admin
- Document in: Incident log
- Follow-up: Root cause analysis
