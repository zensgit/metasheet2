/**
 * Source boundary and closed mapper negatives for the current-application target ceremony.
 * The session value is minted by the existing proof reader. This file does not open a
 * database, a provider, or a network connection.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Request } from 'express'
import { describe, expect, it } from 'vitest'

import { authService } from '../../src/auth/AuthService'
import {
  CURRENT_APP_EVIDENCE_FRESHNESS_SECONDS,
  CURRENT_APP_TARGET_PRODUCER_ID,
  bindProductionTargetCeremony,
  startCurrentAppCeremony,
} from '../../src/auth/admin-grant-target-ceremony'
import { readAuthenticatedSessionContext } from '../../src/auth/security-action-proof'
import type { AuthenticatedSessionContext } from '../../src/auth/security-action-proof'
import {
  ADMIN_GRANT_TARGET_CEREMONY_DOWN_BLOCKED_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_DOWN_ISOLATION_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_DOWN_PREREQUISITE_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_DOWN_REPEATABLE_READ_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_DOWN_REQUIRES_TRANSACTION_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_DOWN_SCHEMA_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_DOWN_SERIALIZABLE_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_UP_BLOCKED_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_UP_ISOLATION_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_UP_PREREQUISITE_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_UP_REPEATABLE_READ_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_UP_REQUIRES_TRANSACTION_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_UP_SCHEMA_CODE,
  ADMIN_GRANT_TARGET_CEREMONY_UP_SERIALIZABLE_CODE,
} from '../../src/db/migrations/zzzz20261117200000_admin_grant_target_ceremony'

const here = dirname(fileURLToPath(import.meta.url))
const ceremonyPath = resolve(here, '../../src/auth/admin-grant-target-ceremony.ts')
const migrationPath = resolve(here, '../../src/db/migrations/zzzz20261117200000_admin_grant_target_ceremony.ts')
const migrationDirectory = resolve(here, '../../src/db/migrations')
const ceremonySource = readFileSync(ceremonyPath, 'utf8')
const migrationSource = readFileSync(migrationPath, 'utf8')

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function sliceFrom(source: string, start: string): string {
  const from = source.indexOf(start)
  expect(from).toBeGreaterThanOrEqual(0)
  return source.slice(from)
}

function genuineContext(): AuthenticatedSessionContext {
  const userId = 'ceremony-boundary-user'
  const token = authService.createToken(
    {
      id: userId,
      email: null,
      name: userId,
      role: 'member',
      permissions: [],
      created_at: new Date(),
      updated_at: new Date(),
    },
    { sid: 'ceremony-boundary-sid' },
  )
  const context = readAuthenticatedSessionContext({
    user: { id: userId },
    headers: { authorization: `Bearer ${token}` },
  } as unknown as Request)
  if (!context) throw new Error('genuine session context was not minted')
  return context
}

function closedReadFailed(value: unknown): void {
  expect(value).toEqual({ success: false, code: 'read_failed' })
  expect(Object.keys(value as object).sort()).toEqual(['code', 'success'])
  expect(Object.getOwnPropertyNames(value).sort()).toEqual(['code', 'success'])
}

describe('current-app ceremony boundary', () => {
  it('keeps production closed and synchronous', () => {
    const result = bindProductionTargetCeremony()
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toEqual({ success: false, code: 'production_unavailable' })
    expect(CURRENT_APP_EVIDENCE_FRESHNESS_SECONDS).toBe(300)
    expect(CURRENT_APP_TARGET_PRODUCER_ID).toBe('current_app_target_ceremony')
  })

  it('imports the actual session alias and the canonical fingerprint leaf', () => {
    expect(ceremonySource).toContain("from './security-action-proof'")
    expect(ceremonySource).toContain('assertAuthenticatedSessionContext')
    expect(ceremonySource).toContain("from './admin-grant-application-material'")
    expect(ceremonySource).toContain('adminGrantApplicationMaterialFingerprint')
    expect(ceremonySource).not.toContain('admin-grant-receiving-reader')
    expect(ceremonySource).not.toContain('session-registry')
    expect(ceremonySource).not.toContain('session-revocation')
    expect(ceremonySource).not.toContain('buildExternalKey')
    expect(ceremonySource).not.toContain('getDingTalkUserDetail')
    expect(ceremonySource).not.toContain('getDingTalkUserInfoByAuthCode')
    expect(ceremonySource).not.toContain('readDingTalkOauthConfig')
    expect(ceremonySource).not.toContain('isCapabilityImplementationAvailable')
    expect(ceremonySource).not.toContain('Number(')
    expect(ceremonySource).not.toContain('parseInt')
    expect(ceremonySource.toLowerCase()).not.toContain('xmin')
    expect(ceremonySource).toContain("nullableText(record, 'providerUnionId')")
    expect(ceremonySource).toContain('rowCount: result.rowCount ?? null')
    expect(ceremonySource).toContain('freshEvidence')
    const mapper = sliceBetween(ceremonySource, 'function mapFailure', 'function hasUnpairedSurrogate')
    expect(mapper).not.toContain('isRefusal(error)')
    expect(mapper).toContain('CurrentAppCeremonyRefusalError')
  })

  it('keeps session SQL inline and does not write grants or sessions', () => {
    expect(ceremonySource).toContain("timestamptz '1970-01-01 00:00:00+00'")
    expect(ceremonySource).toContain('ON CONFLICT (user_id) DO NOTHING')
    expect(ceremonySource).toContain('FOR SHARE')
    expect(ceremonySource).not.toContain('GREATEST')
    expect(ceremonySource).not.toMatch(/INSERT\s+INTO\s+user_sessions/i)
    expect(ceremonySource).not.toMatch(/UPDATE\s+user_sessions/i)
    expect(ceremonySource).not.toMatch(/INSERT\s+INTO\s+user_orgs/i)
    expect(ceremonySource).not.toMatch(/UPDATE\s+user_orgs/i)
    expect(ceremonySource).not.toMatch(/INSERT\s+INTO\s+user_external_identities/i)
    expect(ceremonySource).not.toMatch(/UPDATE\s+user_external_identities/i)
    expect(ceremonySource).toContain("interval '300 seconds'")
    expect(ceremonySource).toContain("interval '5 minutes'")
  })

  it('forwards the stored-app transport options on both web calls', () => {
    const complete = sliceFrom(ceremonySource, 'export async function completeCurrentAppCeremony')
    expect(complete).toContain('logUpstreamMessage: false as const')
    expect(complete).toContain('exchangeCodeForUserAccessToken(request.code,')
    expect(complete).toContain('fetchDingTalkCurrentUser(exchanged.accessToken, options)')
    expect(complete).not.toContain('getDingTalkUserDetail')
  })

  it('keeps lineage on S1 evidence columns only', () => {
    const lineage = sliceBetween(migrationSource, 'function lineageBody', 'async function createCeremony')
    expect(lineage).not.toContain('access_generation')
    expect(lineage).not.toContain('privilege_witness')
    expect(migrationSource).toContain("const PRODUCER_ID = 'current_app_target_ceremony'")
    expect(lineage).toContain('${PRODUCER_ID}')
    expect(lineage).toContain("''self_authenticated''")
    expect(lineage).toContain('admin grant target ceremony lineage refused')
  })

  it('uses generated dollar tags, a truncate guard, and no cascade', () => {
    expect(migrationSource).toContain('function dollarTag')
    expect(migrationSource).toContain("dollarTag(guard, 'agr_t2_guard')")
    expect(migrationSource).toContain("dollarTag(lineage, 'agr_t2_lineage')")
    expect(migrationSource).not.toContain('$fn$')
    expect(migrationSource).not.toContain('$agr_s3$')
    expect(migrationSource).not.toMatch(/AS \$\$[^${]/)
    expect(migrationSource).toContain('BEFORE TRUNCATE')
    expect(migrationSource).toContain('FOR EACH STATEMENT')
    expect(migrationSource).not.toContain('CASCADE')
    expect(migrationSource.toLowerCase()).not.toContain('xmin')
    const names = readdirSync(migrationDirectory).filter((name) => name.startsWith('zzzz20261117200000'))
    expect(names).toEqual(['zzzz20261117200000_admin_grant_target_ceremony.ts'])
    const order = [
      'zzzz20261117183000_admin_grant_receiving_invalidation.ts',
      'zzzz20261117193000_admin_grant_receiving_first_birth.ts',
      'zzzz20261117200000_admin_grant_target_ceremony.ts',
    ]
    expect([...order].sort()).toEqual(order)
  })

  it('gives every isolation refusal its own code', () => {
    const codes = [
      ADMIN_GRANT_TARGET_CEREMONY_UP_REQUIRES_TRANSACTION_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_DOWN_REQUIRES_TRANSACTION_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_UP_REPEATABLE_READ_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_DOWN_REPEATABLE_READ_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_UP_SERIALIZABLE_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_DOWN_SERIALIZABLE_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_UP_ISOLATION_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_DOWN_ISOLATION_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_UP_BLOCKED_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_DOWN_BLOCKED_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_UP_PREREQUISITE_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_DOWN_PREREQUISITE_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_UP_SCHEMA_CODE,
      ADMIN_GRANT_TARGET_CEREMONY_DOWN_SCHEMA_CODE,
    ]
    expect(new Set(codes).size).toBe(codes.length)
    expect(ADMIN_GRANT_TARGET_CEREMONY_UP_REQUIRES_TRANSACTION_CODE).not.toBe(
      ADMIN_GRANT_TARGET_CEREMONY_UP_REPEATABLE_READ_CODE,
    )
    expect(ADMIN_GRANT_TARGET_CEREMONY_UP_REPEATABLE_READ_CODE).not.toBe(
      ADMIN_GRANT_TARGET_CEREMONY_UP_SERIALIZABLE_CODE,
    )
  })

  it('closes a structurally thrown refusal from a genuine session', async () => {
    const queries: string[] = []
    let fetches = 0
    const thrown = {
      success: false as const,
      code: 'caller-controlled-text',
      extra: 'caller-controlled-detail',
    }
    const body = new Proxy({}, {
      ownKeys() {
        throw thrown
      },
    })
    const result = await startCurrentAppCeremony(
      {
        query: async () => {
          queries.push('query')
          return { rows: [], rowCount: 0 }
        },
      },
      body,
      genuineContext(),
      {
        fetchFn: (async () => {
          fetches += 1
          throw new Error('provider')
        }) as typeof fetch,
      },
    )
    closedReadFailed(result)
    expect(queries).toEqual([])
    expect(fetches).toBe(0)
    expect(result).not.toHaveProperty('extra')
  })

  it('closes a reflection-throwing exception from a genuine session', async () => {
    const queries: string[] = []
    let fetches = 0
    const hostile = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('reflection')
      },
      get() {
        throw new Error('reflection')
      },
    })
    const body = new Proxy({}, {
      ownKeys() {
        throw hostile
      },
    })
    const result = await startCurrentAppCeremony(
      {
        query: async () => {
          queries.push('query')
          return { rows: [], rowCount: 0 }
        },
      },
      body,
      genuineContext(),
      {
        fetchFn: (async () => {
          fetches += 1
          throw new Error('provider')
        }) as typeof fetch,
      },
    )
    closedReadFailed(result)
    expect(queries).toEqual([])
    expect(fetches).toBe(0)
  })
})
