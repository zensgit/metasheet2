/**
 * H2 — `DELETE`/`PUT /api/admin/data/bulk` with `data_sources` as the target must answer a coded
 * 409 when the live-id binding foreign key refuses the write, not a bare 500.
 *
 * WHY THIS EXISTS. #5896 re-pointed `integration_external_systems.connection_id` at
 * `data_sources(live_id)` (migration zzzz20260920120000), a STORED generated column that is the
 * row's id while the row is live and NULL once `deleted_at` is set. Both bulk routes accept
 * `data_sources` as a target table (admin-routes.ts validTables), and the PUT route can set
 * `deleted_at` directly — so both can hit SQLSTATE 23503 on
 * `fk_integration_external_systems_live_connection_id`. Their generic catch answered
 * `500 { error: err.message }`: the rows were untouched, but the caller had no stable code and the
 * driver's own sentence reached the client. Registered as row 5 (uncovered) of the coverage matrix
 * in docs/development/data-source-live-id-fk-binding-lock-design-20260920.md §7; this suite is what
 * moves that row to covered.
 *
 * WHAT IS PINNED, in the two layers the fix has:
 *   ① PRE-CHECK  — a referenced source is refused 409 with its id BEFORE any DELETE/UPDATE is
 *                  issued (the fake db asserts the mutation builder was never executed).
 *   ② BACKSTOP   — a mutation that nonetheless raises 23503 on the binding constraint is mapped to
 *                  the SAME 409. This is the layer that actually removes the bare 500, because a
 *                  bind can commit between ① and the write.
 *   BOUNDARIES  — a 23503 carrying ANOTHER constraint name keeps its 500; a 23503 on another table
 *                  keeps its 500; a non-23503 failure keeps its 500; and a PUT that does not set
 *                  `deleted_at` is not pre-checked at all (it cannot clear `live_id`, so refusing
 *                  it would break legitimate bulk edits of referenced rows).
 *
 * SQLSTATE, NEVER PROSE. The driver errors here carry deliberately CHINESE message text: 222 runs a
 * zh_CN PostgreSQL, where the English "violates foreign key constraint" sentence never appears. A
 * fix that matched on English prose passes nothing in this file.
 *
 * TRANSPORT: usePinnedServer() + request(pinned.url()) — `request(app)` in tests/unit is the #4154
 * tripwire.
 *
 * DOUBLES: the kysely handle is replaced at the module boundary (vi.mock of src/db/kysely), so no
 * real database is opened and every query shape the routes issue is observable. Values-free: only
 * synthetic ids and synthetic Chinese driver prose appear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { isAdmin } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'

// ── the fake kysely handle ────────────────────────────────────────────────────

interface FakeDbState {
  /** Rows returned by `selectFrom('data_sources').select('id')` — the pre-check's candidates. */
  candidates: Array<Record<string, unknown>>
  /** Rows returned by `selectFrom('integration_external_systems').select('connection_id')`. */
  references: Array<Record<string, unknown>>
  /**
   * Rows returned by the SECOND and later reference lookups, when set. Models the race the backstop
   * exists for: the pre-check saw no binding, one committed, the mutation then tripped the FK, and
   * the refusal's own lookup now sees it.
   */
  referencesAfterFirstLookup: Array<Record<string, unknown>> | null
  /** How many times the reference lookup ran. */
  referenceLookups: number
  /** Thrown by the candidate lookup when set (advisory-failure posture). */
  candidateError: unknown
  /** Thrown by the reference lookup when set. */
  referenceError: unknown
  /** Thrown by the delete/update `execute()` when set — the database backstop. */
  mutationError: unknown
  /** Rows the mutation reports as affected. */
  mutationResult: unknown[]
  /** Observability: which tables were mutated, in order. */
  mutations: Array<{ kind: 'delete' | 'update'; table: string }>
  /** Observability: which tables the pre-check read, in order. */
  selects: string[]
}

let state: FakeDbState

function freshState(): FakeDbState {
  return {
    candidates: [],
    references: [],
    referencesAfterFirstLookup: null,
    referenceLookups: 0,
    candidateError: null,
    referenceError: null,
    mutationError: null,
    mutationResult: [{}],
    mutations: [],
    selects: [],
  }
}

function makeSelectBuilder(table: string) {
  const builder = {
    select: () => builder,
    where: () => builder,
    execute: async () => {
      state.selects.push(table)
      if (table === 'data_sources') {
        if (state.candidateError) throw state.candidateError
        return state.candidates
      }
      state.referenceLookups += 1
      if (state.referenceError) throw state.referenceError
      if (state.referenceLookups > 1 && state.referencesAfterFirstLookup !== null) {
        return state.referencesAfterFirstLookup
      }
      return state.references
    },
  }
  return builder
}

function makeMutationBuilder(kind: 'delete' | 'update', table: string) {
  const builder = {
    set: () => builder,
    where: () => builder,
    execute: async () => {
      state.mutations.push({ kind, table })
      if (state.mutationError) throw state.mutationError
      return state.mutationResult
    },
  }
  return builder
}

vi.mock('../../src/db/kysely', () => ({
  db: {
    selectFrom: (table: string) => makeSelectBuilder(table),
    deleteFrom: (table: string) => makeMutationBuilder('delete', table),
    updateTable: (table: string) => makeMutationBuilder('update', table),
  },
  transaction: vi.fn(),
}))
// Same three stubs every admin-routes suite installs: without a pool these modules throw at import
// time (AuditRepository.ts:219), which would fail the suite before a single route is exercised.
vi.mock('../../src/db/pg', () => ({ pool: null }))
vi.mock('../../src/services/SnapshotService', () => ({}))
vi.mock('../../src/audit/audit', () => ({}))
/**
 * RBAC double, same literal shape as tests/unit/admin-dlq-read-authz.test.ts:28-30 and
 * admin-read-gates-batch3-authz.test.ts:83-85. The fixture principal below is already named
 * 'admin-fixture'; this stub only makes that stated identity effective, it does not widen anything.
 *
 * Why it is needed here: requireAdminRole() (guards/audit-integration.ts:148) calls
 * `isAdmin(user.id)`, and rbac/service.ts:19 defaults its runner to `query` from src/db/pg — which
 * the `{ pool: null }` stub above does not export. Without this mock every request under test would
 * be answered 503 RBAC_CHECK_FAILED by that guard's catch, masking the 409/400/500 boundaries this
 * suite actually asserts.
 */
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))

import { initAdminRoutes } from '../../src/routes/admin-routes'
import { getSafetyGuard } from '../../src/guards/SafetyGuard'

// ── fixtures (values-free) ────────────────────────────────────────────────────

const LIVE_FK = 'fk_integration_external_systems_live_connection_id'
const LEGACY_FK = 'fk_integration_external_systems_connection_id'
const OTHER_FK = 'fk_some_other_table_some_other_column'
const REFERENCED_CODE = 'DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS'

const SOURCE_ID = 'ds-fixture-referenced'
const OTHER_SOURCE_ID = 'ds-fixture-free'

/**
 * A pg driver error as a zh_CN server reports it: SQLSTATE + constraint name are structured, the
 * message is Chinese. Any guard reading the English prose sees nothing here.
 */
function driverFkError(constraint: string | undefined) {
  return Object.assign(new Error('插入或更新表 "integration_external_systems" 违反了外键约束'), {
    code: '23503',
    ...(constraint === undefined ? {} : { constraint }),
    table: 'integration_external_systems',
  })
}

const DRIVER_PROSE = '插入或更新表 "integration_external_systems" 违反了外键约束'

const pinned = usePinnedServer()

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: { id: string } }).user = { id: 'admin-fixture' }
    next()
  })
  app.use('/api/admin', initAdminRoutes())
  return app
}

/**
 * Mount, then neutralise the SafetyGuard the mount just re-created. requireSafetyCheck resolves the
 * singleton per request (guards/middleware.ts:67), so spying after the mount is what takes effect;
 * spying before it would decorate the instance initAdminRoutes() then throws away.
 */
function mountApp(): void {
  pinned.setApp(buildApp())
  vi.spyOn(getSafetyGuard(), 'checkOperation').mockResolvedValue({
    allowed: true,
    assessment: {
      riskLevel: 'low',
      requiresConfirmation: false,
      requiresDoubleConfirm: false,
      riskDescription: 'test double',
      safeguards: [],
      impact: {},
    },
  } as never)
}

beforeEach(() => {
  // Re-arm inside beforeEach, not only at the vi.mock factory: this suite's afterEach calls
  // vi.restoreAllMocks(), which strips the factory's mockResolvedValue and would leave isAdmin
  // returning undefined from the second test onwards — requireAdminRole() then answers 403 and
  // every 409/400/500 boundary below would be measuring the gate instead of the error mapping.
  vi.mocked(isAdmin).mockResolvedValue(true)
  state = freshState()
  mountApp()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const bulkDelete = (body: Record<string, unknown>) =>
  request(pinned.url()).delete('/api/admin/data/bulk').send(body)

const bulkUpdate = (body: Record<string, unknown>) =>
  request(pinned.url()).put('/api/admin/data/bulk').send(body)

// ── ② the database backstop: 23503 on the binding constraint -> coded 409 ─────

describe('bulk mutations on data_sources: the binding foreign key maps to 409, not a bare 500', () => {
  it.each([
    ['the live-id constraint', LIVE_FK],
    ['the pre-migration constraint name', LEGACY_FK],
    ['no constraint name reported by the driver', undefined],
  ])('DELETE with 23503 (%s) answers 409 %s', async (_label, constraint) => {
    state.mutationError = driverFkError(constraint as string | undefined)

    const res = await bulkDelete({ table: 'data_sources', filters: { id: SOURCE_ID } })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe(REFERENCED_CODE)
    expect(res.body.details).toMatchObject({ table: 'data_sources' })
    expect(Array.isArray(res.body.details.ids)).toBe(true)
    // The mutation WAS attempted (this is the backstop layer, not the pre-check).
    expect(state.mutations).toEqual([{ kind: 'delete', table: 'data_sources' }])
    // Values-free: the driver's own sentence never reaches the client.
    expect(JSON.stringify(res.body)).not.toContain(DRIVER_PROSE)
  })

  it('PUT that sets deleted_at and hits 23503 on the binding constraint answers the same 409', async () => {
    state.mutationError = driverFkError(LIVE_FK)

    const res = await bulkUpdate({
      table: 'data_sources',
      updates: { deleted_at: '2026-09-20T00:00:00.000Z' },
      filters: { id: SOURCE_ID },
    })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe(REFERENCED_CODE)
    expect(res.body.details.table).toBe('data_sources')
    expect(state.mutations).toEqual([{ kind: 'update', table: 'data_sources' }])
    expect(JSON.stringify(res.body)).not.toContain(DRIVER_PROSE)
  })

  it('names the referenced ids in the refusal when the post-failure lookup can still answer', async () => {
    // THE RACE the backstop exists for: the pre-check sees nothing, a bind commits, the DELETE
    // trips the FK, and the refusal's own lookup now finds the binding and names the id.
    state.candidates = [{ id: SOURCE_ID }, { id: OTHER_SOURCE_ID }]
    state.references = []
    state.referencesAfterFirstLookup = [{ connection_id: SOURCE_ID }]
    state.mutationError = driverFkError(LIVE_FK)

    const res = await bulkDelete({ table: 'data_sources', filters: { type: 'postgres' } })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe(REFERENCED_CODE)
    expect(res.body.details.ids).toEqual([SOURCE_ID])
    expect(state.referenceLookups).toBe(2)
    expect(state.mutations).toEqual([{ kind: 'delete', table: 'data_sources' }])
  })

  it('falls back to an EMPTY id list (never a wrong status) when the lookup itself fails', async () => {
    state.mutationError = driverFkError(LIVE_FK)
    state.candidateError = Object.assign(new Error('连接已断开'), { code: '57P01' })

    const res = await bulkDelete({ table: 'data_sources', filters: { id: SOURCE_ID } })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe(REFERENCED_CODE)
    expect(res.body.details.ids).toEqual([])
  })
})

// ── ① the pre-check: refuse before writing anything ───────────────────────────

describe('bulk mutations on data_sources: the pre-check refuses before any write', () => {
  it('DELETE of a referenced source is refused 409 with its id and never reaches the delete', async () => {
    state.candidates = [{ id: SOURCE_ID }, { id: OTHER_SOURCE_ID }]
    state.references = [{ connection_id: SOURCE_ID }]

    const res = await bulkDelete({ table: 'data_sources', filters: { type: 'postgres' } })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe(REFERENCED_CODE)
    expect(res.body.details).toEqual({ table: 'data_sources', ids: [SOURCE_ID] })
    expect(state.mutations).toEqual([])
  })

  it('PUT that sets deleted_at on a referenced source is refused before the update', async () => {
    state.candidates = [{ id: SOURCE_ID }]
    state.references = [{ connection_id: SOURCE_ID }]

    const res = await bulkUpdate({
      table: 'data_sources',
      updates: { deleted_at: '2026-09-20T00:00:00.000Z', is_active: false },
      filters: { id: SOURCE_ID },
    })

    expect(res.status).toBe(409)
    expect(res.body.details.ids).toEqual([SOURCE_ID])
    expect(state.mutations).toEqual([])
  })

  it('lets an unreferenced source through untouched', async () => {
    state.candidates = [{ id: OTHER_SOURCE_ID }]
    state.references = []

    const res = await bulkDelete({ table: 'data_sources', filters: { id: OTHER_SOURCE_ID } })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(state.mutations).toEqual([{ kind: 'delete', table: 'data_sources' }])
  })

  it('treats a missing integration schema (42P01) as zero references, not as a failure', async () => {
    state.candidates = [{ id: SOURCE_ID }]
    state.referenceError = Object.assign(new Error('关系 "integration_external_systems" 不存在'), {
      code: '42P01',
    })

    const res = await bulkDelete({ table: 'data_sources', filters: { id: SOURCE_ID } })

    expect(res.status).toBe(200)
    expect(state.mutations).toEqual([{ kind: 'delete', table: 'data_sources' }])
  })
})

// ── boundaries: what must NOT become a 409 ────────────────────────────────────

describe('boundaries: only the binding constraint on data_sources becomes a 409', () => {
  it('a 23503 carrying ANOTHER constraint name keeps its 500', async () => {
    state.mutationError = driverFkError(OTHER_FK)

    const res = await bulkDelete({ table: 'data_sources', filters: { id: SOURCE_ID } })

    expect(res.status).toBe(500)
    expect(res.body.code).toBeUndefined()
    expect(res.body.success).toBe(false)
  })

  it('the SAME binding constraint against a different target table keeps its 500', async () => {
    state.mutationError = driverFkError(LIVE_FK)

    const res = await bulkDelete({ table: 'tables', filters: { id: 'tbl-fixture' } })

    expect(res.status).toBe(500)
    expect(res.body.code).toBeUndefined()
    // A non-data_sources target is never pre-checked either.
    expect(state.selects).toEqual([])
    expect(state.mutations).toEqual([{ kind: 'delete', table: 'tables' }])
  })

  it('a non-23503 failure on data_sources keeps its 500', async () => {
    state.mutationError = Object.assign(new Error('与服务器的连接已中断'), { code: '57P01' })

    const res = await bulkDelete({ table: 'data_sources', filters: { id: SOURCE_ID } })

    expect(res.status).toBe(500)
    expect(res.body.code).toBeUndefined()
  })

  it('a PUT that does NOT set deleted_at is not pre-checked, even for a referenced source', async () => {
    state.candidates = [{ id: SOURCE_ID }]
    state.references = [{ connection_id: SOURCE_ID }]

    const res = await bulkUpdate({
      table: 'data_sources',
      updates: { name: 'renamed-fixture' },
      filters: { id: SOURCE_ID },
    })

    expect(res.status).toBe(200)
    // No pre-check query was issued at all: `live_id` cannot change, so the FK cannot trip.
    expect(state.selects).toEqual([])
    expect(state.mutations).toEqual([{ kind: 'update', table: 'data_sources' }])
  })

  it('a PUT that CLEARS deleted_at (null) is likewise not pre-checked', async () => {
    state.candidates = [{ id: SOURCE_ID }]
    state.references = [{ connection_id: SOURCE_ID }]

    const res = await bulkUpdate({
      table: 'data_sources',
      updates: { deleted_at: null },
      filters: { id: SOURCE_ID },
    })

    expect(res.status).toBe(200)
    expect(state.selects).toEqual([])
  })

  it('existing request validation is unchanged (unknown table still 400, missing filters still 400)', async () => {
    const unknownTable = await bulkDelete({ table: 'not_a_table', filters: { id: SOURCE_ID } })
    expect(unknownTable.status).toBe(400)

    const noFilters = await bulkDelete({ table: 'data_sources', filters: {} })
    expect(noFilters.status).toBe(400)
    expect(state.selects).toEqual([])
    expect(state.mutations).toEqual([])
  })
})
