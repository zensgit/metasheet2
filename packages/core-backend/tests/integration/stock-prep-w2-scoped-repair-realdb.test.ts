/**
 * W2 — SCOPED repair through the REAL provisioning surface (real DB).
 *
 * The earlier W2 realdb test called the ensureMissingObjectFields PRIMITIVE directly,
 * which bypassed the repair's field-discovery chain (review P1b). THIS test drives the
 * plugin repair function `repairStockPreparationCanonicalTarget` end-to-end against a
 * provisioning surface wired to the real DB — so it exercises:
 *   findObjectSheet → resolveExistingObjectFieldIds (DB-backed, the fix) → ensureMissingObjectFields
 * proving a genuinely-missing template column is discovered and re-added, and existing
 * columns are untouched. If discovery reverted to the compute-only resolveFieldIds,
 * repair would find nothing missing and this test would fail.
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { vi } from 'vitest'

import {
  findObjectSheet,
  getObjectSheetId,
  resolveExistingObjectFieldIds,
  readObjectFieldsContent,
  ensureMissingObjectFields,
  ensureObject,
  buildObjectFieldsRepairSurface,
} from '../../src/multitable/provisioning'
import { createPluginScopedMultitableApi } from '../../src/multitable/plugin-scope'
import { MetaSheetServer } from '../../src/index'

// Narrow view of the SHIPPED core API — just the repair runner we drive end-to-end.
type ShippedRepairSurface = {
  findObjectSheet: (i: { projectId: string; objectId: string }) => Promise<unknown>
  resolveExistingObjectFieldIds: (i: { projectId: string; objectId: string; fieldIds: string[] }) => Promise<Record<string, string>>
  readObjectFieldsContent: (i: { projectId: string; objectId: string; fieldIds: string[] }) => Promise<Record<string, unknown>>
  ensureMissingObjectFields: (i: { projectId: string; objectId: string; fields: unknown[] }) => Promise<{ addedFieldIds: string[]; skippedExistingFieldIds: string[] }>
}
type ShippedCoreApiShape = {
  multitable: {
    provisioning: {
      runObjectFieldsRepairTransaction: <T>(fn: (surface: ShippedRepairSurface) => Promise<T>) => Promise<T>
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const targetProvisioning = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'stock-preparation-target-provisioning.cjs'),
)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const templates = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'stock-preparation-templates.cjs'),
)

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const MAIN_OBJECT_ID = templates.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const PLM_FIELD = templates.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.find(
  (f: { ownership: string }) => f.ownership === 'plm_system',
).id

describeDb('W2 scoped canonical repair (real provisioning surface, real DB)', () => {
  // projectId must carry the plugin namespace suffix so the scope wrapper allows it.
  const PLUGIN = 'plugin-w2test'
  const projectId = `w2scoped_${randomUUID().replace(/-/g, '').slice(0, 10)}:${PLUGIN}`
  const assertObjectScope = vi.fn(async () => {})
  let pool: Pool
  let context: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawProvisioning: any

  const withClient = async <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      return await fn((sql, params) => client.query(sql, params as unknown[]))
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    // A provisioning surface wired to the real DB (mirrors the index.ts surface shape
    // the plugin actually receives), exposing the three methods repair uses.
    rawProvisioning = {
      getObjectSheetId,
      findObjectSheet: ({ projectId: p, objectId }: { projectId: string; objectId: string }) =>
        withClient((q) => findObjectSheet(q as never, p, objectId)),
      resolveExistingObjectFieldIds: ({ projectId: p, objectId, fieldIds }: { projectId: string; objectId: string; fieldIds: string[] }) =>
        withClient((q) => resolveExistingObjectFieldIds({ query: q as never, projectId: p, objectId, fieldIds })),
      readObjectFieldsContent: ({ projectId: p, objectId, fieldIds }: { projectId: string; objectId: string; fieldIds: string[] }) =>
        withClient((q) => readObjectFieldsContent({ query: q as never, projectId: p, objectId, fieldIds })),
      ensureMissingObjectFields: ({ projectId: p, objectId, fields }: { projectId: string; objectId: string; fields: unknown[] }) =>
        withClient(async (q) => {
          await q('BEGIN')
          const r = await ensureMissingObjectFields({ query: q as never, projectId: p, objectId, fields: fields as never })
          await q('COMMIT')
          return r
        }),
      // W2/P2-3: the ATOMIC repair runner — mirrors index.ts by using the SAME shipped
      // surface-builder (buildObjectFieldsRepairSurface), so this real-DB rollback test
      // exercises the production surface-binding, not a hand-mirrored copy (review P3:
      // runner-vs-prod gap). ONE client, ONE transaction; a thrown verify ROLLS BACK.
      runObjectFieldsRepairTransaction: async (fn: (surface: unknown) => Promise<unknown>) => {
        const client = await pool.connect()
        const q = (sql: string, params?: unknown[]) => client.query(sql, params as unknown[])
        try {
          await q('BEGIN')
          const r = await fn(buildObjectFieldsRepairSurface(q as never))
          await q('COMMIT')
          return r
        } catch (e) {
          await q('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
      },
    }
    // Route repair through the REAL scope wrapper (not a hand-built facade): repair
    // must reach the DB-backed methods THROUGH createPluginScopedMultitableApi, and
    // the write must pass hooks.assertObjectScope (review P2).
    const scoped = createPluginScopedMultitableApi(
      { provisioning: rawProvisioning, records: {} } as never,
      PLUGIN,
      { assertObjectScope },
    )
    context = { api: { multitable: scoped } }

    // Provision the canonical main table (all template fields) via the real ensureObject.
    const descriptor = targetProvisioning.buildStockPreparationTargetDescriptor({})
    await withClient(async (q) => {
      await q('BEGIN')
      await ensureObject({ query: q as never, projectId, baseId: null, descriptor })
      await q('COMMIT')
    })
  })

  afterAll(async () => {
    const sheetId = getObjectSheetId(projectId, MAIN_OBJECT_ID)
    await pool.query(`DELETE FROM meta_fields WHERE sheet_id = $1`, [sheetId]).catch(() => {})
    await pool.query(`DELETE FROM meta_sheets WHERE id = $1`, [sheetId]).catch(() => {})
    await pool.end()
  })

  it('discovers a genuinely-missing template column via the DB and re-adds it (existing untouched)', async () => {
    // Resolve the plm_system field's physical id, then DELETE it to simulate a table
    // that predates that template column (the "template evolved" state).
    const before = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    const physicalId = before[PLM_FIELD]
    expect(physicalId).toBeTruthy()
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [physicalId])

    // The field is now genuinely missing (real DB), so the compute-only resolver would
    // WRONGLY still report it present — the DB-backed one must report it gone.
    const afterDelete = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterDelete[PLM_FIELD]).toBeUndefined()

    // Repair through the plugin function → it must discover + re-add the missing column.
    assertObjectScope.mockClear()
    const result = await targetProvisioning.repairStockPreparationCanonicalTarget({ context, projectId, permission: 'admin' })
    expect(result.mode).toBe('canonical_repaired')
    expect(result.evidence.addedFieldCount).toBe(1)
    expect(result.evidence.schemaCompleteAfter).toBe(true)
    // The scoped write passed through the object-scope hook (proves it went through
    // the real scope wrapper, not a bare facade).
    expect(assertObjectScope).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: PLUGIN, objectId: MAIN_OBJECT_ID }),
    )

    // The column is back.
    const afterRepair = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterRepair[PLM_FIELD]).toBeTruthy()

    // A second repair is a clean no-op (nothing missing now).
    const again = await targetProvisioning.repairStockPreparationCanonicalTarget({ context, projectId, permission: 'admin' })
    expect(again.mode).toBe('canonical_already_ready')
    expect(again.evidence.addedFieldCount).toBe(0)
  })

  it('atomically ROLLS BACK the additive write when the mutation guard trips (P2-3)', async () => {
    // Delete the plm field so repair has exactly one column to add.
    const before = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    const physicalId = before[PLM_FIELD]
    expect(physicalId).toBeTruthy()
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [physicalId])

    // A repair runner identical to the real one EXCEPT the AFTER-read returns a MUTATED
    // existing-field snapshot — as if the write primitive had also touched a pre-existing
    // column. assertNoExistingFieldMutated throws INSIDE the transaction, so the additive
    // INSERT this same transaction performed must ROLL BACK (atomic fail-close, not a
    // post-commit detection canary).
    let readCount = 0
    const mutatingProvisioning = {
      ...rawProvisioning,
      runObjectFieldsRepairTransaction: async (fn: (surface: unknown) => Promise<unknown>) => {
        const client = await pool.connect()
        const q = (sql: string, params?: unknown[]) => client.query(sql, params as unknown[])
        try {
          await q('BEGIN')
          // Real shipped surface, with ONLY the after-read wrapped to inject the mutation.
          const base = buildObjectFieldsRepairSurface(q as never)
          const surface = {
            ...base,
            readObjectFieldsContent: async (i: { projectId: string; objectId: string; fieldIds: string[] }) => {
              readCount += 1
              const real = await base.readObjectFieldsContent(i)
              if (readCount >= 2) {
                for (const k of Object.keys(real)) real[k] = { ...real[k], name: `${real[k].name}_MUTATED` }
              }
              return real
            },
          }
          const r = await fn(surface)
          await q('COMMIT')
          return r
        } catch (e) {
          await q('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
      },
    }
    const mutatingContext = {
      api: {
        multitable: createPluginScopedMultitableApi(
          { provisioning: mutatingProvisioning, records: {} } as never,
          PLUGIN,
          { assertObjectScope },
        ),
      },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mutErr: any = null
    try {
      await targetProvisioning.repairStockPreparationCanonicalTarget({ context: mutatingContext, projectId, permission: 'admin' })
    } catch (e) {
      mutErr = e
    }
    expect(mutErr?.code).toBe('REPAIR_MUTATED_EXISTING_FIELD')

    // ATOMIC PROOF: the additive INSERT was rolled back with the failed transaction, so the
    // plm field is STILL missing. A non-atomic (separate-transaction) design would have
    // left it committed — the write and the throwing verify were in the same transaction.
    const afterRollback = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterRollback[PLM_FIELD]).toBeUndefined()

    // Restore a clean end state for any later test (real repair, real commit).
    await targetProvisioning.repairStockPreparationCanonicalTarget({ context, projectId, permission: 'admin' })
  })

  it('REAL production wiring: index.ts createCoreAPI() runObjectFieldsRepairTransaction is transactional (SHIPPED runner)', async () => {
    // Drive the ACTUAL shipped runner from MetaSheetServer.createCoreAPI() — not the in-test
    // runner and not the extracted helper. This closes the runner-vs-prod gap (review P2):
    // disabling index.ts's runObjectFieldsRepairTransaction (e.g. `throw`) REDs THIS test,
    // whereas the other suites (in-test runner / direct helper call) stay green. Follows the
    // G18 precedent (multitable-d2-sidedoor-delete-recoverability-realdb.test.ts).
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const coreApi = (server as unknown as { createCoreAPI: () => ShippedCoreApiShape }).createCoreAPI()
    const shippedRunner = coreApi.multitable.provisioning.runObjectFieldsRepairTransaction
    expect(typeof shippedRunner).toBe('function')

    // Make the plm field genuinely missing so the runner has something to add.
    const before = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    const physicalId = before[PLM_FIELD]
    expect(physicalId).toBeTruthy()
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [physicalId])

    const missingDescriptor = targetProvisioning
      .buildStockPreparationTargetDescriptor({})
      .fields.find((f: { id: string }) => f.id === PLM_FIELD)
    expect(missingDescriptor).toBeTruthy()

    // (1) add-then-throw INSIDE the shipped runner → the additive INSERT must ROLL BACK
    //     (proves the shipped runner opens a real transaction and propagates the throw).
    let threw: unknown = null
    try {
      await shippedRunner(async (surface) => {
        await surface.ensureMissingObjectFields({ projectId, objectId: MAIN_OBJECT_ID, fields: [missingDescriptor] })
        throw new Error('force-rollback')
      })
    } catch (e) {
      threw = e
    }
    expect((threw as Error | null)?.message).toBe('force-rollback')
    const afterRollback = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterRollback[PLM_FIELD]).toBeUndefined()

    // (2) a non-throwing fn COMMITS through the shipped runner (also reds an always-throw
    //     mutant of the shipped runner, since this await would reject).
    await shippedRunner(async (surface) =>
      surface.ensureMissingObjectFields({ projectId, objectId: MAIN_OBJECT_ID, fields: [missingDescriptor] }),
    )
    const afterCommit = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterCommit[PLM_FIELD]).toBeTruthy()
  })
})
