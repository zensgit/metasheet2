/**
 * 人工补充行 B2 — the HOST ↔ PLUGIN CONTRACT (ADR adr-stock-prep-manual-rows-20261030 §2.2 「两边一致」, §3.0, §3.3,
 * §8 「B1」 8 and 「B2 主机」 1). M (host, multitable/stock-preparation-manual-rows.ts) and M′ (plugin,
 * plugins/plugin-integration-core/lib/stock-preparation-manual-rows.cjs) must not drift apart:
 *   K-01 the two prefix constants are byte-equal; the project-sheet object-id rule is the same pattern on both sides;
 *   K-02 every row of the plugin's OWN truth table (…/__tests__/support/stock-preparation-manual-rows-truth-table.cjs) gets
 *        the same prefix / manual / kind answers from the host predicates as the table states, and as the plugin's
 *        functions give on the same input;
 *   K-03 the delete exemption E, stated per row (an explicit column, not derived), and M ⊂ E;
 *   K-04 the pinned details: a whitespace-only creator is no creator, keys are compared raw (never trimmed), a blank or
 *        whitespace-only record id is never manual;
 *   K-05 the 33 template columns, each in exactly ONE class of the host's whitelist (the ADR §3.3 table), with the
 *        classes' ownership and required-ness as the plugin template declares them;
 *   K-06 the plugin registry read is a FIXED statement over columns migration 087 created (parsed from the migration);
 *   K-07 the failure direction is decided by SQLSTATE alone (42P01 = not registered; anything else = unreadable);
 *   K-08 the deployment switch reads with the plugin's exact-literal rule;
 *   K-09 the physical ids the gate derives are provisioning's;
 *   K-10 (B4) the per-sheet switch: the plugin's reader (the switch route's) answers exactly as the host's, value for
 *        value, and what the plugin writes survives the host sanitizer with the lock and the key stanza kept; the switch
 *        route's 「manual rows offered on this sheet」 rule (manualRowsSupportedOnObject) answers exactly as the host's
 *        predicate (a), id for id.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import * as host from '../../src/multitable/stock-preparation-manual-rows'
import {
  MANUAL_ROWS_HOST_REGISTRY_SQL,
  MANUAL_ROWS_PROJECT_TARGET_COLUMNS,
  MANUAL_ROWS_PROJECT_TARGET_SQL,
  MANUAL_ROWS_PROJECT_TARGET_TABLE,
  deriveManualRowsFieldIds,
  evaluateManualRowsGate,
  isManualRowsProjectSheetHost,
  readManualRowsHostRegistry,
  readManualRowsProjectTarget,
  stockPrepProjectSheetsEnabledForManualRows,
} from '../../src/multitable/stock-preparation-manual-rows-gate'
import { STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN } from '../../src/multitable/stock-preparation-project-sheet-grant-contract'
import { getObjectFieldId } from '../../src/multitable/provisioning'
import { sanitizeFieldProperty } from '../../src/multitable/field-codecs'

const requireCjs = createRequire(import.meta.url)
const PLUGIN = '../../../../plugins/plugin-integration-core'
/* eslint-disable @typescript-eslint/no-explicit-any */
const pluginRows = requireCjs(`${PLUGIN}/lib/stock-preparation-manual-rows.cjs`) as any
const pluginOwnBase = requireCjs(`${PLUGIN}/lib/stock-preparation-own-base.cjs`) as any
const pluginTargets = requireCjs(`${PLUGIN}/lib/stock-preparation-project-targets.cjs`) as any
const templates = requireCjs(`${PLUGIN}/lib/stock-preparation-templates.cjs`) as any
const truth = requireCjs(`${PLUGIN}/__tests__/support/stock-preparation-manual-rows-truth-table.cjs`) as any
/* eslint-enable @typescript-eslint/no-explicit-any */

type TruthRow = { name: string; input: { objectId?: unknown; createdBy?: unknown; recordId?: unknown; key?: unknown }; expected: { prefix: boolean; manual: boolean; kind: string | null; source: string } }
const TABLE = truth.MANUAL_ROWS_TRUTH_TABLE as TruthRow[]

/**
 * E per truth-table row, stated EXPLICITLY (not derived from the predicate under test): deletable iff the key is a
 * `manual:` prefix key (raw) AND the creator is non-blank. A row added to the plugin's table without an entry here reds.
 */
const DELETE_EXEMPT: Record<string, boolean> = {
  'the manual supplementary row': true,
  'no creator (null)': false,
  'no creator (absent)': false,
  'empty creator': false,
  'whitespace creator': false,
  "the key names ANOTHER row's id": true,
  'the env main sheet': true,
  'a hand-named sandbox twin': true,
  'a project-sheet-like id with UPPERCASE hex': true,
  'a project-sheet-like id with a short digest': true,
  'no objectId': true,
  'another version tag': true,
  'the bare namespace': true,
  'the own key plus a trailing space (exact equality)': true,
  'no record id (null)': true,
  'an empty record id': true,
  'a whitespace-only record id': true,
  'a LEADING space is not the namespace (raw comparison), and the creator makes it non-PLM': false,
  'the namespace is case-sensitive': false,
  'a PLM key written by the plugin': false,
  'a PLM key on a person-created row (a pre-#6598 right-click copy)': false,
  'a keyless person-created row': false,
  'a keyless plugin row': false,
  'a non-string key': false,
  'the own key on the env sheet with no creator': false,
}

describe('K-01 the constants', () => {
  it('the two prefix constants are byte-equal to the plugin\'s', () => {
    expect(host.MANUAL_ROW_KEY_PREFIX).toBe(pluginRows.MANUAL_ROW_KEY_PREFIX)
    expect(host.MANUAL_ROW_KEY_V1_PREFIX).toBe(pluginRows.MANUAL_ROW_KEY_V1_PREFIX)
    expect(Buffer.from(host.MANUAL_ROW_KEY_PREFIX, 'utf8').equals(Buffer.from(pluginRows.MANUAL_ROW_KEY_PREFIX, 'utf8'))).toBe(true)
    expect(Buffer.from(host.MANUAL_ROW_KEY_V1_PREFIX, 'utf8').equals(Buffer.from(pluginRows.MANUAL_ROW_KEY_V1_PREFIX, 'utf8'))).toBe(true)
    expect(host.MANUAL_ROW_KEY_V1_PREFIX.startsWith(host.MANUAL_ROW_KEY_PREFIX)).toBe(true)
  })
  it('the project-sheet object-id rule is the plugin\'s own (one pattern, both sides)', () => {
    for (const row of TABLE) {
      expect(STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN.test(String(row.input.objectId ?? '')), row.name)
        .toBe(pluginOwnBase.isStockPreparationProjectSheetObjectId(row.input.objectId))
    }
  })
})

describe('K-02 the plugin\'s truth table through the host predicates', () => {
  it('the table is the one B1 merged (anti-vacuity)', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(25)
  })
  it.each(TABLE.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    expect(host.isManualPrefixKey(row.input.key)).toBe(row.expected.prefix)
    expect(host.isManualSupplementRow(row.input)).toBe(row.expected.manual)
    expect(host.classifyManualPrefixRow(row.input)).toBe(row.expected.kind)
    // …and the same as the plugin answers on the same input.
    expect(host.isManualPrefixKey(row.input.key)).toBe(pluginRows.isManualPrefixKey(row.input.key))
    expect(host.isManualSupplementRow(row.input)).toBe(pluginRows.isManualSupplementRow(row.input))
    expect(host.classifyManualPrefixRow(row.input)).toBe(pluginRows.classifyManualPrefixRow(row.input))
    expect(host.manualRowKeyFor(row.input.recordId)).toBe(pluginRows.manualRowKeyFor(row.input.recordId))
  })
})

describe('K-03 the delete exemption E', () => {
  it('every truth-table row has an explicit E entry, and nothing else does', () => {
    expect(Object.keys(DELETE_EXEMPT).sort()).toEqual(TABLE.map((row) => row.name).sort())
  })
  it.each(TABLE.map((row) => [row.name, row] as const))('%s', (name, row) => {
    expect(host.isManualRowDeleteExempt(row.input)).toBe(DELETE_EXEMPT[name])
    if (row.expected.manual) expect(host.isManualRowDeleteExempt(row.input), 'M ⊂ E').toBe(true)
  })
})

describe('K-04 the pinned details', () => {
  const RECORD_ID = truth.RECORD_ID as string
  const objectId = truth.PROJECT_OBJECT_ID as string
  it('a whitespace-only createdBy counts as NO creator (not manual, not deletable)', () => {
    // U+3000 (the ideographic space) is whitespace to String.prototype.trim, on both sides.
    for (const createdBy of ['   ', '\t', '\n ', '　']) {
      expect(host.hasManualRowCreator(createdBy), JSON.stringify(createdBy)).toBe(false)
      expect(host.isManualSupplementRow({ objectId, createdBy, recordId: RECORD_ID, key: `manual:v1:${RECORD_ID}` })).toBe(false)
      expect(host.isManualRowDeleteExempt({ createdBy, key: `manual:v1:${RECORD_ID}` })).toBe(false)
    }
  })
  it('keys are compared RAW: never trimmed, case-sensitive', () => {
    for (const key of [` manual:v1:${RECORD_ID}`, `\tmanual:v1:${RECORD_ID}`, `MANUAL:v1:${RECORD_ID}`, `Manual:v1:${RECORD_ID}`]) {
      expect(host.isManualPrefixKey(key), JSON.stringify(key)).toBe(false)
      expect(host.isManualRowDeleteExempt({ createdBy: 'u', key }), JSON.stringify(key)).toBe(false)
    }
    expect(host.isManualSupplementRow({ objectId, createdBy: 'u', recordId: RECORD_ID, key: `manual:v1:${RECORD_ID} ` })).toBe(false)
  })
  it('a blank or whitespace-only record id is never manual (and has no manual key)', () => {
    for (const recordId of [null, undefined, '', '   ']) {
      expect(host.isManualSupplementRow({ objectId, createdBy: 'u', recordId, key: `manual:v1:${recordId ?? ''}` }), JSON.stringify(recordId)).toBe(false)
      expect(host.manualRowKeyFor(recordId)).toBeNull()
    }
  })
})

describe('K-05 the template census (ADR §3.3)', () => {
  type TemplateField = { id: string; ownership: string; required?: boolean; key?: boolean }
  const fields = templates.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields as TemplateField[]
  const classes = host.MANUAL_ROW_TEMPLATE_CLASSES
  const classOf = (id: string) => (Object.entries(classes) as Array<[string, readonly string[]]>).filter(([, ids]) => ids.includes(id)).map(([cls]) => cls)

  it('33 columns, each in exactly one class; no class names a column the template lacks', () => {
    expect(fields).toHaveLength(33)
    for (const field of fields) expect(classOf(field.id), field.id).toHaveLength(1)
    const all = Object.values(classes).flat()
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual(fields.map((f) => f.id).sort())
  })
  it('the class sizes are the ADR\'s 6 / 2 / 5 / 8 / 9 / 3', () => {
    expect(Object.fromEntries(Object.entries(classes).map(([cls, ids]) => [cls, ids.length]))).toEqual({
      fillable: 6, lineage: 2, plan: 5, progress: 8, identity_run: 9, stamp: 3,
    })
  })
  it('ownership: 备料计划 and 进度与回复 are the template\'s human columns; every other class is plm_system', () => {
    const human = new Set(fields.filter((f) => f.ownership === 'human_preserved').map((f) => f.id))
    expect([...classes.plan, ...classes.progress].sort()).toEqual([...human].sort())
    for (const cls of ['fillable', 'lineage', 'identity_run', 'stamp'] as const) {
      for (const id of classes[cls]) expect(fields.find((f) => f.id === id)?.ownership, id).toBe('plm_system')
    }
  })
  it('the stamps are the key, 项目号 and 有效; the key is the template\'s one key column; every stamp is locked on a project sheet', () => {
    expect([...classes.stamp].sort()).toEqual([host.MANUAL_ROW_ACTIVE_FIELD_ID, host.MANUAL_ROW_KEY_FIELD_ID, host.MANUAL_ROW_PROJECT_NO_FIELD_ID].sort())
    expect(fields.filter((f) => f.key).map((f) => f.id)).toEqual([host.MANUAL_ROW_KEY_FIELD_ID])
    for (const id of classes.stamp) expect(pluginTargets.PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS, id).toContain(id)
  })
  it('the required rewrite: the template requires exactly the stamps + componentSourceId + path + totalQuantity; the create drops componentSourceId / path and adds 名称', () => {
    expect(fields.filter((f) => f.required).map((f) => f.id).sort()).toEqual(['active', 'componentSourceId', 'idempotencyKey', 'path', 'projectNo', 'totalQuantity'])
    expect([...host.MANUAL_ROW_REQUIRED_DROPPED_FIELD_IDS].sort()).toEqual(['componentSourceId', 'path'])
    expect([...host.MANUAL_ROW_REQUIRED_ADDED_FIELD_IDS]).toEqual(['componentName'])
    expect([...host.MANUAL_ROW_NOT_CLEARABLE_FIELD_IDS].sort()).toEqual(['componentName', 'totalQuantity'])
    for (const id of host.MANUAL_ROW_NOT_CLEARABLE_FIELD_IDS) expect(classes.fillable).toContain(id)
  })
  it('the lineage pair is the copy\'s DERIVED_LINEAGE pair (OQ5), and the never-written classes are lineage, identity / RUN and the stamps', () => {
    expect([...classes.lineage].sort()).toEqual(['parentComponentCode', 'parentComponentName'])
    expect([...host.MANUAL_ROW_NEVER_WRITTEN_CLASSES].sort()).toEqual(['identity_run', 'lineage', 'stamp'])
  })
})

describe('K-06 the plugin registry read: fixed SQL over migration-087 columns only', () => {
  const migration = readFileSync(join(__dirname, '..', '..', 'migrations', '087_create_integration_stock_prep_project_target.sql'), 'utf8').replace(/\r\n/g, '\n')
  const create = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/.exec(migration)
  const columns087 = new Set((create?.[2] ?? '').split('\n').map((line) => /^\s{2}([a-z_]+)\s+[A-Z]/.exec(line)?.[1]).filter((name): name is string => !!name))

  it('087 is parsed (anti-vacuity) and names the table the host reads', () => {
    expect(create?.[1]).toBe(MANUAL_ROWS_PROJECT_TARGET_TABLE)
    expect(columns087.size).toBeGreaterThan(20)
  })
  it('the statement is exactly the fixed literal, and every column it reads is a column 087 created', () => {
    expect(MANUAL_ROWS_PROJECT_TARGET_SQL).toBe('SELECT sheet_id, project_no, status, object_id, tenant_id FROM integration_stock_prep_project_target WHERE sheet_id = $1')
    const selected = /^SELECT (.+) FROM (\w+) WHERE sheet_id = \$1$/.exec(MANUAL_ROWS_PROJECT_TARGET_SQL)
    expect(selected?.[2]).toBe(MANUAL_ROWS_PROJECT_TARGET_TABLE)
    const read = selected![1].split(',').map((c) => c.trim())
    expect(read).toEqual([...MANUAL_ROWS_PROJECT_TARGET_COLUMNS])
    for (const column of read) expect(columns087.has(column), column).toBe(true)
  })
  it('the host registry read is fixed too, and reads only the registry\'s own columns', () => {
    expect(MANUAL_ROWS_HOST_REGISTRY_SQL).toBe('SELECT project_id, object_id, plugin_name FROM plugin_multitable_object_registry WHERE sheet_id = $1 LIMIT 1')
  })
  it('both reads hand the sheet id as the only parameter', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    await readManualRowsProjectTarget(query, 'sheet_x')
    await readManualRowsHostRegistry(query, 'sheet_x')
    expect(query.mock.calls).toEqual([[MANUAL_ROWS_PROJECT_TARGET_SQL, ['sheet_x']], [MANUAL_ROWS_HOST_REGISTRY_SQL, ['sheet_x']]])
  })
})

describe('K-07 the failure direction is the SQLSTATE\'s, never the message\'s', () => {
  const failing = (error: Record<string, unknown>) => vi.fn(async () => { throw Object.assign(new Error(String(error.message ?? 'synthetic')), error) })
  it.each([
    ['42P01 (undefined table)', { code: '42P01', message: 'synthetic' }, { kind: 'absent', cause: 'table_missing' }],
    ['42P01 whatever the message says', { code: '42P01', message: 'permission denied' }, { kind: 'absent', cause: 'table_missing' }],
    ['42703 (undefined column)', { code: '42703', message: 'relation does not exist' }, { kind: 'unreadable', sqlState: '42703' }],
    ['42501 (insufficient privilege)', { code: '42501' }, { kind: 'unreadable', sqlState: '42501' }],
    ['no SQLSTATE but a "does not exist" message', { message: 'relation "integration_stock_prep_project_target" does not exist' }, { kind: 'unreadable', sqlState: null }],
    ['a malformed code', { code: '42p01' }, { kind: 'unreadable', sqlState: null }],
  ])('plugin registry: %s', async (_label, error, expected) => {
    expect(await readManualRowsProjectTarget(failing(error), 'sheet_x')).toEqual(expected)
  })
  it('host registry: ANY error is unreadable (it is the core\'s own table) — 42P01 included', async () => {
    expect(await readManualRowsHostRegistry(failing({ code: '42P01' }), 'sheet_x')).toEqual({ kind: 'unreadable', sqlState: '42P01' })
  })
  it('the gate turns an unreadable registry into unavailable / registry_unreadable, and a missing 087 table into not_project_sheet', () => {
    const fields = [{ id: 'k', property: { stockPreparation: { key: true } } }]
    const projectHost = { kind: 'present' as const, row: { projectId: 'p', objectId: truth.PROJECT_OBJECT_ID, pluginName: 'plugin-integration-core' } }
    expect(evaluateManualRowsGate({ sheetId: 's', fields, host: { kind: 'unreadable', sqlState: '08006' }, target: null, mode: 'create', flagOn: true }))
      .toEqual({ kind: 'unavailable', reason: 'registry_unreadable', sheet: null })
    expect(evaluateManualRowsGate({ sheetId: 's', fields, host: projectHost, target: { kind: 'unreadable', sqlState: '42703' }, mode: 'create', flagOn: true }))
      .toEqual({ kind: 'unavailable', reason: 'registry_unreadable', sheet: null })
    expect(evaluateManualRowsGate({ sheetId: 's', fields, host: projectHost, target: { kind: 'absent', cause: 'table_missing' }, mode: 'create', flagOn: true }))
      .toEqual({ kind: 'not_project_sheet' })
  })
})

describe('K-08 the deployment switch: the plugin\'s exact-literal rule, read per call', () => {
  it.each([['true', true], ['TRUE', false], [' true', false], ['true ', false], ['1', false], ['yes', false], ['', false], [undefined, false]])('%j → %s', (value, expected) => {
    const env = value === undefined ? {} : { MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED: value }
    expect(stockPrepProjectSheetsEnabledForManualRows(env as NodeJS.ProcessEnv)).toBe(expected)
    expect(stockPrepProjectSheetsEnabledForManualRows(env as NodeJS.ProcessEnv)).toBe(pluginTargets.stockPreparationProjectSheetsEnabled(env))
  })
})

/**
 * K-10 (B4) THE PER-SHEET SWITCH, read on both sides. The plugin's switch route (B4,
 * lib/stock-preparation-manual-rows.cjs `manualRowsPolicyValueOf`) reads the key column's `stockPreparationManualRows`
 * and answers the admin panel; the host (B2) reads the same property to allow or refuse a manual-row create. If the
 * two readers ever disagreed on a junk value, the panel could say "allowed" while the host refuses (or the reverse).
 * The expected column is stated EXPLICITLY, not derived from either reader.
 */
describe('K-10 (B4) the per-sheet switch: the plugin reader answers exactly as the host reader, value for value', () => {
  const SWITCH_CASES: Array<[string, unknown, 'allowed' | 'disabled' | null, 'allowed' | 'disabled']> = [
    ['an empty property', {}, null, 'allowed'],
    ['a null property', null, null, 'allowed'],
    ['a property that is not an object', 'plain text', null, 'allowed'],
    ['an array property', ['allowed'], null, 'allowed'],
    ['an undefined value (JSON cannot store it)', { stockPreparationManualRows: undefined }, null, 'allowed'],
    ['exactly allowed', { stockPreparationManualRows: 'allowed' }, 'allowed', 'allowed'],
    ['exactly disabled', { stockPreparationManualRows: 'disabled' }, 'disabled', 'disabled'],
    ['upper case', { stockPreparationManualRows: 'ALLOWED' }, 'disabled', 'disabled'],
    ['a leading space', { stockPreparationManualRows: ' allowed' }, 'disabled', 'disabled'],
    ['a trailing space', { stockPreparationManualRows: 'allowed ' }, 'disabled', 'disabled'],
    ['an empty string', { stockPreparationManualRows: '' }, 'disabled', 'disabled'],
    ['null', { stockPreparationManualRows: null }, 'disabled', 'disabled'],
    ['true', { stockPreparationManualRows: true }, 'disabled', 'disabled'],
    ['false', { stockPreparationManualRows: false }, 'disabled', 'disabled'],
    ['a number', { stockPreparationManualRows: 1 }, 'disabled', 'disabled'],
    ['an object', { stockPreparationManualRows: { value: 'allowed' } }, 'disabled', 'disabled'],
    ['an array', { stockPreparationManualRows: ['allowed'] }, 'disabled', 'disabled'],
    ['JSON text, allowed', JSON.stringify({ stockPreparationManualRows: 'allowed' }), 'allowed', 'allowed'],
    ['JSON text, junk', JSON.stringify({ stockPreparationManualRows: 'yes' }), 'disabled', 'disabled'],
    ['JSON text, absent', JSON.stringify({ humanWriteLock: 'plm_system' }), null, 'allowed'],
    ['malformed JSON text', '{"stockPreparationManualRows":', null, 'allowed'],
  ]
  it('the property key and the two closed values are byte-equal', () => {
    expect(pluginRows.MANUAL_ROWS_POLICY_PROPERTY_KEY).toBe(host.MANUAL_ROWS_POLICY_PROPERTY_KEY)
    expect(pluginRows.MANUAL_ROWS_POLICY_ALLOWED).toBe(host.MANUAL_ROWS_POLICY_ALLOWED)
    expect(pluginRows.MANUAL_ROWS_POLICY_DISABLED).toBe(host.MANUAL_ROWS_POLICY_DISABLED)
    expect([...pluginRows.MANUAL_ROWS_POLICIES]).toEqual([host.MANUAL_ROWS_POLICY_ALLOWED, host.MANUAL_ROWS_POLICY_DISABLED])
  })
  it.each(SWITCH_CASES)('%s', (_label, property, value, effect) => {
    expect(host.manualRowsPolicyValueOf(property)).toBe(value)
    expect(pluginRows.manualRowsPolicyValueOf(property)).toBe(value)
    expect(host.manualRowsPolicyOfProperty(property)).toBe(effect)
    expect(pluginRows.manualRowsPolicyOfProperty(property)).toBe(effect)
  })
  it('what the plugin WRITES survives the host sanitizer: each closed value is kept, and the lock and the key stanza ride along', () => {
    for (const policy of pluginRows.MANUAL_ROWS_POLICIES as string[]) {
      const merged = { stockPreparation: { ownership: 'plm_system', key: true }, humanWriteLock: 'plm_system', stockPreparationManualRows: policy }
      const sanitized = sanitizeFieldProperty('string', merged)
      expect(sanitized.stockPreparationManualRows).toBe(policy)
      expect(sanitized.humanWriteLock).toBe('plm_system')
      expect(pluginRows.manualRowsKeyColumnState({ property: sanitized })).toEqual({
        present: true, policy, source: 'set', stored: policy, locked: true, keyStanza: true,
      })
    }
  })
  it('manualRowsSupportedOnObject answers exactly as the host predicate (a), id for id', () => {
    const P = truth.PROJECT_OBJECT_ID as string
    const HEX = P.slice('plm_stock_preparation_sandbox_p_'.length)
    const IDS: Array<[string, unknown, boolean]> = [
      ['the registered project-sheet shape', P, true],
      ['uppercase hex', `plm_stock_preparation_sandbox_p_${HEX.toUpperCase()}`, false],
      ['uppercase prefix', `PLM_STOCK_PREPARATION_SANDBOX_P_${HEX}`, false],
      ['a 23-hex digest', P.slice(0, -1), false],
      ['a 25-hex digest', `${P}0`, false],
      ['a trailing suffix', `${P}_x`, false],
      ['a trailing newline', `${P}\n`, false],
      ['a trailing space', `${P} `, false],
      ['a leading space', ` ${P}`, false],
      ['a leading prefix', `x_${P}`, false],
      ['an adopted older sandbox sheet', 'plm_stock_preparation_sandbox_adopted_syn', false],
      ['the env main sheet', 'plm_stock_preparation_main', false],
      ['empty', '', false], ['null', null, false], ['undefined', undefined, false], ['a number', 1, false],
    ]
    for (const [label, objectId, expected] of IDS) {
      expect(isManualRowsProjectSheetHost({ kind: 'present', row: { projectId: 'p', objectId, pluginName: 'plugin-integration-core' } }), `host: ${label}`).toBe(expected)
      expect(pluginRows.manualRowsSupportedOnObject(objectId), `plugin: ${label}`).toBe(expected)
    }
  })
})

describe('K-09 the derived physical ids are provisioning\'s', () => {
  it('every template column, and the six fillable in template order', () => {
    const derived = deriveManualRowsFieldIds('tenant_k:integration-core', truth.PROJECT_OBJECT_ID)
    for (const id of Object.values(host.MANUAL_ROW_TEMPLATE_CLASSES).flat()) {
      expect(derived.byLogical[id]).toBe(getObjectFieldId('tenant_k:integration-core', truth.PROJECT_OBJECT_ID, id))
    }
    expect(derived.key).toBe(derived.byLogical.idempotencyKey)
    expect(derived.fillable).toEqual(host.MANUAL_ROW_FILLABLE_FIELD_IDS.map((id) => derived.byLogical[id]))
    expect(derived.neverWritten.size).toBe(2 + 9 + 3)
  })
})
