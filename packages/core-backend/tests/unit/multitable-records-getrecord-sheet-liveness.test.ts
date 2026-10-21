/**
 * #5833 — plugin-SDK `records.getRecord` must apply the same sheet-liveness contract as its siblings
 * (`patchRecord` / `createRecord` / `deleteRecord` all go through `loadSheetAndFields`, which refuses a
 * soft-deleted or absent sheet with `MultitableRecordNotFoundError('Sheet not found: <id>')`).
 *
 * Before the fix `getRecord` ran `SELECT … FROM meta_records WHERE id=$1 AND sheet_id=$2` directly, so the
 * after-sales plugin (which falls back to a derived sheet id once its sheet is soft-deleted) could still
 * read records back out of a deleted sheet.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

import { createPluginScopedMultitableApi } from '../../src/multitable/plugin-scope'
import {
  createRecord,
  deleteRecord,
  getRecord,
  MultitableRecordNotFoundError,
  patchRecord,
  type MultitableRecordsQueryFn,
} from '../../src/multitable/records'

const LIVE = 'sheet_live'
const DELETED = 'sheet_deleted'
const ABSENT = 'sheet_absent'

const RECORD_SELECT = 'SELECT id, sheet_id, version, data, locked, locked_by, locked_at FROM meta_records'

type Sheet = { id: string; base_id: string; name: string; description: null; deleted_at: string | null }

function createFakeDb() {
  const sheets: Sheet[] = [
    { id: LIVE, base_id: 'base_a', name: 'Live', description: null, deleted_at: null },
    { id: DELETED, base_id: 'base_a', name: 'Gone', description: null, deleted_at: '2026-09-01T00:00:00Z' },
  ]
  const fields = [LIVE, DELETED].map((sheetId) => ({
    id: `fld_${sheetId}`,
    sheet_id: sheetId,
    name: 'Title',
    type: 'string',
    property: {},
    order: 0,
  }))
  // Records physically still exist under BOTH sheets — soft delete does not remove them.
  const records = [
    { id: 'rec_live', sheet_id: LIVE, version: 3, data: { [`fld_${LIVE}`]: 'alive' }, locked: false, locked_by: null, locked_at: null },
    { id: 'rec_dead', sheet_id: DELETED, version: 1, data: { [`fld_${DELETED}`]: 'leak' }, locked: false, locked_by: null, locked_at: null },
  ]
  const log: Array<{ sql: string; params: unknown[] }> = []

  const query: MultitableRecordsQueryFn = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim()
    log.push({ sql: s, params: [...params] })
    if (s.includes('FROM meta_sheets') && s.includes('WHERE id = $1')) {
      const liveOnly = s.includes('deleted_at IS NULL')
      return {
        rows: sheets.filter((sheet) => sheet.id === params[0] && (!liveOnly || sheet.deleted_at === null)),
      }
    }
    if (s.includes('FROM meta_fields') && s.includes('WHERE sheet_id = $1')) {
      return { rows: fields.filter((field) => field.sheet_id === params[0]) }
    }
    if (s.startsWith(RECORD_SELECT)) {
      return { rows: records.filter((r) => r.id === params[0] && r.sheet_id === params[1]) }
    }
    if (s.startsWith('SELECT locked, locked_by, created_by FROM meta_records')) {
      return {
        rows: records
          .filter((r) => r.id === params[0] && r.sheet_id === params[1])
          .map(() => ({ locked: false, locked_by: null, created_by: null })),
      }
    }
    if (s.startsWith('UPDATE meta_records')) return { rows: [{ version: 4 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }

  const recordSelects = () => log.filter((entry) => entry.sql.startsWith(RECORD_SELECT))
  const sheetSelects = () => log.filter((entry) => entry.sql.includes('FROM meta_sheets'))
  return { query, log, recordSelects, sheetSelects }
}

async function captureRejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the call to reject, but it resolved')
}

function shapeOf(error: Error & { code?: string }) {
  return { ctor: error.constructor, code: error.code, message: error.message }
}

describe('#5833 records.getRecord sheet liveness', () => {
  it('soft-deleted sheet: getRecord refuses exactly like patchRecord/deleteRecord and never runs the record SELECT', async () => {
    const db = createFakeDb()
    const getErr = await captureRejection(getRecord({ query: db.query, sheetId: DELETED, recordId: 'rec_dead' }))
    expect(getErr).toBeInstanceOf(MultitableRecordNotFoundError)
    expect(shapeOf(getErr)).toEqual({
      ctor: MultitableRecordNotFoundError,
      code: 'NOT_FOUND',
      message: `Sheet not found: ${DELETED}`,
    })
    expect(db.recordSelects()).toEqual([])
    // The liveness probe was issued for THIS sheet id, not some other id.
    expect(db.sheetSelects().map((entry) => entry.params)).toEqual([[DELETED]])

    const patchErr = await captureRejection(patchRecord({
      query: createFakeDb().query,
      sheetId: DELETED,
      recordId: 'rec_dead',
      changes: { [`fld_${DELETED}`]: 'x' },
    }))
    const deleteErr = await captureRejection(deleteRecord({ query: createFakeDb().query, sheetId: DELETED, recordId: 'rec_dead' }))
    const createErr = await captureRejection(createRecord({ query: createFakeDb().query, sheetId: DELETED, data: {} }))
    expect(shapeOf(patchErr)).toEqual(shapeOf(getErr))
    expect(shapeOf(deleteErr)).toEqual(shapeOf(getErr))
    expect(shapeOf(createErr)).toEqual(shapeOf(getErr))
  })

  it('absent sheet: same refusal as the siblings, no record SELECT', async () => {
    const db = createFakeDb()
    const getErr = await captureRejection(getRecord({ query: db.query, sheetId: ABSENT, recordId: 'rec_live' }))
    const patchErr = await captureRejection(patchRecord({ query: createFakeDb().query, sheetId: ABSENT, recordId: 'rec_live', changes: {} }))
    const deleteErr = await captureRejection(deleteRecord({ query: createFakeDb().query, sheetId: ABSENT, recordId: 'rec_live' }))
    expect(shapeOf(getErr)).toEqual({
      ctor: MultitableRecordNotFoundError,
      code: 'NOT_FOUND',
      message: `Sheet not found: ${ABSENT}`,
    })
    expect(shapeOf(patchErr)).toEqual(shapeOf(getErr))
    expect(shapeOf(deleteErr)).toEqual(shapeOf(getErr))
    expect(db.recordSelects()).toEqual([])
  })

  it('a deleted sheet is refused even when another (live) sheet exists — the probe is bound to input.sheetId', async () => {
    const db = createFakeDb()
    await expect(getRecord({ query: db.query, sheetId: DELETED, recordId: 'rec_dead' }))
      .rejects.toThrow(`Sheet not found: ${DELETED}`)
    await expect(getRecord({ query: db.query, sheetId: LIVE, recordId: 'rec_live' }))
      .resolves.toMatchObject({ id: 'rec_live', sheetId: LIVE })
  })

  it('live sheet: unchanged result, one liveness probe then the record SELECT', async () => {
    const db = createFakeDb()
    await expect(getRecord({ query: db.query, sheetId: LIVE, recordId: 'rec_live' })).resolves.toEqual({
      id: 'rec_live',
      sheetId: LIVE,
      version: 3,
      data: { [`fld_${LIVE}`]: 'alive' },
      locked: false,
      lockedBy: null,
      lockedAt: null,
    })
    expect(db.log.map((entry) => (entry.sql.includes('FROM meta_sheets') ? 'sheet' : entry.sql.startsWith(RECORD_SELECT) ? 'record' : entry.sql)))
      .toEqual(['sheet', 'record'])
    expect(db.recordSelects()[0]?.params).toEqual(['rec_live', LIVE])
  })

  it('live sheet, missing record: still "Record not found"', async () => {
    const db = createFakeDb()
    await expect(getRecord({ query: db.query, sheetId: LIVE, recordId: 'rec_nope' }))
      .rejects.toThrow('Record not found: rec_nope')
  })

  it('patchRecord on a live sheet still probes liveness exactly once (inner read does not re-probe)', async () => {
    const db = createFakeDb()
    await patchRecord({ query: db.query, sheetId: LIVE, recordId: 'rec_live', changes: { [`fld_${LIVE}`]: 'y' } })
    expect(db.sheetSelects()).toHaveLength(1)
    expect(db.recordSelects()).toHaveLength(1)
  })

  it('plugin-scoped API surfaces the same refusal after the scope hook passes', async () => {
    const db = createFakeDb()
    const assertSheetScope = vi.fn(async () => ({ registered: true }))
    const bound = <T extends { query?: unknown }>(fn: (input: any) => Promise<unknown>) =>
      vi.fn(async (input: T) => fn({ ...input, query: db.query }))
    const multitable = {
      provisioning: {},
      records: {
        listRecords: vi.fn(),
        queryRecords: vi.fn(),
        createRecord: bound(createRecord),
        getRecord: bound(getRecord),
        patchRecord: bound(patchRecord),
        deleteRecord: bound(deleteRecord),
      },
    }
    const scoped = createPluginScopedMultitableApi(multitable as any, 'plugin-after-sales', { assertSheetScope })

    const scopedErr = await captureRejection(scoped.records.getRecord({ sheetId: DELETED, recordId: 'rec_dead' }))
    const directErr = await captureRejection(getRecord({ query: createFakeDb().query, sheetId: DELETED, recordId: 'rec_dead' }))
    expect(assertSheetScope).toHaveBeenCalledWith({ pluginName: 'plugin-after-sales', sheetId: DELETED })
    expect(shapeOf(scopedErr)).toEqual(shapeOf(directErr))
    expect(db.recordSelects()).toEqual([])
    await expect(scoped.records.getRecord({ sheetId: LIVE, recordId: 'rec_live' }))
      .resolves.toMatchObject({ id: 'rec_live', version: 3 })
  })

  describe('wiring (AST)', () => {
    const SRC = join(__dirname, '../../src')
    const parse = (rel: string) => {
      const text = readFileSync(join(SRC, rel), 'utf8')
      return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    }
    const walk = (node: ts.Node, visit: (n: ts.Node) => void) => {
      visit(node)
      node.forEachChild((child) => walk(child, visit))
    }
    const propName = (node: ts.PropertyAssignment | ts.MethodDeclaration) =>
      ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : ''

    it('createCoreAPI plugin SDK records.getRecord delegates to records.ts getRecord (no raw bypass)', () => {
      const sf = parse('index.ts')
      const localAliases = new Set<string>()
      walk(sf, (n) => {
        if (
          ts.isImportDeclaration(n)
          && ts.isStringLiteral(n.moduleSpecifier)
          && n.moduleSpecifier.text === './multitable/records'
          && n.importClause?.namedBindings
          && ts.isNamedImports(n.importClause.namedBindings)
        ) {
          for (const el of n.importClause.namedBindings.elements) {
            if ((el.propertyName ?? el.name).text === 'getRecord') localAliases.add(el.name.text)
          }
        }
      })
      expect([...localAliases]).toEqual(['getMultitableRecord'])

      const wrappers: ts.PropertyAssignment[] = []
      walk(sf, (n) => {
        if (
          ts.isPropertyAssignment(n)
          && propName(n) === 'getRecord'
          && ts.isObjectLiteralExpression(n.parent)
          && ts.isPropertyAssignment(n.parent.parent)
          && propName(n.parent.parent) === 'records'
        ) {
          wrappers.push(n)
        }
      })
      expect(wrappers.length).toBeGreaterThanOrEqual(1)
      for (const wrapper of wrappers) {
        const calls: string[] = []
        let rawMetaRecords = false
        walk(wrapper.initializer, (n) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n.expression.text)
          if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) && /meta_records/.test(n.text)) {
            rawMetaRecords = true
          }
        })
        expect(calls.filter((c) => localAliases.has(c))).toHaveLength(1)
        expect(rawMetaRecords).toBe(false)
      }
    })

    it('records.ts: the unchecked row reader is private and only used by getRecord and patchRecord', () => {
      const sf = parse('multitable/records.ts')
      const HELPER = 'loadRecordRowForLiveSheet'
      let helperExported: boolean | null = null
      const callers: string[] = []
      walk(sf, (n) => {
        if (ts.isFunctionDeclaration(n) && n.name?.text === HELPER) {
          helperExported = (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        }
        if (ts.isExportSpecifier(n) && (n.propertyName ?? n.name).text === HELPER) helperExported = true
        if (ts.isIdentifier(n) && n.text === HELPER && !ts.isFunctionDeclaration(n.parent)) {
          let cur: ts.Node | undefined = n.parent
          while (cur && !(ts.isFunctionDeclaration(cur) && cur.name)) cur = cur.parent
          callers.push(cur && ts.isFunctionDeclaration(cur) && cur.name ? cur.name.text : '<module>')
        }
      })
      expect(helperExported).toBe(false)
      expect(callers.sort()).toEqual(['getRecord', 'patchRecord'])
    })
  })
})
