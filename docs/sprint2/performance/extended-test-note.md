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
