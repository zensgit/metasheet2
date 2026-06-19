/**
 * OAPI-1 gate matcher — the fail-closed switch the global JWT gate consults to let an mst_ token through
 * to the per-route apiTokenAuth on the read allowlist ONLY. Everything else must return false (→ JWT gate
 * → 401). This locks the read-only blast radius at the gate.
 */
import { describe, expect, test } from 'vitest'

import { isApiTokenBearer, isOapiReadAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'

const MST = 'Bearer mst_abc123'
const JWT = 'Bearer eyJhbGciOi.x.y'

describe('OAPI-1 read-allowlist gate matcher', () => {
  test('isApiTokenBearer: only mst_ bearers', () => {
    expect(isApiTokenBearer(MST)).toBe(true)
    expect(isApiTokenBearer(JWT)).toBe(false)
    expect(isApiTokenBearer('mst_abc')).toBe(false) // missing "Bearer "
    expect(isApiTokenBearer(undefined)).toBe(false)
  })

  test('ALLOWS: mst_ + GET on the records read routes', () => {
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records', MST)).toBe(true)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records/rec_123', MST)).toBe(true)
  })

  test('DENIES: non-mst_ bearer (session/JWT) → false (normal JWT gate runs)', () => {
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records', JWT)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records', undefined)).toBe(false)
  })

  test('DENIES: non-GET methods (read-only)', () => {
    expect(isOapiReadAllowlistRequest('POST', '/api/multitable/records', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('PATCH', '/api/multitable/records/rec_1', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('DELETE', '/api/multitable/records/rec_1', MST)).toBe(false)
  })

  test('DENIES: paths outside the OAPI-1 records read routes (fail-closed)', () => {
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records-summary', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records/rec_1/history', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records/rec_1/restore', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/sheets/s1/view', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/fields', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/form-context', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/other/records', MST)).toBe(false)
  })
})
