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
} from '../../src/multitable/provisioning'
import { createPluginScopedMultitableApi } from '../../src/multitable/plugin-scope'

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
    const rawProvisioning = {
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
})
