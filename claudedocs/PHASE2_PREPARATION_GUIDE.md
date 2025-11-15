# Cache Phase 2 Preparation Guide

**Created**: 2025-11-03
**Status**: Phase 1 Complete, Phase 2 Ready to Begin
**Timeline**: 1-2 weeks of data collection before Phase 3 implementation

## Phase 1 Completion Summary

### Merged PRs
- **PR #346**: Fixed approvals.ts async handlers (merged 2025-11-03)
- **PR #347**: Cache Phase 1 - Observability Foundation (merged 2025-11-03)

### Implementation Delivered (593 lines)
1. **types/cache.ts** (113 lines) - Unified cache interface with Result<T> pattern
2. **core/cache/NullCache.ts** (81 lines) - No-op cache with full observability
3. **core/cache/CacheRegistry.ts** (231 lines) - Singleton cache manager
4. **src/routes/internal.ts** (71 lines) - Internal debugging endpoints
5. **src/metrics/metrics.ts** - 8 new Prometheus metrics
6. **src/index.ts** - Cache initialization integration
7. **.env.example** - Cache configuration documentation

### Validation Results
✅ Server starts correctly with log: `Cache: disabled (impl: NullCache)`
✅ `/internal/cache` endpoint returns proper JSON status
✅ All 8 cache metrics registered in `/metrics/prom`
✅ Development environment fully operational
✅ Zero production impact - NullCache is pure pass-through

## Phase 2: Data Collection & Analysis

### Timeline
**Duration**: 1-2 weeks
**Start Date**: After staging deployment
**End Date**: When sufficient pattern data collected

### Objectives
1. **Collect Real Traffic Metrics** - Identify actual cache access patterns
2. **Analyze Performance Impact** - Measure potential cache benefit areas
3. **Identify Cache Candidates** - Prioritize high-value endpoints for caching
4. **Design Cache Strategy** - Plan Phase 3 implementation based on real data

### Required Setup

#### 1. Local Dev Enablement (FEATURE_OTEL)

快速启用 OpenTelemetry 插件进行本地验证：

```bash
cd metasheet-v2

# 构建插件并启动核心（FEATURE_OTEL=true）
pnpm run plugin:build
npm run dev:otel

# 或使用一键冒烟（构建 + 启动 + 端点探测）
npm run smoke:otel
```

端点验证：

```bash
curl -s http://localhost:8900/metrics | head -n 5
curl -s http://localhost:8900/metrics/otel | head -n 5
```

说明：
- 插件默认注册 `/metrics` 与 `/metrics/otel` 两个端点；推荐以 `/metrics/otel` 作为 Prometheus 抓取路径，避免与现有 JSON 格式指标产生歧义。

#### 2. Deploy to Staging Environment

```bash
# Deploy Phase 1 to staging
cd metasheet-v2

# Ensure staging environment has FEATURE_CACHE=true
export FEATURE_CACHE=true
export NODE_ENV=staging

# Deploy via your CI/CD pipeline or manual deployment
kubectl apply -f k8s/staging/deployment.yaml
# OR
./scripts/deploy-staging.sh
```

<<<<<<< HEAD
#### 2. Configure Monitoring (recommend using /metrics/otel to avoid conflicts)
=======
#### 3. Configure Monitoring (recommend using /metrics/otel to avoid conflicts)
>>>>>>> origin/main

```bash
# Verify Prometheus is scraping metrics
curl http://staging.metasheet.com/metrics/prom | grep cache_
```

Prometheus scrape example:

```yaml
scrape_configs:
  - job_name: 'metasheet-v2'
    static_configs:
      - targets: ['staging.metasheet.com:9464']
    metrics_path: /metrics/otel
```

Prometheus scrape example:

```yaml
scrape_configs:
  - job_name: 'metasheet-v2'
    static_configs:
      - targets: ['staging.metasheet.com:9464']
    metrics_path: /metrics/otel
```

# Expected metrics:
# - cache_hits_total{impl="null",key_pattern="*"}
# - cache_miss_total{impl="null",key_pattern="*"}
# - cache_set_total{impl="null",key_pattern="*"}
# - cache_del_total{impl="null",key_pattern="*"}
# - cache_errors_total{impl="null",error_type="*"}
# - cache_invalidate_total{impl="null",tag="*"}
# - cache_enabled{impl="null"}
# - cache_candidate_requests{route="*",method="*"}
```

#### 4. Set Up Grafana Dashboard

Create dashboard with panels for:

**Panel 1: Cache Operation Volume**
```promql
# Total cache operations by pattern
rate(cache_miss_total[5m])
rate(cache_set_total[5m])
```

**Panel 2: Key Pattern Distribution**
```promql
# Top 10 most frequently accessed key patterns
topk(10, sum(rate(cache_miss_total[5m])) by (key_pattern))
```

**Panel 3: Potential Cache Benefit Heatmap**
```promql
# Endpoints with highest access frequency (best cache candidates)
topk(20, sum(rate(cache_candidate_requests[5m])) by (route, method))
```

**Panel 4: Error Tracking**
```promql
# Cache errors by type
rate(cache_errors_total[5m]) by (error_type)
```

### Data Analysis Tasks

#### Week 1: Pattern Collection

**Daily Checks**:
1. Verify metrics are being collected consistently
2. Monitor for any errors or anomalies
3. Review key pattern distribution

**PromQL Queries to Run**:

```promql
# Query 1: Total cache operations per hour
sum(increase(cache_miss_total[1h]))

# Query 2: Top 5 key patterns by access frequency
topk(5, sum(rate(cache_miss_total[5m])) by (key_pattern))

# Query 3: Candidate routes with >100 requests/minute
sum(rate(cache_candidate_requests[1m])) by (route, method) > 100

# Query 4: Time series of cache operations
sum(rate(cache_miss_total[5m])) by (key_pattern)
```

#### Week 2: Deep Analysis

**Analysis Goals**:
1. **Identify High-Value Targets**
   - Routes with >1000 requests/hour
   - Key patterns with >100 accesses/minute
   - Endpoints with slow response times (>500ms)

2. **Estimate Cache Impact**
   - Calculate potential hit rate for each pattern
   - Estimate memory requirements for cache storage
   - Project performance improvement (response time reduction)

3. **Design Cache Strategy**
   - Determine optimal TTL for each key pattern
   - Plan tag-based invalidation groups
   - Design cache warming strategy for critical paths

**Analysis Spreadsheet Template**:

| Key Pattern | Access Freq | Avg Response Time | Est Hit Rate | TTL | Priority | Memory Est |
|-------------|-------------|-------------------|--------------|-----|----------|------------|
| user:{id}   | 500/min     | 150ms            | 80%          | 5m  | HIGH     | 10MB       |
| perm:{role} | 1000/min    | 200ms            | 90%          | 15m | CRITICAL | 5MB        |
| table:{id}  | 200/min     | 300ms            | 60%          | 2m  | MEDIUM   | 20MB       |

### Expected Outcomes

By end of Phase 2, you should have:

1. ✅ **Comprehensive Metrics Report**
   - 1-2 weeks of production-like traffic data
   - Key pattern distribution analysis
   - Cache candidate prioritization matrix

2. ✅ **Performance Impact Estimates**
   - Expected hit rate per key pattern
   - Projected response time improvements
   - Memory usage projections

3. ✅ **Phase 3 Implementation Plan**
   - Prioritized list of cache candidates
   - TTL strategy for each pattern
   - Tag-based invalidation design
   - Rollout strategy (gradual vs full)

4. ✅ **Grafana Dashboard**
   - Real-time cache metrics visualization
   - Alert rules for cache errors
   - Performance tracking baseline

### Success Criteria

Phase 2 is complete when:
- [ ] At least 7 days of continuous metric collection
- [ ] Identified ≥5 high-value cache candidates
- [ ] Performance estimates validated by traffic analysis
- [ ] Phase 3 implementation plan documented
- [ ] Grafana dashboard operational with alerts configured

## Phase 3 Preview: Redis Implementation

### Overview
Phase 3 will implement actual caching using Redis, based on insights from Phase 2.

### Implementation Approach
1. **Create RedisCache Implementation**
   - Implement Cache interface with real Redis operations
   - Add connection pool management
   - Implement tag-based invalidation

2. **Gradual Rollout**
   - Start with single high-value key pattern
   - Monitor hit rate and performance impact
   - Gradually expand to additional patterns

3. **A/B Testing Framework**
   - Split traffic between cached and non-cached paths
   - Measure performance difference
   - Validate memory and latency improvements

### Feature Flag Strategy
```bash
# Phase 2: Collection only
FEATURE_CACHE=true
CACHE_IMPL=null

# Phase 3: Redis implementation
FEATURE_CACHE=true
CACHE_IMPL=redis
CACHE_REDIS_URL=redis://localhost:6379
CACHE_PATTERN_WHITELIST=user,perm  # Start small

# Phase 3: Full rollout
CACHE_IMPL=redis
CACHE_PATTERN_WHITELIST=*  # All patterns
```

## Next Steps

### Immediate Actions (This Week)
1. Deploy Phase 1 to staging environment
2. Verify metrics collection is working
3. Set up Grafana dashboard
4. Begin monitoring traffic patterns

### Week 2-3 Actions
1. Run daily analysis queries
2. Document access patterns
3. Calculate performance estimates
4. Create Phase 3 implementation plan

### Before Phase 3
1. Review analysis results with team
2. Validate cache strategy decisions
3. Estimate Redis resource requirements
4. Plan gradual rollout schedule

## Resources

### Documentation
- **PR #347 Merge Report**: `claudedocs/PR347_CACHE_PHASE1_MERGE_REPORT.md`
- **Session Complete**: `claudedocs/SESSION_COMPLETE_20251103.md`
- **Architecture Decision**: `claudedocs/CACHE_ARCHITECTURE_DECISION_20251103.md`
- **3-Phase Plan**: `claudedocs/CACHE_3PHASE_IMPLEMENTATION_PLAN.md`

### Monitoring Endpoints
- **Health Check**: `http://localhost:8900/health`
- **Cache Status**: `http://localhost:8900/internal/cache` (dev/staging only)
- **Prometheus Metrics**: `http://localhost:8900/metrics/prom`

### PromQL Queries
See "Data Analysis Tasks" section above for ready-to-use queries.

---

**Ready for Phase 2**: All Phase 1 deliverables complete and validated. Proceed with staging deployment when ready.
