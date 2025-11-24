# Phase 5 Nightly SLO Validation Operations Guide

Operational procedures for automated nightly SLO validation, alerting, and incident response.

## Overview

The Phase 5 Nightly Validation system provides continuous monitoring of production SLO compliance through scheduled validation runs. This guide covers setup, alerting, incident response, and trend analysis procedures.

### Objectives

- **Early Detection**: Identify SLO degradation before customer impact
- **Automated Alerting**: Generate actionable alerts for on-call teams
- **Trend Analysis**: Track SLO performance over time
- **Incident Response**: Provide runbooks for common violation patterns

## Setup and Configuration

### 1. Enable GitHub Actions Workflow

**Step 1**: Copy example workflow to active location

```bash
cp .github/workflows/phase5-slo-validation.yml.example \
   .github/workflows/phase5-slo-validation.yml
```

**Step 2**: Customize environment variables

```yaml
# Edit .github/workflows/phase5-slo-validation.yml
env:
  HOST: 127.0.0.1
  PORT: 8900
  JWT_SECRET: ${{ secrets.NIGHTLY_JWT_SECRET }}
  DATABASE_URL: ${{ secrets.NIGHTLY_DATABASE_URL }}
  SAFETY_GUARD_ENABLED: 'true'
  IDEMPOTENCY_ENABLED: 'true'
  RATE_LIMIT_ENABLED: 'true'
```

**Step 3**: Configure GitHub secrets

Required secrets in repository settings:
- `NIGHTLY_JWT_SECRET`: JWT signing secret for validation environment
- `NIGHTLY_DATABASE_URL`: PostgreSQL connection string

**Step 4**: Verify schedule configuration

```yaml
on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM UTC daily
```

**Recommended Schedules**:
- **Production**: `0 2 * * *` (2 AM UTC, low traffic period)
- **Staging**: `0 */6 * * *` (Every 6 hours for faster feedback)
- **Development**: `0 8 * * 1-5` (8 AM UTC, weekdays only)

### 2. Configure Notification Channels

#### Slack Integration (Recommended)

**Step 1**: Create Slack incoming webhook

1. Go to Slack App Directory → Incoming Webhooks
2. Create webhook for `#ops-alerts` channel
3. Copy webhook URL

**Step 2**: Add Slack notification to workflow

```yaml
- name: Notify Slack on failure
  if: steps.slo_validation.outcome == 'failure'
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
  run: |
    curl -X POST "$SLACK_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d '{
        "text": "🚨 Phase 5 SLO Validation Failed",
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "*Phase 5 SLO Validation Failed*\n\n:x: Nightly validation detected SLO violations\n\n*Run*: <${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View Details>\n*Time*: '"$(date -u +"%Y-%m-%d %H:%M UTC")"'"
            }
          }
        ]
      }'
```

**Step 3**: Add GitHub secret

```bash
# In repository settings → Secrets and variables → Actions
# Add new secret: SLACK_WEBHOOK_URL
```

#### Email Notifications

**Step 1**: Configure GitHub notification emails

1. Repository Settings → Notifications
2. Enable "Actions" notifications
3. Select "Send notifications for failed workflows"

**Step 2**: Add team members to watch list

Team members with "Watch" enabled will receive email notifications for workflow failures.

#### PagerDuty Integration (Critical Alerts)

For production systems requiring immediate response:

```yaml
- name: Trigger PagerDuty incident
  if: steps.slo_validation.outcome == 'failure' && github.event_name == 'schedule'
  env:
    PAGERDUTY_INTEGRATION_KEY: ${{ secrets.PAGERDUTY_INTEGRATION_KEY }}
  run: |
    curl -X POST https://events.pagerduty.com/v2/enqueue \
      -H 'Content-Type: application/json' \
      -d '{
        "routing_key": "'"$PAGERDUTY_INTEGRATION_KEY"'",
        "event_action": "trigger",
        "payload": {
          "summary": "Phase 5 SLO Validation Failed",
          "severity": "warning",
          "source": "github-actions",
          "custom_details": {
            "run_id": "${{ github.run_id }}",
            "run_url": "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
          }
        }
      }'
```

### 3. Issue Auto-Creation Configuration

The workflow automatically creates GitHub issues on nightly failures. Customize issue template:

```yaml
create-issue-on-failure:
  needs: slo-validation
  if: failure() && github.event_name == 'schedule'
  runs-on: ubuntu-latest
  steps:
    - name: Create issue for SLO violation
      uses: actions/github-script@v7
      with:
        script: |
          const title = `🚨 Nightly SLO Validation Failed - ${new Date().toISOString().split('T')[0]}`;
          const body = `
          ## SLO Validation Failure

          The nightly SLO validation job has failed.

          **Run**: ${{ github.run_id }}
          **Workflow**: ${{ github.workflow }}
          **Repository**: ${{ github.repository }}
          **Time**: ${new Date().toISOString()}

          ### Required Actions
          1. Review validation artifacts (JSON and Markdown reports)
          2. Identify violated metrics
          3. Determine root cause
          4. Create remediation plan
          5. Close issue once resolved

          [View Workflow Run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})
          `;

          github.rest.issues.create({
            owner: context.repo.owner,
            repo: context.repo.repo,
            title: title,
            body: body,
            labels: ['slo-violation', 'phase5', 'ops', 'priority-high'],
            assignees: ['ops-team-lead'] // Customize
          });
```

## Incident Response Procedures

### Response Workflow

```
SLO Violation Detected
      │
      ▼
[1] Alert Generated
      │
      ├─ Slack notification
      ├─ Email to on-call
      ├─ GitHub issue created
      └─ PagerDuty (if critical)
      │
      ▼
[2] Initial Assessment (15 min SLA)
      │
      ├─ Review validation report
      ├─ Identify violated metrics
      └─ Determine severity
      │
      ▼
[3] Root Cause Analysis
      │
      ├─ Check recent deployments
      ├─ Review error logs
      ├─ Analyze metrics trends
      └─ Correlate with incidents
      │
      ▼
[4] Mitigation Actions
      │
      ├─ Apply hotfix (if available)
      ├─ Rollback (if regression)
      ├─ Scale resources (if capacity)
      └─ Schedule maintenance (if complex)
      │
      ▼
[5] Verification
      │
      ├─ Trigger manual validation
      ├─ Monitor metrics recovery
      └─ Confirm SLO compliance
      │
      ▼
[6] Post-Incident
      │
      ├─ Update runbook
      ├─ Document lessons learned
      ├─ Close GitHub issue
      └─ Notify stakeholders
```

### Severity Classification

#### Critical (P0) - Immediate Response Required

**Criteria**:
- HTTP success rate < 95% (threshold 98%)
- Error rate > 3% (threshold 1%)
- Memory RSS > 750 MB (threshold 500 MB, critical at 1.5x)
- Multiple metric failures (≥4 violations)

**Response**:
- Page on-call engineer immediately
- Notify engineering lead
- Begin incident response within 15 minutes
- Consider rollback as first action

**Example Slack Alert**:
```
🚨 CRITICAL: Phase 5 SLO Validation Failed

Severity: P0 - Immediate Action Required
Violated Metrics:
  • HTTP success rate: 93% (threshold: 98%)
  • Error rate: 4.2% (threshold: 1%)
  • Cache hit rate: 45% (threshold: 80%)

Action Required: Immediate investigation and mitigation
On-Call: @ops-team
[View Details] [View Logs] [Start Incident]
```

#### High (P1) - Same Day Resolution

**Criteria**:
- Plugin reload P99 > 8s (threshold 5s, concerning at 1.6x)
- Cache hit rate < 60% (threshold 80%)
- 2-3 metric violations
- Degraded but functional

**Response**:
- Notify on-call team (no page)
- Investigation within 2 hours
- Mitigation plan within 4 hours
- Resolution target: same business day

#### Medium (P2) - Next Business Day

**Criteria**:
- Single non-critical metric violation
- Marginal threshold breach (within 10%)
- Snapshot restore latency elevated

**Response**:
- Create tracking issue
- Investigation during business hours
- Resolution target: 48 hours

#### Low (P3) - Monitoring

**Criteria**:
- Near-threshold values (within 5%)
- First-time anomalies
- Non-production environments

**Response**:
- Log for trend analysis
- No immediate action required
- Review in weekly ops meeting

### Metric-Specific Runbooks

#### 1. Plugin Reload Latency Violation

**Symptom**: `plugin_reload_latency_p95 > 2.0s` or `p99 > 5.0s`

**Immediate Checks**:
```bash
# Check plugin sizes
ls -lh packages/core-backend/src/plugins/

# Check recent plugin changes
git log --since="7 days ago" -- packages/core-backend/src/plugins/

# Review plugin reload metrics
curl http://localhost:8900/metrics/prom | grep plugin_reload
```

**Common Causes**:
- Large plugin file sizes (check for bundled dependencies)
- Slow plugin initialization (database queries, API calls in init)
- File system performance issues
- Synchronous I/O in plugin loading

**Mitigation**:
1. **Immediate**: Cache plugin code, reduce reload frequency
2. **Short-term**: Optimize plugin initialization logic
3. **Long-term**: Implement lazy loading, async plugin init

#### 2. Cache Hit Rate Violation

**Symptom**: `cache_hit_rate < 80%`

**Immediate Checks**:
```bash
# Check cache metrics
curl http://localhost:8900/metrics/prom | grep -E "cache_hits|cache_misses"

# Check Redis/cache connectivity
redis-cli ping

# Review cache configuration
cat packages/core-backend/.env | grep CACHE
```

**Common Causes**:
- Cache server unavailable or restarted
- TTL too short for access patterns
- Cache eviction due to memory pressure
- Traffic spike from new access patterns

**Mitigation**:
1. **Immediate**: Verify cache server health, restart if needed
2. **Short-term**: Increase cache TTL, expand cache capacity
3. **Long-term**: Implement cache warming, optimize cache keys

#### 3. HTTP Success Rate / Error Rate Violation

**Symptom**: `http_success_rate < 98%` or `error_rate > 1%`

**Immediate Checks**:
```bash
# Check recent error logs
tail -100 /var/log/metasheet/error.log

# Check HTTP status distribution
curl http://localhost:8900/metrics/prom | grep http_requests_total

# Check recent deployments
git log -1 --oneline
```

**Common Causes**:
- Recent deployment with bugs
- Database connectivity issues
- Authentication service problems
- Client sending malformed requests

**Mitigation Priority**:
1. **Rollback** if recent deployment (< 24 hours)
2. **Fix forward** if root cause identified and simple
3. **Scale resources** if capacity-related
4. **Circuit breaker** if downstream service failing

#### 4. Memory RSS Violation

**Symptom**: `memory_rss > 500 MB`

**Immediate Checks**:
```bash
# Check process memory
ps aux | grep node | grep metasheet

# Check heap size
curl http://localhost:8900/metrics/prom | grep nodejs_heap

# Review memory leak indicators
curl http://localhost:8900/metrics/prom | grep nodejs_external_memory
```

**Common Causes**:
- Memory leak in application code
- Unbounded cache growth
- Large response payloads retained
- Event listener leaks

**Mitigation**:
1. **Immediate**: Restart service (temporary relief)
2. **Short-term**: Enable memory profiling, capture heap dumps
3. **Long-term**: Identify and fix memory leaks

#### 5. Snapshot Restore Latency Violation

**Symptom**: `snapshot_restore_latency_p95 > 5.0s` or `p99 > 8.0s`

**Immediate Checks**:
```bash
# Check snapshot sizes
SELECT spreadsheet_id, LENGTH(snapshot_data)
FROM snapshots
ORDER BY LENGTH(snapshot_data) DESC
LIMIT 10;

# Check database performance
EXPLAIN ANALYZE SELECT * FROM snapshots WHERE spreadsheet_id = 'xxx';

# Review recent snapshot operations
curl http://localhost:8900/metrics/prom | grep snapshot_restore
```

**Common Causes**:
- Large snapshot payloads (> 1 MB)
- Database query performance
- Network latency to database
- Deserialization overhead

**Mitigation**:
1. **Immediate**: Cache frequently accessed snapshots
2. **Short-term**: Optimize database queries, add indexes
3. **Long-term**: Implement snapshot compression, chunking

## Artifact Management

### Accessing Validation Artifacts

**Via GitHub Actions UI**:
1. Go to Actions tab
2. Select failed workflow run
3. Scroll to "Artifacts" section
4. Download `phase5-slo-validation-{run_id}`

**Artifact Contents**:
```
phase5-slo-validation-123456/
├── ci-validation-*.json      # Full validation data
├── ci-report-*.md            # Human-readable report
└── server.log                # Server logs during validation
```

### Retention Policy

**Default**: 30 days (configurable in workflow)

```yaml
- name: Upload validation artifacts
  uses: actions/upload-artifact@v4
  with:
    retention-days: 30  # Adjust as needed
```

**Recommendations**:
- **Production**: 90 days (compliance, trend analysis)
- **Staging**: 30 days (debugging, verification)
- **Development**: 7 days (reduce storage costs)

### Long-Term Storage

For regulatory or trend analysis needs, archive artifacts to external storage:

```yaml
- name: Archive to S3
  if: github.event_name == 'schedule'
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
  run: |
    DATE=$(date +%Y-%m-%d)
    aws s3 cp /tmp/ci-validation-*.json \
      s3://metasheet-slo-archives/phase5/$DATE/validation.json
    aws s3 cp /tmp/ci-report-*.md \
      s3://metasheet-slo-archives/phase5/$DATE/report.md
```

## Trend Analysis

### Extracting Historical Data

**Script**: `scripts/phase5-extract-trends.sh` (create this)

```bash
#!/bin/bash
# Extract SLO metrics from archived validation JSONs

ARCHIVE_DIR="${1:-/tmp/archives}"
OUTPUT_CSV="${2:-/tmp/slo-trends.csv}"

echo "date,metric,actual,threshold,status" > "$OUTPUT_CSV"

for json_file in "$ARCHIVE_DIR"/*/validation.json; do
  date=$(echo "$json_file" | grep -oP '\d{4}-\d{2}-\d{2}')

  jq -r --arg date "$date" '.assertions[] |
    [$date, .metric, .actual, .threshold, .status] |
    @csv' "$json_file" >> "$OUTPUT_CSV"
done

echo "Trend data written to $OUTPUT_CSV"
```

**Usage**:
```bash
# Download artifacts from GitHub
gh run download --dir /tmp/archives

# Extract trends
./scripts/phase5-extract-trends.sh /tmp/archives /tmp/trends.csv

# Analyze with Python/R/Excel
python scripts/analyze_trends.py /tmp/trends.csv
```

### Visualization Recommendations

**Grafana Dashboard** (Recommended):

Create dashboard from validation JSONs pushed to time-series database:

```typescript
// Example: Push to Prometheus Pushgateway after validation
const validationData = JSON.parse(fs.readFileSync('/tmp/validation.json'));
const gateway = 'http://pushgateway:9091/metrics/job/phase5_validation';

validationData.assertions.forEach(assertion => {
  const metricName = `phase5_slo_${assertion.metric}_actual`;
  const value = assertion.actual;
  const status = assertion.status === 'pass' ? 1 : 0;

  // Push metric
  fetch(gateway, {
    method: 'POST',
    body: `${metricName} ${value}\nphase5_slo_${assertion.metric}_status ${status}`
  });
});
```

**Google Sheets** (Simple Approach):

1. Download trend CSV
2. Import to Google Sheets
3. Create pivot tables and charts
4. Share with stakeholders

**Example Analysis Queries**:
```sql
-- Weekly SLO compliance rate
SELECT
  DATE_TRUNC('week', date) as week,
  COUNT(CASE WHEN status = 'pass' THEN 1 END) * 100.0 / COUNT(*) as pass_rate
FROM slo_trends
GROUP BY week
ORDER BY week DESC;

-- Metrics with declining trends
SELECT
  metric,
  AVG(CASE WHEN date >= NOW() - INTERVAL '7 days' THEN actual END) as recent_avg,
  AVG(CASE WHEN date < NOW() - INTERVAL '7 days' THEN actual END) as historical_avg
FROM slo_trends
GROUP BY metric
HAVING recent_avg < historical_avg * 0.9;  -- 10% decline
```

## Operational Procedures

### Weekly SLO Review Meeting

**Agenda Template**:

1. **SLO Compliance Summary** (5 min)
   - Overall pass rate: X/Y validations passed
   - Violations by metric
   - Severity distribution

2. **Trend Analysis** (10 min)
   - Improving metrics
   - Declining metrics
   - Threshold adjustments needed

3. **Incident Review** (15 min)
   - Root causes identified
   - Mitigation effectiveness
   - Lessons learned

4. **Action Items** (5 min)
   - Threshold tuning
   - Runbook updates
   - Infrastructure improvements

### Monthly SLO Threshold Review

**Process**:

1. **Data Collection**: Gather 30 days of validation results
2. **Statistical Analysis**: Calculate P50/P95/P99 of actual values
3. **Threshold Evaluation**: Compare actuals vs thresholds
4. **Recommendation**: Tighten, maintain, or loosen thresholds

**Criteria for Threshold Adjustment**:

```yaml
tighten_threshold:
  condition: "P95 of actuals < 80% of threshold"
  example: "P95 plugin_reload = 1.2s, threshold = 2.0s"
  action: "Lower threshold to 1.5s (challenge team)"

maintain_threshold:
  condition: "P95 of actuals between 80-95% of threshold"
  example: "P95 cache_hit_rate = 85%, threshold = 80%"
  action: "Keep current threshold"

loosen_threshold:
  condition: "P95 of actuals > threshold with valid business reason"
  example: "P95 snapshot_restore = 6s, threshold = 5s (large customers)"
  action: "Increase threshold to 7s OR create tiered thresholds"
```

### Threshold Update Procedure

**Step 1**: Create pull request with threshold changes

```bash
# Edit thresholds
vim scripts/phase5-thresholds.json

# Test locally
./scripts/phase5-ci-validate.sh http://localhost:8900/metrics/prom

# Commit
git add scripts/phase5-thresholds.json
git commit -m "ops(slo): adjust plugin reload P95 threshold to 1.5s

Based on 30-day trend analysis showing P95 consistently at 1.2s.
Tightening threshold to drive continued optimization.

Previous: 2.0s
New: 1.5s
Rationale: P95 actuals at 60% of threshold, opportunity to improve"

git push origin ops/adjust-slo-thresholds
```

**Step 2**: Review and approve

- Review historical data
- Verify business justification
- Approve by SRE lead + Engineering Manager

**Step 3**: Monitor after deployment

- Watch next 3 nightly validations
- Be prepared to revert if false positives
- Update team communication

## Advanced Configuration

### Multi-Environment Validation

Run validations against multiple environments:

```yaml
strategy:
  matrix:
    environment:
      - name: production
        url: https://api.metasheet.com
        threshold_multiplier: 1.0

      - name: staging
        url: https://staging.metasheet.com
        threshold_multiplier: 1.2  # More lenient

      - name: canary
        url: https://canary.metasheet.com
        threshold_multiplier: 1.5  # Experimental

steps:
  - name: Run validation - ${{ matrix.environment.name }}
    env:
      METRICS_URL: ${{ matrix.environment.url }}/metrics/prom
    run: |
      # Adjust thresholds dynamically
      jq --arg mult "${{ matrix.environment.threshold_multiplier }}" '
        .thresholds[].threshold = (.thresholds[].threshold * ($mult | tonumber))
      ' scripts/phase5-thresholds.json > /tmp/thresholds-${{ matrix.environment.name }}.json

      # Run validation with adjusted thresholds
      THRESHOLDS_FILE=/tmp/thresholds-${{ matrix.environment.name }}.json \
        ./scripts/phase5-ci-validate.sh "$METRICS_URL"
```

### Custom Validation Schedules

**Business Hours Only**:
```yaml
schedule:
  - cron: '0 9-17 * * 1-5'  # Every hour, 9 AM - 5 PM, weekdays
```

**Weekend Extended Testing**:
```yaml
schedule:
  - cron: '0 */4 * * 1-5'   # Every 4 hours on weekdays
  - cron: '0 */2 * * 0,6'   # Every 2 hours on weekends
```

**Post-Deployment Validation**:
```yaml
on:
  workflow_run:
    workflows: ["Deploy to Production"]
    types: [completed]
```

### Load Testing Integration

Trigger load test before validation to ensure realistic metrics:

```yaml
- name: Run load test
  run: |
    # Start load test
    artillery run tests/load/phase5-baseline.yml &
    LOAD_TEST_PID=$!

    # Wait for steady state
    sleep 300

    # Run validation
    ./scripts/phase5-ci-validate.sh http://localhost:8900/metrics/prom

    # Stop load test
    kill $LOAD_TEST_PID
```

## Troubleshooting

### Validation Workflow Not Triggering

**Check 1**: Verify cron schedule syntax
```bash
# Test cron expression at https://crontab.guru/
# Verify UTC timezone (GitHub Actions uses UTC)
```

**Check 2**: Ensure workflow is on main branch
```bash
git checkout main
git pull
ls -la .github/workflows/phase5-slo-validation.yml
```

**Check 3**: Check GitHub Actions settings
- Repository Settings → Actions → General
- Verify "Allow all actions and reusable workflows" is enabled

### Validation Always Failing

**Check 1**: Review thresholds are realistic
```bash
# Compare actuals vs thresholds
jq '.assertions[] | select(.status == "fail")' /tmp/validation.json
```

**Check 2**: Ensure server has processed traffic
```bash
# Check request count
curl http://localhost:8900/metrics/prom | grep http_requests_total
```

**Check 3**: Verify database migrations applied
```bash
cd packages/core-backend
pnpm db:migrate
```

### Artifacts Not Uploading

**Check 1**: Verify artifact paths exist
```bash
ls -la /tmp/ci-validation-*.json
ls -la /tmp/ci-report-*.md
```

**Check 2**: Check Actions runner permissions
```yaml
permissions:
  contents: read
  actions: write  # Required for artifact upload
```

## References

- **Phase 5 Scripts Documentation**: `scripts/README-PHASE5.md`
- **Metrics Taxonomy**: `docs/observability/metrics-taxonomy.md`
- **SLO Definitions**: `docs/observability/slo-definitions.md`
- **GitHub Actions Docs**: https://docs.github.com/en/actions

---

**Last Updated**: 2025-11-24
**Version**: 1.0.0
**Maintained By**: SRE Team
