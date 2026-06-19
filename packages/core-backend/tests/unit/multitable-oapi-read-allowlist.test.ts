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

  test('ALLOWS: mst_ + GET on the OAPI-1 read routes (records:read + fields:read surface)', () => {
    // records:read
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records', MST)).toBe(true)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records/rec_123', MST)).toBe(true)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records-summary', MST)).toBe(true)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/view', MST)).toBe(true)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/sheets/s1/view-aggregate', MST)).toBe(true)
    // fields:read
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/fields', MST)).toBe(true)
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

  test('DENIES: adjacent/unguarded paths (fail-closed — no over-match = no JWT-skip bypass)', () => {
    // records family
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records/rec_1/history', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/records/rec_1/restore', MST)).toBe(false)
    // /view vs /views (list) and /views/:id/permissions — NOT in scope
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/views', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/views/v1/permissions', MST)).toBe(false)
    // /sheets/:id/view is NOT the guarded /view route; bare /view-aggregate (no /sheets/:id) is not a route
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/sheets/s1/view', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/view-aggregate', MST)).toBe(false)
    // /fields ALLOWED, but its PII/expansion siblings are NOT
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/fields/f1/link-options', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/sheets/s1/person-fields/f1/directory', MST)).toBe(false)
    // misc
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/form-context', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/other/records', MST)).toBe(false)
  })
})
