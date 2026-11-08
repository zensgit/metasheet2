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
  PATCH_OBJECT_FIELD_PROPERTY_READ_SQL,
  type MultitableProvisioningQueryFn,
} from '../../src/multitable/provisioning'
import {
  __resetRecoveryWriterStateColumnProbe,
  canonicalSheetFenceKey,
  SheetWriterBlockedError,
} from '../../src/multitable/canonical-sheet-fence'
import { SHEET_PERMISSION_VERSIONS_BUMP_SQL, SHEET_ROW_KEY_SHARE_SQL } from '../../src/multitable/authz-version-protocol'

/** The D21 explicit sheet-version bump, whitespace-normalized the way the fake records statements. */
const SHEET_VERSION_BUMP = SHEET_PERMISSION_VERSIONS_BUMP_SQL.replace(/\s+/g, ' ').trim()
/** The sheet-row KEY SHARE an ensureFields overwrite takes right before that bump (one line already). */
const SHEET_ROW_KEY_SHARE = SHEET_ROW_KEY_SHARE_SQL.replace(/\s+/g, ' ').trim()

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
    if (normalized === SHEET_VERSION_BUMP) return { rows: [], rowCount: 1 }
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

// Lost-update guard: patchObjectFieldProperty (every plugin write of field metadata — the manual-rows switch, the PLM
// lock stamp, option sync, the pack ownership stamp) merges onto the row it READ, so the read takes the row lock. Then
// a concurrent field write waits instead of being reverted, and this patch waits behind one in flight. The real-Postgres
// interleavings are RT-3 / RT-4 / RT-7 in tests/integration/stock-preparation-field-property-race-realdb.cases.ts.
describe('patchObjectFieldProperty reads the field row under the row lock', () => {
  afterEach(() => {
    delete process.env[WRITER_FENCE_ENV]
    __resetRecoveryWriterStateColumnProbe()
  })

  const run = (query: MultitableProvisioningQueryFn) => patchObjectFieldProperty({
    query,
    projectId: PROJECT_ID,
    objectId: OBJECT_ID,
    fieldId: 'status',
    propertyPatch: { color: 'green' },
  })
  const physicalFieldId = getObjectFieldId(PROJECT_ID, OBJECT_ID, 'status')

  it('the read is FOR NO KEY UPDATE (not FOR UPDATE: FK child inserts take FOR KEY SHARE on the field row)', () => {
    expect(PATCH_OBJECT_FIELD_PROPERTY_READ_SQL).toBe(
      'SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 AND id = $2 FOR NO KEY UPDATE',
    )
  })

  it('statement order with the fence on: fence → the sheet version row (D21) → the locked read → UPDATE meta_fields SET property; one read only', async () => {
    process.env[WRITER_FENCE_ENV] = 'true'
    __resetRecoveryWriterStateColumnProbe()
    const { query, seen } = createFenceQuery({ sheetId: OBJECT_SHEET_ID, fieldId: physicalFieldId })
    await run(query)
    const fenceIndex = seen.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock'))
    const bumpIndex = seen.findIndex(({ sql }) => sql === SHEET_VERSION_BUMP)
    const readIndex = seen.findIndex(({ sql }) => sql === PATCH_OBJECT_FIELD_PROPERTY_READ_SQL)
    const updateIndex = seen.findIndex(({ sql }) => sql.startsWith('UPDATE meta_fields SET property = $3::jsonb'))
    expect(fenceIndex).toBeGreaterThanOrEqual(0)
    expect(bumpIndex).toBeGreaterThan(fenceIndex)
    expect(readIndex).toBeGreaterThan(bumpIndex)
    expect(updateIndex).toBeGreaterThan(readIndex)
    expect(seen[readIndex]?.params).toEqual([OBJECT_SHEET_ID, physicalFieldId])
    expect(seen.filter(({ sql }) => sql.includes('FROM meta_fields'))).toHaveLength(1)
  })

  it('with the fence off the read is still locked (the row lock is what closes the race there)', async () => {
    __resetRecoveryWriterStateColumnProbe()
    const { query, seen } = createFenceQuery({ sheetId: OBJECT_SHEET_ID, fieldId: physicalFieldId })
    await run(query)
    expect(seen.map(({ sql }) => sql).filter((sql) => sql.includes('FROM meta_fields'))).toEqual([PATCH_OBJECT_FIELD_PROPERTY_READ_SQL])
  })
})

// D21 field-row writer rule (authz-version-protocol.ts, the #6792 follow-up): a field writer whose write can trip the
// meta_fields visibility trigger takes the sheet version row BEFORE its first field-row lock, never through the trigger
// after it. The real-Postgres order witnesses and holder barriers are FO-P1…FO-P3 in
// tests/integration/authz-version-field-row-order-realdb.cases.ts.
describe('D21 field-row writer rule: the sheet version row before the first field-row lock', () => {
  afterEach(() => {
    delete process.env[WRITER_FENCE_ENV]
    __resetRecoveryWriterStateColumnProbe()
  })
  const physicalFieldId = getObjectFieldId(PROJECT_ID, OBJECT_ID, 'status')
  const patch = (query: MultitableProvisioningQueryFn, propertyPatch: Record<string, unknown>) => patchObjectFieldProperty({
    query, projectId: PROJECT_ID, objectId: OBJECT_ID, fieldId: 'status', propertyPatch,
  })
  const bumps = (seen: SeenStatement[]) => seen.filter(({ sql }) => sql === SHEET_VERSION_BUMP)

  for (const fence of ['on', 'off'] as const) {
    it(`patchObjectFieldProperty bumps its sheet's version row exactly once, before the locked read, whatever the patch (fence ${fence})`, async () => {
      if (fence === 'on') process.env[WRITER_FENCE_ENV] = 'true'
      __resetRecoveryWriterStateColumnProbe()
      // A patch with no visibility key, and one that hides the field: the stored row (read only under the lock)
      // decides whether the trigger fires, so the bump is unconditional.
      for (const propertyPatch of [{ color: 'green' }, { hidden: true }]) {
        const { query, seen } = createFenceQuery({ sheetId: OBJECT_SHEET_ID, fieldId: physicalFieldId })
        await patch(query, propertyPatch)
        expect(bumps(seen).map(({ params }) => params)).toEqual([[[OBJECT_SHEET_ID]]])
        const bumpIndex = seen.findIndex(({ sql }) => sql === SHEET_VERSION_BUMP)
        const firstFieldRowIndex = seen.findIndex(({ sql }) => /\bmeta_fields\b/.test(sql))
        expect(firstFieldRowIndex).toBeGreaterThan(bumpIndex)
        expect(seen[firstFieldRowIndex]?.sql).toBe(PATCH_OBJECT_FIELD_PROPERTY_READ_SQL)
        const fenceIndex = seen.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock'))
        if (fence === 'on') expect(bumpIndex).toBeGreaterThan(fenceIndex)
        else expect(fenceIndex).toBe(-1)
      }
    })
  }

  it('patchObjectFieldProperty refused by an archiving owner takes no version row (the fence check precedes the bump)', async () => {
    process.env[WRITER_FENCE_ENV] = 'true'
    __resetRecoveryWriterStateColumnProbe()
    const { query, seen } = createFenceQuery({ sheetId: OBJECT_SHEET_ID, fieldId: physicalFieldId, blocked: true })
    await expect(patch(query, { hidden: true })).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(bumps(seen)).toEqual([])
  })

  for (const overwriteMode of ['overwrite', 'observe'] as const) {
    it(`ensureFields in '${overwriteMode}' mode (it can rewrite an existing property) bumps once, before the first field-row write`, async () => {
      __resetRecoveryWriterStateColumnProbe()
      const { query, seen } = createFenceQuery({ sheetId: SHEET_ID })
      await ensureFields({
        query,
        sheetId: SHEET_ID,
        overwriteMode,
        fields: [
          { id: 'field_d21_a', name: 'A', type: 'string' },
          { id: 'field_d21_b', name: 'B', type: 'string' },
        ],
      })
      expect(bumps(seen).map(({ params }) => params)).toEqual([[[SHEET_ID]]])
      const bumpIndex = seen.findIndex(({ sql }) => sql === SHEET_VERSION_BUMP)
      const firstUpsertIndex = seen.findIndex(({ sql }) => sql.startsWith('INSERT INTO meta_fields'))
      const firstFieldStatement = seen.findIndex(({ sql }) => /\bmeta_fields\b/.test(sql))
      expect(firstUpsertIndex).toBeGreaterThan(bumpIndex)
      expect(firstFieldStatement).toBeGreaterThan(bumpIndex)
      // …and BEHIND the sheet row (verifier r1 F1): meta_sheets FOR KEY SHARE right before the bump, so the KEY SHARE the
      // INSERT of a new field takes through its FK is never first requested after the version row
      expect(seen.filter(({ sql }) => sql === SHEET_ROW_KEY_SHARE).map(({ params }) => params)).toEqual([[SHEET_ID]])
      expect(seen.findIndex(({ sql }) => sql === SHEET_ROW_KEY_SHARE)).toBe(bumpIndex - 1)
      expect(seen.slice(0, bumpIndex).some(({ sql }) => /\bmeta_fields\b/.test(sql))).toBe(false)
    })
  }

  for (const overwriteMode of ['refuse', 'preserve'] as const) {
    it(`ensureFields in '${overwriteMode}' mode takes no version row and no sheet-row lock (it rewrites an existing field only with the property its pre-read found equal)`, async () => {
      __resetRecoveryWriterStateColumnProbe()
      const { query, seen } = createFenceQuery({ sheetId: SHEET_ID })
      await ensureFields({ query, sheetId: SHEET_ID, overwriteMode, fields: [{ id: 'field_d21_c', name: 'C', type: 'string' }] })
      expect(seen.some(({ sql }) => sql.startsWith('INSERT INTO meta_fields'))).toBe(true)
      expect(bumps(seen)).toEqual([])
      expect(seen.filter(({ sql }) => sql === SHEET_ROW_KEY_SHARE)).toEqual([])
    })
  }

  it('ensureFields with no fields issues nothing at all (no fence, no version row)', async () => {
    process.env[WRITER_FENCE_ENV] = 'true'
    __resetRecoveryWriterStateColumnProbe()
    const { query, seen } = createFenceQuery({ sheetId: SHEET_ID })
    await ensureFields({ query, sheetId: SHEET_ID, overwriteMode: 'overwrite', fields: [] })
    expect(seen).toEqual([])
  })
})
