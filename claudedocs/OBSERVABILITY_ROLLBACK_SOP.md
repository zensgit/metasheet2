# Observability Rollback Standard Operating Procedure (SOP)

**Document Version**: 1.0
**Last Updated**: 2025-11-10
**Owner**: MetaSheet DevOps Team
**Status**: Active

---

## 🎯 Purpose

This document provides step-by-step instructions for rolling back the observability-hardening changes if critical issues arise after merging PR #421.

---

## ⚠️ When to Execute Rollback

### Immediate Rollback (0-4h) - RED ALERT

Execute rollback **immediately** if any of these conditions occur:

| Condition | Threshold | Impact |
|-----------|-----------|--------|
| **Approval Success = 0** | 3 consecutive runs with no fallback | Critical - Approval system down |
| **Conflicts > 10** | Sustained for 2+ hours | High - Data integrity risk |
| **RBAC P99 > 500ms** | Sustained for 15+ minutes | High - Permission checks timing out |
| **Plugin Start Failures** | >20% failure rate | High - Core functionality broken |
| **Database Connection Loss** | Any connection errors | Critical - Data layer failure |

### Consider Rollback (4-24h) - YELLOW ALERT

Evaluate rollback if:

- ⚠️ Fallback usage rate >50% for 6+ hours
- ⚠️ P99 standard deviation >0.1 (high instability)
- ⚠️ Database query timeouts >5/hour
- ⚠️ WebSocket connection failures >10%
- ⚠️ Cache miss rate >30% (if Redis enabled)

### Defer Optimization (DO NOT ROLLBACK)

These scenarios do **not** warrant rollback:

- ✅ P99 baseline standard deviation >0.05 (normal variation)
- ✅ Raw scrape success rate <90% (fallback working)
- ✅ Single isolated metric spike (self-recovering)
- ✅ Documentation typos or non-critical issues

---

## 🔧 Rollback Execution

### Prerequisites

1. **Access Requirements**:
   - GitHub CLI (`gh`) authenticated with repo admin permissions
   - Database credentials (if DB rollback needed)
   - Production server SSH/kubectl access

2. **Communication**:
   - Alert team in #incidents Slack channel
   - Create incident ticket: `INCIDENT-YYYY-MM-DD-observability-rollback`
   - Notify stakeholders of expected downtime (if any)

3. **Verification**:
   - Confirm current main branch commit hash
   - Check active user sessions (coordinate downtime if needed)

---

### Step 1: Execute Automated Rollback Script

```bash
# Navigate to repository
cd /path/to/metasheet-v2

# Execute rollback script
./scripts/rollback-observability.sh --confirm

# Expected output:
# ✅ Disabled OBS_METRICS_STRICT variable
# ✅ Restored branch protection
# ✅ Cleaned up metrics artifacts
# ✅ Triggered CI verification
```

**What this does**:
- Disables strict metrics gate (`OBS_METRICS_STRICT=false`)
- Restores branch protection from backup
- Cleans recent metrics workflow runs
- Triggers fresh CI verification

**Duration**: ~2-5 minutes

---

### Step 2: Verify Rollback Success

```bash
# Check variable is disabled
gh variable list --repo zensgit/smartsheet | grep OBS_METRICS_STRICT
# Expected: OBS_METRICS_STRICT=false

# Check CI status
gh run list --repo zensgit/smartsheet --branch main --limit 3
# Expected: Latest run shows "CI Tests" workflow running/passed

# Check server health
curl http://localhost:8900/health | jq '.'
# Expected: { "status": "ok", ... }
```

**Duration**: ~5-10 minutes

---

### Step 3: Database Rollback (If Needed)

⚠️ **Only execute if observability merge included database migrations that are causing issues.**

```bash
# Check if rollback SQL exists
ls packages/core-backend/src/db/migrations/rollback-observability.sql

# If exists, execute rollback
DATABASE_URL='postgresql://...' \
  psql -f packages/core-backend/src/db/migrations/rollback-observability.sql

# Verify tables
DATABASE_URL='postgresql://...' \
  node scripts/verify-db-schema.js
```

**Duration**: ~5-15 minutes

---

### Step 4: Restart Services (If Needed)

If metrics collection is still failing after rollback:

```bash
# Restart backend server
pkill -f "node.*core-backend"
cd packages/core-backend
npm run dev &

# Wait for startup
sleep 10

# Verify health
curl http://localhost:8900/health
```

**Duration**: ~2-5 minutes

---

### Step 5: Validate System Recovery

Run comprehensive validation checks:

```bash
# 1. Check approval system
curl http://localhost:8900/api/approvals | jq '.ok'
# Expected: true

# 2. Check RBAC performance
curl -s http://localhost:8900/metrics/prom \
  | grep 'rbac_check_duration_seconds{quantile="0.99"}'
# Expected: <0.050 (50ms)

# 3. Check plugin status
curl http://localhost:8900/api/plugins | jq '.[].status'
# Expected: All showing "active"

# 4. Trigger test approval workflow
# (Manual test in UI or via API)
```

**Duration**: ~10-15 minutes

---

## 📊 Post-Rollback Actions

### Immediate (0-2h)

- [ ] Update incident ticket with rollback completion
- [ ] Post status update in #incidents channel
- [ ] Monitor system for 2 hours to ensure stability
- [ ] Create rollback log: `claudedocs/ROLLBACK_LOG_YYYYMMDD_HHMMSS.md`

### Short-Term (2-24h)

- [ ] Schedule post-mortem meeting (within 24h)
- [ ] Document root cause in incident ticket
- [ ] Create GitHub issue for fix: `[ROLLBACK] Root cause and remediation plan`
- [ ] Update this SOP with lessons learned

### Mid-Term (1-7 days)

- [ ] Develop fix for root cause
- [ ] Test fix in staging environment
- [ ] Create new PR with fix + additional safeguards
- [ ] Schedule re-merge attempt (with team approval)

---

## 🔍 Troubleshooting

### Issue: Rollback script fails with "permission denied"

**Solution**:
```bash
# Make script executable
chmod +x scripts/rollback-observability.sh

# If still failing, check gh auth
gh auth status

# Re-authenticate if needed
gh auth login
```

---

### Issue: Branch protection restore fails

**Solution**:
```bash
# Manual restore via GitHub UI
# 1. Go to: https://github.com/zensgit/smartsheet/settings/branches
# 2. Click "Edit" on main branch
# 3. Restore settings from backup file:
cat .github/branch-protection-backup.json

# Or use API directly
gh api --method PUT \
  /repos/zensgit/smartsheet/branches/main/protection \
  --input .github/branch-protection-backup.json
```

---

### Issue: Database schema out of sync

**Solution**:
```bash
# Run schema verification
DATABASE_URL='postgresql://...' \
  node scripts/verify-db-schema.js

# If tables missing, restore from backup
# (Contact DBA for production database restore)

# Or re-run migrations from clean state
cd packages/core-backend
npm run db:migrate
```

---

### Issue: Metrics still failing after rollback

**Solution**:
```bash
# Disable all observability workflows temporarily
gh workflow disable "Observability Metrics Lite" --repo zensgit/smartsheet
gh workflow disable "observability-strict.yml" --repo zensgit/smartsheet

# Clean all metrics artifacts
gh run list --workflow "Observability Metrics Lite" --json databaseId -q '.[].databaseId' \
  | xargs -I {} gh run delete {} --repo zensgit/smartsheet

# Re-enable after system stabilizes
gh workflow enable "Observability Metrics Lite" --repo zensgit/smartsheet
```

---

## 📞 Escalation Contacts

| Role | Contact | Availability |
|------|---------|-------------|
| **On-Call Engineer** | #oncall-engineering | 24/7 |
| **Database Team** | dba-team@metasheet.com | Business hours |
| **DevOps Lead** | devops-lead@metasheet.com | 24/7 (urgent only) |
| **VP Engineering** | vp-eng@metasheet.com | Critical incidents only |

---

## 📝 Rollback Checklist

Use this checklist during rollback execution:

```markdown
## Rollback Execution Checklist

**Incident ID**: _____________
**Started At**: _____________
**Executed By**: _____________

### Pre-Rollback
- [ ] Incident ticket created
- [ ] Team notified in #incidents
- [ ] Current commit hash recorded: _____________
- [ ] Active sessions checked (downtime coordinated if needed)

### Execution
- [ ] Automated rollback script executed successfully
- [ ] Variable OBS_METRICS_STRICT set to false
- [ ] Branch protection restored
- [ ] Metrics artifacts cleaned
- [ ] CI verification triggered

### Verification
- [ ] Server health check passed
- [ ] Approval system functional
- [ ] RBAC latency < 50ms
- [ ] All plugins active
- [ ] Database schema verified (if needed)

### Post-Rollback
- [ ] 2-hour stability monitoring completed
- [ ] Rollback log created
- [ ] Incident ticket updated with resolution
- [ ] Post-mortem scheduled
- [ ] This SOP updated with lessons learned

**Completed At**: _____________
**Final Status**: ✅ SUCCESS / ❌ PARTIAL / ⚠️ FAILED
**Notes**: _____________________________________________
```

---

## 🔄 Rollback History

| Date | Reason | Duration | Outcome | Root Cause |
|------|--------|----------|---------|------------|
| _TBD_ | _Initial SOP creation_ | _N/A_ | _N/A_ | _N/A_ |

*(Update this table after each rollback execution)*

---

## 📚 Related Documents

- **Merge Plan**: `claudedocs/PHASE1_MERGE_REPORT.md`
- **Validation Report**: `claudedocs/PHASE2_VALIDATION_REPORT.md`
- **Observation Report**: `claudedocs/PHASE3_OBSERVATION_REPORT.md`
- **Rollback Script**: `scripts/rollback-observability.sh`
- **DB Verification**: `scripts/verify-db-schema.js`

---

## ✅ Document Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| **Author** | Claude AI | _Digital_ | 2025-11-10 |
| **Reviewer** | _Pending_ | _________ | ________ |
| **Approver** | _Pending_ | _________ | ________ |

---

**End of SOP**
