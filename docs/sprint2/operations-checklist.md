# Sprint 2 Operations Checklist

**Document Purpose**: Quick reference guide for Sprint 2 validation operations
**Last Updated**: 2025-11-21 09:50 CST
**Status**: Active - Standby Mode

## Quick Status Check

### One-Command Status
```bash
# Quick system health check
echo "=== Sprint 2 Status ===" && \
echo "Watcher: $(ps aux | grep 72134 | grep -v grep | wc -l | tr -d ' ') process(es)" && \
echo "Branch: $(git branch --show-current)" && \
echo "Latest commit: $(git log -1 --oneline)" && \
echo "Issue #5: https://github.com/zensgit/metasheet2/issues/5"
```

### Expected Output
```
=== Sprint 2 Status ===
Watcher: 1 process(es)
Branch: feature/sprint2-snapshot-protection
Latest commit: 28ca187c docs(sprint2): add standby status report
Issue #5: https://github.com/zensgit/metasheet2/issues/5
```

## Monitoring Checklist (Every 2 Hours)

### Manual Check Routine
1. **Check Issue #5 for new comments**
   ```bash
   gh issue view 5 --repo zensgit/metasheet2 --json comments \
     --jq '{comment_count: (.comments | length), latest: (.comments[-1] | {author: .author.login, time: .createdAt})}'
   ```

2. **Verify Watcher Process**
   ```bash
   ps aux | grep 72134 | grep -v grep
   ```
   - ✅ Expected: 1 line showing `bash scripts/watch-staging-token-and-validate.sh 5`
   - ❌ Issue: No output → Watcher died, need restart

3. **Check Watcher Log (Last 20 lines)**
   ```bash
   tail -20 /tmp/staging_watch.log
   ```
   - Look for: Successful GitHub API calls or TLS timeout errors
   - Recent reminders should be posting to Issue #5

### If Watcher Dies
```bash
# Restart watcher
cd /Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2
nohup bash scripts/watch-staging-token-and-validate.sh 5 > /tmp/staging_watch.log 2>&1 &
echo "New watcher PID: $!"
```

### If Credentials Arrive
```bash
# Stop watcher immediately
kill 72134

# Export credentials
export STAGING_BASE_URL="<provided URL>"
export STAGING_JWT="<provided token>"

# Execute staging validation (60-90 min)
cd /Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2
bash /tmp/execute-staging-validation.sh

# OR use quick smoke test first (30 sec)
bash scripts/staging-latency-smoke.sh "$STAGING_JWT" "$STAGING_BASE_URL"
```

## Decision Points

### At 24h Mark (2025-11-21 14:28 UTC / 22:28 CST)

**If Credentials Received**:
```bash
# See "If Credentials Arrive" above
# Then update documentation with results
# Finally submit PR with full staging validation
```

**If No Credentials**:
```bash
# Post update to Issue #5
gh issue comment 5 --repo zensgit/metasheet2 --body "## 24h Checkpoint - Entering Partial Validation Phase

Staging credentials not received after 24h. Executing extended local validation:
- Re-running all 17 integration tests with fresh database
- Documenting extended local validation results
- Preparing for 48h decision point

Status: Continuing with fallback strategy as documented."

# Re-run integration tests with fresh database
cd packages/core-backend
pnpm migrate:reset
npm test -- tests/integration/snapshot-protection.test.ts

# Document results in staging-validation-report.md
```

### At 48h Mark (2025-11-22 14:28 UTC)

**If Still No Credentials**:
```bash
# Execute PR submission with labels
gh pr create \
  --title "Sprint 2: Snapshot Protection System" \
  --body-file docs/sprint2/pr-description-draft.md \
  --label "Local Validation Only" \
  --label "Staging Verification Required" \
  --label "P1-high" \
  --base main

# Create follow-up issue
gh issue create --repo zensgit/metasheet2 \
  --title "[Post-Merge] Sprint 2 Staging Validation" \
  --body "## Post-Merge Staging Validation Required

**Related PR**: #<PR_NUMBER>
**Priority**: P1-high
**Timeline**: Complete within 24h of merge

**Required Items**:
- Staging BASE_URL
- Admin JWT Token (2h validity acceptable)

**Validation Steps**: See docs/sprint2/staging-validation-report.md

**Rollback Plan**: docs/sprint2/rollback.md"
```

## Key Commands Reference

### Git Operations
```bash
# Check current status
git status
git log -5 --oneline

# Sync with remote
git fetch origin
git pull origin feature/sprint2-snapshot-protection

# Commit and push updates
git add docs/sprint2/
git commit -m "docs(sprint2): update status report"
git push origin feature/sprint2-snapshot-protection
```

### Issue #5 Operations
```bash
# View Issue details
gh issue view 5 --repo zensgit/metasheet2

# Add comment
gh issue comment 5 --repo zensgit/metasheet2 --body "Your comment here"

# Check comment count
gh issue view 5 --repo zensgit/metasheet2 --json comments --jq '.comments | length'
```

### Performance Testing
```bash
# Generate JWT
LOCAL_JWT=$(node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({id:'ops',roles:['admin']},'dev-jwt-secret-local',{expiresIn:'1h'}))")

# Quick smoke test (30 sec)
bash scripts/staging-latency-smoke.sh "$LOCAL_JWT" http://localhost:8900

# Full performance test (60 rounds)
bash scripts/performance-baseline-test.sh "$LOCAL_JWT" http://localhost:8900
```

### Plugin System Check
```bash
# Check plugin status
curl -s http://localhost:8900/api/plugins | jq '.plugins | length'

# List active plugins
curl -s http://localhost:8900/api/plugins | jq '.plugins[] | select(.status == "active") | .name'
```

## File Locations Reference

### Core Documentation
```
docs/sprint2/
├── standby-status-report.md          ← Latest comprehensive status
├── day1-completion-summary.md         ← Day 1 work summary
├── pr-description-draft.md            ← PR template (ready to submit)
├── staging-validation-report.md       ← Validation tracking
├── escalation-checkpoint.md           ← 12h checkpoint
├── plugin-status-audit.md             ← Plugin system audit
├── extended-test-note.md              ← JWT auth blocker note
├── operations-checklist.md            ← This file
└── rollback.md                        ← Rollback procedure (if needed)
```

### Scripts
```
scripts/
├── staging-latency-smoke.sh           ← Quick health check (30 sec)
├── README-staging-smoke.md            ← Script usage guide
├── performance-baseline-test.sh       ← Performance testing
├── verify-sprint2-staging.sh          ← Full validation suite
└── watch-staging-token-and-validate.sh ← Watcher (PID: 72134)
```

### Evidence & Artifacts
```
docs/sprint2/evidence/                 ← 165+ evidence files
docs/sprint2/performance/              ← Performance data
docs/sprint2/screenshots/              ← 3 placeholder files
```

## Troubleshooting

### Issue: Watcher Not Posting Comments
**Symptom**: No new comments on Issue #5 for >1 hour
**Check**:
```bash
tail -50 /tmp/staging_watch.log | grep -E "(error|timeout|failed)"
```
**Fix**: Restart watcher (see "If Watcher Dies" above)

### Issue: GitHub API Rate Limit
**Symptom**: Error messages about rate limiting in watcher log
**Check**:
```bash
curl -s https://api.github.com/rate_limit -H "Authorization: token $(gh auth token)" | jq '.rate'
```
**Fix**: Wait for rate limit reset, or use personal access token with higher limits

### Issue: Can't Find Watcher PID
**Symptom**: Process 72134 not found
**Find Current Watcher**:
```bash
ps aux | grep "watch-staging-token" | grep -v grep
```
**Update Documentation**: Note new PID in standby-status-report.md

### Issue: JWT Token Expired
**Symptom**: 401 errors in staging validation
**Regenerate Token**:
```bash
node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({id:'ops',roles:['admin']},'dev-jwt-secret-local',{expiresIn:'2h'}))"
```

## Communication Templates

### 24h Update Template
```markdown
## 24h Checkpoint - Status Update

**Elapsed Time**: 24 hours since request created
**Status**: ⚠️ BLOCKED - No credentials received

**Progress Since Last Update**:
- [List any additional work completed]

**Next Actions**:
- Entering Partial Validation Phase (Hour 24-48)
- Will continue monitoring Issue #5
- 48h decision point: [Date/Time]

**Request**: Please provide staging credentials or confirm alternate plan.
```

### Emergency Escalation Template
```markdown
## 🔴 URGENT: Sprint 2 Validation Blocked

**Priority**: P0 - CRITICAL
**Impact**: Sprint 2 delivery at risk
**Time Elapsed**: [XX] hours

**Blocking Issue**: Staging credentials not provided
**Business Impact**: Cannot validate feature in production-like environment

**Immediate Action Required**:
1. Provide Staging BASE_URL
2. Provide Admin JWT Token (2h validity acceptable)
3. OR Approve proceeding with local validation only

**Risk if No Action**: May need to proceed with "Local Validation Only" PR submission
```

## Metrics to Track

### Daily Checklist
- [ ] Watcher process healthy
- [ ] Issue #5 checked (manual)
- [ ] Latest commit pushed
- [ ] Documentation up to date
- [ ] No blocker changes

### Weekly Checklist
- [ ] Review watcher logs for patterns
- [ ] Update risk assessment
- [ ] Validate evidence files integrity
- [ ] Check for stale background processes
- [ ] Review and update this checklist

## Quick Wins

### Fast Documentation Updates
```bash
# Update standby status report with current time
cd docs/sprint2
sed -i '' "s/Generated: .*/Generated: $(date '+%Y-%m-%d %H:%M CST')/" standby-status-report.md
git add standby-status-report.md
git commit -m "docs(sprint2): update status report timestamp"
git push
```

### Fast Issue Check
```bash
# One-liner to check Issue #5 and copy latest comment
gh issue view 5 --repo zensgit/metasheet2 --json comments --jq '.comments[-1].body' | pbcopy
echo "Latest comment copied to clipboard"
```

### Fast Performance Spot Check
```bash
# Quick 5-sample latency check
for i in {1..5}; do
  time curl -s http://localhost:8900/api/snapstats > /dev/null
done
```

## Critical Contacts

- **Issue Tracker**: https://github.com/zensgit/metasheet2/issues/5
- **PR Branch**: feature/sprint2-snapshot-protection
- **Rollback Plan**: docs/sprint2/rollback.md
- **Ops Runbook**: docs/sprint2/ops-runbook.md

## Maintenance Notes

### When to Update This Checklist
- Watcher PID changes
- New scripts added
- Decision points reached
- Process improvements identified
- Troubleshooting scenarios discovered

### Version History
- 2025-11-21 09:50 CST: Initial version (Day 1 standby mode)

---

**Remember**: This is a living document. Update it as you learn more efficient workflows or encounter new scenarios.
