/**
 * Deprovision effect provider witness — the code side (no database).
 *
 * Invariants proved here, each with a recorded fake client that refuses unknown SQL:
 *  - the effects INSERT issued when the provider column is absent is byte-identical to the shape
 *    every earlier ledger writer used; when the column is present the INSERT carries `provider`
 *    on `grant_changed` rows and NULL on every other row;
 *  - the column probe names no table in its statement text, runs once per transaction scope,
 *    and is never keyed on the client;
 *  - a non-default grant provider is refused while the ledger cannot record it;
 *  - the write-mode statement sequence differs from the pre-column sequence by exactly one
 *    read-only probe placed before the first effect INSERT; the preview sequence is unchanged;
 *  - restore and compensation act on the provider the effect row witnesses, NULL read as the
 *    default provider, through one function;
 *  - the migration file carries the `zzzz` prefix and the newest timestamp in the directory;
 *  - the effects INSERT has exactly one writer in production code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))
const mutexMocks = vi.hoisted(() => ({
  lockUsersForAccessGraphWrite: vi.fn(),
}))
const rbacMocks = vi.hoisted(() => ({
  invalidateUserPerms: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: dbMocks.query,
  transaction: dbMocks.transaction,
}))
vi.mock('../../src/directory/access-graph-mutex', () => ({
  lockUsersForAccessGraphWrite: mutexMocks.lockUsersForAccessGraphWrite,
}))
vi.mock('../../src/rbac/service', () => ({
  invalidateUserPerms: rbacMocks.invalidateUserPerms,
}))

import {
  DEPROVISION_EFFECT_PROVIDER_PROBE_SQL,
  LEGACY_DEPROVISION_EFFECT_INSERT_SQL,
  applyDirectoryDeprovisionCandidate,
  probeDeprovisionEffectProviderColumn,
  type ApplyDeprovisionCandidateInput,
} from '../../src/directory/deprovision-ledger'
import {
  compensateSupersededDenyGrant,
  listDeprovisionEffects,
  restoreDeprovisionEvent,
} from '../../src/directory/deprovision-evidence-api'

// The effects INSERT as every ledger writer issued it before the provider column existed. This
// copy is deliberately independent of the production constant so a change to either side is a
// diff, not a tautology.
const FROZEN_LEGACY_INSERT = `INSERT INTO directory_deprovision_effects (
         event_id, local_user_id, org_id, effect_type,
         before_active, after_active, grant_row_created,
         access_generation_at_apply, status
       ) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5, $6, $7, $8, 'applied')`

type Recorded = { sql: string; params: unknown[] | undefined }

function statementShape(sql: string): string {
  if (/^\s*SELECT id FROM users WHERE id = \$1::text\s+FOR UPDATE/.test(sql)) return 'lock_user'
  if (/FROM users candidate_user/.test(sql)) return 'read_state'
  if (/^\s*UPDATE users\s+SET access_generation/.test(sql)) return 'bump_generation'
  if (/^\s*UPDATE user_orgs\s+SET is_active = FALSE/.test(sql)) return 'deactivate_membership'
  if (/^\s*INSERT INTO user_external_auth_grants/.test(sql)) return 'create_deny_row'
  if (/^\s*UPDATE user_external_auth_grants/.test(sql)) return 'flip_grant'
  if (/^\s*UPDATE directory_deprovision_effects\s+SET status = 'superseded'/.test(sql)) return 'supersede_effects'
  if (/^\s*UPDATE directory_deprovision_events\s+SET status = 'superseded'/.test(sql)) return 'supersede_events'
  if (/^\s*INSERT INTO directory_deprovision_events/.test(sql)) return 'insert_event'
  if (/FROM information_schema\.columns/.test(sql)) return 'probe_provider_column'
  if (/^\s*INSERT INTO directory_deprovision_effects \(/.test(sql)) return 'insert_effect'
  throw new Error(`Unhandled SQL in effect-provider fake:\n${sql}`)
}

function writerClient(options: {
  provider: string
  columnPresent: boolean
  grantEnabled?: boolean
  grantRowExists?: boolean
}) {
  const recorded: Recorded[] = []
  const client = {
    recorded,
    query: async (sql: string, params?: unknown[]) => {
      recorded.push({ sql, params })
      switch (statementShape(sql)) {
        case 'lock_user':
          return { rows: [{ id: String(params?.[0]) }] }
        case 'read_state':
          return {
            rows: [{
              activation_status: 'activated',
              is_active: true,
              access_generation: 4,
              linked_at_apply: true,
              org_membership_active: true,
              org_candidacy_clear: true,
              globally_clear: true,
              login_grant_provider: options.provider,
              login_grant_enabled: options.grantEnabled ?? true,
              login_grant_row_exists: options.grantRowExists ?? true,
            }],
          }
        case 'bump_generation':
          return { rows: [{ access_generation: 5 }] }
        case 'deactivate_membership':
          return { rows: [{ user_id: String(params?.[0]) }] }
        case 'create_deny_row':
          return { rows: [] }
        case 'flip_grant':
          return { rows: [{ local_user_id: String(params?.[0]) }] }
        case 'supersede_effects':
        case 'supersede_events':
          return { rows: [] }
        case 'insert_event':
          return { rows: [{ id: '00000000-0000-4000-8000-00000000e0e0' }] }
        case 'probe_provider_column':
          return { rows: [{ present: options.columnPresent }] }
        case 'insert_effect':
          return { rows: [] }
        default:
          throw new Error('unreachable')
      }
    },
  }
  return client
}

const APPLY_INPUT: ApplyDeprovisionCandidateInput = {
  localUserId: 'user-1',
  orgId: 'org-1',
  integrationId: '00000000-0000-4000-8000-000000000001',
  directoryAccountId: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003',
  triggeredBy: 'unit-test',
  policy: 'mark_inactive',
  write: true,
}

const effectInserts = (recorded: Recorded[]) =>
  recorded.filter((entry) => statementShape(entry.sql) === 'insert_effect')
const probes = (recorded: Recorded[]) =>
  recorded.filter((entry) => statementShape(entry.sql) === 'probe_provider_column')

describe('effects INSERT shape under the provider-column probe', () => {
  it('the pre-column INSERT text is byte-identical to the frozen legacy shape', () => {
    expect(LEGACY_DEPROVISION_EFFECT_INSERT_SQL).toBe(FROZEN_LEGACY_INSERT)
  })

  it('column absent: every effect row is written with the legacy text and eight parameters', async () => {
    const client = writerClient({ provider: 'dingtalk', columnPresent: false })
    const result = await applyDirectoryDeprovisionCandidate(client, APPLY_INPUT)
    expect(result.applied).toBe(true)
    const inserts = effectInserts(client.recorded)
    expect(inserts.map((entry) => entry.params?.[3]).sort()).toEqual(
      ['grant_changed', 'membership_changed', 'user_changed'],
    )
    for (const entry of inserts) {
      expect(entry.sql).toBe(FROZEN_LEGACY_INSERT)
      expect(entry.params).toHaveLength(8)
    }
  })

  it('column present: grant_changed carries the provider as $9 and the other rows carry NULL', async () => {
    const client = writerClient({ provider: 'dingtalk', columnPresent: true })
    await applyDirectoryDeprovisionCandidate(client, APPLY_INPUT)
    const inserts = effectInserts(client.recorded)
    expect(inserts).toHaveLength(3)
    for (const entry of inserts) {
      expect(entry.sql).not.toBe(FROZEN_LEGACY_INSERT)
      expect(entry.sql).toMatch(/access_generation_at_apply, status, provider\s*\)/)
      expect(entry.sql).toMatch(/'applied', \$9::text\)$/)
      expect(entry.params).toHaveLength(9)
      const type = entry.params?.[3]
      expect(entry.params?.[8]).toBe(type === 'grant_changed' ? 'dingtalk' : null)
    }
  })

  it('column present: the provider written is the source integration provider (non-default integration provider)', async () => {
    const client = writerClient({ provider: 'wecom', columnPresent: true })
    await applyDirectoryDeprovisionCandidate(client, APPLY_INPUT)
    const grantInsert = effectInserts(client.recorded).find((entry) => entry.params?.[3] === 'grant_changed')
    expect(grantInsert?.params?.[8]).toBe('wecom')
    const flip = client.recorded.find((entry) => statementShape(entry.sql) === 'flip_grant')
    expect(flip?.params).toEqual(['user-1', 'wecom'])
    expect(flip?.sql).toMatch(/provider = \$2::text/)
    expect(flip?.sql).not.toMatch(/'dingtalk'/)
  })

  it('deny-row creation writes the provider parameter, never a literal', async () => {
    const client = writerClient({
      provider: 'wecom',
      columnPresent: true,
      grantEnabled: false,
      grantRowExists: false,
    })
    await applyDirectoryDeprovisionCandidate(client, APPLY_INPUT)
    const creation = client.recorded.find((entry) => statementShape(entry.sql) === 'create_deny_row')
    expect(creation?.params).toEqual(['user-1', 'wecom'])
    expect(creation?.sql).not.toMatch(/'dingtalk'/)
  })

  it('column absent + non-default grant provider: refuses with a typed error and writes no effect row', async () => {
    const client = writerClient({ provider: 'wecom', columnPresent: false })
    await expect(applyDirectoryDeprovisionCandidate(client, APPLY_INPUT)).rejects.toMatchObject({
      code: 'DEPROVISION_EFFECT_PROVIDER_UNSUPPORTED',
    })
    expect(effectInserts(client.recorded)).toHaveLength(0)
    expect(probes(client.recorded)).toHaveLength(1)
  })

  it('the state read joins the integration by id and keys both grant reads on its provider', async () => {
    const client = writerClient({ provider: 'dingtalk', columnPresent: true })
    await applyDirectoryDeprovisionCandidate(client, APPLY_INPUT)
    const state = client.recorded.find((entry) => statementShape(entry.sql) === 'read_state')
    expect(state?.sql).toMatch(/LEFT JOIN directory_integrations source_integration_row\s+ON source_integration_row\.id = \$3::uuid/)
    expect(state?.sql.match(/grant_(?:row|presence)\.provider = source_integration_row\.provider/g)).toHaveLength(2)
    expect(state?.sql).not.toMatch(/'dingtalk'/)
    expect(state?.params).toHaveLength(6)
  })
})

describe('provider-column probe', () => {
  it('names no table in its text and passes table and column as parameters', async () => {
    expect(DEPROVISION_EFFECT_PROVIDER_PROBE_SQL).not.toMatch(/directory_deprovision/)
    expect(DEPROVISION_EFFECT_PROVIDER_PROBE_SQL).toMatch(/table_name = \$1::text/)
    expect(DEPROVISION_EFFECT_PROVIDER_PROBE_SQL).toMatch(/column_name = \$2::text/)
    const recorded: Recorded[] = []
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        recorded.push({ sql, params })
        return { rows: [{ present: false }] }
      },
    }
    expect(await probeDeprovisionEffectProviderColumn(client)).toBe(false)
    expect(recorded).toEqual([
      { sql: DEPROVISION_EFFECT_PROVIDER_PROBE_SQL, params: ['directory_deprovision_effects', 'provider'] },
    ])
  })

  it('a missing or non-boolean answer reads as absent', async () => {
    for (const rows of [[], [{}], [{ present: 'true' }], [{ present: null }]]) {
      const client = { query: async () => ({ rows }) }
      expect(await probeDeprovisionEffectProviderColumn(client)).toBe(false)
    }
    const client = { query: async () => ({ rows: [{ present: true }] }) }
    expect(await probeDeprovisionEffectProviderColumn(client)).toBe(true)
  })

  it('runs once per scope object, again for a new scope on the same client, and every time without a scope', async () => {
    const client = writerClient({ provider: 'dingtalk', columnPresent: true })
    const scope = {}
    await applyDirectoryDeprovisionCandidate(client, { ...APPLY_INPUT, ledgerScope: scope })
    await applyDirectoryDeprovisionCandidate(client, { ...APPLY_INPUT, localUserId: 'user-2', ledgerScope: scope })
    expect(probes(client.recorded)).toHaveLength(1)
    // Same client, new scope: the cache is not keyed on the client.
    await applyDirectoryDeprovisionCandidate(client, { ...APPLY_INPUT, localUserId: 'user-3', ledgerScope: {} })
    expect(probes(client.recorded)).toHaveLength(2)
    // No scope: no cache.
    await applyDirectoryDeprovisionCandidate(client, { ...APPLY_INPUT, localUserId: 'user-4' })
    await applyDirectoryDeprovisionCandidate(client, { ...APPLY_INPUT, localUserId: 'user-5' })
    expect(probes(client.recorded)).toHaveLength(4)
    expect(effectInserts(client.recorded)).toHaveLength(15)
  })

  it('the cached answer is per scope: an absent column stays absent for that scope', async () => {
    const client = writerClient({ provider: 'dingtalk', columnPresent: false })
    const scope = {}
    await applyDirectoryDeprovisionCandidate(client, { ...APPLY_INPUT, ledgerScope: scope })
    await applyDirectoryDeprovisionCandidate(client, { ...APPLY_INPUT, localUserId: 'user-2', ledgerScope: scope })
    expect(probes(client.recorded)).toHaveLength(1)
    for (const entry of effectInserts(client.recorded)) expect(entry.sql).toBe(FROZEN_LEGACY_INSERT)
  })
})

describe('statement sequence', () => {
  const WRITE_SEQUENCE_BEFORE_COLUMN = [
    'lock_user',
    'read_state',
    'bump_generation',
    'deactivate_membership',
    'flip_grant',
    'supersede_effects',
    'supersede_events',
    'insert_event',
    'insert_effect',
    'insert_effect',
    'insert_effect',
  ]

  it('write mode adds exactly one probe immediately before the first effect INSERT', async () => {
    const client = writerClient({ provider: 'dingtalk', columnPresent: true })
    await applyDirectoryDeprovisionCandidate(client, APPLY_INPUT)
    const shapes = client.recorded.map((entry) => statementShape(entry.sql))
    const expected = [...WRITE_SEQUENCE_BEFORE_COLUMN]
    expected.splice(expected.indexOf('insert_effect'), 0, 'probe_provider_column')
    expect(shapes).toEqual(expected)
    expect(shapes.filter((shape) => shape === 'probe_provider_column')).toHaveLength(1)
  })

  it('preview mode issues the state read only, with no probe and no lock', async () => {
    const client = writerClient({ provider: 'dingtalk', columnPresent: true })
    const result = await applyDirectoryDeprovisionCandidate(client, { ...APPLY_INPUT, write: false })
    expect(result.applied).toBe(false)
    expect(result.plan.effects.map((effect) => effect.type).sort()).toEqual(
      ['grant_changed', 'membership_changed', 'user_changed'],
    )
    expect(client.recorded.map((entry) => statementShape(entry.sql))).toEqual(['read_state'])
  })
})

function recordedClient(answer: (shape: string, params: unknown[] | undefined) => { rows: Array<Record<string, unknown>> }) {
  const recorded: Recorded[] = []
  return {
    recorded,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      recorded.push({ sql, params })
      return answer(evidenceShape(sql), params)
    }),
  }
}

function evidenceShape(sql: string): string {
  if (/^\s*SELECT local_user_id\s+FROM directory_deprovision_events/.test(sql)) return 'event_owner'
  if (/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/.test(sql)) return 'lock_user'
  if (/FROM directory_deprovision_events\s+WHERE id = \$1::uuid\s+FOR UPDATE/.test(sql)) return 'read_event'
  if (/FROM directory_deprovision_effects effect\s+WHERE effect\.event_id = \$1::uuid/.test(sql)) return 'read_effects'
  if (/^\s*SELECT enabled\s+FROM user_external_auth_grants/.test(sql)) return 'read_grant'
  if (/^\s*SELECT 1\s+FROM user_external_auth_grants/.test(sql)) return 'residual_grant'
  if (/^\s*SELECT event\.id\s+FROM directory_deprovision_events event/.test(sql)) return 'live_event'
  if (/^\s*SELECT effect\.id\s+FROM directory_deprovision_effects effect/.test(sql)) return 'live_effect'
  if (/^\s*SELECT account\.is_active AS account_active/.test(sql)) return 'read_source'
  if (/FROM user_orgs\s+WHERE user_id = \$1::text\s+AND org_id = \$2::text\s+FOR SHARE/.test(sql)) return 'read_membership'
  if (/^\s*DELETE FROM user_external_auth_grants/.test(sql)) return 'delete_grant'
  if (/^\s*INSERT INTO user_external_auth_grants/.test(sql)) return 'upsert_grant'
  if (/^\s*UPDATE directory_deprovision_effects\s+SET status = 'reversed'/.test(sql)) return 'reverse_effect'
  if (/^\s*UPDATE directory_deprovision_effects\s+SET status = 'compensated'/.test(sql)) return 'compensate_effect'
  if (/^\s*UPDATE users\s+SET access_generation/.test(sql)) return 'bump_generation'
  if (/^\s*UPDATE directory_deprovision_events\s+SET status = 'fully_resolved'/.test(sql)) return 'resolve_event'
  throw new Error(`Unhandled SQL in evidence fake:\n${sql}`)
}

describe('restore acts on the provider the effect row witnesses', () => {
  beforeEach(() => {
    dbMocks.transaction.mockReset()
    rbacMocks.invalidateUserPerms.mockReset()
  })

  async function restoreWith(effect: { provider: string | null; grantRowCreated: boolean }) {
    const client = recordedClient((shape, params) => {
      switch (shape) {
        case 'event_owner':
          return { rows: [{ local_user_id: 'user-1' }] }
        case 'lock_user':
          return { rows: [{ id: 'user-1', email: null, username: null, mobile: null, activation_status: 'activated', is_active: true, access_generation: 3 }] }
        case 'read_event':
          return { rows: [{ id: 'ev-1', integration_id: 'int-1', directory_account_id: 'acct-1', local_user_id: 'user-1', access_generation_at_apply: 3, status: 'applied' }] }
        case 'read_effects':
          return { rows: [{
            id: 'fx-1',
            effect_type: 'grant_changed',
            org_id: null,
            before_active: !effect.grantRowCreated,
            after_active: false,
            grant_row_created: effect.grantRowCreated,
            access_generation_at_apply: 3,
            status: 'applied',
            provider: effect.provider,
          }] }
        case 'read_grant':
          return { rows: [{ enabled: false }] }
        case 'delete_grant':
        case 'upsert_grant':
          return { rows: [{ local_user_id: String(params?.[0]) }] }
        case 'reverse_effect':
          return { rows: [{ id: 'fx-1' }] }
        case 'bump_generation':
          return { rows: [{ access_generation: 4 }] }
        case 'resolve_event':
          return { rows: [{ id: 'ev-1' }] }
        default:
          throw new Error(`unexpected ${shape}`)
      }
    })
    dbMocks.transaction.mockImplementation(async (handler: (c: typeof client) => Promise<unknown>) => handler(client))
    await restoreDeprovisionEvent({ eventId: 'ev-1', mode: 'admin_force', adminUserId: 'admin', confirm: true, note: 'owner approved restore' })
    return client.recorded
  }

  it('a NULL witness (pre-column row) reads and flips the default provider row', async () => {
    const recorded = await restoreWith({ provider: null, grantRowCreated: false })
    const read = recorded.find((entry) => evidenceShape(entry.sql) === 'read_grant')
    const upsert = recorded.find((entry) => evidenceShape(entry.sql) === 'upsert_grant')
    expect(read?.params).toEqual(['user-1', 'dingtalk'])
    expect(upsert?.params?.[4]).toBe('dingtalk')
    expect(upsert?.sql).toMatch(/VALUES \(\$5::text, \$1::text/)
    expect(upsert?.sql).not.toMatch(/'dingtalk'/)
  })

  it('a wecom witness reads and flips the wecom row (non-default integration provider)', async () => {
    const recorded = await restoreWith({ provider: 'wecom', grantRowCreated: false })
    expect(recorded.find((entry) => evidenceShape(entry.sql) === 'read_grant')?.params).toEqual(['user-1', 'wecom'])
    expect(recorded.find((entry) => evidenceShape(entry.sql) === 'upsert_grant')?.params?.[4]).toBe('wecom')
  })

  it('a creation effect deletes the witnessed provider row, NULL read as the default', async () => {
    const asNull = await restoreWith({ provider: null, grantRowCreated: true })
    expect(asNull.find((entry) => evidenceShape(entry.sql) === 'read_grant')?.params).toEqual(['user-1', 'dingtalk'])
    expect(asNull.find((entry) => evidenceShape(entry.sql) === 'delete_grant')?.params).toEqual(['user-1', 'dingtalk'])
    const asWecom = await restoreWith({ provider: 'wecom', grantRowCreated: true })
    expect(asWecom.find((entry) => evidenceShape(entry.sql) === 'delete_grant')?.params).toEqual(['user-1', 'wecom'])
  })

  it('the effects read goes through to_jsonb so a ledger without the column still answers', async () => {
    const recorded = await restoreWith({ provider: null, grantRowCreated: false })
    const read = recorded.find((entry) => evidenceShape(entry.sql) === 'read_effects')
    expect(read?.sql).toMatch(/\(to_jsonb\(effect\) ->> 'provider'\) AS provider/)
    expect(read?.sql).not.toMatch(/effect\.provider/)
  })
})

describe('compensation acts on the provider the creation effect witnesses', () => {
  beforeEach(() => {
    dbMocks.transaction.mockReset()
    mutexMocks.lockUsersForAccessGraphWrite.mockReset()
    rbacMocks.invalidateUserPerms.mockReset()
    mutexMocks.lockUsersForAccessGraphWrite.mockResolvedValue(
      new Map([['user-1', { id: 'user-1', isActive: true, activationStatus: 'activated', accessGeneration: 7 }]]),
    )
  })

  async function compensateWith(options: { provider: string | null; status: 'superseded' | 'compensated'; residual?: boolean }) {
    const client = recordedClient((shape, params) => {
      switch (shape) {
        case 'event_owner':
          return { rows: [{ local_user_id: 'user-1' }] }
        case 'read_event':
          return { rows: [{ id: 'ev-1', org_id: 'org-1', integration_id: 'int-1', directory_account_id: 'acct-1', local_user_id: 'user-1', globally_clear: true, status: 'superseded' }] }
        case 'read_effects':
          return { rows: [{ id: 'fx-1', effect_type: 'grant_changed', grant_row_created: true, status: options.status, provider: options.provider }] }
        case 'residual_grant':
          return { rows: options.residual ? [{ '?column?': 1 }] : [] }
        case 'live_event':
        case 'live_effect':
          return { rows: [] }
        case 'read_source':
          return { rows: [{ account_active: true, integration_status: 'active', link_matches: true }] }
        case 'read_membership':
          return { rows: [{ is_active: true }] }
        case 'delete_grant':
          return { rows: [{ local_user_id: String(params?.[0]) }] }
        case 'compensate_effect':
          return { rows: [{ id: 'fx-1' }] }
        case 'bump_generation':
          return { rows: [{ access_generation: 8 }] }
        default:
          throw new Error(`unexpected ${shape}`)
      }
    })
    dbMocks.transaction.mockImplementation(async (handler: (c: typeof client) => Promise<unknown>) => handler(client))
    const outcome = compensateSupersededDenyGrant({ eventId: 'ev-1', adminUserId: 'admin', confirm: true, note: 'owner approved cleanup' })
    return { outcome, recorded: client.recorded }
  }

  it('DELETE branch: a NULL witness deletes the default provider row', async () => {
    const { outcome, recorded } = await compensateWith({ provider: null, status: 'superseded' })
    await expect(outcome).resolves.toMatchObject({ grantRow: 'deleted', alreadyCompensated: false })
    const del = recorded.find((entry) => evidenceShape(entry.sql) === 'delete_grant')
    expect(del?.params).toEqual(['user-1', 'dingtalk'])
    expect(del?.sql).toMatch(/provider = \$2::text/)
    expect(del?.sql).not.toMatch(/'dingtalk'/)
  })

  it('DELETE branch: a wecom witness deletes the wecom row only (non-default integration provider)', async () => {
    const { outcome, recorded } = await compensateWith({ provider: 'wecom', status: 'superseded' })
    await expect(outcome).resolves.toMatchObject({ grantRow: 'deleted' })
    expect(recorded.find((entry) => evidenceShape(entry.sql) === 'delete_grant')?.params).toEqual(['user-1', 'wecom'])
  })

  it('already-compensated branch: the residual check reads the witnessed provider, NULL as the default', async () => {
    const asNull = await compensateWith({ provider: null, status: 'compensated' })
    await expect(asNull.outcome).resolves.toMatchObject({ alreadyCompensated: true, grantRow: 'already_absent' })
    expect(asNull.recorded.find((entry) => evidenceShape(entry.sql) === 'residual_grant')?.params).toEqual(['user-1', 'dingtalk'])
    const asWecom = await compensateWith({ provider: 'wecom', status: 'compensated', residual: true })
    await expect(asWecom.outcome).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })
    expect(asWecom.recorded.find((entry) => evidenceShape(entry.sql) === 'residual_grant')?.params).toEqual(['user-1', 'wecom'])
  })

  it('the effects read goes through to_jsonb', async () => {
    const { outcome, recorded } = await compensateWith({ provider: null, status: 'superseded' })
    await outcome
    const read = recorded.find((entry) => evidenceShape(entry.sql) === 'read_effects')
    expect(read?.sql).toMatch(/\(to_jsonb\(effect\) ->> 'provider'\) AS provider/)
  })
})

describe('listDeprovisionEffects', () => {
  beforeEach(() => {
    dbMocks.query.mockReset()
  })

  it('reads provider through to_jsonb and resolves login_grant_provider on grant rows only', async () => {
    dbMocks.query.mockResolvedValueOnce({
      rows: [
        { id: 'fx-1', effect_type: 'grant_changed', provider: null },
        { id: 'fx-2', effect_type: 'grant_changed', provider: 'wecom' },
        { id: 'fx-3', effect_type: 'membership_changed', provider: null },
      ],
    })
    const rows = await listDeprovisionEffects('ev-1')
    expect(dbMocks.query.mock.calls[0]?.[0]).toMatch(/\(to_jsonb\(effect\) ->> 'provider'\) AS provider/)
    expect(dbMocks.query.mock.calls[0]?.[1]).toEqual(['ev-1'])
    expect(rows.map((row) => [row.id, row.provider, row.login_grant_provider])).toEqual([
      ['fx-1', null, 'dingtalk'],
      ['fx-2', 'wecom', 'wecom'],
      ['fx-3', null, null],
    ])
  })
})

describe('migration file and effect-writer census', () => {
  const migrationsDir = join(__dirname, '..', '..', 'src', 'db', 'migrations')
  const srcDir = join(__dirname, '..', '..', 'src')

  // The migrations whose objects this one reads or alters: the integrations table, the
  // deprovision ledger and the three later shapes of its effects table. On a fresh database the
  // migrator applies files in name order, so the stamp must sort after every one of them.
  const DEPENDENCY_STAMPS = [
    '20260324150000', // directory_integrations
    '20260724170000', // directory_deprovision_events / _effects
    '20260728100000', // ledger hardening (shared validate / immutable triggers)
    '20260808090000', // effects.grant_row_created
    '20260810100000', // effects compensation status
  ]
  // The newest zzzz stamp present when this stamp was allocated; a lower stamp cannot be new.
  const ALLOCATION_FLOOR = '20261105033000'

  it('the provider migration carries the zzzz prefix, a unique timestamp, and sorts after the migrations it depends on', () => {
    const names = readdirSync(migrationsDir).filter((name) => name.endsWith('.ts'))
    const mine = names.filter((name) => name.endsWith('_deprovision_effect_provider.ts'))
    expect(mine).toHaveLength(1)
    const match = /^zzzz(\d{14})_deprovision_effect_provider\.ts$/.exec(mine[0]!)
    expect(match).not.toBeNull()
    const stamp = match![1]!
    const stamps = names
      .map((name) => /^zzzz(\d{14})_/.exec(name)?.[1])
      .filter((value): value is string => typeof value === 'string')
    expect(stamps.filter((value) => value === stamp)).toHaveLength(1)
    for (const dependency of DEPENDENCY_STAMPS) {
      expect(stamps).toContain(dependency)
      expect(stamp > dependency).toBe(true)
    }
    expect(stamps).toContain(ALLOCATION_FLOOR)
    expect(stamp > ALLOCATION_FLOOR).toBe(true)
  })

  it('the effects INSERT has exactly one production writer, and that writer probes the column', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          if (name === 'migrations' || name === '__tests__') continue
          walk(full)
          continue
        }
        if (!/\.(ts|js|mjs)$/.test(name) || /\.test\./.test(name)) continue
        if (/INSERT INTO directory_deprovision_effects/.test(readFileSync(full, 'utf8'))) {
          offenders.push(full.slice(srcDir.length + 1))
        }
      }
    }
    walk(srcDir)
    expect(offenders).toEqual(['directory/deprovision-ledger.ts'])
    const writer = readFileSync(join(srcDir, 'directory', 'deprovision-ledger.ts'), 'utf8')
    expect(writer).toMatch(/probeDeprovisionEffectProviderColumn\(client, scope\)/)
    expect(writer.match(/INSERT INTO directory_deprovision_effects \(/g)).toHaveLength(2)
  })
})
