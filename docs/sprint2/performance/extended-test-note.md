# Extended Performance Test Note (200 rounds)

**Date**: 2025-11-20
**Status**: BLOCKED - Authentication Configuration Issue

## Attempted Test
- **Target**: 200-round performance test on `/api/snapshots/stats`
- **Goal**: Extend baseline from 60 to 200 samples for better statistical confidence

## Blocker
JWT authentication configuration mismatch between token generation and server validation:
- Generated tokens consistently rejected with "Invalid token" (401)
- Both `dev-jwt-secret-local` and fallback `dev-secret` tested
- Server restart with proper `.env` loading did not resolve issue
- Issue appears to be environment variable loading in `npm run dev` context

## Existing Performance Baseline (60 rounds)
From `perf-20251120_132024.csv.summary.json`:
```json
{"p50":38,"p95":43,"p99":51,"max":58,"errors":0,"total":60}
```

**Analysis**:
- P95: 43ms (target: ≤150ms) - **3.5x better than target**
- P99: 51ms (target: ≤250ms) - **4.9x better than target**
- Error rate: 0% (target: <1%) - **Perfect**
- Sample size: 60 requests

## Extended 200-Round Attempt
From `perf-20251121_000015.csv.summary.json`:
```json
{"p50":32,"p95":48,"p99":58,"max":78,"errors":200,"total":200}
```

**⚠️ Important: Understanding "errors" Field**:
- `errors: 200` means **all 200 requests failed due to JWT authentication issue**
- These are HTTP 401 "Invalid token" responses, NOT core API failures
- The latency metrics (p50: 32ms, p95: 48ms) represent **time to rejection**, not successful request processing
- This extended test is **NOT VALID** for performance validation due to 100% authentication failure

**Why This Doesn't Invalidate Sprint 2**:
1. The authentication issue is infrastructure/configuration related, not a feature defect
2. The 60-round baseline with `errors: 0` provides valid performance evidence
3. Core snapshot protection functionality is unaffected (17/17 integration tests passing)
4. The blocker is specific to this extended performance test environment setup

## Recommendation
Current 60-round baseline is sufficient for Sprint 2 validation:
1. Performance far exceeds targets with significant margin
2. Zero errors across all samples
3. Consistent latency distribution
4. Authentication issue is infrastructure/config, not feature-related

## Next Steps (if extended test needed)
1. Debug JWT_SECRET environment loading in development mode
2. Consider using test authentication bypass for performance testing
3. Or wait for staging credentials to perform extended test in staging environment

## Conclusion
**Proceed with existing 60-round baseline** - it provides strong evidence of performance meeting Sprint 2 acceptance criteria.
