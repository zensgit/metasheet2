/**
 * The endpoint service on scripted dependencies: which failed re-checks may change another user's
 * endpoint, and how a database failure before the user lock is answered.
 */
import { describe, expect, it } from 'vitest'
import { createEndpointsService, isProofGone } from '../../src/notifications/endpoints-service'
import { NotificationHttpError } from '../../src/notifications/notification-errors'
import type { NotificationDbDeps } from '../../src/notifications/notification-tx'
import type { Db, RecipientResolver, ResolveFailureCode } from '../../src/notifications/recipient-resolver'

const EVERY_CODE = [
  'connection_not_found',
  'connection_inactive',
  'provider_not_registered',
  'proof_kind_unavailable',
  'proof_missing',
  'proof_not_linked',
  'proof_wrong_user',
  'proof_ambiguous',
  'proof_account_inactive',
  'proof_changed',
  'proof_assurance_insufficient',
  'address_missing',
  'address_unusable',
  'address_kind_not_derivable',
  'address_bound_on_other_connection',
  'scope_unproven',
  'scope_changed',
  'user_not_active_member',
  'endpoint_not_found',
] as const satisfies readonly ResolveFailureCode[]

// A code added to the resolver but missing above makes this line fail to compile.
const everyCodeIsListed: Exclude<ResolveFailureCode, (typeof EVERY_CODE)[number]> extends never ? true : false = true

describe('which failed re-checks mean the proof is gone', () => {
  it('lists every failure code', () => {
    expect(everyCodeIsListed).toBe(true)
  })

  it('counts a missing, cancelled, foreign, moved or changed proof, and no state that can pass', () => {
    expect(EVERY_CODE.filter((code) => isProofGone(code))).toEqual([
      'proof_missing',
      'proof_not_linked',
      'proof_wrong_user',
      'proof_changed',
      'proof_assurance_insufficient',
      'address_missing',
      'address_unusable',
      'scope_changed',
    ])
  })

  it('does not count a disabled connection, an inactive membership or account, an unknown anchor, or a missing provider or reader', () => {
    for (const code of ['connection_inactive', 'user_not_active_member', 'proof_account_inactive', 'scope_unproven', 'provider_not_registered', 'proof_kind_unavailable'] as const) {
      expect(isProofGone(code), code).toBe(false)
    }
  })
})

const TARGET = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  provider: 'dingtalk',
  addressKind: 'dingtalk_userid',
  proofKind: 'directory_link',
  proofId: '22222222-2222-4222-8222-222222222222',
  proofWitness: 'p',
  addressWitness: 'a',
  tenantAddressWitness: 't',
  boundTenant: 'tenant',
  boundAppScope: 'app',
}

function serviceOver(over: { resolve?: () => Promise<unknown>; query?: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }) {
  const db: Db = { query: over.query ?? (async () => ({ rows: [] })) }
  const deps: NotificationDbDeps = { db, transaction: async (fn) => fn(db) }
  const resolver = {
    resolveForConnection: over.resolve ?? (async () => ({ ok: true, target: TARGET })),
    verifyEndpoint: async () => ({ ok: true, target: TARGET }),
  } as unknown as RecipientResolver
  return createEndpointsService({ ...deps, resolver, audit: async () => undefined })
}

const input = { orgId: 'org-1', userId: 'user-1', connectionId: TARGET.connectionId, proofKind: 'directory_link' as const }
const failure = (code: string) => Object.assign(new Error('driver text'), { code })

describe('a database failure while an endpoint is made, before the user lock is taken', () => {
  it('in the first resolution is answered 503 NOTIFICATION_BUSY for a cancelled statement', async () => {
    const service = serviceOver({ resolve: async () => Promise.reject(failure('57014')) })
    const error = (await service.establish(input).catch((reason: unknown) => reason)) as NotificationHttpError
    expect([error.status, error.code]).toEqual([503, 'NOTIFICATION_BUSY'])
  })

  it('in the holder read is answered 503 NOTIFICATION_BUSY, and a missing table 503 NOTIFICATION_SCHEMA_UNAVAILABLE', async () => {
    for (const [code, expected] of [['57014', 'NOTIFICATION_BUSY'], ['42P01', 'NOTIFICATION_SCHEMA_UNAVAILABLE']] as const) {
      const service = serviceOver({ query: async () => Promise.reject(failure(code)) })
      const error = (await service.establish(input).catch((reason: unknown) => reason)) as NotificationHttpError
      expect([error.status, error.code], code).toEqual([503, expected])
    }
  })
})
