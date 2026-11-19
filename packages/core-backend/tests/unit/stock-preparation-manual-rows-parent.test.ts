/**
 * 人工补充行的父组件 — ADR adr-stock-prep-manual-rows-20261030 §12 (owner-ruled 2026-11-19), slice P1: the PURE rules and
 * the GATE. No router here; the three routes, /context and the two picker reads are in
 * stock-preparation-manual-rows-parent-routes.test.ts.
 *
 *   R-01 P3 + P4, the pair's shape: both columns or neither, text or null, never a name without a 图号; blank judged on
 *        the trimmed value;
 *   R-02 P5, the self-parent comparison: case-sensitive, surrounding whitespace ignored, a non-text own 图号 compared
 *        as its text;
 *   R-03 the refusal: one closed code, four reasons, 400 / 422, fixed values-free sentences;
 *   G-01 the gate with the request's field ids: the pair's two columns must exist and be locked ONLY for a request
 *        that names the pair — every other verdict is what it was;
 *   G-02 the pair's own gate (the edit gate for a request naming the pair) and its loader;
 *   G-03 /context's block: `parentFieldIds` only where the routes accept the pair AND the actor callback says yes;
 *   G-04 the lock exemption is exactly eight columns; the copy rule's 'pair' class;
 *   G-05 「复制为新行」: the pair is carried whole or not at all;
 *   G-06 the create's pair check, and the create transaction's re-check of the pair's lock;
 *   G-07 the edit transaction's re-check: P5 on the LOCKED, merged row, in both directions, and only when the patch
 *        names 父组件图号 or the row's own 图号;
 *   S-01 the picker's query-string parser;
 *   S-02 the two statements are FIXED text: every column id, the deny set and the search text are parameters;
 *   S-03 their parameter lists; S-04 the row mappers.
 *
 * Mock pool, no DB. Every value is synthetic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  comparableManualRowCode,
  isBlankManualRowParentValue,
  isManualRowParentValueType,
  isManualRowSelfParent,
  manualRowParentPairProblem,
  MANUAL_ROW_KEY_V1_PREFIX,
} from '../../src/multitable/stock-preparation-manual-rows'
import {
  MANUAL_ROW_PARENT_REFUSAL_MESSAGES,
  STOCK_PREP_MANUAL_PARENT_INVALID_CODE,
  STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE_MESSAGE,
  StockPrepManualRowParentRefusedError,
  StockPrepManualRowsRefusedError,
  assertManualRowCreateInTransaction,
  assertManualRowEditInTransaction,
  assertManualRowParentPairForCreate,
  liftManualRowExemptLocks,
  loadManualRowParentPairVerdict,
  loadManualRowsVerdict,
  manualRowCopyParentPair,
  manualRowCopyRule,
  manualRowParentPairGateReason,
  manualRowParentPairProblemOf,
  manualRowsContextBlockOf,
  mintManualRowCreateExtension,
  namesManualRowParentPair,
  resolveManualRowsContextBlock,
  type ManualRowsSheet,
  type ManualRowsVerdict,
} from '../../src/multitable/stock-preparation-manual-rows-gate'
import {
  MANUAL_ROW_PARENT_DEPENDENTS_SQL,
  MANUAL_ROW_PARENT_OPTIONS_DEFAULT_LIMIT,
  MANUAL_ROW_PARENT_OPTIONS_MAX_LIMIT,
  MANUAL_ROW_PARENT_OPTIONS_SQL,
  MANUAL_ROW_PARENT_SQL_TRIM_CHARS,
  manualRowParentDependentsCountOf,
  manualRowParentDependentsParams,
  manualRowParentOptionOf,
  manualRowParentOptionsPage,
  manualRowParentOptionsParams,
  parseManualRowParentOptionsQuery,
} from '../../src/multitable/stock-preparation-manual-row-parent-options'
import { isFieldHumanWriteLocked } from '../../src/multitable/human-write-lock'
import {
  MR_ENV_OBJECT,
  MR_PROJECT_NO,
  createManualRowsFakePool,
  evaluateParentDependentsStatement,
  evaluateParentOptionsStatement,
  type FakeSheet,
} from '../utils/stock-prep-manual-rows-fake-pg'

const fake = createManualRowsFakePool()
/** U+3000, which String.prototype.trim treats as whitespace — spelled by code point so the source holds no invisible character. */
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000)
const P = (n: number) => `plm_stock_preparation_sandbox_p_${n.toString(16).padStart(24, '0')}`
const query = fake.pool.query as never
const ph = (sheet: FakeSheet, logical: string) => fake.phys(sheet, logical)
const pairOf = (sheet: FakeSheet) => ({ code: ph(sheet, 'parentComponentCode'), name: ph(sheet, 'parentComponentName') })

let S: Record<string, FakeSheet>

beforeEach(() => {
  fake.reset()
  S = {
    PREG: fake.addSheet('PREG', { objectId: P(1) }),
    DISABLED: fake.addSheet('DISABLED', { objectId: P(2), policy: 'disabled' }),
    ARCHIVED: fake.addSheet('ARCHIVED', { objectId: P(3), target: { status: 'archived' } }),
    NOLOCK: fake.addSheet('NOLOCK', { objectId: P(4), locked: 'none' }),
    // The three stamped columns locked, the parent pair (and everything else) not.
    PAIRUNLOCKED: fake.addSheet('PAIRUNLOCKED', { objectId: P(5), locked: ['idempotencyKey', 'projectNo', 'active'] }),
    // Everything locked but 父组件名称: a half-locked pair.
    PAIRHALFLOCKED: fake.addSheet('PAIRHALFLOCKED', { objectId: P(6), locked: ['idempotencyKey', 'projectNo', 'active', 'parentComponentCode', 'componentCode', 'componentName'] }),
    NOPARENTNAME: fake.addSheet('NOPARENTNAME', { objectId: P(7), omit: ['parentComponentName'] }),
    ENV: fake.addSheet('ENV', { objectId: MR_ENV_OBJECT, target: null }),
    PLAIN: fake.addSheet('PLAIN', { objectId: P(8), noStanza: true }),
  }
})

const verdictOf = (sheet: FakeSheet, mode: 'create' | 'edit', submitted?: string[]) =>
  loadManualRowsVerdict(query, sheet.sheetId, sheet.fields, mode, mode === 'create' ? true : undefined, submitted)
const reasonOf = (verdict: ManualRowsVerdict) => (verdict.kind === 'unavailable' ? verdict.reason : verdict.kind)
const sheetOf = async (sheet: FakeSheet): Promise<ManualRowsSheet> => {
  const verdict = await verdictOf(sheet, 'edit')
  if (verdict.kind !== 'allowed') throw new Error(`fixture is not editable: ${reasonOf(verdict)}`)
  return verdict.sheet
}

// ── R. the pure rules ────────────────────────────────────────────────────────────────────────────────

describe('R-01 P3 + P4 — the pair\'s shape', () => {
  it('a request that names neither column has no pair to judge', () => {
    expect(manualRowParentPairProblem({ hasCode: false, hasName: false })).toBeNull()
    expect(manualRowParentPairProblem({ hasCode: false, hasName: false, code: 5, name: {} })).toBeNull()
  })
  it.each([
    ['only 父组件图号', { hasCode: true, hasName: false, code: 'SYN-P' }],
    ['only 父组件名称', { hasCode: false, hasName: true, name: 'Synthetic parent' }],
    ['only 父组件图号, and not even text (the half pair is answered first)', { hasCode: true, hasName: false, code: 5 }],
    ['only 父组件名称, blank', { hasCode: false, hasName: true, name: null }],
  ])('P3 %s → pair_incomplete', (_label, input) => {
    expect(manualRowParentPairProblem(input)).toBe('pair_incomplete')
  })
  it.each([
    ['both null (no parent)', null, null],
    ['both empty', '', ''],
    ['both whitespace', '   ', '\t'],
    ['a 图号 without a name (PLM has such parents)', 'SYN-P', null],
    ['a 图号 with an empty name', 'SYN-P', ''],
    ['a 图号 with a whitespace name', 'SYN-P', '  '],
    ['both text', 'SYN-P', 'Synthetic parent'],
    ['text with surrounding whitespace (stored as sent)', ' SYN-P ', ' Synthetic parent '],
    ['the ideographic space counts as whitespace, so this is 「both blank」', IDEOGRAPHIC_SPACE, IDEOGRAPHIC_SPACE],
  ])('P4 %s → acceptable', (_label, code, name) => {
    expect(manualRowParentPairProblem({ hasCode: true, hasName: true, code, name })).toBeNull()
  })
  it.each([
    ['a name with a null 图号', null, 'Synthetic parent'],
    ['a name with an empty 图号', '', 'Synthetic parent'],
    ['a name with a whitespace 图号', ' \t ', 'Synthetic parent'],
  ])('P4 %s → name_without_code', (_label, code, name) => {
    expect(manualRowParentPairProblem({ hasCode: true, hasName: true, code, name })).toBe('name_without_code')
  })
  it.each([
    ['a number 图号', 12, 'Synthetic parent'],
    ['a number name', 'SYN-P', 12],
    ['a boolean', true, null],
    ['an object', { value: 'SYN-P' }, null],
    ['an array', ['SYN-P'], 'Synthetic parent'],
    ['zero', 0, null],
    ['an absent value under a named column', undefined, 'Synthetic parent'],
  ])('P4 %s → not_text (a pair column takes a string or null)', (_label, code, name) => {
    expect(manualRowParentPairProblem({ hasCode: true, hasName: true, code, name })).toBe('not_text')
  })
  it('the two primitives', () => {
    for (const blank of [null, undefined, '', ' ', '\t\n', IDEOGRAPHIC_SPACE]) expect(isBlankManualRowParentValue(blank), JSON.stringify(blank)).toBe(true)
    for (const filled of ['a', ' a ', 0, false, {}, []]) expect(isBlankManualRowParentValue(filled), JSON.stringify(filled)).toBe(false)
    for (const ok of [null, '', 'a']) expect(isManualRowParentValueType(ok)).toBe(true)
    for (const bad of [undefined, 0, 1, true, {}, []]) expect(isManualRowParentValueType(bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('R-02 P5 — a row is not its own parent', () => {
  it.each([
    ['the same text', 'SYN-1', 'SYN-1', true],
    ['surrounding whitespace on the parent', ' SYN-1\t', 'SYN-1', true],
    ['surrounding whitespace on the row\'s own 图号', 'SYN-1', '  SYN-1 ', true],
    ['an ideographic space around it', `${IDEOGRAPHIC_SPACE}SYN-1${IDEOGRAPHIC_SPACE}`, 'SYN-1', true],
    ['a different case is a different 图号', 'syn-1', 'SYN-1', false],
    ['an inner space is part of the text', 'SYN 1', 'SYN1', false],
    ['a different 图号', 'SYN-2', 'SYN-1', false],
    ['no parent', null, 'SYN-1', false],
    ['a blank parent', '   ', 'SYN-1', false],
    ['the row has no 图号', 'SYN-1', null, false],
    ['the row\'s 图号 is blank', 'SYN-1', '', false],
    ['both blank', '', '', false],
    ['both absent', undefined, undefined, false],
    ['a number stored in the row\'s own 图号 compares as its text', '123', 123, true],
    ['a boolean stored in the row\'s own 图号 compares as its text', 'true', true, true],
    ['an object in the row\'s own 图号 never matches', '[object Object]', {}, false],
  ])('%s → %s', (_label, parentCode, componentCode, expected) => {
    expect(isManualRowSelfParent(parentCode, componentCode)).toBe(expected)
  })
  it('the comparable form: trimmed text, or null when there is nothing to compare; never a rewrite of the stored value', () => {
    expect(comparableManualRowCode(' A ')).toBe('A')
    expect(comparableManualRowCode(7)).toBe('7')
    expect(comparableManualRowCode(false)).toBe('false')
    for (const nothing of [null, undefined, '', '  ', {}, [], Number.NaN, Number.POSITIVE_INFINITY]) expect(comparableManualRowCode(nothing), String(nothing)).toBeNull()
  })
})

describe('R-03 the refusal', () => {
  it.each([
    ['pair_incomplete', 400],
    ['not_text', 400],
    ['name_without_code', 422],
    ['self_parent', 422],
  ] as const)('%s → %s, one closed code, the reason token in details', (reason, status) => {
    const err = new StockPrepManualRowParentRefusedError(reason)
    expect(err.status).toBe(status)
    expect(err.code).toBe('STOCK_PREP_MANUAL_PARENT_INVALID')
    expect(err.code).toBe(STOCK_PREP_MANUAL_PARENT_INVALID_CODE)
    expect(err.body()).toEqual({ ok: false, error: { code: 'STOCK_PREP_MANUAL_PARENT_INVALID', message: MANUAL_ROW_PARENT_REFUSAL_MESSAGES[reason], details: { reason } } })
  })
  it('the sentences are fixed text (pinned) and carry no id, 图号 or name', () => {
    expect(MANUAL_ROW_PARENT_REFUSAL_MESSAGES).toEqual({
      pair_incomplete: '父组件图号和父组件名称要一起提交，不能只改其中一列。',
      not_text: '父组件图号和父组件名称只能填文字，或者留空。',
      name_without_code: '只填了父组件名称、没有父组件图号，不能保存；请补上父组件图号，或者把两项都清空。',
      self_parent: '父组件图号不能和这一行自己的图号相同。',
    })
    for (const message of [...Object.values(MANUAL_ROW_PARENT_REFUSAL_MESSAGES), STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE_MESSAGE]) {
      expect(message).not.toMatch(/fld_|rec_|sheet_|SYN|\$\{/)
    }
    expect(STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE_MESSAGE).toBe('这个入口只修改人工补充行的图号、名称、规格、材料、用量、总用量，以及父组件图号和父组件名称（这两列要一起提交）；其他列请照常编辑。')
  })
})

// ── G. the gate ──────────────────────────────────────────────────────────────────────────────────────

describe('G-01 the gate with the request\'s field ids', () => {
  it('a fully locked project sheet: a create and an edit that name the pair are allowed', async () => {
    const pair = pairOf(S.PREG)
    for (const submitted of [[pair.code, pair.name], [pair.code], [pair.name], [ph(S.PREG, 'componentName'), pair.code, pair.name]]) {
      expect(reasonOf(await verdictOf(S.PREG, 'create', submitted))).toBe('allowed')
      expect(reasonOf(await verdictOf(S.PREG, 'edit', submitted))).toBe('allowed')
    }
  })
  it.each([
    ['PAIRUNLOCKED', 'neither pair column carries the lock'],
    ['PAIRHALFLOCKED', '父组件图号 is locked, 父组件名称 is not'],
  ])('%s (%s): naming either pair column is lock_missing in BOTH modes; a request that does not name the pair is allowed exactly as before', async (key) => {
    const sheet = S[key]
    const pair = pairOf(sheet)
    for (const submitted of [[pair.code, pair.name], [pair.code], [pair.name]]) {
      expect(reasonOf(await verdictOf(sheet, 'create', submitted)), `create ${submitted.length}`).toBe('lock_missing')
      expect(reasonOf(await verdictOf(sheet, 'edit', submitted)), `edit ${submitted.length}`).toBe('lock_missing')
    }
    for (const submitted of [undefined, [], [ph(sheet, 'componentName'), ph(sheet, 'totalQuantity')], [ph(sheet, 'notes')]]) {
      expect(reasonOf(await verdictOf(sheet, 'create', submitted))).toBe('allowed')
      expect(reasonOf(await verdictOf(sheet, 'edit', submitted))).toBe('allowed')
    }
  })
  it('a sheet WITHOUT one of the two columns: naming the pair is contract_mismatch; anything else is allowed as before', async () => {
    const sheet = S.NOPARENTNAME
    const code = ph(sheet, 'parentComponentCode')
    const absentName = ph(sheet, 'parentComponentName')
    expect(reasonOf(await verdictOf(sheet, 'create', [code]))).toBe('contract_mismatch')
    expect(reasonOf(await verdictOf(sheet, 'edit', [code, absentName]))).toBe('contract_mismatch')
    expect(reasonOf(await verdictOf(sheet, 'create', [ph(sheet, 'componentName')]))).toBe('allowed')
    expect(reasonOf(await verdictOf(sheet, 'edit'))).toBe('allowed')
  })
  it('the other conditions keep their order and their mode: archived / disabled stop a create that names the pair, never an edit (rule P8)', async () => {
    for (const [key, createReason] of [['ARCHIVED', 'project_archived'], ['DISABLED', 'disabled']] as const) {
      const pair = pairOf(S[key])
      expect(reasonOf(await verdictOf(S[key], 'create', [pair.code, pair.name]))).toBe(createReason)
      expect(reasonOf(await verdictOf(S[key], 'edit', [pair.code, pair.name]))).toBe('allowed')
    }
    const nolock = pairOf(S.NOLOCK)
    expect(reasonOf(await verdictOf(S.NOLOCK, 'edit', [nolock.code, nolock.name]))).toBe('lock_missing')
    expect(reasonOf(await verdictOf(S.ENV, 'edit', [ph(S.ENV, 'parentComponentCode')]))).toBe('not_project_sheet')
  })
  it('the deployment switch still stops a create that names the pair (project_sheets_off)', async () => {
    const pair = pairOf(S.PREG)
    const verdict = await loadManualRowsVerdict(query, S.PREG.sheetId, S.PREG.fields, 'create', false, [pair.code, pair.name])
    expect(reasonOf(verdict)).toBe('project_sheets_off')
  })
  it('namesManualRowParentPair: either column names the pair; nothing else does', async () => {
    const sheet = await sheetOf(S.PREG)
    const { code, name } = sheet.derived.parent
    expect(namesManualRowParentPair(sheet.derived, [code])).toBe(true)
    expect(namesManualRowParentPair(sheet.derived, [name])).toBe(true)
    expect(namesManualRowParentPair(sheet.derived, new Set(['x', name]))).toBe(true)
    for (const none of [undefined, null, [], [sheet.derived.componentCode, sheet.derived.key, 'parentComponentCode']]) {
      expect(namesManualRowParentPair(sheet.derived, none)).toBe(false)
    }
  })
  it('manualRowParentPairGateReason answers exactly what the gate answers for a request naming the pair', async () => {
    for (const [key, expected] of [['PREG', null], ['DISABLED', null], ['ARCHIVED', null], ['PAIRUNLOCKED', 'lock_missing'], ['PAIRHALFLOCKED', 'lock_missing'], ['NOPARENTNAME', 'contract_mismatch']] as const) {
      const sheet = await sheetOf(S[key])
      expect(manualRowParentPairGateReason(S[key].fields, sheet.derived), key).toBe(expected)
      const gate = reasonOf(await verdictOf(S[key], 'edit', [sheet.derived.parent.code, sheet.derived.parent.name]))
      expect(gate, key).toBe(expected ?? 'allowed')
    }
  })
})

describe('G-02 the pair\'s own gate (the edit gate for a request that names the pair)', () => {
  it.each([
    ['PREG', 'allowed'],
    ['DISABLED', 'allowed'],
    ['ARCHIVED', 'allowed'],
    ['PAIRUNLOCKED', 'lock_missing'],
    ['PAIRHALFLOCKED', 'lock_missing'],
    ['NOPARENTNAME', 'contract_mismatch'],
    ['NOLOCK', 'lock_missing'],
    ['ENV', 'not_project_sheet'],
    ['PLAIN', 'not_project_sheet'],
  ])('%s → %s', async (key, expected) => {
    expect(reasonOf(await loadManualRowParentPairVerdict(query, S[key].sheetId, S[key].fields))).toBe(expected)
  })
  it('an ordinary sheet issues no statement; a project sheet issues the two registry reads and nothing else', async () => {
    fake.sqlLog.length = 0
    await loadManualRowParentPairVerdict(query, S.PLAIN.sheetId, S.PLAIN.fields)
    expect(fake.sqlLog).toEqual([])
    await loadManualRowParentPairVerdict(query, S.PREG.sheetId, S.PREG.fields)
    expect(fake.sqlLog.map((entry) => entry.sql.split(' FROM ')[1]?.split(' ')[0])).toEqual(['plugin_multitable_object_registry', 'integration_stock_prep_project_target'])
  })
  it('a registry that cannot be read is unavailable / registry_unreadable (fail closed)', async () => {
    fake.failures.target = { code: '42501', message: 'synthetic: permission denied' }
    expect(reasonOf(await loadManualRowParentPairVerdict(query, S.PREG.sheetId, S.PREG.fields))).toBe('registry_unreadable')
    fake.failures.target = { code: '42P01', message: 'synthetic' }
    expect(reasonOf(await loadManualRowParentPairVerdict(query, S.PREG.sheetId, S.PREG.fields))).toBe('not_project_sheet')
  })
})

describe('G-03 /context: parentFieldIds', () => {
  const yes = () => true
  const blockOf = (sheet: FakeSheet, callback?: (manualSheet: ManualRowsSheet) => boolean, env: NodeJS.ProcessEnv = { MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED: 'true' }) =>
    resolveManualRowsContextBlock(query, sheet.sheetId, sheet.fields, env, callback)

  it('sent where the routes accept the pair and the actor callback says yes — appended after the four B2 / B3 keys', async () => {
    const block = (await blockOf(S.PREG, yes))!
    expect(block.parentFieldIds).toEqual(pairOf(S.PREG))
    expect(Object.keys(block)).toEqual(['state', 'editableFieldIds', 'requiredFieldIds', 'dialogFieldIds', 'parentFieldIds'])
    expect(block.editableFieldIds).not.toContain(block.parentFieldIds!.code)
    expect(block.editableFieldIds).not.toContain(block.parentFieldIds!.name)
  })
  it('NOT sent when the callback says no, or when no callback is given (the block is then exactly the B2 / B3 block)', async () => {
    const without = await blockOf(S.PREG)
    const refused = await blockOf(S.PREG, () => false)
    expect(without).toEqual(refused)
    expect(Object.keys(without!)).toEqual(['state', 'editableFieldIds', 'requiredFieldIds', 'dialogFieldIds'])
    // …and it is what the pure block function answers.
    expect(without).toEqual(manualRowsContextBlockOf(await verdictOf(S.PREG, 'create'), S.PREG.fields))
  })
  it.each([
    ['PAIRUNLOCKED', 'allowed'],
    ['PAIRHALFLOCKED', 'allowed'],
    ['NOPARENTNAME', 'allowed'],
    ['NOLOCK', 'unavailable'],
  ])('%s: the routes do not accept the pair, so the key is absent and the actor is not even asked (state %s)', async (key, state) => {
    const callback = vi.fn(yes)
    const block = (await blockOf(S[key], callback))!
    expect(block.state).toBe(state)
    expect('parentFieldIds' in block).toBe(false)
    expect(callback).not.toHaveBeenCalled()
  })
  it.each([
    ['DISABLED', { state: 'disabled' }, undefined],
    ['ARCHIVED', { state: 'unavailable', reason: 'project_archived' }, undefined],
    ['PREG', { state: 'unavailable', reason: 'project_sheets_off' }, {}],
  ])('rule P8 — %s (%j): a create is refused, yet an existing manual row\'s parent can still be changed, so the key IS sent', async (key, expected, env) => {
    const block = (await blockOf(S[key], yes, env as NodeJS.ProcessEnv | undefined))!
    expect(block).toMatchObject(expected)
    expect(block.parentFieldIds).toEqual(pairOf(S[key]))
  })
  it('the callback receives the sheet the gate derived (its pair ids are the block\'s)', async () => {
    const callback = vi.fn((manualSheet: ManualRowsSheet) => manualSheet.derived.parent.code === pairOf(S.PREG).code)
    expect((await blockOf(S.PREG, callback))!.parentFieldIds).toEqual(pairOf(S.PREG))
    expect(callback).toHaveBeenCalledTimes(1)
  })
  it('not P_reg: no block, no callback; a registry that cannot be read: a block without the key', async () => {
    const callback = vi.fn(yes)
    expect(await blockOf(S.ENV, callback)).toBeNull()
    expect(await blockOf(S.PLAIN, callback)).toBeNull()
    fake.failures.target = { code: '08006', message: 'synthetic: connection failure' }
    expect(await blockOf(S.PREG, callback)).toEqual({ state: 'unavailable', reason: 'registry_unreadable', editableFieldIds: [], requiredFieldIds: [], dialogFieldIds: [] })
    expect(callback).not.toHaveBeenCalled()
  })
  it('costs no statement beyond the block\'s own two registry reads', async () => {
    fake.sqlLog.length = 0
    await blockOf(S.PREG, yes)
    expect(fake.sqlLog).toHaveLength(2)
    fake.sqlLog.length = 0
    await blockOf(S.PLAIN, yes)
    expect(fake.sqlLog).toEqual([])
  })
})

describe('G-04 the lock exemption and the copy classes', () => {
  it('liftManualRowExemptLocks lifts the lock from exactly the eight exempt columns and touches no other field', async () => {
    const sheet = await sheetOf(S.PREG)
    const fields = S.PREG.fields.map((field) => ({ id: field.id, property: field.property }))
    const lifted = liftManualRowExemptLocks(fields, sheet)
    const exempt = ['componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity', 'parentComponentCode', 'parentComponentName'].map((l) => ph(S.PREG, l))
    expect([...sheet.derived.lockExempt].sort()).toEqual([...exempt].sort())
    for (const [index, field] of fields.entries()) {
      if (exempt.includes(field.id)) {
        expect(isFieldHumanWriteLocked(field), field.id).toBe(true)
        expect(isFieldHumanWriteLocked(lifted[index]), field.id).toBe(false)
        // a copy: the source field keeps its lock
        expect(lifted[index]).not.toBe(field)
      } else {
        expect(lifted[index], field.id).toBe(field)
      }
    }
    // every other locked column is still locked after the lift
    const lockedBefore = fields.filter((field) => isFieldHumanWriteLocked(field)).map((field) => field.id)
    expect(lockedBefore.length).toBeGreaterThan(exempt.length)
    expect(lifted.filter((field) => isFieldHumanWriteLocked(field)).map((field) => field.id).sort())
      .toEqual(lockedBefore.filter((id) => !exempt.includes(id)).sort())
  })
  it('the copy rule: the parent pair is its own class (decided as a pair), the six + 备料计划 copy, everything else never', async () => {
    const sheet = await sheetOf(S.PREG)
    const ruleOf = (logical: string) => manualRowCopyRule({ id: ph(S.PREG, logical) }, sheet)
    expect(ruleOf('parentComponentCode')).toBe('pair')
    expect(ruleOf('parentComponentName')).toBe('pair')
    for (const logical of ['componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity', 'materialType', 'blankType', 'demandDate', 'leadTimeDays', 'makeOrBuy']) expect(ruleOf(logical), logical).toBe('read_write')
    for (const logical of ['idempotencyKey', 'projectNo', 'active', 'componentSourceId', 'parentSourceId', 'path', 'depth', 'notes', 'procurementReply', 'issueConfirmDate', 'projectSpecModel']) expect(ruleOf(logical), logical).toBe('never')
  })
})

describe('G-05 「复制为新行」 — the pair is carried whole or not at all (ADR §12.5, OQ-P1)', () => {
  const all = () => true
  const carry = async (sheetKey: string, source: Record<string, unknown>, overrides: Partial<Parameters<typeof manualRowCopyParentPair>[0]> = {}) => {
    const sheet = await sheetOf(S[sheetKey])
    const { code, name } = sheet.derived.parent
    const sourceData: Record<string, unknown> = {}
    if ('code' in source) sourceData[code] = source.code
    if ('name' in source) sourceData[name] = source.name
    const out = manualRowCopyParentPair({ fields: S[sheetKey].fields, sheet, sourceData, copyComponentCode: 'SYN-OWN', canRead: all, canWrite: all, ...overrides })
    return { out, code, name }
  }

  it('both columns carried, values exactly as the source stores them', async () => {
    const { out, code, name } = await carry('PREG', { code: ' SYN-PARENT ', name: 'Synthetic parent ' })
    expect(out).toEqual({ [code]: ' SYN-PARENT ', [name]: 'Synthetic parent ' })
  })
  it('a parent without a name: the 图号 is carried and the name travels as null (the pair still goes together)', async () => {
    for (const source of [{ code: 'SYN-PARENT' }, { code: 'SYN-PARENT', name: null }]) {
      const { out, code, name } = await carry('PREG', source)
      expect(out).toEqual({ [code]: 'SYN-PARENT', [name]: null })
    }
    const blankName = await carry('PREG', { code: 'SYN-PARENT', name: '' })
    expect(blankName.out).toEqual({ [blankName.code]: 'SYN-PARENT', [blankName.name]: '' })
  })
  it.each([
    ['the source has no parent', {}],
    ['both blank', { code: '', name: null }],
    ['a name without a 图号 (a PLM child whose parent has no drawing number)', { name: 'Synthetic parent' }],
    ['a name with a whitespace 图号', { code: '  ', name: 'Synthetic parent' }],
    ['a 图号 that is not text', { code: 42, name: 'Synthetic parent' }],
    ['a name that is not text', { code: 'SYN-PARENT', name: { text: 'x' } }],
  ])('%s → neither column', async (_label, source) => {
    expect((await carry('PREG', source)).out).toEqual({})
  })
  it('P5 against the NEW row: a parent equal to the copy\'s own 图号 is not carried (whitespace ignored); a copy without a 图号 carries it', async () => {
    expect((await carry('PREG', { code: 'SYN-OWN', name: 'Synthetic parent' })).out).toEqual({})
    expect((await carry('PREG', { code: ' SYN-OWN ', name: 'Synthetic parent' })).out).toEqual({})
    const noOwn = await carry('PREG', { code: 'SYN-OWN', name: 'Synthetic parent' }, { copyComponentCode: undefined })
    expect(noOwn.out).toEqual({ [noOwn.code]: 'SYN-OWN', [noOwn.name]: 'Synthetic parent' })
  })
  it('the actor must be able to READ and WRITE BOTH columns — one missing answer on either column drops both', async () => {
    const sheet = await sheetOf(S.PREG)
    const { code, name } = sheet.derived.parent
    for (const column of [code, name]) {
      expect((await carry('PREG', { code: 'SYN-PARENT', name: 'Synthetic parent' }, { canRead: (id) => id !== column })).out, `read ${column}`).toEqual({})
      expect((await carry('PREG', { code: 'SYN-PARENT', name: 'Synthetic parent' }, { canWrite: (id) => id !== column })).out, `write ${column}`).toEqual({})
    }
  })
  it.each(['PAIRUNLOCKED', 'PAIRHALFLOCKED', 'NOPARENTNAME'])('%s: the routes do not write the pair on this sheet → neither column, whatever the actor may do', async (key) => {
    expect((await carry(key, { code: 'SYN-PARENT', name: 'Synthetic parent' })).out).toEqual({})
  })
})

describe('G-06 the create: the pair check, and the transaction\'s re-check of the pair\'s lock', () => {
  it('assertManualRowParentPairForCreate: P3 / P4 / P5 over the create\'s own data', async () => {
    const sheet = await sheetOf(S.PREG)
    const { code, name } = sheet.derived.parent
    const own = sheet.derived.componentCode
    const reasonFor = (data: Record<string, unknown>) => {
      try {
        assertManualRowParentPairForCreate(sheet, data)
        return null
      } catch (err) {
        expect(err).toBeInstanceOf(StockPrepManualRowParentRefusedError)
        return (err as StockPrepManualRowParentRefusedError).reason
      }
    }
    expect(reasonFor({})).toBeNull()
    expect(reasonFor({ [own]: 'SYN-1' })).toBeNull()
    expect(reasonFor({ [code]: 'SYN-P', [name]: 'Synthetic parent', [own]: 'SYN-1' })).toBeNull()
    expect(reasonFor({ [code]: null, [name]: null })).toBeNull()
    expect(reasonFor({ [code]: 'SYN-P' })).toBe('pair_incomplete')
    expect(reasonFor({ [name]: 'Synthetic parent' })).toBe('pair_incomplete')
    expect(reasonFor({ [code]: 7, [name]: null })).toBe('not_text')
    expect(reasonFor({ [code]: '', [name]: 'Synthetic parent' })).toBe('name_without_code')
    expect(reasonFor({ [code]: 'SYN-1', [name]: 'Synthetic parent', [own]: 'SYN-1' })).toBe('self_parent')
    expect(reasonFor({ [code]: ' SYN-1', [name]: null, [own]: 'SYN-1 ' })).toBe('self_parent')
    expect(manualRowParentPairProblemOf(sheet, { [code]: 'SYN-P' })).toBe('pair_incomplete')
    // an inherited key is not a submitted column
    expect(manualRowParentPairProblemOf(sheet, Object.create({ [code]: 'SYN-P' }))).toBeNull()
  })
  it('assertManualRowCreateInTransaction re-checks the pair\'s lock on the RE-READ fields — only for data that names the pair', async () => {
    const sheet = await sheetOf(S.PREG)
    const extension = mintManualRowCreateExtension({ ...sheet, projectNo: MR_PROJECT_NO }, 'create')
    const { code, name } = sheet.derived.parent
    const reread = S.PREG.fields.map((field) => ({ id: field.id, property: { ...field.property } }))
    await expect(assertManualRowCreateInTransaction(query, extension, reread, [code, name])).resolves.toMatchObject({ sheetId: S.PREG.sheetId })
    // The lock left 父组件名称 between the route's check and the transaction.
    const unlocked = reread.map((field) => (field.id === name ? { id: field.id, property: { ...field.property, humanWriteLock: undefined } } : field))
    await expect(assertManualRowCreateInTransaction(query, extension, unlocked, [code, name])).rejects.toMatchObject({ reason: 'lock_missing' })
    await expect(assertManualRowCreateInTransaction(query, extension, unlocked, [code])).rejects.toBeInstanceOf(StockPrepManualRowsRefusedError)
    // The same re-read fields are fine for a create that does not name the pair.
    await expect(assertManualRowCreateInTransaction(query, extension, unlocked, [sheet.derived.componentName])).resolves.toMatchObject({ sheetId: S.PREG.sheetId })
    await expect(assertManualRowCreateInTransaction(query, extension, unlocked)).resolves.toMatchObject({ sheetId: S.PREG.sheetId })
  })
})

describe('G-07 the edit transaction\'s re-check — P5 on the locked, merged row', () => {
  const manualRecord = (sheet: FakeSheet, id: string, cells: Record<string, unknown>) =>
    fake.addRecord(sheet, id, { projectNo: MR_PROJECT_NO, idempotencyKey: `${MANUAL_ROW_KEY_V1_PREFIX}${id}`, active: true, componentName: 'SYN', totalQuantity: 1, ...cells }, 'u_mrp1_writer')
  const recheck = async (sheetKey: string, recordId: string, changes?: Record<string, unknown>) => {
    const sheet = await sheetOf(S[sheetKey])
    try {
      await assertManualRowEditInTransaction(query, sheet, recordId, changes)
      return 'ok'
    } catch (err) {
      return (err as { reason?: string }).reason ?? String(err)
    }
  }

  it('direction 1 — the patch sets the parent to the row\'s own stored 图号: self_parent', async () => {
    const row = manualRecord(S.PREG, 'rec_mrp1_g07_a', { componentCode: 'SYN-1' })
    const { code, name } = pairOf(S.PREG)
    expect(await recheck('PREG', row.id, { [code]: 'SYN-1', [name]: 'Synthetic parent' })).toBe('self_parent')
    expect(await recheck('PREG', row.id, { [code]: ' SYN-1 ', [name]: null })).toBe('self_parent')
    expect(await recheck('PREG', row.id, { [code]: 'SYN-2', [name]: 'Synthetic parent' })).toBe('ok')
  })
  it('direction 2 — the patch sets the row\'s own 图号 to the STORED parent: self_parent, though the patch does not name the pair', async () => {
    const row = manualRecord(S.PREG, 'rec_mrp1_g07_b', { componentCode: 'SYN-1', parentComponentCode: 'SYN-P', parentComponentName: 'Synthetic parent' })
    const own = ph(S.PREG, 'componentCode')
    expect(await recheck('PREG', row.id, { [own]: 'SYN-P' })).toBe('self_parent')
    expect(await recheck('PREG', row.id, { [own]: 'SYN-P  ' })).toBe('self_parent')
    expect(await recheck('PREG', row.id, { [own]: 'syn-p' })).toBe('ok')
    expect(await recheck('PREG', row.id, { [own]: null })).toBe('ok')
  })
  it('the MERGED row decides: a patch that moves both columns is judged on the two new values', async () => {
    const row = manualRecord(S.PREG, 'rec_mrp1_g07_c', { componentCode: 'SYN-1', parentComponentCode: 'SYN-P', parentComponentName: null })
    const { code, name } = pairOf(S.PREG)
    const own = ph(S.PREG, 'componentCode')
    // new parent = the OLD own 图号, new own 图号 = something else → fine
    expect(await recheck('PREG', row.id, { [code]: 'SYN-1', [name]: null, [own]: 'SYN-9' })).toBe('ok')
    // new parent = new own 图号 → refused
    expect(await recheck('PREG', row.id, { [code]: 'SYN-9', [name]: null, [own]: 'SYN-9' })).toBe('self_parent')
    // removing the parent while the 图号 becomes the old parent → fine
    expect(await recheck('PREG', row.id, { [code]: null, [name]: null, [own]: 'SYN-P' })).toBe('ok')
  })
  it('it judges the row the FOR UPDATE read returned — a value another writer committed after the route\'s first read', async () => {
    const row = manualRecord(S.PREG, 'rec_mrp1_g07_d', { componentCode: 'SYN-1' })
    const { code, name } = pairOf(S.PREG)
    const own = ph(S.PREG, 'componentCode')
    // The concurrent writer's commit lands before this transaction takes the row lock.
    fake.setOnRecordLockForUpdate((record) => { record.data[own] = 'SYN-P' })
    expect(await recheck('PREG', row.id, { [code]: 'SYN-P', [name]: null })).toBe('self_parent')
    fake.setOnRecordLockForUpdate((record) => { record.data[code] = 'SYN-7' })
    expect(await recheck('PREG', row.id, { [own]: 'SYN-7' })).toBe('self_parent')
    const lockReads = fake.statements(/^SELECT id, data, created_by FROM meta_records WHERE sheet_id = \$1 AND id = \$2 FOR UPDATE$/)
    expect(lockReads.length).toBe(2)
  })
  it('a patch that names neither 父组件图号 nor the row\'s own 图号 is NOT judged — an unrelated edit never fails on the row\'s existing cells', async () => {
    const row = manualRecord(S.PREG, 'rec_mrp1_g07_e', { componentCode: 'SYN-1', parentComponentCode: 'SYN-1', parentComponentName: 'Synthetic parent' })
    expect(await recheck('PREG', row.id, { [ph(S.PREG, 'material')]: 'SYN-MATERIAL' })).toBe('ok')
    expect(await recheck('PREG', row.id, {})).toBe('ok')
    expect(await recheck('PREG', row.id)).toBe('ok')
  })
  it('P3 / P4 hold inside the guard too, whatever the route did before it', async () => {
    const row = manualRecord(S.PREG, 'rec_mrp1_g07_f', { componentCode: 'SYN-1' })
    const { code, name } = pairOf(S.PREG)
    expect(await recheck('PREG', row.id, { [code]: 'SYN-P' })).toBe('pair_incomplete')
    expect(await recheck('PREG', row.id, { [name]: 'Synthetic parent' })).toBe('pair_incomplete')
    expect(await recheck('PREG', row.id, { [code]: 5, [name]: null })).toBe('not_text')
    expect(await recheck('PREG', row.id, { [code]: '', [name]: 'Synthetic parent' })).toBe('name_without_code')
  })
  it('M comes first: a row that is not a manual row is refused as not_manual_row, pair or no pair', async () => {
    const plm = fake.addRecord(S.PREG, 'rec_mrp1_g07_plm', { idempotencyKey: '{"componentSourceId":"SYN"}', componentCode: 'SYN-1' }, null)
    const { code, name } = pairOf(S.PREG)
    expect(await recheck('PREG', plm.id, { [code]: 'SYN-P', [name]: null })).toBe('not_manual_row')
    expect(await recheck('PREG', 'rec_mrp1_g07_absent', { [code]: 'SYN-P', [name]: null })).toBe('not_manual_row')
  })
  it('the pair\'s lock is part of the re-check: lifted on the re-read fields → lock_missing, only for a patch that names the pair', async () => {
    const row = manualRecord(S.PREG, 'rec_mrp1_g07_g', { componentCode: 'SYN-1' })
    const { code, name } = pairOf(S.PREG)
    const lift = () => fake.setOnTransactionFieldRead((sheet) => {
      delete sheet.fields.find((field) => field.id === code)!.property.humanWriteLock
    })
    const sheet = await sheetOf(S.PREG)
    lift()
    await expect(assertManualRowEditInTransaction(query, sheet, row.id, { [code]: 'SYN-P', [name]: null })).rejects.toMatchObject({ reason: 'lock_missing' })
    // the lock is gone for good on the fake now; an edit of the six is still fine
    await expect(assertManualRowEditInTransaction(query, sheet, row.id, { [ph(S.PREG, 'material')]: 'SYN' })).resolves.toBeUndefined()
  })
})

// ── S. the picker's statements ───────────────────────────────────────────────────────────────────────

describe('S-01 the query-string parser', () => {
  const ok = (query_: Record<string, unknown> | null | undefined) => {
    const parsed = parseManualRowParentOptionsQuery(query_)
    if (parsed.kind !== 'ok') throw new Error(`expected ok, got ${parsed.message}`)
    return parsed.value
  }
  it('defaults: no search, 20', () => {
    expect(ok({})).toEqual({ q: '', limit: 20 })
    expect(ok(null)).toEqual({ q: '', limit: MANUAL_ROW_PARENT_OPTIONS_DEFAULT_LIMIT })
    expect(ok(undefined)).toEqual({ q: '', limit: 20 })
  })
  it('q is trimmed and otherwise kept as typed (lower-casing is the parameter list\'s job)', () => {
    expect(ok({ q: '  SYN-Parent ' }).q).toBe('SYN-Parent')
    expect(ok({ q: '' }).q).toBe('')
    expect(ok({ q: '100%_\\' }).q).toBe('100%_\\')
  })
  it.each([
    ['1', 1], ['20', 20], ['50', 50], ['51', 50], ['999999', 50], ['0', 1], [' 7 ', 7], ['007', 7], ['9999999', 50], ['9'.repeat(400), 50],
    ['abc', 20], ['-3', 20], ['1.5', 20], ['', 20], ['1e3', 20], ['0x10', 20], ['5 6', 20],
  ])('limit %j → %s (clamped to 1 – 50; anything that is not an integer falls back to 20)', (raw, expected) => {
    expect(ok({ limit: raw }).limit).toBe(expected)
    expect(expected).toBeLessThanOrEqual(MANUAL_ROW_PARENT_OPTIONS_MAX_LIMIT)
  })
  it('a limit that is not a single string falls back to the default', () => {
    for (const raw of [5, ['5', '6'], { a: 1 }, null]) expect(ok({ limit: raw }).limit, JSON.stringify(raw)).toBe(20)
  })
  it('q longer than 200 characters, or not a single text value, is refused', () => {
    expect(parseManualRowParentOptionsQuery({ q: 'x'.repeat(201) })).toEqual({ kind: 'invalid', message: 'q must be at most 200 characters' })
    expect(ok({ q: 'x'.repeat(200) }).q).toHaveLength(200)
    expect(parseManualRowParentOptionsQuery({ q: ['a', 'b'] })).toEqual({ kind: 'invalid', message: 'q must be a single text value' })
    expect(parseManualRowParentOptionsQuery({ q: { a: 'b' } }).kind).toBe('invalid')
  })
})

describe('S-02 the two statements are fixed text', () => {
  const statements = { options: MANUAL_ROW_PARENT_OPTIONS_SQL, dependents: MANUAL_ROW_PARENT_DEPENDENTS_SQL }
  it('each uses exactly its parameters, 1…n, with no gap', () => {
    const numbers = (sql: string) => [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
    expect(numbers(statements.options)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(numbers(statements.dependents)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
  it.each(Object.entries(statements))('%s: every JSON key it reads is a `$n::text` parameter — no column id is part of the text', (_name, sql) => {
    const keyReads = [...sql.matchAll(/\bdata\s*->>?\s*([^\s,)]+)/g)]
    expect(keyReads.length).toBeGreaterThan(0)
    for (const read of keyReads) expect(read[1], read[0]).toMatch(/^\$\d+::text$/)
    // …and `data` is never used whole (no row leaves the database)
    expect(sql.match(/\bdata\b/g)).toHaveLength(keyReads.length)
    // the only quoted literals are SQL's own closed words
    const literals = [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1])
    for (const literal of literals) expect(['true', 'string', '{}', '', 'parent', 'component'], literal).toContain(literal)
    expect(sql).not.toMatch(/fld_|\$\{|--|;/)
  })
  it('options: the row cut — sheet, the optional active filter and the deny set — happens in the first CTE, before anything is grouped, counted or capped', () => {
    const sql = MANUAL_ROW_PARENT_OPTIONS_SQL
    const picked = sql.slice(sql.indexOf('WITH picked AS MATERIALIZED ('), sql.indexOf('texts AS ('))
    expect(picked).toContain('FROM meta_records')
    expect(picked).toContain('WHERE sheet_id = $1')
    expect(picked).toContain("AND ($6::text IS NULL OR data ->> $6::text = 'true')")
    expect(picked).toContain('AND NOT (id = ANY($7::text[]))')
    // nothing after the first CTE reads the table again
    expect(sql.split('FROM meta_records')).toHaveLength(2)
    expect(sql.indexOf('COUNT(*)')).toBeGreaterThan(sql.indexOf('texts AS ('))
    expect(sql.indexOf('LIMIT $10::int')).toBeGreaterThan(sql.indexOf('COUNT(*)'))
  })
  it('options: only JSON strings are candidates; a blank 图号 is never listed; the search reads the two output columns only', () => {
    const sql = MANUAL_ROW_PARENT_OPTIONS_SQL
    expect(sql.match(/jsonb_typeof\(\w+\) = 'string'/g)).toHaveLength(4)
    expect(sql).toContain("WHERE BTRIM(parent_code, $8::text) <> ''")
    expect(sql).toContain("WHERE BTRIM(code, $8::text) <> ''")
    expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM parents WHERE parents.code = texts.code)')
    const tail = sql.slice(sql.lastIndexOf('SELECT code, name, kind, child_count'))
    expect(tail).toContain("WHERE $9::text = ''")
    expect(tail).toContain('OR strpos(LOWER(code), $9::text) > 0')
    expect(tail).toContain("OR strpos(LOWER(COALESCE(name, '')), $9::text) > 0")
    expect(tail).not.toMatch(/LIKE|ESCAPE/)
  })
  it('options: the order is fixed and locale-independent — parents first, then 图号, then 名称', () => {
    expect(MANUAL_ROW_PARENT_OPTIONS_SQL).toContain('ORDER BY CASE WHEN kind = \'parent\' THEN 0 ELSE 1 END, code COLLATE "C", name COLLATE "C" NULLS FIRST')
  })
  it('dependents: one number over OTHER manual rows of the sheet the actor may read', () => {
    const sql = MANUAL_ROW_PARENT_DEPENDENTS_SQL
    expect(sql.startsWith('SELECT COUNT(*)::int AS dependents')).toBe(true)
    for (const clause of [
      'WHERE sheet_id = $1',
      'AND id <> $2',
      'AND BTRIM(data ->> $3::text, $7::text) = BTRIM($4::text, $7::text)',
      'AND data ->> $5::text = $6::text || id',
      'AND created_by IS NOT NULL',
      "AND BTRIM(created_by, $7::text) <> ''",
      'AND NOT (id = ANY($8::text[]))',
    ]) expect(sql, clause).toContain(clause)
  })
})

describe('S-03 the parameter lists', () => {
  const columns = { code: 'fld_c', name: 'fld_n', parentCode: 'fld_pc', parentName: 'fld_pn', active: 'fld_a' }
  it('options: the layout the statement documents; limit + 1; the search lower-cased', () => {
    expect(manualRowParentOptionsParams({ sheetId: 'sheet_x', columns, deniedRecordIds: ['rec_1'], q: 'SYN-Parent', limit: 20 })).toEqual([
      'sheet_x', 'fld_c', 'fld_n', 'fld_pc', 'fld_pn', 'fld_a', ['rec_1'], MANUAL_ROW_PARENT_SQL_TRIM_CHARS, 'syn-parent', 21,
    ])
  })
  it('options: a column the actor may not read travels as NULL, never as an id', () => {
    const params = manualRowParentOptionsParams({ sheetId: 'sheet_x', columns: { code: null, name: null, parentCode: 'fld_pc', parentName: null, active: null }, deniedRecordIds: [], q: '', limit: 50 })
    expect(params).toEqual(['sheet_x', null, null, 'fld_pc', null, null, [], MANUAL_ROW_PARENT_SQL_TRIM_CHARS, '', 51])
  })
  it('dependents: the layout the statement documents, the key prefix as a parameter', () => {
    expect(manualRowParentDependentsParams({ sheetId: 'sheet_x', recordId: 'rec_self', parentCodeFieldId: 'fld_pc', ownCode: 'SYN-1', keyFieldId: 'fld_k', deniedRecordIds: ['rec_d'] })).toEqual([
      'sheet_x', 'rec_self', 'fld_pc', 'SYN-1', 'fld_k', 'manual:v1:', MANUAL_ROW_PARENT_SQL_TRIM_CHARS, ['rec_d'],
    ])
  })
  it('the trim characters are the eight documented ones, and the deny list is copied', () => {
    expect([...MANUAL_ROW_PARENT_SQL_TRIM_CHARS].map((ch) => ch.codePointAt(0))).toEqual([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c, 0xa0, 0x3000])
    const denied = ['rec_1']
    const params = manualRowParentOptionsParams({ sheetId: 's', columns, deniedRecordIds: denied, q: '', limit: 1 })
    expect(params[6]).toEqual(denied)
    expect(params[6]).not.toBe(denied)
  })
})

describe('S-04 the row mappers', () => {
  it('the page: the first `limit` of `limit + 1` rows, and whether there were more', () => {
    expect(manualRowParentOptionsPage([1, 2, 3], 2)).toEqual({ rows: [1, 2], truncated: true })
    expect(manualRowParentOptionsPage([1, 2], 2)).toEqual({ rows: [1, 2], truncated: false })
    expect(manualRowParentOptionsPage([], 20)).toEqual({ rows: [], truncated: false })
  })
  it('an entry: the masked 图号 / 名称 as stored; childCount only for a parent; a blank name is null', () => {
    expect(manualRowParentOptionOf({ kind: 'parent', child_count: 3 }, ' SYN-P ', 'Synthetic parent')).toEqual({ code: ' SYN-P ', name: 'Synthetic parent', kind: 'parent', childCount: 3 })
    expect(manualRowParentOptionOf({ kind: 'parent', child_count: '4' }, 'SYN-P', null)).toEqual({ code: 'SYN-P', name: null, kind: 'parent', childCount: 4 })
    expect(manualRowParentOptionOf({ kind: 'component', child_count: null }, 'SYN-C', '  ')).toEqual({ code: 'SYN-C', name: null, kind: 'component' })
    expect(manualRowParentOptionOf({ kind: 'anything else' }, 'SYN-C', undefined)).toEqual({ code: 'SYN-C', name: null, kind: 'component' })
    expect(manualRowParentOptionOf({ kind: 'parent', child_count: 'x' }, 'SYN-P', 'n')).toMatchObject({ childCount: 0 })
  })
  it('a row whose 图号 did not survive the mask, or is blank, yields no entry', () => {
    for (const code of [undefined, null, '', '   ', 5, {}]) expect(manualRowParentOptionOf({ kind: 'parent', child_count: 1 }, code, 'name'), JSON.stringify(code)).toBeNull()
  })
  it('the dependents count: the statement\'s single number, anything unexpected is 0', () => {
    expect(manualRowParentDependentsCountOf([{ dependents: 3 }])).toBe(3)
    expect(manualRowParentDependentsCountOf([{ dependents: '2' }])).toBe(2)
    for (const rows of [[], null, undefined, [{}], [{ dependents: -1 }], [{ dependents: 'x' }]]) expect(manualRowParentDependentsCountOf(rows as never)).toBe(0)
  })
})

// ── F. the fake's evaluation of the two statements (what the route suite runs them on) ──────────────
//
// The route suite answers the two statements from tests/utils/stock-prep-manual-rows-fake-pg.ts. These cases state
// the semantics that evaluation implements, on the statements' own parameter lists, so a change of either side reds.

describe('F-01 the fake evaluates the candidate statement as documented', () => {
  const C = 'fld_c'
  const N = 'fld_n'
  const PC = 'fld_pc'
  const PN = 'fld_pn'
  const A = 'fld_a'
  const row = (id: string, data: Record<string, unknown>, sheet = 'sheet_x') => ({ id, sheet_id: sheet, data: { [A]: true, ...data } })
  const all = { code: C, name: N, parentCode: PC, parentName: PN, active: A }
  const run = (records: Array<ReturnType<typeof row>>, over: Partial<{ columns: typeof all | Record<string, string | null>; denied: string[]; q: string; limit: number }> = {}) =>
    evaluateParentOptionsStatement(records, manualRowParentOptionsParams({
      sheetId: 'sheet_x', columns: (over.columns ?? all) as never, deniedRecordIds: over.denied ?? [], q: over.q ?? '', limit: over.limit ?? 20,
    }))
  const RECORDS = [
    row('r1', { [C]: 'A-1', [N]: 'Assembly', [PC]: null }),
    row('r2', { [C]: 'B-1', [N]: 'Part b', [PC]: 'A-1', [PN]: 'Assembly and spec' }),
    row('r3', { [C]: 'B-2', [N]: 'Part c', [PC]: 'A-1', [PN]: 'Assembly and spec' }),
    row('r4', { [C]: 'B-2', [N]: 'Part c', [PC]: 'Z-9', [PN]: null }),
    row('r5', { [C]: '  ', [N]: 'No code' }),
    row('r6', { [C]: 'I-1', [N]: 'Inactive', [A]: false }),
    row('r7', { [C]: 'O-1', [N]: 'Other sheet' }, 'sheet_other'),
    row('r8', { [C]: 77, [N]: 'A number is not a 图号 candidate', [PC]: { not: 'text' } }),
  ]
  it('parents (with child counts) first, then the components that are not already parents; blank, inactive, foreign and non-text rows out', () => {
    expect(run(RECORDS)).toEqual([
      { code: 'A-1', name: 'Assembly and spec', kind: 'parent', child_count: 2 },
      { code: 'Z-9', name: null, kind: 'parent', child_count: 1 },
      { code: 'B-1', name: 'Part b', kind: 'component', child_count: null },
      { code: 'B-2', name: 'Part c', kind: 'component', child_count: null },
    ])
  })
  it('a NULL column id reads nothing: no name, no kind of entry, no active filter', () => {
    expect(run(RECORDS, { columns: { ...all, parentName: null } }).filter((item) => item.kind === 'parent')).toEqual([
      { code: 'A-1', name: null, kind: 'parent', child_count: 2 },
      { code: 'Z-9', name: null, kind: 'parent', child_count: 1 },
    ])
    expect(run(RECORDS, { columns: { ...all, parentCode: null, parentName: null } }).map((item) => [item.kind, item.code])).toEqual([
      ['component', 'A-1'], ['component', 'B-1'], ['component', 'B-2'],
    ])
    expect(run(RECORDS, { columns: { ...all, code: null, name: null } }).every((item) => item.kind === 'parent')).toBe(true)
    expect(run(RECORDS, { columns: { ...all, active: null } }).map((item) => item.code)).toContain('I-1')
  })
  it('denied rows are cut before grouping: the count drops, an entry only they carried disappears', () => {
    expect(run(RECORDS, { denied: ['r2'] })[0]).toEqual({ code: 'A-1', name: 'Assembly and spec', kind: 'parent', child_count: 1 })
    expect(run(RECORDS, { denied: ['r4'] }).map((item) => item.code)).not.toContain('Z-9')
    // with its children denied, A-1 is no longer a parent and is listed as the component it also is
    expect(run(RECORDS, { denied: ['r2', 'r3'] })).toContainEqual({ code: 'A-1', name: 'Assembly', kind: 'component', child_count: null })
  })
  it('the search is a case-insensitive substring of 图号 or 名称 of the ENTRY; the cap is limit + 1', () => {
    expect(run(RECORDS, { q: 'PART' }).map((item) => item.code)).toEqual(['B-1', 'B-2'])
    expect(run(RECORDS, { q: 'z-9' }).map((item) => item.code)).toEqual(['Z-9'])
    // A-1's own row name 'Assembly' is not the entry's name once A-1 is listed as a parent — the entry is matched
    expect(run(RECORDS, { q: 'and spec' }).map((item) => item.code)).toEqual(['A-1'])
    expect(run(RECORDS, { q: 'nothing matches' })).toEqual([])
    expect(run(RECORDS, { limit: 1 })).toHaveLength(2)
  })
  it('byte order, and values returned exactly as stored', () => {
    const records = [row('a', { [C]: 'b' }), row('b', { [C]: 'B' }), row('c', { [C]: ' a ' }), row('d', { [C]: '图' })]
    expect(run(records).map((item) => item.code)).toEqual([' a ', 'B', 'b', '图'])
  })
})

describe('F-02 the fake evaluates the dependents statement as documented', () => {
  const PC = 'fld_pc'
  const K = 'fld_k'
  const child = (id: string, parent: unknown, over: Partial<{ createdBy: string | null; key: string; sheet: string }> = {}) => ({
    id, sheet_id: over.sheet ?? 'sheet_x', created_by: over.createdBy === undefined ? 'u_person' : over.createdBy, data: { [PC]: parent, [K]: over.key ?? `manual:v1:${id}` },
  })
  const count = (records: Array<ReturnType<typeof child>>, denied: string[] = [], ownCode = 'SYN-1') =>
    evaluateParentDependentsStatement(records, manualRowParentDependentsParams({ sheetId: 'sheet_x', recordId: 'self', parentCodeFieldId: PC, ownCode, keyFieldId: K, deniedRecordIds: denied }))
  it('other manual rows whose parent is this 图号 (whitespace ignored); never the row itself, a PLM row, a creator-less row or another sheet', () => {
    const records = [
      child('self', 'SYN-1'),
      child('c1', 'SYN-1'),
      child('c2', ' SYN-1\t'),
      child('c3', 'SYN-2'),
      child('c4', 'SYN-1', { key: '{"componentSourceId":"SYN"}' }),
      child('c5', 'SYN-1', { createdBy: null }),
      child('c6', 'SYN-1', { createdBy: '   ' }),
      child('c7', 'SYN-1', { key: 'manual:v1:someone_else' }),
      child('c8', 'SYN-1', { sheet: 'sheet_other' }),
      child('c9', null),
    ]
    expect(count(records)).toBe(2)
    expect(count(records, ['c1'])).toBe(1)
    expect(count(records, [], 'SYN-2')).toBe(1)
    expect(count(records, [], 'syn-1')).toBe(0)
  })
})
