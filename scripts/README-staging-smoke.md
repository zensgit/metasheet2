# Staging Latency Smoke Test

## Overview

`staging-latency-smoke.sh` is a quick health check script designed to monitor critical endpoint latencies in the staging environment. It tests 5 key endpoints with multiple samples and provides clear pass/fail status based on Sprint 2 performance targets.

## Features

- **Multi-endpoint Testing**: Tests 5 critical endpoints (health, snapshots, stats, rules, plugins)
- **Statistical Analysis**: Calculates min/max/avg latency for each endpoint
- **Color-coded Output**: Visual health indicators (✅/⚠️/🔴)
- **Performance Thresholds**:
  - ⚠️  Warning: >150ms (Sprint 2 P95 target)
  - 🔴 Critical: >250ms (Sprint 2 P99 target)
- **Error Detection**: Tracks and reports failed requests
- **Exit Codes**: 0 (healthy), 1 (warning/critical), 2 (failed endpoints)

## Usage

### Basic Usage
```bash
./scripts/staging-latency-smoke.sh <JWT_TOKEN> <BASE_URL>
```

### Examples

**Test Staging Environment:**
```bash
# With staging credentials
./scripts/staging-latency-smoke.sh "eyJhbGc..." https://staging.metasheet.com
```

**Test Local Development:**
```bash
# Generate JWT token
LOCAL_JWT=$(node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({id:'ops',roles:['admin']},'dev-jwt-secret-local',{expiresIn:'1h'}))")

# Run smoke test
./scripts/staging-latency-smoke.sh "$LOCAL_JWT" http://localhost:8900
```

**In CI/CD Pipeline:**
```bash
# After deployment, verify health
./scripts/staging-latency-smoke.sh "$STAGING_JWT" "$STAGING_URL" || {
  echo "Staging health check failed!"
  exit 1
}
```

## Output Example

```
╔════════════════════════════════════════════════════════════╗
║      Sprint 2 Staging Latency Smoke Test                  ║
╚════════════════════════════════════════════════════════════╝

Base URL: https://staging.metasheet.com
Samples: 5 per endpoint
Thresholds: ⚠️  >150ms | 🔴 >250ms

Testing endpoints...

Testing health... ..... ✅ avg: 12ms (min: 10ms, max: 15ms)
Testing snapshots_list... ..... ✅ avg: 45ms (min: 40ms, max: 52ms)
Testing snapshots_stats... ..... ✅ avg: 38ms (min: 35ms, max: 42ms)
Testing rules_list... ..... ✅ avg: 55ms (min: 50ms, max: 60ms)
Testing plugins... ..... ✅ avg: 20ms (min: 18ms, max: 23ms)

╔════════════════════════════════════════════════════════════╗
║                    Test Results                            ║
╚════════════════════════════════════════════════════════════╝

Endpoint             Min      Max      Avg   Status Errors
────────────────────────────────────────────────────────────────
health                10ms     15ms     12ms   ✅ OK   0/5
snapshots_list        40ms     52ms     45ms   ✅ OK   0/5
snapshots_stats       35ms     42ms     38ms   ✅ OK   0/5
rules_list            50ms     60ms     55ms   ✅ OK   0/5
plugins               18ms     23ms     20ms   ✅ OK   0/5

Overall Average Latency: 34ms

╔════════════════════════════════════════════════════════════╗
║                    Health Summary                          ║
╚════════════════════════════════════════════════════════════╝

✅ HEALTHY: All endpoints responding within acceptable thresholds

Endpoint Status:
  ✅ Healthy: 5
  ⚠️  Warning: 0
  🔴 Critical: 0
  ❌ Failed: 0

Performance Targets:
  Sprint 2 P95 Target: ≤150ms
  Sprint 2 P99 Target: ≤250ms
  Current Avg: 34ms (PASS)

═══════════════════════════════════════════════════════════
Test completed at 2025-11-21 09:30:00
```

## Tested Endpoints

| Endpoint | Path | Auth Required | Purpose |
|----------|------|---------------|---------|
| `health` | `/health` | No | Basic server health check |
| `snapshots_list` | `/api/snapshots` | Yes | Snapshot listing API |
| `snapshots_stats` | `/api/snapstats` | Yes | Snapshot statistics (key performance endpoint) |
| `rules_list` | `/api/v2/admin/protection-rules` | Yes | Protection rules management |
| `plugins` | `/api/plugins` | Yes | Plugin system status |

## Performance Thresholds

Based on Sprint 2 validation targets:

| Threshold | Latency | Status | Action |
|-----------|---------|--------|--------|
| **Healthy** | <150ms | ✅ | No action needed |
| **Warning** | 150-250ms | ⚠️  | Monitor closely, investigate if persistent |
| **Critical** | >250ms | 🔴 | Immediate investigation required |
| **Failed** | Request error | ❌ | Endpoint unavailable or authentication failed |

## Exit Codes

- `0`: All endpoints healthy (<150ms average)
- `1`: One or more endpoints in warning (>150ms) or critical (>250ms) state
- `2`: One or more endpoints completely failed (all requests errored)

## Integration with Monitoring

### Prometheus Integration
```bash
# Export metrics to file for Prometheus consumption
./scripts/staging-latency-smoke.sh "$JWT" "$URL" > /var/metrics/staging_health.txt
```

### Cron Job (Continuous Monitoring)
```bash
# Check staging health every 5 minutes
*/5 * * * * /path/to/staging-latency-smoke.sh "$JWT" "$URL" || \
  echo "Staging health degraded" | mail -s "Alert: Staging Health" ops@example.com
```

### Kubernetes Liveness Probe
```yaml
livenessProbe:
  exec:
    command:
    - /scripts/staging-latency-smoke.sh
    - "$JWT_TOKEN"
    - "http://localhost:8900"
  initialDelaySeconds: 30
  periodSeconds: 60
  timeoutSeconds: 30
  failureThreshold: 3
```

## Troubleshooting

### All Endpoints Failed
**Symptoms**: All requests return 999ms (error indicator)
**Causes**:
- Base URL incorrect or unreachable
- Network connectivity issues
- Server not running

**Resolution**:
1. Verify BASE_URL: `curl $BASE_URL/health`
2. Check network: `ping <hostname>`
3. Check server logs

### 401 Unauthorized Errors
**Symptoms**: Protected endpoints fail, health passes
**Causes**:
- JWT token expired or invalid
- Wrong JWT_SECRET used for token generation
- Missing Authorization header

**Resolution**:
1. Regenerate JWT token with correct secret
2. Verify token expiration: `jwt decode <token>`
3. Check server JWT_SECRET matches token generation

### High Latency (>150ms)
**Symptoms**: Endpoints respond but exceed thresholds
**Causes**:
- Database query inefficiency
- Network latency (especially for remote staging)
- Server resource constraints

**Resolution**:
1. Check database indexes: `\d+ snapshots`, `\d+ protection_rules`
2. Review server metrics: CPU, memory, disk I/O
3. Analyze slow queries: Prometheus metrics or database logs

## Customization

### Adjust Thresholds
Edit the script configuration:
```bash
THRESHOLD_WARNING=150  # ms (default: Sprint 2 P95 target)
THRESHOLD_CRITICAL=250 # ms (default: Sprint 2 P99 target)
```

### Change Sample Count
```bash
SAMPLES=5  # default: 5 samples per endpoint
```

### Add More Endpoints
```bash
declare -A ENDPOINTS=(
  ["health"]="/health"
  ["custom_endpoint"]="/api/custom"
  # Add more...
)
```

## Best Practices

1. **Run Before Deployments**: Verify staging health before promoting to production
2. **Continuous Monitoring**: Schedule regular smoke tests (every 5-15 minutes)
3. **Alert on Failures**: Integrate with alerting systems (PagerDuty, Slack, email)
4. **Compare Trends**: Save results to track latency trends over time
5. **Post-Deployment**: Run immediately after deployment to catch regressions early

## Related Scripts

- `verify-sprint2-staging.sh`: Comprehensive Sprint 2 validation suite (60-90 min)
- `performance-baseline-test.sh`: Extended performance testing (30-200 rounds)
- `staging-latency-smoke.sh`: **Quick health check (30 seconds)** ← You are here

## Sprint 2 Context

This script was created as part of Sprint 2 Snapshot Protection System validation work. It provides a quick alternative to the full `verify-sprint2-staging.sh` validation suite, suitable for:

- **Quick Health Checks**: 30 seconds vs 60-90 minutes
- **Continuous Monitoring**: Can run frequently without heavy resource usage
- **Post-Deployment Verification**: Immediate feedback on deployment success
- **Incident Response**: Fast triage during production incidents

For comprehensive validation including all 9 API endpoints, 4 rule effects, and full evidence collection, use `verify-sprint2-staging.sh` instead.

---

**Created**: 2025-11-21 (Sprint 2 Day 1)
**Purpose**: Quick staging health monitoring for Sprint 2 validation
**Maintainer**: Sprint 2 Validation Automation
