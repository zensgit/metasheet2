// YiDa standardization Y2: prepare a draft from a multitable sheet/view (owner's own permissions).
// Synthetic in-memory dependencies only; the plan builder is the actual plugin compiler.
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Request } from 'express'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  parseYidaSheetSourceInput, readYidaSheetSourceRows, YIDA_SHEET_SOURCE_LIMITS,
  type YidaSheetSourceAccess, type YidaSheetSourceDependencies, type YidaSheetSourceField,
} from '../../src/integration/yida-sheet-source'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const importNative = createRequire(import.meta.url)('../utils/yida-native-module-import.cjs') as (url: string) => Promise<Record<string, unknown>>
type Data = Record<string, unknown>
type Compiled = { planDigest: string; locatorDigest: string; plan: { rows: Array<{ payload: Data; localBusinessKey: string }> }; rowSpecs: unknown }
let compile: (input: { config: Data; rowsText: string; allocation: Data }) => Compiled

const config = () => ({ version: 2, kind: 'yida-form-protocol-static', intent: 'create',
  target: { appType: 'synthetic_sheet_app', formUuid: 'synthetic_sheet_form' },
  businessKey: ['projectNo', 'lineId', 'parentCode'], emptyKeyFields: ['parentCode'],
  fieldCatalog: [{ id: 'project', control: 'text', required: true }, { id: 'line', control: 'text', required: true },
    { id: 'parent', control: 'text', required: false }, { id: 'qty', control: 'number', required: true },
    { id: 'description', control: 'text', required: false }],
  fieldMap: [{ source: 'projectNo', target: 'project', type: 'string', required: true },
    { source: 'lineId', target: 'line', type: 'string', required: true },
    { source: 'parentCode', target: 'parent', type: 'string', required: false },
    { source: 'quantity', target: 'qty', type: 'number', required: true },
    { source: 'description', target: 'description', type: 'string', required: false }] })
const columns = [{ fieldId: 'fld_project', source: 'projectNo' }, { fieldId: 'fld_line', source: 'lineId' },
  { fieldId: 'fld_parent', source: 'parentCode' }, { fieldId: 'fld_qty', source: 'quantity' },
  { fieldId: 'fld_desc', source: 'description' }]
const fields: YidaSheetSourceField[] = [
  { id: 'fld_project', type: 'string' }, { id: 'fld_line', type: 'string' }, { id: 'fld_parent', type: 'string' },
  { id: 'fld_qty', type: 'number' }, { id: 'fld_desc', type: 'string' }, { id: 'fld_status', type: 'select' },
  { id: 'fld_formula', type: 'formula' }, { id: 'fld_secret', type: 'string' }, { id: 'fld_link', type: 'link' },
]
function record(id: string, line: string, qty: number, extra: Data = {}) {
  return { id, data: { fld_project: 'SYN-P1', fld_line: line, fld_qty: qty, fld_desc: 'synthetic part ' + line,
    fld_status: 'open', fld_secret: 'synthetic-unreadable', ...extra } }
}
type Leaf = { fieldId: string; value: unknown }
type Node = { conjunction: 'and'; conditions: Leaf[] }
function harness(patch: Partial<{ access: Partial<YidaSheetSourceAccess>; records: Array<{ id: string; data: unknown }>
  readableFields: string[]; readableRecords: string[] | null; view: { sheetId: string; filterInfo: unknown } | null }> = {}) {
  const calls: string[] = []
  const records = patch.records ?? [record('rec_1', 'SYN-L1', 6), record('rec_2', 'SYN-L2', 4), record('rec_3', 'SYN-L3', 2)]
  const dependencies: YidaSheetSourceDependencies = {
    async resolveAccess(_req, sheetId) {
      calls.push('access:' + sheetId)
      return { userId: 'synthetic-owner', isAdminRole: false, canRead: true, canExport: true, live: true, bounded: false,
        capabilities: { canRead: true }, ...patch.access }
    },
    async loadFields() { calls.push('fields'); return fields },
    async readableFieldIds(_sheet, userId) {
      calls.push('field-permissions:' + userId)
      return new Set(patch.readableFields ?? fields.filter(field => field.id !== 'fld_secret').map(field => field.id))
    },
    async loadView(viewId) { calls.push('view:' + viewId); return patch.view === undefined ? null : patch.view },
    async loadRecords(_sheet, limit) { calls.push('records:' + limit); return records.slice(0, limit) },
    async readableRecordIds(_sheet, userId, _admin, ids) {
      calls.push('record-permissions:' + userId)
      return new Set(patch.readableRecords === null || patch.readableRecords === undefined ? ids : patch.readableRecords)
    },
    filter: {
      parse: filterInfo => (filterInfo ?? null) as Node | null,
      prune: (node, keep) => {
        const kept = (node as Node).conditions.filter(leaf => keep(leaf))
        return kept.length ? { conjunction: 'and', conditions: kept } : null
      },
      leaves: node => (node as Node).conditions,
      evaluate: (node, leaf) => (node as Node).conditions.every(condition => leaf(condition)),
      leafMatches: (_type, value, leaf) => value === (leaf as Leaf).value,
      effectiveType: field => field.type,
    },
  }
  return { dependencies, calls }
}
const req = {} as Request
const source = (extra: Data = {}) => parseYidaSheetSourceInput({ kind: 'sheet', sheetId: 'sheet_synthetic', columns, ...extra })
async function code(promise: Promise<unknown>) {
  try { await promise } catch (error) {
    expect(Object.keys(error as object).sort()).toEqual(['code', 'name'])
    expect((error as Error).message).toBe((error as { code: string }).code)
    return (error as { code: string }).code
  }
  return 'NO_ERROR'
}

beforeAll(async () => {
  compile = (await importNative(pathToFileURL(path.join(root, 'plugins/plugin-integration-core/lib/yida-draft-plan.mjs')).href))
    .compileYidaDraft as typeof compile
})

describe('YiDa sheet/view source (Y2)', () => {
  it('parity: the plan built from sheet rows equals the plan built from the equivalent pasted rowsText', async () => {
    const { dependencies } = harness()
    const read = await readYidaSheetSourceRows(req, source(), dependencies)
    expect(read.rowCount).toBe(3)
    // What an owner would paste for the same three rows (empty parent omitted, as the grid shows it).
    const pasted = JSON.stringify([
      { projectNo: 'SYN-P1', lineId: 'SYN-L1', quantity: 6, description: 'synthetic part SYN-L1' },
      { projectNo: 'SYN-P1', lineId: 'SYN-L2', quantity: 4, description: 'synthetic part SYN-L2' },
      { projectNo: 'SYN-P1', lineId: 'SYN-L3', quantity: 2, description: 'synthetic part SYN-L3' },
    ])
    expect(read.rowsText).toBe(pasted)
    const fromSheet = compile({ config: config(), rowsText: read.rowsText, allocation: { mode: 'original' } })
    const fromPaste = compile({ config: config(), rowsText: pasted, allocation: { mode: 'original' } })
    expect(fromSheet.planDigest).toBe(fromPaste.planDigest)
    expect(fromSheet.plan).toEqual(fromPaste.plan)
    expect(fromSheet.rowSpecs).toEqual(fromPaste.rowSpecs)
    // Allocation consumes the same rows shape too.
    const allocation = { mode: 'equal_integer', projects: ['SYN-P1', 'SYN-P2'], projectField: 'projectNo', quantityField: 'quantity' }
    expect(compile({ config: config(), rowsText: read.rowsText, allocation }).planDigest)
      .toBe(compile({ config: config(), rowsText: pasted, allocation }).planDigest)
  })

  it('reads only with the owner permissions: no read/export, a dead or People sheet, an unreadable column are refused', async () => {
    for (const [access, expected] of [[{ canRead: false }, 'YIDA_SHEET_SOURCE_DENIED'], [{ canExport: false }, 'YIDA_SHEET_SOURCE_DENIED'],
      [{ userId: null }, 'YIDA_SHEET_SOURCE_DENIED'], [{ live: false }, 'YIDA_SHEET_SOURCE_NOT_FOUND'],
      [{ bounded: true }, 'YIDA_SHEET_SOURCE_DENIED']] as const) {
      const { dependencies, calls } = harness({ access })
      expect(await code(readYidaSheetSourceRows(req, source(), dependencies))).toBe(expected)
      expect(calls.some(call => call.startsWith('records:'))).toBe(false)
    }
    // A column the owner cannot read looks exactly like an unknown column.
    for (const fieldId of ['fld_secret', 'fld_missing']) {
      const { dependencies, calls } = harness()
      const input = parseYidaSheetSourceInput({ kind: 'sheet', sheetId: 'sheet_synthetic', columns: [...columns.slice(0, 4), { fieldId, source: 'description' }] })
      expect(await code(readYidaSheetSourceRows(req, input, dependencies))).toBe('YIDA_SHEET_SOURCE_INPUT')
      expect(calls.some(call => call.startsWith('records:'))).toBe(false)
    }
    for (const fieldId of ['fld_formula', 'fld_link']) {
      const { dependencies } = harness()
      const input = parseYidaSheetSourceInput({ kind: 'sheet', sheetId: 'sheet_synthetic', columns: [...columns.slice(0, 4), { fieldId, source: 'description' }] })
      expect(await code(readYidaSheetSourceRows(req, input, dependencies))).toBe('YIDA_SHEET_SOURCE_UNSUPPORTED')
    }
  })

  it('records the owner cannot read never reach rowsText; the read is the owner request actor', async () => {
    const { dependencies, calls } = harness({ readableRecords: ['rec_1', 'rec_3'] })
    const read = await readYidaSheetSourceRows(req, source(), dependencies)
    expect(read.rowCount).toBe(2)
    expect(read.rowsText.includes('SYN-L2')).toBe(false)
    expect(read.rowsText.includes('synthetic-unreadable')).toBe(false)
    expect(calls).toEqual(['access:sheet_synthetic', 'fields', 'field-permissions:synthetic-owner',
      'records:' + (YIDA_SHEET_SOURCE_LIMITS.maxScan + 1), 'record-permissions:synthetic-owner'])
  })

  it('a view filter narrows the rows; a view of another sheet is 404; a computed filter leaf is refused', async () => {
    const filtered = harness({ view: { sheetId: 'sheet_synthetic', filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fld_line', value: 'SYN-L2' }] } } })
    const read = await readYidaSheetSourceRows(req, source({ viewId: 'view_synthetic' }), filtered.dependencies)
    expect(read.rowCount).toBe(1)
    expect(JSON.parse(read.rowsText)).toEqual([{ projectNo: 'SYN-P1', lineId: 'SYN-L2', quantity: 4, description: 'synthetic part SYN-L2' }])
    // A leaf on an unreadable field is dropped (grid parity), never used as an oracle.
    const hidden = harness({ view: { sheetId: 'sheet_synthetic', filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fld_secret', value: 'x' }] } } })
    expect((await readYidaSheetSourceRows(req, source({ viewId: 'view_synthetic' }), hidden.dependencies)).rowCount).toBe(3)
    const foreign = harness({ view: { sheetId: 'sheet_other', filterInfo: null } })
    expect(await code(readYidaSheetSourceRows(req, source({ viewId: 'view_synthetic' }), foreign.dependencies))).toBe('YIDA_SHEET_SOURCE_NOT_FOUND')
    const missing = harness({ view: null })
    expect(await code(readYidaSheetSourceRows(req, source({ viewId: 'view_synthetic' }), missing.dependencies))).toBe('YIDA_SHEET_SOURCE_NOT_FOUND')
    const computed = harness({ view: { sheetId: 'sheet_synthetic', filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fld_formula', value: 1 }] } } })
    expect(await code(readYidaSheetSourceRows(req, source({ viewId: 'view_synthetic' }), computed.dependencies))).toBe('YIDA_SHEET_SOURCE_UNSUPPORTED')
  })

  it('reads are bounded and refused past a bound, never truncated; empty and non-scalar cells are closed', async () => {
    const scan = Array.from({ length: YIDA_SHEET_SOURCE_LIMITS.maxScan + 1 }, (_, index) => record('rec_' + index, 'L' + index, 1))
    expect(await code(readYidaSheetSourceRows(req, source(), harness({ records: scan }).dependencies))).toBe('YIDA_SHEET_SOURCE_LIMIT')
    const many = Array.from({ length: YIDA_SHEET_SOURCE_LIMITS.maxRows + 1 }, (_, index) => record('rec_' + index, 'L' + index, 1))
    expect(await code(readYidaSheetSourceRows(req, source(), harness({ records: many }).dependencies))).toBe('YIDA_SHEET_SOURCE_LIMIT')
    const exact = many.slice(0, YIDA_SHEET_SOURCE_LIMITS.maxRows)
    expect((await readYidaSheetSourceRows(req, source(), harness({ records: exact }).dependencies)).rowCount).toBe(YIDA_SHEET_SOURCE_LIMITS.maxRows)
    const wide = Array.from({ length: 40 }, (_, index) => record('rec_' + index, 'L' + index, 1, { fld_desc: 'x'.repeat(4000) }))
    expect(await code(readYidaSheetSourceRows(req, source(), harness({ records: wide }).dependencies))).toBe('YIDA_SHEET_SOURCE_LIMIT')
    expect(await code(readYidaSheetSourceRows(req, source(), harness({ records: [] }).dependencies))).toBe('YIDA_SHEET_SOURCE_INPUT')
    for (const value of [['a'], { nested: true }, Number.NaN]) {
      const rows = [record('rec_1', 'SYN-L1', 1, { fld_desc: value })]
      expect(await code(readYidaSheetSourceRows(req, source(), harness({ records: rows }).dependencies))).toBe('YIDA_SHEET_SOURCE_UNSUPPORTED')
    }
  })

  it('errors are values-free fixed codes; a dependency failure closes to UNAVAILABLE', async () => {
    const { dependencies } = harness()
    const broken: YidaSheetSourceDependencies = { ...dependencies, async loadRecords() { throw new Error('SYNTHETIC SYN-L1 synthetic part') } }
    let caught: unknown
    try { await readYidaSheetSourceRows(req, source(), broken) } catch (error) { caught = error }
    expect((caught as Error).message).toBe('YIDA_SHEET_SOURCE_UNAVAILABLE')
    expect(JSON.stringify(caught).includes('SYN-L1')).toBe(false)
    expect('cause' in (caught as object)).toBe(false)
  })

  it('the source body is a closed shape: kind sheet, sheetId, optional viewId, 1..64 unique columns', () => {
    for (const bad of [null, [], { kind: 'sql', sheetId: 's', columns }, { kind: 'sheet', columns },
      { kind: 'sheet', sheetId: 's', columns: [] }, { kind: 'sheet', sheetId: 's', columns, extra: 1 },
      { kind: 'sheet', sheetId: ' s', columns }, { kind: 'sheet', sheetId: 's', columns: [{ fieldId: 'a', source: 'b', x: 1 }] },
      { kind: 'sheet', sheetId: 's', columns: [{ fieldId: 'a', source: 'b' }, { fieldId: 'a', source: 'c' }] },
      { kind: 'sheet', sheetId: 's', columns: [{ fieldId: 'a', source: 'b' }, { fieldId: 'c', source: 'b' }] },
      { kind: 'sheet', sheetId: 's', columns: [{ fieldId: 'a', source: 'has space' }] },
      { kind: 'sheet', sheetId: 's', columns: Array.from({ length: 65 }, (_, index) => ({ fieldId: 'f' + index, source: 's' + index })) }]) {
      expect(() => parseYidaSheetSourceInput(bad)).toThrow('YIDA_SHEET_SOURCE_INPUT')
    }
    expect(parseYidaSheetSourceInput({ kind: 'sheet', sheetId: 's', viewId: 'v', columns: [{ fieldId: 'a', source: 'b' }] }))
      .toEqual({ sheetId: 's', viewId: 'v', columns: [{ fieldId: 'a', source: 'b' }] })
  })

  // ---- Source binding (design baseline v2.3 §7.2): only a registered project sheet yields a binding ----
  const keyed: YidaSheetSourceField[] = fields.map(field => field.id === 'fld_line'
    ? { ...field, property: { stockPreparation: { ownership: 'plm_system', preserveOnRefresh: true, required: true, key: true } } } : field)
  function registered(patch: Parameters<typeof harness>[0] = {}, keyFields = keyed) {
    const { dependencies, calls } = harness(patch)
    const bound: YidaSheetSourceDependencies = { ...dependencies,
      async loadFields() { calls.push('fields'); return keyFields },
      async resolveProjectSheet(_req, sheetId) { calls.push('registry:' + sheetId); return { projectNo: 'SYN-P1' } } }
    return { dependencies: bound, calls }
  }
  it('a registered sheet read yields the binding: key column, alias map and one record per row; rowsText is unchanged', async () => {
    const { dependencies, calls } = registered({ readableRecords: ['rec_1', 'rec_3'] })
    const read = await readYidaSheetSourceRows(req, source(), dependencies)
    const plain = await readYidaSheetSourceRows(req, source(), harness({ readableRecords: ['rec_1', 'rec_3'] }).dependencies)
    expect(read.rowsText).toBe(plain.rowsText)
    expect(read.binding).toEqual({ sheetId: 'sheet_synthetic', keyFieldId: 'fld_line',
      fieldBindings: { projectNo: 'fld_project', lineId: 'fld_line', parentCode: 'fld_parent', quantity: 'fld_qty', description: 'fld_desc' },
      records: [{ recordId: 'rec_1', keyValue: 'SYN-L1', projectNo: 'SYN-P1' }, { recordId: 'rec_3', keyValue: 'SYN-L3', projectNo: 'SYN-P1' }] })
    expect(Object.isFrozen(read.binding) && Object.isFrozen(read.binding!.records) && Object.isFrozen(read.binding!.records[0])).toBe(true)
    expect(calls).toContain('registry:sheet_synthetic')
    // The compiler accepts exactly this shape and binds every row.
    const compiled = compile({ config: config(), rowsText: read.rowsText, allocation: { mode: 'original' }, sourceBinding: read.binding } as Parameters<typeof compile>[0])
    expect((compiled.rowSpecs as Array<{ creationIdentityDigest?: string }>).every(spec => /^[0-9a-f]{64}$/.test(String(spec.creationIdentityDigest)))).toBe(true)
    // An unregistered sheet, or a host without the registry dependency, reads unbound (no binding key at all).
    const unregistered = { ...dependencies, async resolveProjectSheet() { return null } }
    expect(Object.hasOwn(await readYidaSheetSourceRows(req, source(), unregistered), 'binding')).toBe(false)
    expect(Object.hasOwn(plain, 'binding')).toBe(false)
  })
  it('a registered sheet is never drafted unbound: a missing or doubled key column and a row without a key are refused before rowsText', async () => {
    // The key column must be among the read columns.
    const withoutKey = parseYidaSheetSourceInput({ kind: 'sheet', sheetId: 'sheet_synthetic', columns: columns.filter(column => column.fieldId !== 'fld_line') })
    expect(await code(readYidaSheetSourceRows(req, withoutKey, registered().dependencies))).toBe('YIDA_SHEET_SOURCE_INPUT')
    // Exactly one key column.
    expect(await code(readYidaSheetSourceRows(req, source(), registered({}, fields).dependencies))).toBe('YIDA_SHEET_SOURCE_UNSUPPORTED')
    const doubled = keyed.map(field => field.id === 'fld_project' ? { ...field, property: { stockPreparation: { key: true } } } : field)
    expect(await code(readYidaSheetSourceRows(req, source(), registered({}, doubled).dependencies))).toBe('YIDA_SHEET_SOURCE_UNSUPPORTED')
    // Every bound row needs a non-empty, trimmed key cell.
    for (const bad of [undefined, '', ' SYN-L2', 7]) {
      const records = [record('rec_1', 'SYN-L1', 6), { id: 'rec_2', data: { ...record('rec_2', 'SYN-L2', 4).data, fld_line: bad } }]
      expect(await code(readYidaSheetSourceRows(req, source(), registered({ records }).dependencies))).toBe('YIDA_SHEET_SOURCE_INPUT')
    }
    // The same rows on an unregistered sheet are read unbound; the key column is then an ordinary column.
    expect((await readYidaSheetSourceRows(req, withoutKey, harness().dependencies)).rowCount).toBe(3)
  })
})
