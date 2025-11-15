# 🔒 Strict Observability Workflow Setup

**Created**: 2025-09-19
**Workflow File**: `.github/workflows/observability-strict.yml`
**Status**: ✅ Ready for Testing

## 📋 Overview

The **Observability Strict** workflow enforces more aggressive performance and quality thresholds than the standard Observability workflow. It's designed to ensure production-readiness with stricter SLA requirements.

## 🎯 Strict Thresholds

### Performance Gates (Enhanced)

| Metric | Standard | **Strict** | Improvement |
|--------|----------|------------|-------------|
| P99 Latency | <0.5s | **<0.3s** | 40% stricter |
| Error Rate (5xx) | <1% | **<0.5%** | 50% stricter |
| Cache Hit Rate | >40% | **>60%** | 50% higher |
| Contract Tests | Non-blocking | **Blocking** | Quality gate |

### Additional Checks
- **Stress Testing**: 100 concurrent requests
- **Log Analysis**: Scans for FATAL/CRITICAL errors
- **Conflict Rate**: <10% of successful approvals

## 🚀 How to Trigger

### Method 1: Manual Trigger (workflow_dispatch)
```bash
# Once the workflow is merged to main
gh workflow run "Observability Strict" --ref main
```

### Method 2: PR Label
Add the `v2-strict` label to any PR:
```bash
gh pr edit <PR_NUMBER> --add-label "v2-strict"
```

### Method 3: GitHub UI
1. Go to Actions tab
2. Select "Observability Strict" workflow
3. Click "Run workflow"
4. Select branch and click "Run workflow"

## 📊 Workflow Features

### 1. Enhanced Performance Validation
```yaml
# P99 must be < 0.3s (strict mode)
awk "BEGIN {exit !($P99 < 0.3)}"
```

### 2. Stress Testing
- Sends 100 concurrent requests
- Builds realistic P99 statistics
- Validates performance under load

### 3. Contract Test Enforcement
- All contract tests MUST pass
- Failures block the workflow
- Detailed test report in artifacts

### 4. Server Log Analysis
- Checks for critical errors
- Validates clean shutdown
- Monitors for memory leaks

## 📝 Setup Instructions

### Step 1: Create the v2-strict Label
```bash
gh label create "v2-strict" \
  --description "Trigger strict observability checks" \
  --color "FF0000"
```
✅ **Status**: Label created

### Step 2: Deploy Workflow File
The workflow file has been created at:
`.github/workflows/observability-strict.yml`

✅ **Status**: File created and pushed

### Step 3: Test the Workflow

#### Option A: Test on Current PR
```bash
# Add label to PR #41
gh pr edit 41 --add-label "v2-strict"
```

#### Option B: Create Test PR
```bash
# Create a test branch
git checkout -b test/strict-workflow

# Make a small change
echo "# Test" >> README.md
git add README.md
git commit -m "test: Trigger strict workflow"
git push origin test/strict-workflow

# Create PR with label
gh pr create --title "Test strict workflow" \
  --body "Testing v2-strict workflow" \
  --label "v2-strict"
```

## 🔧 Configuration as Required Check

Once the strict workflow consistently passes, make it a required check:

### Via GitHub UI
1. Go to Settings → Branches
2. Edit protection rules for `main`
3. Add "Observability Strict / Strict E2E with Enhanced Gates" to required checks

### Via API
```bash
# Get current protection
gh api repos/zensgit/smartsheet/branches/main/protection > protection.json

# Add strict check to required contexts
jq '.required_status_checks.contexts += ["Observability Strict / Strict E2E with Enhanced Gates"]' protection.json > new-protection.json

# Update protection
gh api repos/zensgit/smartsheet/branches/main/protection \
  --method PUT \
  --input new-protection.json
```

## 📈 Monitoring Success Criteria

### Green Run Requirements
Before promoting to required check, ensure:
- [ ] 10 consecutive successful runs
- [ ] P99 consistently <0.3s
- [ ] Error rate consistently <0.5%
- [ ] Cache hit rate consistently >60%
- [ ] All contract tests passing

### Performance Baseline
Track these metrics across runs:
```bash
# Extract metrics from workflow artifacts
gh run download <RUN_ID> -n strict-metrics-<RUN_ID>
cat metrics.txt | grep "quantile=\"0.99\""
```

## 🔄 Workflow Lifecycle

### Phase 1: Testing (Current)
- Run manually on select PRs
- Monitor for false positives
- Tune thresholds if needed

### Phase 2: Optional Check
- Add as non-required check
- Run on all PRs with v2-strict label
- Gather performance data

### Phase 3: Required Check
- Make mandatory for main branch
- Block merges on failure
- Ensure all PRs meet strict criteria

## 📊 Expected Output

### Successful Run
```
✅ STRICT: P99 latency check passed (0.002s < 0.3s)
✅ STRICT: Error rate check passed (0.0000 < 0.5%)
✅ STRICT: Cache hit rate above 60%: 0.75
✅ All contract tests passed
```

### Failed Run (Example)
```
❌ STRICT: P99 latency too high: 0.35s (threshold: <0.3s)
⚠️ STRICT: Cache hit rate below 60%: 0.45
```

## 🐛 Troubleshooting

### Workflow Not Triggering
1. Ensure workflow file is in default branch
2. Check label exists: `gh label list | grep v2-strict`
3. Verify PR has label: `gh pr view <PR_NUM> --json labels`

### Performance Failures
1. Check server logs in artifacts
2. Review stress test results
3. Analyze P99 distribution
4. Consider temporary threshold relaxation

### Contract Test Failures
1. Download contract-smoke.json artifact
2. Review failed test details
3. Check for endpoint implementation
4. Verify mock server responses

## 📚 Related Documentation

- [Observability Workflow](./.github/workflows/observability.yml)
- [Contract Tests](./scripts/contract-smoke.js)
- [Performance Report](./PERFORMANCE_GATE_IMPLEMENTATION_REPORT.md)
- [Production Config](./PRODUCTION_CONFIG_AUDIT_REPORT.md)

## 🎯 Success Metrics

### Week 1 Target
- 5+ successful manual runs
- P99 <0.25s achieved
- Zero false positives

### Week 2 Target
- 20+ successful runs
- Add as optional check
- Gather baseline metrics

### Week 4 Target
- 50+ successful runs
- Promote to required check
- Document performance improvements

## 🔗 Quick Links

- **PR #41**: https://github.com/zensgit/smartsheet/pull/41
- **Workflow Runs**: https://github.com/zensgit/smartsheet/actions
- **Label**: https://github.com/zensgit/smartsheet/labels/v2-strict

---

**Next Steps**:
1. Wait for current PR #41 checks to complete
2. Merge PR to make workflow available
3. Test workflow with manual dispatch
4. Monitor initial runs for stability

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>