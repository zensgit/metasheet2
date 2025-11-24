# Sprint 2 — Post-Merge Validation Checklist

**Purpose**: Execute full staging validation after PR merge when credentials become available
**Time Required**: 60-90 minutes
**Prerequisites**: Staging BASE_URL + Admin JWT Token

---

## Pre-Validation Setup

- [ ] **Credentials Received**
  - [ ] Staging BASE_URL (e.g., `https://staging.metasheet.com`)
  - [ ] Admin JWT Token (validate expiry: should have ≥2h remaining)
  - [ ] Document receipt time in Issue #5

- [ ] **Environment Preparation**
  - [ ] Verify staging environment is healthy: `curl <BASE_URL>/health`
  - [ ] Confirm database migrations applied: Check `schema_migrations` table
  - [ ] Fix JWT_SECRET mismatch if needed (see staging-validation-report.md § 4)

- [ ] **Local Setup**
  - [ ] Pull latest from `main` branch (post-merge)
  - [ ] Export credentials: `export STAGING_URL=<url>` and `export STAGING_JWT=<token>`
  - [ ] Verify scripts executable: `chmod +x scripts/verify-sprint2-staging.sh`

---

## Validation Execution (60-90 min)

### Phase 1: API Smoke Tests (15 min)

- [ ] **Snapshots API** (4 endpoints)
  - [ ] `POST /api/snapshots` → 201 Created
  - [ ] `PATCH /api/snapshots/:id/tags` → 200 OK
  - [ ] `PATCH /api/snapshots/:id/protection` → 200 OK
  - [ ] `PATCH /api/snapshots/:id/channel` → 200 OK

- [ ] **Protection Rules API** (5 endpoints)
  - [ ] `GET /api/admin/protection-rules` → 200 OK
  - [ ] `POST /api/admin/protection-rules` → 201 Created
  - [ ] `GET /api/admin/protection-rules/:id` → 200 OK
  - [ ] `POST /api/admin/protection-rules/:id/evaluate` → 200 OK (dry-run)
  - [ ] `DELETE /api/admin/protection-rules/:id` → 204 No Content

### Phase 2: Rule Effects Validation (20 min)

Test all 4 rule effects with real scenarios:

- [ ] **Effect: `allow`**
  - [ ] Create rule: `{ "conditions": {...}, "effect": "allow" }`
  - [ ] Evaluate snapshot matching conditions → `{"allowed": true, "effect": "allow"}`
  - [ ] Verify `rule_execution_log` entry created

- [ ] **Effect: `block`**
  - [ ] Create rule: `{ "conditions": {...}, "effect": "block" }`
  - [ ] Evaluate snapshot matching conditions → `{"allowed": false, "effect": "block"}`
  - [ ] Verify blocking reason logged

- [ ] **Effect: `elevate_risk`**
  - [ ] Create rule: `{ "conditions": {...}, "effect": "elevate_risk" }`
  - [ ] Evaluate snapshot → `{"allowed": true, "effect": "elevate_risk", "metadata": {...}}`
  - [ ] Verify risk metadata captured

- [ ] **Effect: `require_approval`**
  - [ ] Create rule: `{ "conditions": {...}, "effect": "require_approval" }`
  - [ ] Evaluate snapshot → `{"allowed": false, "effect": "require_approval", "metadata": {...}}`
  - [ ] Verify approval workflow triggered

### Phase 3: Performance Baseline (15 min)

- [ ] **Run 60-round test**
  ```bash
  bash scripts/performance-baseline-test.sh "$STAGING_JWT" "$STAGING_URL" 60
  ```
  - [ ] P50 < 100ms (target)
  - [ ] P95 < 150ms (target)
  - [ ] P99 < 250ms (target)
  - [ ] Error rate < 1%

- [ ] **Capture results**
  - [ ] Save output: `docs/sprint2/performance/staging-perf-<timestamp>.csv`
  - [ ] Generate summary: `scripts/perf-summary.sh <csv_file>`

### Phase 4: Prometheus Metrics (10 min)

- [ ] **Verify all 6 metrics collecting data**
  ```bash
  curl -s "$STAGING_URL/metrics/prom" > staging-metrics.txt
  grep -E "(snapshot_create|protection_rule|snapstats_latency|http_errors|rate_limit)" staging-metrics.txt
  ```

  - [ ] `snapshot_create_total` > 0
  - [ ] `protection_rule_eval_total` > 0
  - [ ] `snapstats_latency_bucket` (P95/P99 buckets populated)
  - [ ] `http_errors_total` = 0 (or <1% of requests)
  - [ ] `rate_limit_triggered_total` (verify rate limiting works)
  - [ ] `rule_execution_duration_seconds` (if implemented)

- [ ] **Capture metrics snapshot**
  ```bash
  bash scripts/capture-metrics-snapshot.sh "$STAGING_URL" > docs/sprint2/evidence/staging-metrics-<timestamp>.prom.txt
  ```

### Phase 5: Capacity Snapshot (10 min)

- [ ] **Capture staging database capacity**
  ```bash
  # SSH to staging database or use remote psql
  bash scripts/capacity-snapshot.sh > docs/sprint2/capacity/staging-capacity-<timestamp>.json
  ```

- [ ] **Generate capacity diff (Local T0 vs Staging T1)**
  ```bash
  bash scripts/capacity-diff.sh \
    docs/sprint2/capacity/capacity-20251121-132911.json \
    docs/sprint2/capacity/staging-capacity-<timestamp>.json \
    > docs/sprint2/capacity/staging-capacity-diff-<timestamp>.md
  ```

- [ ] **Review growth metrics**
  - [ ] Database size reasonable (staging may be larger than local dev)
  - [ ] No unexpected table size explosions
  - [ ] Index footprint acceptable

### Phase 6: Screenshots & Evidence (15 min)

- [ ] **Capture Grafana dashboards** (if available)
  - [ ] Snapshot Protection overview panel
  - [ ] API latency graphs (P50/P95/P99)
  - [ ] Error rate graph
  - [ ] Save: `docs/sprint2/screenshots/grafana-staging-<timestamp>.png`

- [ ] **API Response Samples**
  ```bash
  # Capture sample responses for documentation
  curl -H "Authorization: Bearer $STAGING_JWT" "$STAGING_URL/api/admin/protection-rules" | jq '.' > docs/sprint2/evidence/staging-rule-list-<timestamp>.json
  ```

- [ ] **Export evidence bundle**
  ```bash
  tar -czf docs/sprint2/staging-evidence-<timestamp>.tar.gz docs/sprint2/evidence/ docs/sprint2/screenshots/
  ```

### Phase 7: Edge Cases & Error Handling (10 min)

- [ ] **Rate Limiting**
  - [ ] Trigger rate limit: Rapid-fire 100 requests
  - [ ] Verify 429 response returned
  - [ ] Confirm `rate_limit_triggered_total` incremented

- [ ] **Invalid Requests**
  - [ ] Missing required fields → 400 Bad Request
  - [ ] Invalid rule ID → 404 Not Found
  - [ ] Unauthorized (no token) → 401 Unauthorized
  - [ ] Forbidden (non-admin) → 403 Forbidden

- [ ] **Idempotency**
  - [ ] Create duplicate rule → Handle gracefully (409 or ignore)
  - [ ] Update non-existent rule → 404
  - [ ] Delete already deleted rule → 404

---

## Post-Validation Actions

### Success Path (All Gates Pass)

- [ ] **Update Documentation**
  - [ ] Fill `staging-validation-report.md` with results
  - [ ] Update `pr-description-draft.md` validation summary
  - [ ] Mark "Staging Verification Required" as complete

- [ ] **Evidence Checklist**
  - [ ] All API responses captured (9 endpoints)
  - [ ] All 4 rule effects validated
  - [ ] Performance CSV + summary JSON
  - [ ] Prometheus metrics snapshot
  - [ ] Capacity diff report
  - [ ] Screenshots (Grafana/API samples)

- [ ] **Final Sign-off**
  - [ ] Post results to Issue #5
  - [ ] Close Issue #5 as resolved
  - [ ] Update PR with "Staging Validated ✅" comment
  - [ ] Remove "Staging Verification Required" label from PR

### Failure Path (Issues Found)

- [ ] **Document Failures**
  - [ ] Create failure report: `docs/sprint2/staging-validation-failures-<timestamp>.md`
  - [ ] Capture error logs and stack traces
  - [ ] Screenshot failing API responses

- [ ] **Impact Assessment**
  - [ ] Categorize: Critical / High / Medium / Low
  - [ ] Determine if rollback required (Critical/High failures)
  - [ ] Identify root cause (code vs environment vs configuration)

- [ ] **Rollback Decision**
  - [ ] If Critical failure → Execute `docs/sprint2/rollback.md`
  - [ ] If High failure → Create hotfix PR
  - [ ] If Medium/Low → Create follow-up issues, track in Sprint 3

- [ ] **Communication**
  - [ ] Notify team in Issue #5 + PR comments
  - [ ] Escalate to Tech Lead if rollback needed
  - [ ] Document lessons learned for future sprints

---

## Validation Acceptance Criteria

**All Must Pass**:
- ✅ 9/9 API endpoints return expected status codes
- ✅ 4/4 rule effects validated with real scenarios
- ✅ Performance: P95 < 150ms, P99 < 250ms
- ✅ Error rate < 1%
- ✅ 6/6 Prometheus metrics collecting data
- ✅ No Critical or High severity issues found

**Post-Merge Definition of Done**:
- Staging validation completed within 24h of credential availability
- All evidence captured and documented
- Issue #5 closed with resolution summary
- Team notified of validation results

---

## Quick Reference

**Key Scripts**:
- Main validation: `scripts/verify-sprint2-staging.sh <JWT> <BASE_URL>`
- Performance test: `scripts/performance-baseline-test.sh <JWT> <BASE_URL> <rounds>`
- Metrics capture: `scripts/capture-metrics-snapshot.sh <BASE_URL>`
- Capacity snapshot: `scripts/capacity-snapshot.sh`

**Environment Variables**:
```bash
export STAGING_URL="https://staging.metasheet.com"
export STAGING_JWT="eyJ..."
export STAGING_DB_HOST="staging-db.internal"  # If capacity check needs remote DB
```

**Rollback Trigger Conditions**:
- Any API endpoint consistently returning 5xx
- Database migration failures
- Data corruption detected
- Performance degradation >3x from baseline (P95 >450ms)
- Security vulnerabilities discovered

**Estimated Timeline**:
- Phase 1 (API Smoke): 15 min
- Phase 2 (Rule Effects): 20 min
- Phase 3 (Performance): 15 min
- Phase 4 (Metrics): 10 min
- Phase 5 (Capacity): 10 min
- Phase 6 (Screenshots): 15 min
- Phase 7 (Edge Cases): 10 min
- **Total**: ~95 minutes (1h 35m)

**Contact for Issues**:
- Tech Lead: [Name/Contact]
- DevOps: [Name/Contact] (for staging access issues)
- Database: [Name/Contact] (for migration issues)
