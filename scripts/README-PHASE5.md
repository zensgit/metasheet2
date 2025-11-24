# Phase 5 SLO Validation & Metrics Automation

Comprehensive documentation for Phase 5 production baseline metrics validation system.

## Overview

The Phase 5 automation system provides automated SLO (Service Level Objective) validation for the metasheet backend. It validates 8 core metrics against defined thresholds, generates human-readable reports, and integrates with CI/CD pipelines.

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Phase 5 Validation Flow                   │
└─────────────────────────────────────────────────────────────┘

  Prometheus                                        Validation
  /metrics/prom                                     Results
      │                                                 │
      ├──────────────────────────────────────────────┐ │
      │                                              │ │
      ▼                                              ▼ ▼
┌──────────────┐      ┌────────────────────┐   ┌─────────────┐
│  Percentile  │      │  Full Orchestrator │   │  CI Wrapper │
│   Parser     │─────▶│  phase5-full-      │──▶│  phase5-ci- │
│  (Node/TS)   │      │  validate.sh       │   │  validate.sh│
└──────────────┘      └────────────────────┘   └─────────────┘
                              │                       │
                              ▼                       │
                      ┌────────────────┐             │
                      │ Report Gen     │             │
                      │ phase5-        │             │
                      │ generate-      │             │
                      │ report.sh      │             │
                      └────────────────┘             │
                              │                       │
                              ▼                       ▼
                      ┌─────────────┐         ┌──────────────┐
                      │ Markdown    │         │  CI Exit     │
                      │ Report      │         │  Codes       │
                      └─────────────┘         │  0: Pass     │
                                              │  1: Fail     │
                                              │  2: Error    │
                                              └──────────────┘

Configuration:
└── phase5-thresholds.json (SLO definitions)
```

## Core Components

### 1. phase5-thresholds.json

**Purpose**: Central configuration defining all SLO thresholds

**Location**: `scripts/phase5-thresholds.json`

**Metrics Defined**:
- **Latency Metrics**: Plugin reload P95/P99, Snapshot restore P95/P99
- **Availability Metrics**: Cache hit rate, HTTP success rate, Error rate
- **Resource Metrics**: Memory RSS
- **Fallback Metrics**: Effective fallback ratio

**Structure**:
```json
{
  "thresholds": [
    {
      "metric": "plugin_reload_latency_p95",
      "threshold": 2.0,
      "unit": "seconds",
      "type": "upper_bound",
      "prometheus_metric": "metasheet_plugin_reload_duration_seconds"
    }
  ],
  "validation_rules": {
    "fallback_taxonomy": {
      "valid_reasons": ["http_timeout", "http_error", "message_timeout",
                        "message_error", "cache_miss", "circuit_breaker"]
    }
  }
}
```

### 2. phase5-metrics-percentiles.ts

**Purpose**: Parse Prometheus histogram metrics and calculate P50/P95/P99 percentiles

**Location**: `scripts/phase5-metrics-percentiles.ts`

**Usage**:
```bash
# Basic usage
npx tsx scripts/phase5-metrics-percentiles.ts <metrics-url> <output-json>

# Example
npx tsx scripts/phase5-metrics-percentiles.ts \
  http://localhost:8900/metrics/prom \
  /tmp/percentiles.json
```

**Algorithm**: Linear interpolation between histogram buckets for accurate percentile calculation

**Output Format**:
```json
{
  "timestamp": "2025-11-24T14:25:09.624Z",
  "metrics": {
    "metasheet_plugin_reload_duration_seconds": {
      "p50": 0.05,
      "p95": 0.095,
      "p99": 0.099,
      "count": 1,
      "sum": 0.000616291,
      "mean": 0.000616291
    }
  }
}
```

**Requirements**:
- Node.js 20+
- Dependencies: None (uses native fetch)
- Execution: `npx tsx` (installed via pnpm)

### 3. phase5-full-validate.sh

**Purpose**: Main orchestrator that integrates all validation components

**Location**: `scripts/phase5-full-validate.sh`

**Usage**:
```bash
# Basic usage
./scripts/phase5-full-validate.sh <metrics-url> <output-json>

# Example
./scripts/phase5-full-validate.sh \
  http://localhost:8900/metrics/prom \
  /tmp/validation.json
```

**Operations**:
1. Fetch Prometheus metrics
2. Extract counter/gauge metrics
3. Calculate percentiles using Node script
4. Validate fallback taxonomy
5. Calculate effective fallback
6. Assert all SLO thresholds
7. Generate validation JSON

**Exit Codes**:
- `0`: All checks passed
- `1`: One or more SLO violations
- `2`: Script error

**Output Schema**:
```json
{
  "timestamp": "2025-11-24T14:25:35Z",
  "metrics_url": "http://localhost:8900/metrics/prom",
  "percentiles": { /* P50/P95/P99 for histograms */ },
  "counters": {
    "cache_hit_rate": 75.5,
    "http_success_rate": 99.2,
    "error_rate": 0.3,
    "memory_rss_mb": 245.8,
    "fallback_by_reason": {
      "http_timeout": 5,
      "cache_miss": 120
    }
  },
  "validation": {
    "fallback_taxonomy_valid": true
  },
  "assertions": [
    {
      "metric": "plugin_reload_latency_p95",
      "actual": 0.095,
      "threshold": 2.0,
      "unit": "seconds",
      "type": "upper_bound",
      "comparison": "≤",
      "status": "pass"
    }
  ],
  "summary": {
    "total_checks": 8,
    "passed": 6,
    "failed": 2,
    "overall_status": "fail"
  }
}
```

**Environment Variables**:
- `COUNT_CACHE_MISS_AS_FALLBACK`: Set to `false` (default) to exclude cache misses from effective fallback count

### 4. phase5-generate-report.sh

**Purpose**: Convert validation JSON to human-readable Markdown report

**Location**: `scripts/phase5-generate-report.sh`

**Usage**:
```bash
# Basic usage
./scripts/phase5-generate-report.sh <validation-json> <output-markdown>

# Example
./scripts/phase5-generate-report.sh \
  /tmp/validation.json \
  /tmp/report.md
```

**Output Sections**:
1. **Summary**: Overall status, pass/fail counts
2. **SLO Assertions Table**: All metrics with actual vs threshold
3. **Detailed Metrics**: Percentile latencies, counter metrics
4. **Fallback Breakdown**: Counts by reason
5. **Validation Status**: Taxonomy validation results
6. **Configuration**: Environment settings

**Example Output**:
```markdown
# Phase 5 SLO Validation Report

**Status**: ✅ **PASS**
**Timestamp**: 2025-11-24T14:25:35Z

## Summary
| Metric | Value |
|--------|-------|
| Total Checks | 8 |
| Passed | ✅ 8 |
| Failed | ❌ 0 |

## SLO Assertions
| Metric | Actual | Threshold | Comparison | Status |
|--------|--------|-----------|------------|--------|
| plugin_reload_latency_p95 | 0.095s | 2.0s | ≤ | ✅ pass |
| cache_hit_rate | 82% | 80.0% | ≥ | ✅ pass |
```

### 5. phase5-ci-validate.sh

**Purpose**: CI wrapper that provides proper exit codes for CI/CD integration

**Location**: `scripts/phase5-ci-validate.sh`

**Usage**:
```bash
# Basic usage
./scripts/phase5-ci-validate.sh <metrics-url>

# Example (in CI)
./scripts/phase5-ci-validate.sh http://127.0.0.1:8900/metrics/prom
```

**CI Integration Features**:
- Proper exit codes (0/1/2)
- Violation extraction and display
- Artifact generation in `/tmp`
- Integration with phase5-full-validate.sh and phase5-generate-report.sh

**Exit Codes**:
- `0`: All SLO checks passed
- `1`: One or more SLO violations detected
- `2`: Script error (missing dependencies, connection failure, etc.)

**Output Artifacts**:
```bash
/tmp/ci-validation-$$.json    # Full validation JSON
/tmp/ci-report-$$.md          # Markdown report
```

**Example CI Usage**:
```yaml
- name: Run Phase 5 SLO Validation
  id: slo_validation
  env:
    METRICS_URL: http://127.0.0.1:8900/metrics/prom
  run: |
    ./scripts/phase5-ci-validate.sh "$METRICS_URL"
  continue-on-error: true

- name: Fail if SLO validation failed
  if: steps.slo_validation.outcome == 'failure'
  run: |
    echo "❌ SLO validation failed"
    exit 1
```

## GitHub Actions Integration

### Workflow Example

**Location**: `.github/workflows/phase5-slo-validation.yml.example`

**Usage**: Copy to `.github/workflows/phase5-slo-validation.yml` and customize

**Triggers**:
- Push to main branch
- Pull requests
- Manual dispatch
- Nightly at 2 AM UTC (`cron: '0 2 * * *'`)

**Features**:
1. **PostgreSQL Service**: Automated database setup
2. **Server Lifecycle**: Start, health check, stop
3. **Database Setup**: Migrations and RBAC seeding
4. **Validation Execution**: Phase 5 CI validation
5. **Artifact Upload**: JSON, Markdown, server logs (30-day retention)
6. **PR Comments**: Automatic result posting
7. **Issue Creation**: Auto-create issues on nightly failures

**Key Sections**:
```yaml
services:
  postgres:
    image: quay.io/enterprisedb/postgresql:15
    env:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
      POSTGRES_DB: metasheet

steps:
  - name: Run Phase 5 SLO Validation
    run: ./scripts/phase5-ci-validate.sh "$METRICS_URL"

  - name: Upload validation artifacts
    uses: actions/upload-artifact@v4
    with:
      name: phase5-slo-validation-${{ github.run_id }}
      path: |
        /tmp/ci-validation-*.json
        /tmp/ci-report-*.md
        /tmp/server.log
      retention-days: 30

  - name: Comment PR with results
    if: github.event_name == 'pull_request'
    uses: actions/github-script@v7
    # Posts Markdown report as PR comment
```

## Local Development Usage

### Complete Workflow

```bash
# 1. Start backend server
cd packages/core-backend
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/metasheet \
JWT_SECRET=test-secret \
npm run dev

# 2. Wait for server health
curl http://localhost:8900/health

# 3. Run full validation (recommended)
./scripts/phase5-full-validate.sh \
  http://localhost:8900/metrics/prom \
  /tmp/validation.json

# 4. Generate report
./scripts/phase5-generate-report.sh \
  /tmp/validation.json \
  /tmp/report.md

# 5. View report
cat /tmp/report.md

# Alternative: Use CI wrapper (simpler)
./scripts/phase5-ci-validate.sh http://localhost:8900/metrics/prom
```

### Individual Component Testing

**Test Percentile Parser**:
```bash
npx tsx scripts/phase5-metrics-percentiles.ts \
  http://localhost:8900/metrics/prom \
  /tmp/percentiles.json

cat /tmp/percentiles.json | jq '.'
```

**Test Orchestrator**:
```bash
./scripts/phase5-full-validate.sh \
  http://localhost:8900/metrics/prom \
  /tmp/validation.json

# Check results
jq '.summary' /tmp/validation.json
jq '.assertions[] | select(.status == "fail")' /tmp/validation.json
```

**Test Report Generator**:
```bash
./scripts/phase5-generate-report.sh \
  /tmp/validation.json \
  /tmp/report.md

head -50 /tmp/report.md
```

## Troubleshooting

### Common Issues

#### 1. Server Connection Failures

**Symptom**: `curl: (7) Failed to connect to localhost port 8900`

**Solutions**:
- Verify server is running: `ps aux | grep node`
- Check health endpoint: `curl http://localhost:8900/health`
- Review server logs for startup errors
- Verify DATABASE_URL is correct

#### 2. Missing Metrics

**Symptom**: `No histogram data found for metasheet_plugin_reload_duration_seconds`

**Solutions**:
- Ensure server has processed requests (metrics are created on first use)
- Trigger plugin reload: Make API calls that load plugins
- Verify Prometheus endpoint: `curl http://localhost:8900/metrics/prom | grep plugin_reload`
- Check if metrics are instrumented in code

#### 3. Zero Values for Rate Metrics

**Symptom**: `cache_hit_rate: 0%, http_success_rate: 0%`

**Expected Behavior**: On fresh server start with no traffic, rate metrics will be 0%

**Solutions**:
- Generate traffic by making API requests
- For cache_hit_rate: Trigger operations that use cache (metadata reads)
- For http_success_rate: Make business API calls (not just /health)
- Verify with: `curl http://localhost:8900/metrics/prom | grep -E "cache|http_requests"`

#### 4. Fallback Taxonomy Validation Failures

**Symptom**: `Invalid fallback reason found: unknown_reason`

**Solutions**:
- Check that all fallback events use valid taxonomy reasons
- Valid reasons: `http_timeout`, `http_error`, `message_timeout`, `message_error`, `cache_miss`, `circuit_breaker`
- Search codebase: `grep -r "metasheet_fallback_total" packages/core-backend/src`
- Ensure all `fallbackCounter.inc({ reason: '...' })` use valid reasons

#### 5. macOS grep Compatibility Warning

**Symptom**: `grep: invalid option -- P`

**Impact**: Non-critical - validation still completes successfully

**Solutions**:
- Ignore warning (does not affect results)
- Future fix: Replace `grep -oP` with `grep -oE` or `awk`

#### 6. ES Module Issues

**Symptom**: `ReferenceError: require is not defined in ES module scope`

**Status**: Fixed in current version

**Historical Fix**: Removed `if (require.main === module)` pattern, replaced with direct `main()` call

#### 7. jq Command Not Found

**Symptom**: `jq: command not found`

**Solutions**:
```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq

# Verify
jq --version
```

#### 8. bc Command Not Found

**Symptom**: `bc: command not found`

**Solutions**:
```bash
# macOS (usually pre-installed)
brew install bc

# Ubuntu/Debian
sudo apt-get install bc

# Verify
bc --version
```

### Debug Mode

Enable verbose logging for troubleshooting:

```bash
# Set debug mode
set -x

# Run validation with full trace
bash -x ./scripts/phase5-full-validate.sh \
  http://localhost:8900/metrics/prom \
  /tmp/validation.json
```

### Validation JSON Inspection

```bash
# View summary
jq '.summary' /tmp/validation.json

# View failed assertions
jq '.assertions[] | select(.status == "fail")' /tmp/validation.json

# View all metrics
jq '.counters' /tmp/validation.json

# View percentiles
jq '.percentiles' /tmp/validation.json

# Check taxonomy validation
jq '.validation.fallback_taxonomy_valid' /tmp/validation.json
```

## Metrics Reference

### 1. Plugin Reload Latency (Histogram)

**Prometheus Metric**: `metasheet_plugin_reload_duration_seconds`

**SLO Thresholds**:
- P95 ≤ 2.0 seconds
- P99 ≤ 5.0 seconds

**Interpretation**:
- Measures time to reload plugin code
- High values indicate slow plugin initialization
- Check plugin code complexity, file I/O, dependencies

### 2. Snapshot Restore Latency (Histogram)

**Prometheus Metric**: `metasheet_snapshot_restore_duration_seconds`

**SLO Thresholds**:
- P95 ≤ 5.0 seconds
- P99 ≤ 8.0 seconds

**Interpretation**:
- Measures time to restore spreadsheet state
- High values indicate large snapshots or slow deserialization
- Check snapshot size, compression, database query performance

### 3. Cache Hit Rate (Counter-derived)

**Prometheus Metrics**: `cache_hits_total`, `cache_misses_total`

**Calculation**: `cache_hits_total / (cache_hits_total + cache_misses_total) * 100`

**SLO Threshold**: ≥ 80%

**Interpretation**:
- Measures effectiveness of caching layer
- Low values indicate cache isn't effective or working
- Check cache configuration, TTL settings, eviction policies

### 4. HTTP Success Rate (Counter-derived)

**Prometheus Metric**: `http_requests_total` (by status code)

**Calculation**: `(2xx + 3xx) / total_requests * 100`

**SLO Threshold**: ≥ 98%

**Interpretation**:
- Measures API reliability
- Low values indicate high error rates
- Check error logs, client issues, backend stability

### 5. Error Rate (Counter-derived)

**Prometheus Metric**: `http_requests_total` (by status code)

**Calculation**: `(4xx + 5xx) / total_requests * 100`

**SLO Threshold**: ≤ 1%

**Interpretation**:
- Inverse of success rate
- High 4xx: Client errors (authentication, validation)
- High 5xx: Server errors (crashes, timeouts)

### 6. Memory RSS (Gauge)

**Prometheus Metric**: `process_resident_memory_bytes`

**Calculation**: `process_resident_memory_bytes / 1024 / 1024` MB

**SLO Threshold**: ≤ 500 MB

**Interpretation**:
- Measures process memory usage
- High values indicate memory leaks or large data structures
- Monitor over time for growth patterns

### 7. Fallback Effective Ratio (Counter-derived)

**Prometheus Metric**: `metasheet_fallback_total` (by reason)

**Calculation**: `effective_fallback / raw_fallback` where:
- `effective_fallback = raw_fallback - cache_miss` (when `COUNT_CACHE_MISS_AS_FALLBACK=false`)
- `effective_fallback = raw_fallback` (when `COUNT_CACHE_MISS_AS_FALLBACK=true`)

**SLO Threshold**: ≤ 0.6

**Interpretation**:
- Measures proportion of "real" degradation events
- Excludes cold cache misses from degradation count
- High values indicate system instability or resource issues

**Taxonomy**: All fallback events must use one of:
- `http_timeout`: HTTP request exceeded timeout
- `http_error`: HTTP request returned error status
- `message_timeout`: Message processing exceeded timeout
- `message_error`: Message processing failed with error
- `cache_miss`: Cache lookup missed (may be excluded from effective count)
- `circuit_breaker`: Circuit breaker opened due to failures

## Best Practices

### 1. Regular Validation Schedule

- **Development**: Run before committing changes affecting core paths
- **CI/CD**: Run on every PR and main branch push
- **Nightly**: Run scheduled validation to catch drift
- **Production**: Consider read-only metrics export for monitoring

### 2. Traffic Generation for Testing

Generate realistic traffic before validation:

```bash
# Example: Trigger plugin operations
curl -X POST http://localhost:8900/api/plugin/reload \
  -H "Authorization: Bearer $TOKEN"

# Example: Trigger cache operations
for i in {1..100}; do
  curl http://localhost:8900/api/metadata/$i
done

# Example: Mix of success and error requests
curl http://localhost:8900/api/valid-endpoint   # 200
curl http://localhost:8900/api/invalid-endpoint # 404
```

### 3. Threshold Tuning

Start with loose thresholds and tighten based on real data:

```json
{
  "metric": "plugin_reload_latency_p95",
  "threshold": 2.0,  // Start here
  "observed": 0.095,  // Actual P95 from testing
  "tuned": 0.5       // Tighter threshold after confidence
}
```

### 4. Artifact Retention

Keep validation artifacts for trend analysis:

```bash
# Save with timestamps
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
cp /tmp/validation.json /tmp/validation-$TIMESTAMP.json
cp /tmp/report.md /tmp/report-$TIMESTAMP.md

# Analyze trends
jq '.summary.failed' /tmp/validation-*.json
```

### 5. Integration with Monitoring

Export validation results to monitoring systems:

```bash
# Example: Push to time-series database
./scripts/phase5-ci-validate.sh http://localhost:8900/metrics/prom
if [ $? -eq 0 ]; then
  curl -X POST http://monitoring/api/v1/slo/phase5/pass
else
  curl -X POST http://monitoring/api/v1/slo/phase5/fail
fi
```

## Future Enhancements

### Planned Improvements

1. **Memory Histogram Support**: Calculate P95 memory usage from histogram instead of gauge
2. **Multi-Service Validation**: Support validating multiple backend instances
3. **Historical Comparison**: Compare current run against baseline or previous runs
4. **Grafana Dashboard**: Auto-generate Grafana dashboard from thresholds.json
5. **Alert Manager Integration**: Automatic alert configuration generation
6. **Performance Regression Detection**: Flag significant degradation vs. baseline
7. **Custom Metrics Support**: Plugin system for domain-specific metrics

### Extensibility

Add custom metrics by:

1. **Define in thresholds.json**:
```json
{
  "metric": "custom_operation_latency_p99",
  "threshold": 3.0,
  "unit": "seconds",
  "type": "upper_bound",
  "prometheus_metric": "custom_operation_duration_seconds"
}
```

2. **Instrument in backend**:
```typescript
const customHistogram = new Histogram({
  name: 'custom_operation_duration_seconds',
  help: 'Custom operation latency',
  buckets: [0.1, 0.5, 1, 2, 5, 10]
});
```

3. **Re-run validation** - automatically included

## Support and Maintenance

### Maintainers

Phase 5 automation system developed as part of Production Baseline initiative.

### Related Documentation

- **Phase 5 Metrics Taxonomy**: See `docs/observability/metrics-taxonomy.md`
- **SLO Definitions**: See `docs/observability/slo-definitions.md`
- **Backend Instrumentation**: See `packages/core-backend/docs/metrics.md`
- **Prometheus Setup**: See `docs/deployment/prometheus.md`

### Version History

- **v1.0.0** (2025-11-24): Initial release
  - 8 core metrics
  - Histogram percentile support
  - Fallback taxonomy validation
  - CI/CD integration
  - GitHub Actions workflow

### Dependencies

**Required**:
- Bash 4.0+
- Node.js 20+
- jq 1.6+
- bc (standard Unix calculator)
- curl

**Optional**:
- GitHub Actions (for CI integration)
- PostgreSQL (for backend testing)

---

**Last Updated**: 2025-11-24
**Version**: 1.0.0
**Status**: Production Ready
