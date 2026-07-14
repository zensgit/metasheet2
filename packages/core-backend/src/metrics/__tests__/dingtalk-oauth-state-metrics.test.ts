/**
 * Real registry + real /metrics/prom endpoint test for the DingTalk OAuth state-operations
 * metrics producer (metasheet_dingtalk_oauth_state_operations_total /
 * metasheet_dingtalk_oauth_state_fallback_total).
 *
 * This intentionally does NOT mock prom-client, express, or the metrics registry — it boots
 * a real express app, mounts the real installMetrics() route, and scrapes it with supertest,
 * because scripts/ops/dingtalk-oauth-stability-check.sh gates its verdict on a real scrape of
 * a real deployed instance ever containing a SAMPLE line (not '# HELP'/'# TYPE') that
 * startswith('metasheet_dingtalk_oauth_state_operations_total'). A test against mocked metrics
 * text would not prove the producer is wired end-to-end.
 *
 * Test order is deliberate and load-bearing: the presence-at-zero assertion MUST run before
 * any OAuth state operation executes in this file, because the counters are module-level
 * singletons and vitest runs `it` blocks within a file sequentially by default.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { installMetrics } from '../metrics'
import {
  __resetDingTalkOAuthStateStoreForTests,
  DingTalkOAuthStateStoreUnavailableError,
  generateState,
  validateState,
} from '../../auth/dingtalk-oauth'

const OPERATIONS_METRIC = 'metasheet_dingtalk_oauth_state_operations_total'
const FALLBACK_METRIC = 'metasheet_dingtalk_oauth_state_fallback_total'

// Mirrors the check script's `matching()` helper (scripts/ops/dingtalk-oauth-stability-check.sh):
// a plain `line.startswith(prefix)` over the raw scrape text — '# HELP' / '# TYPE' comment
// lines never match a metric-name prefix, only SAMPLE lines do.
function sampleLinesStartingWith(body: string, prefix: string): string[] {
  return body.split('\n').filter((line) => line.startsWith(prefix))
}

function buildApp() {
  const app = express()
  installMetrics(app)
  return app
}

describe('DingTalk OAuth state metrics (real registry + real endpoint)', () => {
  beforeEach(() => {
    delete process.env.METRICS_SCRAPE_TOKEN
    delete process.env.REDIS_URL
    delete process.env.REDIS_HOST
    delete process.env.DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE
  })

  it('reports the operations metric as present at zero before any OAuth state operation runs', async () => {
    const res = await request(buildApp()).get('/metrics/prom')

    expect(res.status).toBe(200)

    const operationLines = sampleLinesStartingWith(res.text, OPERATIONS_METRIC)
    // 2 operations (write/validate) x 2 results (ok/error) = 4 zero-initialized combinations.
    expect(operationLines).toHaveLength(4)

    const writeOk = operationLines.find((line) =>
      line.startsWith(`${OPERATIONS_METRIC}{operation="write",result="ok"}`))
    const writeError = operationLines.find((line) =>
      line.startsWith(`${OPERATIONS_METRIC}{operation="write",result="error"}`))
    const validateOk = operationLines.find((line) =>
      line.startsWith(`${OPERATIONS_METRIC}{operation="validate",result="ok"}`))
    const validateError = operationLines.find((line) =>
      line.startsWith(`${OPERATIONS_METRIC}{operation="validate",result="error"}`))

    for (const line of [writeOk, writeError, validateOk, validateError]) {
      expect(line).toBeDefined()
      // The SAMPLE line's trailing token is the value; zero-init means it must read exactly 0,
      // proving liveness (the producer emitted the series) rather than traffic.
      expect(line?.trim().endsWith(' 0')).toBe(true)
    }

    const fallbackLines = sampleLinesStartingWith(res.text, FALLBACK_METRIC)
    expect(fallbackLines).toHaveLength(2)
    for (const line of fallbackLines) {
      expect(line.trim().endsWith(' 0')).toBe(true)
    }
  })

  it('increments write/ok, fallback{write}, and validate/ok after a real memory-path OAuth round trip', async () => {
    // No REDIS_URL/REDIS_HOST configured in this test env, so getRedisStateClient() short-
    // circuits to null and both calls take the in-process memory fallback path for real —
    // this is not a mocked Redis outage, it is simply no shared store being configured.
    await __resetDingTalkOAuthStateStoreForTests()

    const state = await generateState({ redirectPath: '/attendance' })
    const validation = await validateState(state)
    expect(validation).toEqual({ valid: true, redirectPath: '/attendance' })

    const res = await request(buildApp()).get('/metrics/prom')
    expect(res.status).toBe(200)

    const operationLines = sampleLinesStartingWith(res.text, OPERATIONS_METRIC)
    const writeOkLine = operationLines.find((line) =>
      line.startsWith(`${OPERATIONS_METRIC}{operation="write",result="ok"}`))
    const validateOkLine = operationLines.find((line) =>
      line.startsWith(`${OPERATIONS_METRIC}{operation="validate",result="ok"}`))
    expect(writeOkLine).toBeDefined()
    expect(validateOkLine).toBeDefined()
    expect(Number(writeOkLine?.trim().split(' ').pop())).toBeGreaterThanOrEqual(1)
    expect(Number(validateOkLine?.trim().split(' ').pop())).toBeGreaterThanOrEqual(1)

    const fallbackLines = sampleLinesStartingWith(res.text, FALLBACK_METRIC)
    const fallbackWriteLine = fallbackLines.find((line) =>
      line.startsWith(`${FALLBACK_METRIC}{operation="write"}`))
    expect(fallbackWriteLine).toBeDefined()
    expect(Number(fallbackWriteLine?.trim().split(' ').pop())).toBeGreaterThanOrEqual(1)
    // The validate side consulted memory for the same reason (no shared store) — the
    // degradation signal must cover both directions, not just the write.
    const fallbackValidateLine = fallbackLines.find((line) =>
      line.startsWith(`${FALLBACK_METRIC}{operation="validate"}`))
    expect(fallbackValidateLine).toBeDefined()
    expect(Number(fallbackValidateLine?.trim().split(' ').pop())).toBeGreaterThanOrEqual(1)

    // Negative control: the scraped metrics body must never contain the raw state UUID —
    // labels are the fixed 'operation'/'result' enums only, never state values or user data.
    expect(res.text).not.toContain(state)
  })

  it('increments write/error and validate/error when a shared state store is required but unavailable', async () => {
    // Shared-required mode with no Redis configured: generateState() must fail closed
    // (throw) and validateState() must refuse — and BOTH must leave an error sample
    // behind, so a real multi-replica store outage is visible in /metrics/prom instead
    // of only in logs. These are the branches the stability gate cannot exercise live.
    await __resetDingTalkOAuthStateStoreForTests()
    process.env.DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE = 'true'

    await expect(generateState()).rejects.toThrow(DingTalkOAuthStateStoreUnavailableError)
    const refusal = await validateState('not-a-real-state')
    expect(refusal.valid).toBe(false)

    const res = await request(buildApp()).get('/metrics/prom')
    expect(res.status).toBe(200)

    const operationLines = sampleLinesStartingWith(res.text, OPERATIONS_METRIC)
    const writeErrorLine = operationLines.find((line) =>
      line.startsWith(`${OPERATIONS_METRIC}{operation="write",result="error"}`))
    const validateErrorLine = operationLines.find((line) =>
      line.startsWith(`${OPERATIONS_METRIC}{operation="validate",result="error"}`))
    expect(Number(writeErrorLine?.trim().split(' ').pop())).toBeGreaterThanOrEqual(1)
    expect(Number(validateErrorLine?.trim().split(' ').pop())).toBeGreaterThanOrEqual(1)
  })
})
