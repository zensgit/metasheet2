import { afterEach, describe, expect, it } from 'vitest'

import {
  createSheet,
  createView,
  ensureFields,
  ensureMissingObjectFields,
  ensureSheet,
  ensureView,
  getObjectFieldId,
  getObjectSheetId,
  patchObjectFieldProperty,
  type MultitableProvisioningQueryFn,
} from '../../src/multitable/provisioning'
import {
  __resetRecoveryWriterStateColumnProbe,
  canonicalSheetFenceKey,
  SheetWriterBlockedError,
} from '../../src/multitable/canonical-sheet-fence'

const WRITER_FENCE_ENV = 'MULTITABLE_ENABLE_WRITER_FENCE'
const SHEET_ID = 'sheet_dh1_provisioning'
const PROJECT_ID = 'tenant_dh1:provisioning'
const OBJECT_ID = 'asset'
const OBJECT_SHEET_ID = getObjectSheetId(PROJECT_ID, OBJECT_ID)

type SeenStatement = { sql: string; params: unknown[] }

function createFenceQuery(options: {
  sheetId: string
  blocked?: boolean
  fieldId?: string
}): { query: MultitableProvisioningQueryFn; seen: SeenStatement[] } {
  const seen: SeenStatement[] = []
  const query: MultitableProvisioningQueryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    seen.push({ sql: normalized, params })

    if (normalized.includes('FROM information_schema.columns')) return { rows: [{}] }
    if (normalized.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (normalized === 'SELECT recovery_writer_state FROM meta_sheets WHERE id = $1') {
      return { rows: [{ recovery_writer_state: options.blocked ? 'archiving' : null }] }
    }
    if (normalized.startsWith('INSERT INTO meta_sheets')) return { rows: [], rowCount: 1 }
    if (normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
      return {
        rows: [{
          id: options.sheetId,
          base_id: 'base_dh1',
          name: 'D-H1',
          description: null,
        }],
      }
    }
    if (normalized.startsWith('INSERT INTO meta_fields')) return { rows: [], rowCount: 1 }
    if (normalized.startsWith('UPDATE meta_fields')) {
      return {
        rows: [{
          id: options.fieldId ?? 'field_dh1',
          sheet_id: options.sheetId,
          name: 'Field',
          type: 'string',
          property: {},
          order: 0,
        }],
        rowCount: 1,
      }
    }
    if (normalized.includes('FROM meta_fields')) {
      if (options.fieldId && normalized.includes('WHERE sheet_id = $1 AND id = $2')) {
        return {
          rows: [{
            id: options.fieldId,
            sheet_id: options.sheetId,
            name: 'Field',
            type: 'string',
            property: {},
            order: 0,
          }],
        }
      }
      return { rows: [] }
    }
    if (normalized.startsWith('INSERT INTO meta_views')) return { rows: [], rowCount: 1 }
    if (normalized.includes('FROM meta_views') && normalized.includes('WHERE id = $1')) {
      return {
        rows: [{
          id: String(params[0]),
          sheet_id: options.sheetId,
          name: 'View',
          type: 'grid',
          filter_info: {},
          sort_info: {},
          group_info: {},
          hidden_field_ids: [],
          config: {},
        }],
      }
    }
    throw new Error(`Unhandled SQL in D-H1 provisioning fence test: ${normalized}`)
  }
  return { query, seen }
}

type WriterCase = {
  name: string
  sheetId: string
  run: (query: MultitableProvisioningQueryFn) => Promise<unknown>
}

const writerCases: WriterCase[] = [
  {
    name: 'createSheet',
    sheetId: SHEET_ID,
    run: (query) => createSheet({ query, sheetId: SHEET_ID, baseId: 'base_dh1', name: 'D-H1' }),
  },
  {
    name: 'ensureSheet',
    sheetId: SHEET_ID,
    run: (query) => ensureSheet({ query, sheetId: SHEET_ID, baseId: 'base_dh1', name: 'D-H1' }),
  },
  {
    name: 'ensureFields',
    sheetId: SHEET_ID,
    run: (query) => ensureFields({
      query,
      sheetId: SHEET_ID,
      overwriteMode: 'overwrite',
      fields: [{ id: 'field_dh1', name: 'Field', type: 'string' }],
    }),
  },
  {
    name: 'patchObjectFieldProperty',
    sheetId: OBJECT_SHEET_ID,
    run: (query) => patchObjectFieldProperty({
      query,
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      fieldId: 'status',
      propertyPatch: { color: 'green' },
    }),
  },
  {
    name: 'ensureView',
    sheetId: SHEET_ID,
    run: (query) => ensureView({
      query,
      projectId: PROJECT_ID,
      sheetId: SHEET_ID,
      descriptor: { id: 'grid', objectId: OBJECT_ID, name: 'View', type: 'grid' },
    }),
  },
  {
    name: 'createView',
    sheetId: SHEET_ID,
    run: (query) => createView({ query, viewId: 'view_dh1', sheetId: SHEET_ID, name: 'View' }),
  },
  {
    name: 'ensureMissingObjectFields',
    sheetId: OBJECT_SHEET_ID,
    run: (query) => ensureMissingObjectFields({
      query,
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      fields: [{ id: 'new_field', name: 'New Field', type: 'string' }],
    }),
  },
]

function firstWriteIndex(seen: SeenStatement[]): number {
  return seen.findIndex(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql))
}

describe('D-H1 provisioning writer closure', () => {
  afterEach(() => {
    delete process.env[WRITER_FENCE_ENV]
    __resetRecoveryWriterStateColumnProbe()
  })

  for (const writer of writerCases) {
    it(`${writer.name} fences the correct sheet before its first source write`, async () => {
      process.env[WRITER_FENCE_ENV] = 'true'
      __resetRecoveryWriterStateColumnProbe()
      const physicalFieldId = writer.name === 'patchObjectFieldProperty'
        ? getObjectFieldId(PROJECT_ID, OBJECT_ID, 'status')
        : undefined
      const { query, seen } = createFenceQuery({ sheetId: writer.sheetId, fieldId: physicalFieldId })

      await writer.run(query)

      const fenceIndex = seen.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock'))
      const blockIndex = seen.findIndex(({ sql }) => sql === 'SELECT recovery_writer_state FROM meta_sheets WHERE id = $1')
      const writeIndex = firstWriteIndex(seen)
      expect(fenceIndex).toBeGreaterThanOrEqual(0)
      expect(blockIndex).toBeGreaterThan(fenceIndex)
      expect(writeIndex).toBeGreaterThan(blockIndex)
      expect(seen[fenceIndex]?.params).toEqual([canonicalSheetFenceKey(writer.sheetId)])
      expect(seen[blockIndex]?.params).toEqual([writer.sheetId])
    })

    it(`${writer.name} refuses an archiving owner before any source write`, async () => {
      process.env[WRITER_FENCE_ENV] = 'true'
      __resetRecoveryWriterStateColumnProbe()
      const physicalFieldId = writer.name === 'patchObjectFieldProperty'
        ? getObjectFieldId(PROJECT_ID, OBJECT_ID, 'status')
        : undefined
      const { query, seen } = createFenceQuery({
        sheetId: writer.sheetId,
        fieldId: physicalFieldId,
        blocked: true,
      })

      await expect(writer.run(query)).rejects.toBeInstanceOf(SheetWriterBlockedError)
      expect(firstWriteIndex(seen)).toBe(-1)
    })
  }

  for (const writer of writerCases) {
    it(`${writer.name} keeps all new fence traffic absent while the writer-fence flag is OFF`, async () => {
      __resetRecoveryWriterStateColumnProbe()
      const physicalFieldId = writer.name === 'patchObjectFieldProperty'
        ? getObjectFieldId(PROJECT_ID, OBJECT_ID, 'status')
        : undefined
      const { query, seen } = createFenceQuery({ sheetId: writer.sheetId, fieldId: physicalFieldId })

      await writer.run(query)

      expect(seen.some(({ sql }) => sql.includes('information_schema.columns'))).toBe(false)
      expect(seen.some(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBe(false)
      expect(seen.some(({ sql }) => sql.includes('recovery_writer_state'))).toBe(false)
    })
  }
})
