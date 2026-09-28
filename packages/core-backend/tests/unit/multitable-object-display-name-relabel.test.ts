import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MANAGED_TABLE_RELABEL_ENABLED_ENV,
  MultitableRelabelDisabledError,
  MultitableRelabelInputError,
  MultitableRelabelPlanChangedError,
  MultitableRelabelScopeError,
  computeRelabelPlanDigest,
  isManagedTableRelabelApplyEnabled,
  relabelObjectDisplayNames,
  runRelabelObjectDisplayNamesWith,
  type RelabelObjectDisplayNamesArgs,
} from '../../src/multitable/object-display-name-relabel'
import { getObjectFieldId, getObjectSheetId } from '../../src/multitable/provisioning'
import {
  createPluginScopedMultitableApi,
  MultitableProjectNamespaceError,
  MultitableObjectScopeError,
} from '../../src/multitable/plugin-scope'
import type { MultitableAPI } from '../../src/types/plugin'

/**
 * 客户反馈 2026-09-24 #4a — the audited, compare-and-set relabel of an already-provisioned object.
 *
 * The fake below HONOURS THE SQL it is handed rather than hard-coding the safe semantics: the
 * compare half of each UPDATE is enforced only if the statement actually carries `AND name = $n`,
 * the registry answers only the columns the statement filters on, and any statement the primitive
 * is not expected to issue THROWS. A mutation that drops a guard from the SQL therefore changes
 * what the fake does, and the assertions see it.
 *
 * WHAT THIS FAKE CANNOT PROVE: row-lock behaviour. It records that the write leg ASKS for
 * `FOR UPDATE` on the sheet row and the field rows (and the dry run does not), but whether PostgreSQL
 * then blocks a concurrent writer is only provable against a real database — see the realdb follow-up
 * named in the PR.
 */

type FieldRow = { id: string; sheet_id: string; name: string; type: string; property: Record<string, unknown>; order: number }
type SheetRow = { id: string; base_id: string | null; name: string; deleted_at: string | null }
type RegistryRow = { sheet_id: string; project_id: string; object_id: string }
type RevisionRow = {
  id: string
  sheet_id: string
  entity_type: string
  entity_id: string
  action: string
  before: unknown
  after: unknown
  changed_keys: string[]
  batch_id: string | null
  actor_id: string | null
}

const TENANT_A_PROJECT = 'tenant_a:integration-core'
const TENANT_B_PROJECT = 'tenant_b:integration-core'
const LEDGER = 'plm_stock_preparation_confirmation_decision'

const LEDGER_FIELDS: Array<{ id: string; en: string; zh: string }> = [
  { id: 'decisionId', en: 'Decision ID', zh: '裁决ID' },
  { id: 'status', en: 'Status', zh: '状态' },
  { id: 'conflictType', en: 'Conflict Type', zh: '冲突类型' },
  { id: 'notes', en: 'Notes', zh: '备注' },
]
const SHEET_EN = 'Stock Preparation Confirmation Decision'
const SHEET_ZH = '备料确认账本'

function sheetIdOf(projectId: string, objectId = LEDGER): string {
  return getObjectSheetId(projectId, objectId)
}

function fieldIdOf(projectId: string, fieldId: string, objectId = LEDGER): string {
  return getObjectFieldId(projectId, objectId, fieldId)
}

function createFakeDb() {
  const sheets: SheetRow[] = []
  const fields: FieldRow[] = []
  const registry: RegistryRow[] = []
  const revisions: RevisionRow[] = []
  // `field_permissions` rows exist in the fake so that "permissions unchanged" is an observation, not
  // an absence of code: the primitive must never issue a statement against this table.
  const fieldPermissions: Array<{ sheet_id: string; field_id: string; subject: string; can_write: boolean }> = []
  const statements: string[] = []
  // Optional race hook: runs after the field SELECT, before any UPDATE (a concurrent rename).
  let afterFieldRead: (() => void) | null = null

  function provision(projectId: string, options: { baseId?: string | null; register?: boolean; sheetName?: string } = {}) {
    const sheetId = sheetIdOf(projectId)
    sheets.push({ id: sheetId, base_id: options.baseId ?? 'base_sp', name: options.sheetName ?? SHEET_EN, deleted_at: null })
    LEDGER_FIELDS.forEach((field, order) => {
      fields.push({
        id: fieldIdOf(projectId, field.id),
        sheet_id: sheetId,
        name: field.en,
        type: 'string',
        property: { validation: [{ type: 'required' }], stockPreparationConfirmationDecision: { ownership: 'plm_system' } },
        order,
      })
      fieldPermissions.push({ sheet_id: sheetId, field_id: fieldIdOf(projectId, field.id), subject: 'role:operator', can_write: false })
    })
    if (options.register !== false) registry.push({ sheet_id: sheetId, project_id: projectId, object_id: LEDGER })
    return sheetId
  }

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    statements.push(normalized)
    if (/field_permissions/i.test(normalized)) throw new Error(`the relabel must never touch field_permissions: ${normalized}`)

    if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] }
    if (normalized.startsWith('SELECT 1 FROM information_schema.columns')) return { rows: [] }

    if (normalized.startsWith('SELECT 1 FROM plugin_multitable_object_registry')) {
      // Filter on exactly the columns the statement names — dropping one from the SQL widens the match.
      const rows = registry.filter((row) =>
        (!/sheet_id = \$1/.test(normalized) || row.sheet_id === params[0])
        && (!/project_id = \$2/.test(normalized) || row.project_id === params[1])
        && (!/object_id = \$3/.test(normalized) || row.object_id === params[2]))
      return { rows: rows.map(() => ({ '?column?': 1 })) }
    }
    if (normalized.startsWith('SELECT id, base_id, name FROM meta_sheets WHERE id = $1')) {
      const row = sheets.find((sheet) => sheet.id === params[0] && sheet.deleted_at === null)
      return { rows: row ? [{ ...row }] : [] }
    }
    if (normalized.startsWith('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1')) {
      const rows = fields.filter((field) => field.sheet_id === params[0]).map((field) => ({ ...field, property: JSON.parse(JSON.stringify(field.property)) }))
      if (afterFieldRead) {
        const hook = afterFieldRead
        afterFieldRead = null
        hook()
      }
      return { rows }
    }
    if (normalized.startsWith('SELECT 1 FROM meta_sheets WHERE id <> $1')) {
      const [sheetId, baseId, name] = params as [string, string | null, string]
      const rows = sheets.filter((sheet) => sheet.id !== sheetId && sheet.deleted_at === null && sheet.base_id === baseId && sheet.name === name)
      return { rows: rows.map(() => ({ '?column?': 1 })) }
    }
    if (normalized.startsWith('UPDATE meta_fields SET name = $3')) {
      const [id, sheetId, nextName, expectedName] = params as [string, string, string, string]
      const casClause = /AND name = \$4/.test(normalized)
      const row = fields.find((field) => field.id === id && field.sheet_id === sheetId && (!casClause || field.name === expectedName))
      if (!row) return { rows: [], rowCount: 0 }
      row.name = nextName
      if (/property = /.test(normalized)) row.property = {}
      return { rows: [{ id: row.id, name: row.name, type: row.type, property: row.property, order: row.order }], rowCount: 1 }
    }
    if (normalized.startsWith('UPDATE meta_sheets SET name = $2')) {
      const [id, nextName, expectedName] = params as [string, string, string]
      const casClause = /AND name = \$3/.test(normalized)
      const row = sheets.find((sheet) => sheet.id === id && sheet.deleted_at === null && (!casClause || sheet.name === expectedName))
      if (!row) return { rows: [], rowCount: 0 }
      row.name = nextName
      return { rows: [{ name: row.name }], rowCount: 1 }
    }
    if (normalized.startsWith('INSERT INTO meta_config_revisions')) {
      const [id, sheetId, entityType, entityId, action, before, after, changedKeys, batchId, actorId] = params as [
        string, string, string, string, string, string, string, string[], string | null, string | null,
      ]
      revisions.push({
        id,
        sheet_id: sheetId,
        entity_type: entityType,
        entity_id: entityId,
        action,
        before: JSON.parse(before),
        after: JSON.parse(after),
        changed_keys: changedKeys,
        batch_id: batchId,
        actor_id: actorId,
      })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL from the relabel primitive: ${normalized}`)
  })

  return {
    query,
    sheets,
    fields,
    registry,
    revisions,
    fieldPermissions,
    statements,
    provision,
    raceAfterFieldRead(hook: () => void) {
      afterFieldRead = hook
    },
    writeStatements() {
      return statements.filter((statement) => /^(UPDATE|INSERT|DELETE)\b/i.test(statement))
    },
    fieldName(projectId: string, fieldId: string) {
      return fields.find((field) => field.id === fieldIdOf(projectId, fieldId))?.name
    },
  }
}

function ledgerArgs(projectId: string, overrides: Partial<RelabelObjectDisplayNamesArgs> = {}): RelabelObjectDisplayNamesArgs {
  return {
    projectId,
    objectId: LEDGER,
    sheetName: { expectedName: SHEET_EN, nextName: SHEET_ZH },
    fields: LEDGER_FIELDS.map((field) => ({ fieldId: field.id, expectedName: field.en, nextName: field.zh })),
    actorId: 'user_admin',
    ...overrides,
  }
}

type FakeDb = ReturnType<typeof createFakeDb>

/** The only legal way to write: preview, then apply exactly that preview's digest. */
async function applyPreviewed(db: FakeDb, args: RelabelObjectDisplayNamesArgs) {
  const preview = await relabelObjectDisplayNames({ query: db.query, ...args, apply: false })
  return relabelObjectDisplayNames({ query: db.query, ...args, apply: true, expectedPlanDigest: preview.planDigest })
}

const ENV_SNAPSHOT = process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV]

beforeEach(() => {
  // The write leg is DEFAULT OFF; every suite that writes arms it explicitly, and the switch suite
  // below disarms it on purpose.
  process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV] = 'true'
})

afterEach(() => {
  delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
  if (ENV_SNAPSHOT === undefined) delete process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV]
  else process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV] = ENV_SNAPSHOT
})

describe('relabelObjectDisplayNames — compare-and-set relabel of an existing object', () => {
  it('dry run (the default) plans every untouched column and writes NOTHING', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const result = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    expect(result.present).toBe(true)
    expect(result.applied).toBe(false)
    expect(result.fields.map((entry) => entry.status)).toEqual(['would_rename', 'would_rename', 'would_rename', 'would_rename'])
    expect(result.sheetName).toEqual({ status: 'would_rename' })
    expect(result.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.revisionCount).toBe(0)
    expect(result.batchId).toBeNull()
    expect(db.writeStatements()).toEqual([])
    expect(db.revisions).toEqual([])
    expect(db.fieldName(TENANT_A_PROJECT, 'status')).toBe('Status')
  })

  it('`apply` must be exactly true — a truthy non-boolean is still a dry run', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const result = await relabelObjectDisplayNames({
      query: db.query,
      ...ledgerArgs(TENANT_A_PROJECT),
      apply: 'true' as unknown as boolean,
    })
    expect(result.applied).toBe(false)
    expect(db.writeStatements()).toEqual([])
  })

  it('untouched → renamed: every English column and the sheet get their Chinese name', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const result = await applyPreviewed(db, ledgerArgs(TENANT_A_PROJECT))
    expect(result.applied).toBe(true)
    expect(result.fields).toEqual(LEDGER_FIELDS.map((field) => ({ fieldId: field.id, status: 'renamed' })))
    expect(result.sheetName).toEqual({ status: 'renamed' })
    for (const field of LEDGER_FIELDS) expect(db.fieldName(TENANT_A_PROJECT, field.id)).toBe(field.zh)
    expect(db.sheets[0].name).toBe(SHEET_ZH)
  })

  it('field ids, type, property, order and field permissions are unchanged — only `name` moves', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const before = JSON.parse(JSON.stringify(db.fields))
    const permissionsBefore = JSON.parse(JSON.stringify(db.fieldPermissions))
    await applyPreviewed(db, ledgerArgs(TENANT_A_PROJECT))
    expect(db.fields.map((field) => field.id)).toEqual(before.map((field: FieldRow) => field.id))
    expect(db.fields.map(({ name: _name, ...rest }) => rest)).toEqual(before.map(({ name: _name, ...rest }: FieldRow) => rest))
    expect(db.fieldPermissions).toEqual(permissionsBefore)
    // The only UPDATE statements are name-only; nothing sets type/property/order. Both renames stamp
    // updated_at (field and sheet alike).
    for (const statement of db.writeStatements().filter((s) => s.startsWith('UPDATE meta_fields'))) {
      expect(statement).toMatch(/^UPDATE meta_fields SET name = \$3, updated_at = now\(\) WHERE/)
    }
    const sheetUpdates = db.writeStatements().filter((s) => s.startsWith('UPDATE meta_sheets'))
    expect(sheetUpdates).toHaveLength(1)
    expect(sheetUpdates[0]).toMatch(/^UPDATE meta_sheets SET name = \$2, updated_at = now\(\) WHERE/)
  })

  it('records ONE config revision per rename (field + sheet_config), name-only diff, one batch, the actor', async () => {
    const db = createFakeDb()
    const sheetId = db.provision(TENANT_A_PROJECT)
    const result = await applyPreviewed(db, ledgerArgs(TENANT_A_PROJECT))
    expect(result.revisionCount).toBe(LEDGER_FIELDS.length + 1)
    expect(db.revisions).toHaveLength(LEDGER_FIELDS.length + 1)
    const fieldRevisions = db.revisions.filter((revision) => revision.entity_type === 'field')
    expect(fieldRevisions.map((revision) => revision.entity_id)).toEqual(LEDGER_FIELDS.map((field) => fieldIdOf(TENANT_A_PROJECT, field.id)))
    fieldRevisions.forEach((revision, index) => {
      expect(revision).toMatchObject({
        sheet_id: sheetId,
        action: 'update',
        before: { name: LEDGER_FIELDS[index].en },
        after: { name: LEDGER_FIELDS[index].zh },
        changed_keys: ['name'],
        actor_id: 'user_admin',
      })
    })
    const sheetRevision = db.revisions.find((revision) => revision.entity_type === 'sheet_config')
    expect(sheetRevision).toMatchObject({
      sheet_id: sheetId,
      entity_id: sheetId,
      before: { name: SHEET_EN },
      after: { name: SHEET_ZH },
      changed_keys: ['name'],
    })
    expect(new Set(db.revisions.map((revision) => revision.batch_id))).toEqual(new Set([result.batchId]))
    expect(result.batchId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('hand-renamed → skipped_name_changed, left exactly as the person named it, no revision', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT, { sheetName: '我们的裁决表' })
    const status = db.fields.find((field) => field.id === fieldIdOf(TENANT_A_PROJECT, 'status'))!
    status.name = '处理状态'
    // The DRY RUN must already say so. The apply leg alone cannot prove this: its SQL compare would
    // also refuse the rename, so a plan that promised `would_rename` for a hand-renamed column (and
    // lied to the admin in the preview) would still leave the apply assertions below green.
    const plan = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    expect(plan.fields.find((entry) => entry.fieldId === 'status')).toEqual({ fieldId: 'status', status: 'skipped_name_changed' })
    expect(plan.sheetName).toEqual({ status: 'skipped_name_changed' })
    const result = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: plan.planDigest })
    expect(result.fields.find((entry) => entry.fieldId === 'status')).toEqual({ fieldId: 'status', status: 'skipped_name_changed' })
    expect(result.sheetName).toEqual({ status: 'skipped_name_changed' })
    expect(db.fieldName(TENANT_A_PROJECT, 'status')).toBe('处理状态')
    expect(db.sheets[0].name).toBe('我们的裁决表')
    expect(db.revisions.map((revision) => revision.entity_id)).not.toContain(fieldIdOf(TENANT_A_PROJECT, 'status'))
    // The others still went through.
    expect(db.fieldName(TENANT_A_PROJECT, 'decisionId')).toBe('裁决ID')
    // Values-free: the person's name for the column appears nowhere in the result.
    expect(JSON.stringify(result)).not.toContain('处理状态')
    expect(JSON.stringify(result)).not.toContain('我们的裁决表')
  })

  it('target name already used by ANOTHER field on the sheet → skipped_name_taken, no duplicate created', async () => {
    const db = createFakeDb()
    const sheetId = db.provision(TENANT_A_PROJECT)
    // A pack/extension column already carries 备注.
    db.fields.push({ id: 'fld_ext_notes', sheet_id: sheetId, name: '备注', type: 'string', property: {}, order: 99 })
    const result = await applyPreviewed(db, ledgerArgs(TENANT_A_PROJECT))
    expect(result.fields.find((entry) => entry.fieldId === 'notes')).toEqual({ fieldId: 'notes', status: 'skipped_name_taken' })
    expect(db.fieldName(TENANT_A_PROJECT, 'notes')).toBe('Notes')
    expect(db.fields.filter((field) => field.sheet_id === sheetId && field.name === '备注')).toHaveLength(1)
  })

  it('two requests aiming at the SAME target are both skipped rather than racing to a duplicate', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const args = ledgerArgs(TENANT_A_PROJECT, {
      sheetName: null,
      fields: [
        { fieldId: 'status', expectedName: 'Status', nextName: '状态' },
        { fieldId: 'conflictType', expectedName: 'Conflict Type', nextName: '状态' },
      ],
    })
    const result = await applyPreviewed(db, args)
    expect(result.fields.map((entry) => entry.status)).toEqual(['skipped_name_taken', 'skipped_name_taken'])
    expect(db.writeStatements()).toEqual([])
  })

  it('sheet name already used by a sibling sheet in the same base → skipped_name_taken', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    db.sheets.push({ id: 'sheet_copy', base_id: 'base_sp', name: SHEET_ZH, deleted_at: null })
    const result = await applyPreviewed(db, ledgerArgs(TENANT_A_PROJECT))
    expect(result.sheetName).toEqual({ status: 'skipped_name_taken' })
    expect(db.sheets[0].name).toBe(SHEET_EN)
  })

  it('a sheet name another table of the SAME plan is about to take (takenSheetNames) → skipped_name_taken in the PREVIEW', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const args = ledgerArgs(TENANT_A_PROJECT, { takenSheetNames: [SHEET_ZH] })
    const preview = await relabelObjectDisplayNames({ query: db.query, ...args })
    expect(preview.sheetName).toEqual({ status: 'skipped_name_taken' })
    const result = await relabelObjectDisplayNames({ query: db.query, ...args, apply: true, expectedPlanDigest: preview.planDigest })
    expect(result.sheetName).toEqual({ status: 'skipped_name_taken' })
    expect(db.sheets[0].name).toBe(SHEET_EN)
    // …and the fields of that same table still go through.
    expect(db.fieldName(TENANT_A_PROJECT, 'status')).toBe('状态')
  })

  it('second run is a no-op: everything already_target, zero writes, zero revisions', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    await applyPreviewed(db, ledgerArgs(TENANT_A_PROJECT))
    const revisionsAfterFirst = db.revisions.length
    db.statements.length = 0
    const second = await applyPreviewed(db, ledgerArgs(TENANT_A_PROJECT))
    expect(second.fields.map((entry) => entry.status)).toEqual(['already_target', 'already_target', 'already_target', 'already_target'])
    expect(second.sheetName).toEqual({ status: 'already_target' })
    expect(second.revisionCount).toBe(0)
    expect(second.batchId).toBeNull()
    expect(db.revisions).toHaveLength(revisionsAfterFirst)
    expect(db.writeStatements()).toEqual([])
  })

  it('a concurrent rename between the read and the write is reported, not overwritten (the SQL compare half)', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const preview = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    db.raceAfterFieldRead(() => {
      db.fields.find((field) => field.id === fieldIdOf(TENANT_A_PROJECT, 'status'))!.name = '有人刚改的'
      // The sheet row was read BEFORE this point too, so its rename must also lose on the SQL compare.
      db.sheets[0].name = '有人刚改的表名'
    })
    const result = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: preview.planDigest })
    expect(result.fields.find((entry) => entry.fieldId === 'status')).toEqual({ fieldId: 'status', status: 'skipped_name_changed' })
    expect(db.fieldName(TENANT_A_PROJECT, 'status')).toBe('有人刚改的')
    expect(db.revisions.map((revision) => revision.entity_id)).not.toContain(fieldIdOf(TENANT_A_PROJECT, 'status'))
    expect(result.sheetName).toEqual({ status: 'skipped_name_changed' })
    expect(db.sheets[0].name).toBe('有人刚改的表名')
    expect(db.revisions.some((revision) => revision.entity_type === 'sheet_config')).toBe(false)
  })

  it('a field the sheet does not have → missing', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const args = ledgerArgs(TENANT_A_PROJECT, {
      fields: [{ fieldId: 'supersededAt', expectedName: 'Superseded At', nextName: '作废时间' }],
      sheetName: null,
    })
    const result = await applyPreviewed(db, args)
    expect(result.fields).toEqual([{ fieldId: 'supersededAt', status: 'missing' }])
  })

  it('an object with no live sheet answers present:false and writes nothing', async () => {
    const db = createFakeDb()
    db.registry.push({ sheet_id: sheetIdOf(TENANT_A_PROJECT), project_id: TENANT_A_PROJECT, object_id: LEDGER })
    const result = await applyPreviewed(db, ledgerArgs(TENANT_A_PROJECT))
    expect(result.present).toBe(false)
    expect(db.writeStatements()).toEqual([])
  })
})

describe('relabelObjectDisplayNames — preview == apply (planDigest)', () => {
  it('the digest is stable across identical dry runs and covers exactly the would-be renames', async () => {
    const db = createFakeDb()
    const sheetId = db.provision(TENANT_A_PROJECT)
    const first = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    const second = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    expect(second.planDigest).toBe(first.planDigest)
    expect(first.planDigest).toBe(computeRelabelPlanDigest(sheetId, [
      { entity: 'sheet', from: SHEET_EN, to: SHEET_ZH },
      ...LEDGER_FIELDS.map((field) => ({ entity: `field:${field.id}`, from: field.en, to: field.zh })),
    ]))
  })

  it('apply WITHOUT a digest is refused before any statement', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    await expect(relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT), apply: true })).rejects.toBeInstanceOf(MultitableRelabelInputError)
    await expect(relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: 'sha256:nothex' })).rejects.toBeInstanceOf(MultitableRelabelInputError)
    expect(db.statements).toEqual([])
  })

  it('the tables moved after the preview → PLAN_CHANGED, and NOTHING is written', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const preview = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    // After the preview someone renames a column BACK to English — the apply would now rename one
    // more column than the admin saw.
    db.fields.find((field) => field.id === fieldIdOf(TENANT_A_PROJECT, 'notes'))!.name = '随手备注'
    await expect(
      relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: preview.planDigest }),
    ).rejects.toBeInstanceOf(MultitableRelabelPlanChangedError)
    expect(db.writeStatements()).toEqual([])
    expect(db.revisions).toEqual([])
    expect(db.fieldName(TENANT_A_PROJECT, 'status')).toBe('Status')
  })

  it('a digest of ANOTHER plan (another table) is refused with nothing written', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    db.provision(TENANT_B_PROJECT)
    const otherPreview = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_B_PROJECT) })
    await expect(
      relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: otherPreview.planDigest }),
    ).rejects.toBeInstanceOf(MultitableRelabelPlanChangedError)
    expect(db.writeStatements()).toEqual([])
  })
})

describe('relabelObjectDisplayNames — the operator switch (default OFF)', () => {
  it('reads exactly the literal "true": unset / TRUE / 1 / " true" are all OFF', () => {
    expect(isManagedTableRelabelApplyEnabled({})).toBe(false)
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '']) {
      expect(isManagedTableRelabelApplyEnabled({ [MANAGED_TABLE_RELABEL_ENABLED_ENV]: value }), JSON.stringify(value)).toBe(false)
    }
    expect(isManagedTableRelabelApplyEnabled({ [MANAGED_TABLE_RELABEL_ENABLED_ENV]: 'true' })).toBe(true)
  })

  it('switch off: the write leg is refused BEFORE ANY statement (no fence, no lock, no read)', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const preview = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    for (const value of [undefined, 'TRUE', '1']) {
      if (value === undefined) delete process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV]
      else process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV] = value
      db.statements.length = 0
      await expect(
        relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: preview.planDigest }),
      ).rejects.toBeInstanceOf(MultitableRelabelDisabledError)
      expect(db.statements, `switch=${String(value)}`).toEqual([])
    }
    expect(db.fieldName(TENANT_A_PROJECT, 'status')).toBe('Status')
    expect(db.revisions).toEqual([])
  })

  it('switch off: the DRY RUN still works (it writes nothing)', async () => {
    delete process.env[MANAGED_TABLE_RELABEL_ENABLED_ENV]
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const preview = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    expect(preview.fields.every((entry) => entry.status === 'would_rename')).toBe(true)
    expect(db.writeStatements()).toEqual([])
  })
})

describe('relabelObjectDisplayNames — tenancy through the object registry', () => {
  it("tenant B cannot relabel tenant A's ledger: B's derived sheet has no registry row → refused, zero writes", async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    await expect(
      relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_B_PROJECT), apply: true, expectedPlanDigest: `sha256:${'0'.repeat(64)}` }),
    ).rejects.toBeInstanceOf(MultitableRelabelScopeError)
    expect(db.writeStatements()).toEqual([])
    expect(db.fieldName(TENANT_A_PROJECT, 'status')).toBe('Status')
  })

  it('a registry row for the right sheet but ANOTHER project does not count (the triple must match)', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT, { register: false })
    db.registry.push({ sheet_id: sheetIdOf(TENANT_A_PROJECT), project_id: TENANT_B_PROJECT, object_id: LEDGER })
    await expect(
      relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) }),
    ).rejects.toBeInstanceOf(MultitableRelabelScopeError)
    expect(db.writeStatements()).toEqual([])
  })

  it('an unregistered (hand-made / dump-restored) sheet is refused on the DRY RUN too', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT, { register: false })
    await expect(relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })).rejects.toBeInstanceOf(MultitableRelabelScopeError)
  })

  it("relabelling tenant A leaves tenant B's identical ledger untouched", async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    db.provision(TENANT_B_PROJECT)
    await applyPreviewed(db, ledgerArgs(TENANT_A_PROJECT))
    for (const field of LEDGER_FIELDS) expect(db.fieldName(TENANT_B_PROJECT, field.id)).toBe(field.en)
    expect(db.sheets.find((sheet) => sheet.id === sheetIdOf(TENANT_B_PROJECT))!.name).toBe(SHEET_EN)
    expect(db.revisions.every((revision) => revision.sheet_id === sheetIdOf(TENANT_A_PROJECT))).toBe(true)
  })
})

describe('relabelObjectDisplayNames — fence, row locks and input hygiene', () => {
  it('apply takes the writer fence FIRST (before any read); a dry run takes none', async () => {
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const preview = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    expect(db.statements.some((statement) => statement.startsWith('SELECT pg_advisory_xact_lock'))).toBe(false)
    db.statements.length = 0
    await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: preview.planDigest })
    expect(db.statements[0]).toMatch(/^SELECT pg_advisory_xact_lock/)
  })

  it('apply asks for FOR UPDATE on the sheet row AND the field rows, before reading names; the dry run locks nothing', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const preview = await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT) })
    const dryReads = db.statements.filter((statement) => /FROM meta_(sheets|fields) WHERE (id|sheet_id) = \$1/.test(statement))
    expect(dryReads.length).toBeGreaterThanOrEqual(2)
    expect(dryReads.some((statement) => /FOR UPDATE/.test(statement))).toBe(false)
    db.statements.length = 0
    await relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: preview.planDigest })
    const sheetRead = db.statements.find((statement) => statement.startsWith('SELECT id, base_id, name FROM meta_sheets WHERE id = $1'))
    const fieldRead = db.statements.find((statement) => statement.startsWith('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1'))
    expect(sheetRead).toMatch(/ FOR UPDATE$/)
    expect(fieldRead).toMatch(/ ORDER BY id FOR UPDATE$/)
    // Sheet row first, then the field rows, then the first write.
    const sheetIndex = db.statements.indexOf(sheetRead!)
    const fieldIndex = db.statements.indexOf(fieldRead!)
    const firstWrite = db.statements.findIndex((statement) => /^(UPDATE|INSERT)/.test(statement))
    expect(sheetIndex).toBeLessThan(fieldIndex)
    expect(fieldIndex).toBeLessThan(firstWrite)
  })

  it('a target name that fails display-name hygiene is refused before ANY statement', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const args = ledgerArgs(TENANT_A_PROJECT, {
      fields: [{ fieldId: 'status', expectedName: 'Status', nextName: '状\uFFFD态' }],
    })
    await expect(relabelObjectDisplayNames({ query: db.query, ...args })).rejects.toBeInstanceOf(MultitableRelabelInputError)
    expect(db.statements).toEqual([])
  })

  it('refuses an untrimmed, empty, identical or duplicated request, or bad takenSheetNames, before any statement', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const bad: Array<Partial<RelabelObjectDisplayNamesArgs>> = [
      { fields: [{ fieldId: 'status', expectedName: 'Status', nextName: ' 状态' }] },
      { fields: [{ fieldId: 'status', expectedName: 'Status', nextName: '' }] },
      { fields: [{ fieldId: 'status', expectedName: 'Status', nextName: 'Status' }] },
      {
        fields: [
          { fieldId: 'status', expectedName: 'Status', nextName: '状态' },
          { fieldId: 'status', expectedName: 'Status', nextName: '状态2' },
        ],
      },
      { takenSheetNames: 'x' as unknown as string[] },
      { takenSheetNames: [' 备料确认账本'] },
    ]
    for (const overrides of bad) {
      await expect(relabelObjectDisplayNames({ query: db.query, ...ledgerArgs(TENANT_A_PROJECT, overrides) })).rejects.toBeInstanceOf(MultitableRelabelInputError)
    }
    expect(db.statements).toEqual([])
  })
})

describe('runRelabelObjectDisplayNamesWith — the host glue', () => {
  function inlineTx(db: FakeDb) {
    let runs = 0
    const withTxQuery = async <R>(run: (query: typeof db.query) => Promise<R>): Promise<R> => {
      runs += 1
      return run(db.query)
    }
    return { withTxQuery, runs: () => runs }
  }

  async function previewDigest(db: FakeDb, args: RelabelObjectDisplayNamesArgs): Promise<string> {
    return (await relabelObjectDisplayNames({ query: db.query, ...args })).planDigest
  }

  it('drops the display-name caches once, AFTER a committed write, for that sheet only', async () => {
    const db = createFakeDb()
    const sheetId = db.provision(TENANT_A_PROJECT)
    const tx = inlineTx(db)
    const afterCommit = vi.fn()
    const expectedPlanDigest = await previewDigest(db, ledgerArgs(TENANT_A_PROJECT))
    await runRelabelObjectDisplayNamesWith(tx.withTxQuery, { ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest }, afterCommit)
    expect(tx.runs()).toBe(1)
    expect(afterCommit).toHaveBeenCalledTimes(1)
    expect(afterCommit).toHaveBeenCalledWith(sheetId)
  })

  it('does not invalidate on a dry run or on a no-op re-run', async () => {
    const db = createFakeDb()
    db.provision(TENANT_A_PROJECT)
    const tx = inlineTx(db)
    const afterCommit = vi.fn()
    await runRelabelObjectDisplayNamesWith(tx.withTxQuery, ledgerArgs(TENANT_A_PROJECT), afterCommit)
    expect(afterCommit).not.toHaveBeenCalled()
    await runRelabelObjectDisplayNamesWith(tx.withTxQuery, { ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: await previewDigest(db, ledgerArgs(TENANT_A_PROJECT)) }, vi.fn())
    await runRelabelObjectDisplayNamesWith(tx.withTxQuery, { ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: await previewDigest(db, ledgerArgs(TENANT_A_PROJECT)) }, afterCommit)
    expect(afterCommit).not.toHaveBeenCalled()
  })

  it('does not invalidate when the transaction throws', async () => {
    const afterCommit = vi.fn()
    const failing = async <R>(_run: (query: never) => Promise<R>): Promise<R> => {
      throw new Error('rolled back')
    }
    await expect(runRelabelObjectDisplayNamesWith(failing, { ...ledgerArgs(TENANT_A_PROJECT), apply: true, expectedPlanDigest: `sha256:${'0'.repeat(64)}` }, afterCommit)).rejects.toThrow('rolled back')
    expect(afterCommit).not.toHaveBeenCalled()
  })
})

describe('plugin-scope — relabelObjectDisplayNames is namespace- and object-scoped', () => {
  function hostWith(relabel?: ReturnType<typeof vi.fn>) {
    const provisioning = relabel ? { relabelObjectDisplayNames: relabel } : {}
    return { provisioning, records: {} } as unknown as MultitableAPI
  }

  it('forwards only after the project-namespace and object-scope checks, with the checked ids and every input', async () => {
    const relabel = vi.fn(async (_input: unknown) => ({ present: true }))
    const assertObjectScope = vi.fn(async (_input: unknown) => undefined)
    const scoped = createPluginScopedMultitableApi(hostWith(relabel), 'plugin-integration-core', { assertObjectScope })
    const digest = `sha256:${'a'.repeat(64)}`
    await scoped.provisioning.relabelObjectDisplayNames!({ ...ledgerArgs(TENANT_A_PROJECT), takenSheetNames: ['X'], apply: true, expectedPlanDigest: digest })
    expect(assertObjectScope).toHaveBeenCalledWith({ pluginName: 'plugin-integration-core', projectId: TENANT_A_PROJECT, objectId: LEDGER })
    expect(relabel).toHaveBeenCalledTimes(1)
    expect(relabel.mock.calls[0][0]).toMatchObject({ projectId: TENANT_A_PROJECT, objectId: LEDGER, apply: true, expectedPlanDigest: digest, takenSheetNames: ['X'] })
  })

  it("refuses a project outside the plugin's namespace before the host is asked", async () => {
    const relabel = vi.fn()
    const scoped = createPluginScopedMultitableApi(hostWith(relabel), 'plugin-integration-core', { assertObjectScope: vi.fn() })
    await expect(
      scoped.provisioning.relabelObjectDisplayNames!({ ...ledgerArgs('tenant_a:plugin-attendance'), apply: true }),
    ).rejects.toBeInstanceOf(MultitableProjectNamespaceError)
    expect(relabel).not.toHaveBeenCalled()
  })

  it('refuses an object the plugin does not own before the host is asked', async () => {
    const relabel = vi.fn()
    const assertObjectScope = vi.fn(async () => {
      throw new MultitableObjectScopeError('plugin-integration-core', TENANT_A_PROJECT, LEDGER, 'unclaimed')
    })
    const scoped = createPluginScopedMultitableApi(hostWith(relabel), 'plugin-integration-core', { assertObjectScope })
    await expect(
      scoped.provisioning.relabelObjectDisplayNames!({ ...ledgerArgs(TENANT_A_PROJECT), apply: true }),
    ).rejects.toBeInstanceOf(MultitableObjectScopeError)
    expect(relabel).not.toHaveBeenCalled()
  })

  it('is absent when the host does not provide it (optional capability, truthful feature detection)', () => {
    const scoped = createPluginScopedMultitableApi(hostWith(), 'plugin-integration-core', {})
    expect(scoped.provisioning.relabelObjectDisplayNames).toBeUndefined()
  })
})
