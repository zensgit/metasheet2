/**
 * B3 — plugin-owned SYSTEM bases (stock-prep own base), core half.
 *
 *   ensureSystemBase              SQL shape, created true/false, id + name validation with ZERO
 *                                 queries, `base_legacy` refused, adoption FAIL-CLOSED on an owned /
 *                                 workspace-scoped / soft-deleted row, error shapes (409 on adoption)
 *   plugin-scope prefix rule      `base_<slug>_` computed from the plugin name with no sanitising,
 *                                 the wrapper refuses before delegating, surface only when the host has it
 *   isPluginSystemBaseIdCandidate the `POST /bases` reservation rule
 *
 * Mutation witnesses (in-memory only, recorded in the PR body): M1 drops the adoption checks -> cases
 * 6-8 red; M6 empties assertBaseIdAllowedForPlugin -> case 13 red; M8 drops `status = 409` -> case 10 red.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_BASE_ID,
  MultitableBaseAdoptionError,
  MultitableSystemBaseInputError,
  SYSTEM_BASE_ID_PATTERN,
  ensureSystemBase,
} from '../../src/multitable/provisioning'
import {
  MultitableBaseScopeError,
  assertBaseIdAllowedForPlugin,
  createPluginScopedMultitableApi,
  getPluginBaseIdPrefix,
  getPluginBaseSlug,
  isPluginSystemBaseIdCandidate,
} from '../../src/multitable/plugin-scope'

type BaseRow = {
  id: string
  name: string
  owner_id: string | null
  workspace_id: string | null
  deleted_at: string | null
}

function createBaseQuery(seed: BaseRow[] = []) {
  const bases: BaseRow[] = seed.map((row) => ({ ...row }))
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('INSERT INTO meta_bases')) {
      const [id, name, , , ownerId, workspaceId] = params as [string, string, string, string, string | null, string | null]
      if (bases.some((row) => row.id === id)) return { rows: [] }
      bases.push({ id, name, owner_id: ownerId, workspace_id: workspaceId, deleted_at: null })
      return { rows: [{ id }] }
    }
    if (normalized.startsWith('SELECT owner_id, workspace_id, deleted_at FROM meta_bases')) {
      const row = bases.find((entry) => entry.id === params[0])
      return {
        rows: row ? [{ owner_id: row.owner_id, workspace_id: row.workspace_id, deleted_at: row.deleted_at }] : [],
      }
    }
    throw new Error(`Unhandled SQL in test: ${normalized.slice(0, 80)}`)
  })
  return { query, bases }
}

const GOOD_ID = 'base_integration-core_sp_0123456789abcdef01234567'

describe('ensureSystemBase', () => {
  it('1. issues the idempotent insert with NULL owner/workspace, then re-reads ownership', async () => {
    const { query } = createBaseQuery()
    await ensureSystemBase({ query, baseId: GOOD_ID, name: 'Stock preparation' })
    expect(query).toHaveBeenCalledTimes(2)
    const [insertSql, insertParams] = query.mock.calls[0]
    const normalizedInsert = String(insertSql).replace(/\s+/g, ' ')
    expect(normalizedInsert).toContain('INSERT INTO meta_bases')
    expect(normalizedInsert).toContain('ON CONFLICT (id) DO NOTHING')
    expect(insertParams).toEqual([GOOD_ID, 'Stock preparation', 'table', '#1677ff', null, null])
    const [selectSql, selectParams] = query.mock.calls[1]
    expect(String(selectSql).replace(/\s+/g, ' ')).toContain('SELECT owner_id, workspace_id, deleted_at')
    expect(selectParams).toEqual([GOOD_ID])
  })

  it('2. reports created:true on the first call for an id and created:false afterwards', async () => {
    const { query, bases } = createBaseQuery()
    const first = await ensureSystemBase({ query, baseId: GOOD_ID, name: 'Stock preparation' })
    const second = await ensureSystemBase({ query, baseId: GOOD_ID, name: 'Stock preparation' })
    expect(first).toEqual({ baseId: GOOD_ID, created: true })
    expect(second).toEqual({ baseId: GOOD_ID, created: false })
    expect(bases).toHaveLength(1)
  })

  it('3. refuses malformed ids before any query', async () => {
    const badIds: unknown[] = ['legacy', 'base_', 'base_-x', 'base_a', `base_${'a'.repeat(121)}`, 42, null, undefined]
    for (const badId of badIds) {
      const { query } = createBaseQuery()
      await expect(ensureSystemBase({ query, baseId: badId as string, name: 'x' })).rejects.toBeInstanceOf(
        MultitableSystemBaseInputError,
      )
      expect(query).not.toHaveBeenCalled()
    }
    // The positive edge of the same rule, so the refusals above are refusals of the rule and not of
    // the fake: 4-char and 120-char ids pass.
    expect(SYSTEM_BASE_ID_PATTERN.test('base_abc')).toBe(true)
    expect(SYSTEM_BASE_ID_PATTERN.test(`base_${'a'.repeat(120)}`)).toBe(true)
    expect(SYSTEM_BASE_ID_PATTERN.test(`base_${'a'.repeat(121)}`)).toBe(false)
  })

  it('4. refuses base_legacy before any query — the shared default base is not adoptable', async () => {
    const { query } = createBaseQuery()
    await expect(ensureSystemBase({ query, baseId: DEFAULT_BASE_ID, name: 'Migrated Base' })).rejects.toMatchObject({
      name: 'MultitableSystemBaseInputError',
      field: 'baseId',
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('5. refuses a blank or oversized name before any query and stores the trimmed name', async () => {
    for (const badName of ['', '   ', 'x'.repeat(101)]) {
      const { query } = createBaseQuery()
      await expect(ensureSystemBase({ query, baseId: GOOD_ID, name: badName })).rejects.toMatchObject({
        name: 'MultitableSystemBaseInputError',
        field: 'name',
      })
      expect(query).not.toHaveBeenCalled()
    }
    const { query, bases } = createBaseQuery()
    await ensureSystemBase({ query, baseId: GOOD_ID, name: '  备料  ' })
    expect(bases[0].name).toBe('备料')
    expect(query.mock.calls[0][1]).toEqual([GOOD_ID, '备料', 'table', '#1677ff', null, null])
  })

  const adoptionCases: Array<[string, Partial<BaseRow>, string]> = [
    ['6. owned by a user', { owner_id: 'user_squatter_9f2' }, 'owned'],
    ['7. scoped to a workspace', { workspace_id: 'workspace_private_7c1' }, 'workspace_scoped'],
    ['8. soft-deleted', { deleted_at: '2026-09-01T00:00:00.000Z' }, 'deleted'],
  ]
  for (const [label, patch, reason] of adoptionCases) {
    it(`${label}: an existing row is NEVER adopted (fail-closed, values-free)`, async () => {
      const seeded: BaseRow = { id: GOOD_ID, name: 'Squat', owner_id: null, workspace_id: null, deleted_at: null, ...patch }
      const { query, bases } = createBaseQuery([seeded])
      const error = await ensureSystemBase({ query, baseId: GOOD_ID, name: 'Stock preparation' }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MultitableBaseAdoptionError)
      expect((error as MultitableBaseAdoptionError).reason).toBe(reason)
      expect((error as MultitableBaseAdoptionError).baseId).toBe(GOOD_ID)
      expect((error as Error).message).toContain(GOOD_ID)
      for (const secret of ['user_squatter_9f2', 'workspace_private_7c1', '2026-09-01']) {
        expect((error as Error).message).not.toContain(secret)
        expect(JSON.stringify({ ...(error as object) })).not.toContain(secret)
      }
      // The row is untouched: the insert was a DO NOTHING and nothing else wrote.
      expect(bases).toEqual([seeded])
    })
  }

  it('9. adopts an existing row whose owner, workspace and deleted_at are all NULL, with created:false', async () => {
    const { query } = createBaseQuery([{ id: GOOD_ID, name: '备料', owner_id: null, workspace_id: null, deleted_at: null }])
    await expect(ensureSystemBase({ query, baseId: GOOD_ID, name: 'Stock preparation' })).resolves.toEqual({
      baseId: GOOD_ID,
      created: false,
    })
  })

  it('10. error shapes: name, code, and the adoption refusal carries status 409', () => {
    const adoption = new MultitableBaseAdoptionError(GOOD_ID, 'owned')
    expect(adoption).toBeInstanceOf(Error)
    expect(adoption.name).toBe('MultitableBaseAdoptionError')
    expect(adoption.code).toBe('MULTITABLE_BASE_ADOPTION_REFUSED')
    // The plugin route wrapper's sendError prefers `.status`; without it the refusal would be an
    // untyped 500 (inferHttpStatus knows none of these names).
    expect(adoption.status).toBe(409)

    const input = new MultitableSystemBaseInputError('baseId', 'rule')
    expect(input).toBeInstanceOf(Error)
    expect(input.name).toBe('MultitableSystemBaseInputError')
    expect(input.code).toBe('MULTITABLE_SYSTEM_BASE_INPUT_INVALID')
    expect(input.field).toBe('baseId')
    expect((input as { status?: unknown }).status).toBeUndefined()
  })
})

describe('plugin-scope base-id prefix', () => {
  it('11. derives base_<slug>_ directly from the plugin name', () => {
    expect(getPluginBaseIdPrefix('plugin-integration-core')).toBe('base_integration-core_')
    expect(getPluginBaseIdPrefix('attendance')).toBe('base_attendance_')
    expect(getPluginBaseIdPrefix('plugin-attendance')).toBe('base_attendance_')
    expect(getPluginBaseSlug('plugin-integration-core')).toBe('integration-core')
  })

  it('11b. a name that cannot form a slug has NO prefix — never a trimmed or lower-cased one', () => {
    for (const name of ['Plugin-Foo', 'plugin-integration-core!', 'plugin-', '', 'plugin_x', '  ']) {
      expect(getPluginBaseIdPrefix(name)).toBeNull()
    }
    expect(() => assertBaseIdAllowedForPlugin('Plugin-Foo', 'base_oo_x')).toThrow(MultitableBaseScopeError)
    expect(() => assertBaseIdAllowedForPlugin('Plugin-Foo', 'base_foo_x')).toThrow(MultitableBaseScopeError)
    expect(() => assertBaseIdAllowedForPlugin('Plugin-Foo', 'base_Foo_x')).toThrow(MultitableBaseScopeError)
  })

  function scopedWith(delegate: (input: { baseId: string; name: string }) => Promise<unknown>) {
    const ensureSystemBaseDelegate = vi.fn(delegate)
    const scoped = createPluginScopedMultitableApi(
      { provisioning: { ensureSystemBase: ensureSystemBaseDelegate }, records: {} } as any,
      'plugin-integration-core',
    )
    return { scoped, ensureSystemBaseDelegate }
  }

  it('12. plugin-integration-core may ensure a base under its own prefix; the delegate sees the same input', async () => {
    const { scoped, ensureSystemBaseDelegate } = scopedWith(async (input) => ({ baseId: input.baseId, created: true }))
    const input = { baseId: 'base_integration-core_sp_abc', name: 'Stock preparation' }
    await expect(scoped.provisioning.ensureSystemBase!(input)).resolves.toEqual({
      baseId: 'base_integration-core_sp_abc',
      created: true,
    })
    expect(ensureSystemBaseDelegate).toHaveBeenCalledTimes(1)
    expect(ensureSystemBaseDelegate).toHaveBeenCalledWith(input)
  })

  it('13. every id outside the prefix is refused BEFORE the delegate runs', async () => {
    const { scoped, ensureSystemBaseDelegate } = scopedWith(async () => {
      throw new Error('delegate must not run')
    })
    const refused = [
      'base_legacy',
      `base_${randomUUID()}`,
      'base_attendance_catalog',
      'base_integration_x',
      'base_integration-core_', // the prefix alone
      'base_Integration-core_x',
      '',
    ]
    for (const baseId of refused) {
      await expect(scoped.provisioning.ensureSystemBase!({ baseId, name: 'x' })).rejects.toBeInstanceOf(
        MultitableBaseScopeError,
      )
    }
    expect(ensureSystemBaseDelegate).not.toHaveBeenCalled()
  })

  it('14. the wrapper is absent when the host lacks ensureSystemBase, so feature detection is truthful', () => {
    const scoped = createPluginScopedMultitableApi(
      { provisioning: { ensureObject: async () => ({}) }, records: {} } as any,
      'plugin-integration-core',
    )
    expect('ensureSystemBase' in scoped.provisioning).toBe(false)
    expect(typeof scoped.provisioning.ensureSystemBase).toBe('undefined')
  })
})

describe('isPluginSystemBaseIdCandidate', () => {
  it('15. matches plugin-shaped ids only — never server-minted or legacy ids', () => {
    for (const id of ['base_integration-core_sp_x', 'base_attendance_catalog', 'base_a_b']) {
      expect(isPluginSystemBaseIdCandidate(id)).toBe(true)
    }
    for (const id of [DEFAULT_BASE_ID, `base_${randomUUID()}`, 'base_rn', 'base_Integration-core_x', 'base__x', 'sheet_x', '']) {
      expect(isPluginSystemBaseIdCandidate(id)).toBe(false)
    }
  })
})
