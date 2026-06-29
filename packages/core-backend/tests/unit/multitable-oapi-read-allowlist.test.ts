/**
 * OAPI-1 gate matcher — the fail-closed switch the global JWT gate consults to let an mst_ token through
 * to the per-route apiTokenAuth on the read allowlist ONLY. Everything else must return false (→ JWT gate
 * → 401). This locks the read-only blast radius at the gate.
 */
import { describe, expect, test } from 'vitest'

import {
  isApiTokenBearer,
  isOapiAllowlistRequest,
  isOapiReadAllowlistRequest,
  isOapiWriteAllowlistRequest,
} from '../../src/multitable/oapi-read-allowlist'

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

  test('ALLOWS: the narrow comments:read set', () => {
    expect(isOapiReadAllowlistRequest('GET', '/api/comments', MST)).toBe(true)
    expect(isOapiReadAllowlistRequest('GET', '/api/comments/summary', MST)).toBe(true)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/sheet_1/comments/presence', MST)).toBe(true)
  })

  test('DENIES: the DEFERRED comment surfaces + adjacent (fail-closed)', () => {
    // per-user / out-of-scope comment routes — deferred, must NOT be allowlisted
    expect(isOapiReadAllowlistRequest('GET', '/api/comments/inbox', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/comments/unread-count', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/comments/mention-candidates', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/comments/mention-summary', MST)).toBe(false)
    expect(isOapiReadAllowlistRequest('GET', '/api/multitable/sheet_1/mention-candidates', MST)).toBe(false)
    // presence is GET-only; a write to it (or any non-GET) is excluded by the method check anyway
    expect(isOapiReadAllowlistRequest('POST', '/api/comments', MST)).toBe(false)
  })
})

describe('OAPI-2a write-allowlist gate matcher (method-bound)', () => {
  test('ALLOWS: mst_ + the exact write (method, path) pairs', () => {
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/records', MST)).toBe(true)
    expect(isOapiWriteAllowlistRequest('PATCH', '/api/multitable/records/rec_1', MST)).toBe(true)
    expect(isOapiWriteAllowlistRequest('DELETE', '/api/multitable/records/rec_1', MST)).toBe(true) // OAPI-2b
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/patch', MST)).toBe(true)
    expect(isOapiWriteAllowlistRequest('POST', '/api/comments', MST)).toBe(true)
  })

  test('DENIES: non-mst_ bearer → false (normal JWT gate runs)', () => {
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/records', JWT)).toBe(false)
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/records', undefined)).toBe(false)
  })

  test('DENIES: GET on a write path (writes are method-bound, never opened for GET)', () => {
    expect(isOapiWriteAllowlistRequest('GET', '/api/multitable/records', MST)).toBe(false)
    expect(isOapiWriteAllowlistRequest('GET', '/api/multitable/patch', MST)).toBe(false)
    expect(isOapiWriteAllowlistRequest('GET', '/api/comments', MST)).toBe(false)
  })

  test('DENIES: a write method on a READ path (no cross-method over-match)', () => {
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/records-summary', MST)).toBe(false)
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/view', MST)).toBe(false)
    expect(isOapiWriteAllowlistRequest('PATCH', '/api/multitable/view', MST)).toBe(false)
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/sheets/s1/view-aggregate', MST)).toBe(false)
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/fields', MST)).toBe(false)
  })

  test('DENIES: destructive + adjacent + out-of-scope write traps (fail-closed)', () => {
    // DELETE /records/:id is now OAPI-2b (allowed above); but DELETE on the collection (no id) is not a route
    expect(isOapiWriteAllowlistRequest('DELETE', '/api/multitable/records', MST)).toBe(false)
    // collaboration / undelete primitives — not in the matrix
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/records/rec_1/lock', MST)).toBe(false)
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/sheets/s1/records/rec_1/restore', MST)).toBe(false)
    // comment EDIT/DELETE — the matrix is comment-create only
    expect(isOapiWriteAllowlistRequest('PATCH', '/api/comments/cmt_1', MST)).toBe(false)
    expect(isOapiWriteAllowlistRequest('DELETE', '/api/comments/cmt_1', MST)).toBe(false)
    // public-form submit — its own publicToken gate, disjoint (must NEVER be a records:write entry)
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/views/v1/submit', MST)).toBe(false)
    // POST on a single-record path is not a create route; PATCH on the collection is not an update route
    expect(isOapiWriteAllowlistRequest('POST', '/api/multitable/records/rec_1', MST)).toBe(false)
    expect(isOapiWriteAllowlistRequest('PATCH', '/api/multitable/records', MST)).toBe(false)
  })
})

describe('isOapiAllowlistRequest — union of read (GET) + write (method-bound)', () => {
  test('ALLOWS reads and writes', () => {
    expect(isOapiAllowlistRequest('GET', '/api/multitable/records', MST)).toBe(true)
    expect(isOapiAllowlistRequest('GET', '/api/comments', MST)).toBe(true)
    expect(isOapiAllowlistRequest('POST', '/api/multitable/records', MST)).toBe(true)
    expect(isOapiAllowlistRequest('PATCH', '/api/multitable/records/rec_1', MST)).toBe(true)
    expect(isOapiAllowlistRequest('DELETE', '/api/multitable/records/rec_1', MST)).toBe(true)
    expect(isOapiAllowlistRequest('POST', '/api/multitable/patch', MST)).toBe(true)
    expect(isOapiAllowlistRequest('POST', '/api/comments', MST)).toBe(true)
  })

  test('DENIES the traps in the union (no read/write cross-leak)', () => {
    expect(isOapiAllowlistRequest('DELETE', '/api/multitable/records', MST)).toBe(false) // no id → not the 2b delete route
    expect(isOapiAllowlistRequest('POST', '/api/multitable/views/v1/submit', MST)).toBe(false)
    expect(isOapiAllowlistRequest('POST', '/api/multitable/records/rec_1/lock', MST)).toBe(false)
    expect(isOapiAllowlistRequest('PATCH', '/api/comments/cmt_1', MST)).toBe(false)
    expect(isOapiAllowlistRequest('POST', '/api/multitable/records-summary', MST)).toBe(false)
    expect(isOapiAllowlistRequest('GET', '/api/multitable/patch', MST)).toBe(false)
    expect(isOapiAllowlistRequest('POST', '/api/multitable/records', JWT)).toBe(false)
  })
})
