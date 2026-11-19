/**
 * Unrun strict-login store and migration source checks.
 * These do not open PostgreSQL and do not qualify the migration.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { adminGrantCommandKey } from '../../src/auth/admin-grant-proof-storage'
import {
  commandKeyFor,
  grantIdFor,
  grantIdsFor,
  parseStrictSessionContext,
  readConnectionLoginScope,
  readCurrentConnectionLoginScope,
  readStrictLoginInstallation,
  revokeForUserInScope,
  type StrictLoginGrantCaller,
  STRICT_LOGIN_GRANT_ID_DOMAIN,
  STRICT_LOGIN_GRANT_REPLAY_CONSTRAINTS,
  StrictLoginGrantError,
} from '../../src/auth/strict-login-grant-store'
import {
  STRICT_LOGIN_GRANT_FUNCTIONS,
  STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX,
  STRICT_LOGIN_GRANT_PREREQUISITES,
  STRICT_LOGIN_GRANT_SESSION_CHECKS,
  STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN,
  STRICT_LOGIN_GRANT_TABLES,
  STRICT_LOGIN_GRANT_TRIGGERS,
} from '../../src/db/migrations/zzzz20261118120000_strict_login_grant_scope'

const here = dirname(fileURLToPath(import.meta.url))
const storeSource = readFileSync(join(here, '../../src/auth/strict-login-grant-store.ts'), 'utf8')
const bundleSource = readFileSync(join(here, '../../src/auth/strict-login-grant-bundle.ts'), 'utf8')
const migrationSource = readFileSync(join(here, '../../src/db/migrations/zzzz20261118120000_strict_login_grant_scope.ts'), 'utf8')

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = end.length === 0 ? source.length : source.indexOf(end, from + start.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function order(source: string, parts: readonly string[]): void {
  let cursor = 0
  for (const part of parts) {
    const found = source.indexOf(part, cursor)
    expect(found).toBeGreaterThanOrEqual(cursor)
    cursor = found + part.length
  }
}

function sessionContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accessGeneration: '3',
    applicationRevision: '2',
    assurance: 'self_authenticated',
    bindingRevision: '1',
    capRev: '4',
    connectionId: '11111111-1111-4111-8111-111111111111',
    evidenceId: 'evidence-1',
    grantId: `slg.${'ab'.repeat(32)}`,
    identityId: '22222222-2222-4222-8222-222222222222',
    orgId: 'org-1',
    policyRevision: 1,
    provider: 'dingtalk',
    scopeAsserted: false,
    subjectAppScope: 'scope-1',
    subjectKey: 'subject-1',
    v: 1,
    ...overrides,
  }
}

describe('strict login grant pure helpers', () => {
  it('builds a stable grant id from the exported domain', () => {
    const commandKey = 'cd'.repeat(32)
    const first = grantIdFor(commandKey, 1, 'user-a')
    const digest = createHash('sha256')
      .update(STRICT_LOGIN_GRANT_ID_DOMAIN, 'utf8')
      .update(JSON.stringify([commandKey, 1, 'user-a']), 'utf8')
      .digest('hex')
    expect(first).toBe(`slg.${digest}`)
    expect(grantIdFor(commandKey, 1, 'user-a')).toBe(first)
  })

  it('refuses unsorted, duplicate, and empty grant user ids', () => {
    const commandKey = 'cd'.repeat(32)
    expect(grantIdsFor(commandKey, ['user-a', 'user-b'])).toEqual([
      { ordinal: 1, userId: 'user-a', grantId: grantIdFor(commandKey, 1, 'user-a') },
      { ordinal: 2, userId: 'user-b', grantId: grantIdFor(commandKey, 2, 'user-b') },
    ])
    expect(() => grantIdsFor(commandKey, ['user-b', 'user-a'])).toThrow(StrictLoginGrantError)
    expect(() => grantIdsFor(commandKey, ['user-a', 'user-a'])).toThrow(StrictLoginGrantError)
    expect(() => grantIdsFor(commandKey, [])).toThrow(StrictLoginGrantError)
  })

  it('delegates the command key and freezes a 16-key session context', () => {
    expect(commandKeyFor('actor-1', 'org-1', 'command-1')).toBe(adminGrantCommandKey('actor-1', 'org-1', 'command-1'))
    const parsed = parseStrictSessionContext(sessionContext())
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.keys(parsed).sort()).toHaveLength(16)
    expect(() => parseStrictSessionContext(sessionContext({ extra: true }))).toThrow(StrictLoginGrantError)
    expect(() => parseStrictSessionContext(sessionContext({ v: 2 }))).toThrow(StrictLoginGrantError)
    expect(() => parseStrictSessionContext(sessionContext({ evidenceId: 'bad\u0000id' }))).toThrow(StrictLoginGrantError)
  })

  it('keeps the error free of a production flag and excludes the live slot from replay', () => {
    const error = new StrictLoginGrantError('STRICT_LOGIN_GRANT_INPUT_REFUSED')
    expect('productionAvailable' in error).toBe(false)
    expect(STRICT_LOGIN_GRANT_REPLAY_CONSTRAINTS).toHaveLength(4)
    expect(STRICT_LOGIN_GRANT_REPLAY_CONSTRAINTS).not.toContain(STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX)
  })
})

describe('strict login grant source census', () => {
  it('keeps the proof service in the statically bound cold bundle writer', () => {
    expect(bundleSource).toContain("import { createAdminGrantProofService } from './admin-grant-proof'")
    expect(bundleSource).not.toContain('import(')
    expect(storeSource).not.toContain("from './admin-grant-proof'")
    expect(storeSource).not.toContain("import('./admin-grant-proof')")
    expect(storeSource).not.toContain('insertConsumedGrantBundle')
    expect(storeSource).not.toContain('strict-login-grant-bundle')
  })

  it('counts the installed shape as 24 and keeps a separate named-relation census', () => {
    const triggerNames: readonly string[] = STRICT_LOGIN_GRANT_TRIGGERS
    const overlap = STRICT_LOGIN_GRANT_FUNCTIONS.filter((name) => triggerNames.includes(name))
    expect(overlap).toHaveLength(4)
    expect(
      STRICT_LOGIN_GRANT_TABLES.length
      + STRICT_LOGIN_GRANT_FUNCTIONS.length
      + STRICT_LOGIN_GRANT_TRIGGERS.length
      + STRICT_LOGIN_GRANT_SESSION_CHECKS.length
      + 2,
    ).toBe(24)
    const named = between(migrationSource, 'async function namedOwnedTables', 'async function census')
    const shape = between(migrationSource, 'async function census', 'function contextShapeSql')
    expect(named).not.toContain('relkind')
    expect(named).not.toContain('relpersistence')
    expect(shape).toContain("c.relkind = 'r'")
    expect(shape).toContain("c.relpersistence = 'p'")
    const storeNamed = between(storeSource, "SELECT 'named'::text AS kind", 'const CENSUS_EXPECTED')
    expect(storeNamed).not.toContain('relkind')
    expect(storeNamed).not.toContain('relpersistence')
  })

  it('records the finite migration and bundle corrections in source', () => {
    expect(migrationSource).not.toContain('pg_catalog.chr(0)')
    expect(migrationSource).not.toContain('check_function_bodies')
    expect(migrationSource).toContain('seal_row record;')
    expect(migrationSource).not.toContain('admin_grant_proof_seals%ROWTYPE')
    expect(migrationSource).toContain('OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id')
    expect(migrationSource).toContain('OR grant_row.granted_by IS DISTINCT FROM receipt_row.actor_id')
    expect(STRICT_LOGIN_GRANT_PREREQUISITES).not.toContain('admin_grant_proof_seals')
    expect(STRICT_LOGIN_GRANT_PREREQUISITES).not.toContain('admin_grant_proof_targets')
    expect(storeSource).toContain('GREATEST(revoked_after, pg_catalog.clock_timestamp())')
    expect(storeSource).not.toContain('pg_catalog.greatest')
    expect(storeSource).toContain('\\u0000')
    const bundle = between(bundleSource, 'export async function insertConsumedGrantBundle', '')
    order(bundle, [
      'service.assertConsumedOnTx(input.consumed, tx, input.context, intent)',
      'assertReceiving(input.consumed, intent)',
      'grantedBy !== input.context.userId || grantedBy !== intent.actorId',
      'INSERT INTO ${receipts}',
      'service.assertConsumedOnTx(input.consumed, tx, input.context, intent)',
      'assertReceiving(input.consumed, intent)',
      'INSERT INTO ${grantTable}',
    ])
    expect(bundle).not.toContain('catch')
  })
})

// These caller doubles qualify query boundaries only; native grant lifecycle is separate.
function installedCaller(
  effect: (sql: string, params: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>,
  installed = true,
): StrictLoginGrantCaller {
  return {
    async query(sql, params = []) {
      if (sql.includes('current_schemas(false)')) return { rows: [{ schema_name: 'b2_unit' }] }
      if (sql.includes('"kysely_migration"')) return { rows: installed ? [{ present: 1 }] : [] }
      if (sql.includes('FROM pg_catalog.')) {
        if (!sql.includes("SELECT 'table'::text AS kind")) throw new Error('UNEXPECTED_CATALOG_QUERY')
        const groups = [
          ['table', STRICT_LOGIN_GRANT_TABLES], ['function', STRICT_LOGIN_GRANT_FUNCTIONS],
          ['trigger', STRICT_LOGIN_GRANT_TRIGGERS], ['check', STRICT_LOGIN_GRANT_SESSION_CHECKS],
          ['index', [STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX]], ['column', [STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN]],
          ['named', STRICT_LOGIN_GRANT_TABLES],
        ] as const
        return { rows: installed ? groups.flatMap(([kind, names]) => names.map((name) => ({ kind, name }))) : [] }
      }
      return { rows: await effect(sql.replace(/\s+/g, ' ').trim(), params) }
    },
  }
}

const DEPARTED_CONNECTION = '11111111-1111-4111-8111-111111111111'

describe('strict login installation census round trips', () => {
  it('retains all seven catalog categories in three reads and does not cache across calls', async () => {
    const base = installedCaller(async () => [])
    const calls: Array<{ sql: string; params: readonly unknown[] }> = []
    let censusReads = 0
    const caller: StrictLoginGrantCaller = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        const result = await base.query(sql, params)
        if (sql.includes("SELECT 'table'::text AS kind") && ++censusReads === 2) {
          return { rows: result.rows.filter((row) => row.kind !== 'index') }
        }
        return result
      },
    }
    await expect(readStrictLoginInstallation(caller)).resolves.toEqual({ installation: 'installed' })
    expect(calls).toHaveLength(3)
    expect(calls[0].sql).toContain('current_schemas(false)')
    expect(calls[1].sql).toContain('"kysely_migration"')
    expect(calls[2].sql.match(/UNION ALL/g)).toHaveLength(6)
    expect(calls[2].params).toEqual([
      'b2_unit', [...STRICT_LOGIN_GRANT_TABLES], [...STRICT_LOGIN_GRANT_FUNCTIONS],
      [...STRICT_LOGIN_GRANT_TRIGGERS], [...STRICT_LOGIN_GRANT_SESSION_CHECKS],
      STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX, STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN,
    ])
    await expect(readStrictLoginInstallation(caller)).rejects.toMatchObject({ code: 'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED' })
    expect(calls).toHaveLength(6)
  })

  it.each(['table', 'function', 'trigger', 'check', 'index', 'column', 'named'])(
    'refuses an incomplete %s category instead of treating it as absent', async (kind) => {
      const base = installedCaller(async () => [])
      const caller: StrictLoginGrantCaller = {
        async query(sql, params = []) {
          const result = await base.query(sql, params)
          return sql.includes("SELECT 'table'::text AS kind")
            ? { rows: result.rows.filter((row) => row.kind !== kind) }
            : result
        },
      }
      await expect(readStrictLoginInstallation(caller)).rejects.toMatchObject({ code: 'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED' })
    },
  )

  it('refuses objects without a ledger and a named non-table relation without installation', async () => {
    for (const onlyNamed of [false, true]) {
      const base = installedCaller(async () => [])
      const caller: StrictLoginGrantCaller = {
        async query(sql, params = []) {
          if (sql.includes('"kysely_migration"')) return { rows: [] }
          const result = await base.query(sql, params)
          return onlyNamed && sql.includes("SELECT 'table'::text AS kind")
            ? { rows: result.rows.filter((row) => row.kind === 'named') }
            : result
        },
      }
      await expect(readStrictLoginInstallation(caller)).rejects.toMatchObject({ code: 'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED' })
    }
  })

  it.each([1, 2, 3])('refuses a failure in witness read %i', async (failAt) => {
    const base = installedCaller(async () => [])
    let calls = 0
    const caller: StrictLoginGrantCaller = {
      async query(sql, params = []) {
        if (++calls === failAt) throw new Error('synthetic catalog failure')
        return base.query(sql, params)
      },
    }
    await expect(readStrictLoginInstallation(caller)).rejects.toMatchObject({ code: 'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED' })
    expect(calls).toBe(failAt)
  })

  it('reuses only the current schema read and preserves SHARE before the final scope read', async () => {
    const calls: string[] = []
    const base = installedCaller(async (sql) => sql.includes('FOR SHARE') ? [{ id: DEPARTED_CONNECTION }] : [])
    const caller: StrictLoginGrantCaller = {
      async query(sql, params = []) { calls.push(sql); return base.query(sql, params) },
    }
    await expect(readConnectionLoginScope(caller, DEPARTED_CONNECTION)).resolves.toEqual({ installation: 'installed', scope: null })
    expect(calls).toHaveLength(5)
    expect(calls.filter((sql) => sql.includes('current_schemas(false)'))).toHaveLength(1)
    expect(calls[3]).toContain('FOR SHARE')
    expect(calls[4]).toContain('"directory_connection_login_scope"')
  })
})

describe('strict login grant candidate scope and current-method reads', () => {
  it('restricts both grant discovery reads to the candidate user and connection before ordered terminal updates', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = []
    const caller = installedCaller(async (sql, params) => {
      calls.push({ sql, params })
      if (sql.includes('WHERE revoked_at IS NULL')) return [{ id: 'grant-b' }, { id: 'grant-a' }]
      return [{ id: params[0] }]
    })
    const result = await revokeForUserInScope(caller, DEPARTED_CONNECTION, 'user-a', {
      reason: 'deprovision', revokedBy: 'actor', revokedRunId: '22222222-2222-4222-8222-222222222222',
    })
    expect(result).toEqual({ grantIds: ['grant-a', 'grant-b'] })
    expect(calls.map(({ sql }) => sql.startsWith('UPDATE') ? 'update' : sql.includes('FOR UPDATE') ? 'lock' : 'discover'))
      .toEqual(['discover', 'lock', 'lock', 'discover', 'update', 'update'])
    for (const index of [0, 3]) {
      expect(calls[index].sql, 'CANDIDATE_SCOPE_QUERY').toBe('SELECT id FROM "b2_unit"."user_external_identity_login_grants" WHERE revoked_at IS NULL AND (connection_id = $1::uuid AND local_user_id = $2::text)')
      expect(calls[index].params).toEqual([DEPARTED_CONNECTION, 'user-a'])
    }
    expect(calls.slice(1, 3).map(({ params }) => params)).toEqual([['grant-a'], ['grant-b']])
    expect(calls.slice(4).map(({ params }) => params)).toEqual([
      ['grant-a', 'deprovision', 'actor', null, '22222222-2222-4222-8222-222222222222', null, null],
      ['grant-b', 'deprovision', 'actor', null, '22222222-2222-4222-8222-222222222222', null, null],
    ])
  })

  it('reads current scope eligibility without taking an integration or scope row lock', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = []
    const caller = installedCaller(async (sql, params) => {
      calls.push({ sql, params })
      return [{ id: DEPARTED_CONNECTION, connection_id: DEPARTED_CONNECTION, command_id: 'command-a', transitioned_at: '2026-11-18T00:00:00.123456Z' }]
    })
    await expect(readCurrentConnectionLoginScope(caller, DEPARTED_CONNECTION)).resolves.toEqual({
      installation: 'installed', scope: { connectionId: DEPARTED_CONNECTION, commandId: 'command-a', transitionedAt: '2026-11-18T00:00:00.123456Z' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toEqual([DEPARTED_CONNECTION])
    expect(calls[0].sql).toContain('FROM "b2_unit"."directory_integrations" integration LEFT JOIN "b2_unit"."directory_connection_login_scope" scope ON scope.connection_id = integration.id WHERE integration.id = $1::uuid')
    expect(calls[0].sql, 'CURRENT_METHOD_NONLOCKING_QUERY').not.toMatch(/FOR (?:SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)|LOCK TABLE/i)
  })

  it('distinguishes absent scope from a missing integration and propagates a failed current read', async () => {
    await expect(readCurrentConnectionLoginScope(installedCaller(async () => [{ connection_id: null }]), DEPARTED_CONNECTION))
      .resolves.toEqual({ installation: 'installed', scope: null })
    await expect(readCurrentConnectionLoginScope(installedCaller(async () => []), DEPARTED_CONNECTION))
      .rejects.toMatchObject({ code: 'STRICT_LOGIN_GRANT_INPUT_REFUSED' })
    const failure = new Error('synthetic read failed')
    await expect(readCurrentConnectionLoginScope(installedCaller(async () => { throw failure }), DEPARTED_CONNECTION))
      .rejects.toBe(failure)
  })

  it('keeps never-installed explicit and refuses installation failure before a current-method query', async () => {
    let domainReads = 0
    const caller = installedCaller(async () => { domainReads += 1; return [] }, false)
    await expect(readCurrentConnectionLoginScope(caller, DEPARTED_CONNECTION))
      .resolves.toEqual({ installation: 'never-installed', scope: null })
    expect(domainReads).toBe(0)
    await expect(readCurrentConnectionLoginScope({ query: async () => { throw new Error('catalog unavailable') } }, DEPARTED_CONNECTION))
      .rejects.toMatchObject({ code: 'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED' })
  })
})
