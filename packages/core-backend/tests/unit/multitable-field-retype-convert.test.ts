/**
 * 字段类型转换第 2 刀 —— 纯函数单测（转换矩阵、往返保真 A、选项生成、目标 property、planHash、预览凭证）。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §1 / §2 / §4 / §5。
 * DB-free；路由接线见 multitable-field-retype-convert-preview-route.test.ts。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

import jwt from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  canonicalFieldRetypeConvertPlanInput,
  classifyFieldRetypeConvertCell,
  classifyFieldRetypeConvertPair,
  compareCodeUnits,
  deriveFieldRetypeConvertTargetProperty,
  FIELD_RETYPE_CONVERT_EXCLUDED_TYPES,
  FIELD_RETYPE_CONVERT_FIRST_BATCH,
  FIELD_RETYPE_CONVERT_FLAG_ENV,
  FIELD_RETYPE_MAX_OPTIONS,
  isFieldRetypeConvertEnabled,
  isFieldRetypeConvertTrashBlocking,
  planFieldRetypeConvert,
  toFieldRetypeConvertPreviewResponse,
  type FieldRetypeConvertLiveCell,
  type FieldRetypeConvertTrashCell,
} from '../../src/multitable/field-retype-convert'
import { FIELD_RETYPE_EXCLUDED_TYPES, LOSSLESS_FIELD_RETYPE } from '../../src/multitable/field-retype-whitelist'
import { SHEET_REVERT_DEFAULT_MAX_RECORDS } from '../../src/multitable/restore-caps'
import {
  hashFieldRetypeConvertPlan,
  mintFieldRetypeConvertPreviewIdentity,
  verifyFieldRetypeConvertPreviewIdentity,
} from '../../src/multitable/restore-preview-identity'

const SRC = path.resolve(__dirname, '../../src/multitable')
const TRUTH_TABLE = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/field-retype-truth-table.json'), 'utf8'),
) as { excludedTargetTypes: string[]; table: Record<string, string[]> }

const live = (recordId: string, value: unknown, opts: { version?: number; missing?: boolean; notObject?: boolean } = {}): FieldRetypeConvertLiveCell => ({
  recordId,
  version: opts.version ?? 1,
  dataIsObject: opts.notObject !== true,
  hasKey: opts.missing !== true,
  value: opts.missing === true ? null : value,
})
const trash = (recordId: string, value: unknown, opts: { missing?: boolean; notObject?: boolean } = {}): FieldRetypeConvertTrashCell => ({
  recordId,
  dataIsObject: opts.notObject !== true,
  hasKey: opts.missing !== true,
  value: opts.missing === true ? null : value,
})
const plan = (cells: FieldRetypeConvertLiveCell[], trashRows: FieldRetypeConvertTrashCell[] = [], sourceProperty: Record<string, unknown> = {}, targetType: 'select' | 'multiSelect' = 'select') =>
  planFieldRetypeConvert({ sourceProperty, targetType, live: cells, trash: trashRows })

// ── 新旧分离（ADR §1 L6 / v2 前提 1.3）──────────────────────────────────────────────────────────────────
describe('separation from the lossless whitelist', () => {
  test('first-batch pairs ∩ LOSSLESS_FIELD_RETYPE = ∅ (and ∩ the shared truth table = ∅)', () => {
    const firstBatch = Object.entries(FIELD_RETYPE_CONVERT_FIRST_BATCH).flatMap(([s, ts]) => ts.map((t) => `${s}→${t}`))
    expect(firstBatch.sort()).toEqual(['string→multiSelect', 'string→select'])
    const lossless = new Set(Object.entries(LOSSLESS_FIELD_RETYPE).flatMap(([s, ts]) => ts.map((t) => `${s}→${t}`)))
    const fixture = new Set(Object.entries(TRUTH_TABLE.table).flatMap(([s, ts]) => ts.map((t) => `${s}→${t}`)))
    expect(firstBatch.filter((p) => lossless.has(p))).toEqual([])
    expect(firstBatch.filter((p) => fixture.has(p))).toEqual([])
  })

  test('the convert module and the whitelist import NOTHING from each other (source-level)', () => {
    const convertSrc = fs.readFileSync(path.join(SRC, 'field-retype-convert.ts'), 'utf8')
    const previewSrc = fs.readFileSync(path.join(SRC, 'field-retype-convert-preview.ts'), 'utf8')
    const whitelistSrc = fs.readFileSync(path.join(SRC, 'field-retype-whitelist.ts'), 'utf8')
    const importRe = /(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g
    const specifiers = (src: string) => [...src.matchAll(importRe)].map((m) => m[1] ?? m[2] ?? m[3])
    expect(specifiers(convertSrc).filter((s) => /field-retype-whitelist/.test(s))).toEqual([])
    expect(specifiers(previewSrc).filter((s) => /field-retype-whitelist/.test(s))).toEqual([])
    expect(specifiers(whitelistSrc).filter((s) => /field-retype-convert/.test(s))).toEqual([])
    // the scan itself is not vacuous: the convert module does import something (node:crypto)
    expect(specifiers(convertSrc).length).toBeGreaterThan(0)
  })

  test('its own excluded set equals the whitelist set and the truth-table set (compared, not imported)', () => {
    expect([...FIELD_RETYPE_CONVERT_EXCLUDED_TYPES].sort()).toEqual([...FIELD_RETYPE_EXCLUDED_TYPES].sort())
    expect([...FIELD_RETYPE_CONVERT_EXCLUDED_TYPES].sort()).toEqual([...TRUTH_TABLE.excludedTargetTypes].sort())
  })

  test('FIELD_RETYPE_MAX_OPTIONS is its own constant (5000), separate from the record cap', () => {
    expect(FIELD_RETYPE_MAX_OPTIONS).toBe(5000)
    expect(SHEET_REVERT_DEFAULT_MAX_RECORDS).toBe(5000)
  })
})

// ── flag（ADR §5）──────────────────────────────────────────────────────────────────────────────────────
describe('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT — exact literal', () => {
  test("only the byte-exact 'true' activates", () => {
    expect(FIELD_RETYPE_CONVERT_FLAG_ENV).toBe('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT')
    expect(isFieldRetypeConvertEnabled({ MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT: 'true' })).toBe(true)
    for (const v of [undefined, '', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'on']) {
      expect(isFieldRetypeConvertEnabled({ MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT: v })).toBe(false)
    }
  })
})

// ── 配对判定 ────────────────────────────────────────────────────────────────────────────────────────────
describe('classifyFieldRetypeConvertPair', () => {
  test('first batch passes; everything else refuses with a reason', () => {
    expect(classifyFieldRetypeConvertPair('string', 'string', 'select')).toBeNull()
    expect(classifyFieldRetypeConvertPair('string', 'string', 'multiSelect')).toBeNull()
    expect(classifyFieldRetypeConvertPair('string', 'string', 'number')).toBe('pair_not_in_first_batch')
    expect(classifyFieldRetypeConvertPair('string', 'string', 'multi_select')).toBe('pair_not_in_first_batch')
    expect(classifyFieldRetypeConvertPair('longText', 'longText', 'select')).toBe('pair_not_in_first_batch')
    expect(classifyFieldRetypeConvertPair('select', 'select', 'multiSelect')).toBe('pair_not_in_first_batch')
  })

  test('excluded types win over the pair check (otherwise excluded_type would be unreachable)', () => {
    for (const t of FIELD_RETYPE_CONVERT_EXCLUDED_TYPES) {
      expect(classifyFieldRetypeConvertPair(t, t, 'select')).toBe('excluded_type')
      expect(classifyFieldRetypeConvertPair('string', 'string', t)).toBe('excluded_type')
    }
  })

  test('source is judged on the STORED type: an unknown type the route maps to "string" is refused', () => {
    // The route's mapFieldType falls back to 'string' for any unrecognised name; the pair check must not.
    expect(classifyFieldRetypeConvertPair('text', 'string', 'select')).toBe('pair_not_in_first_batch')
    expect(classifyFieldRetypeConvertPair('someCustomType', 'string', 'select')).toBe('pair_not_in_first_batch')
    expect(classifyFieldRetypeConvertPair(null, 'string', 'select')).toBe('pair_not_in_first_batch')
  })
})

// ── 往返保真 A（ADR §4）─────────────────────────────────────────────────────────────────────────────────
describe('rule A — one cell = one option, whitespace rejects the whole run', () => {
  test('leading / trailing whitespace ⇒ leading_trailing_whitespace', () => {
    for (const v of [' A', 'A ', '\tA', 'A\n', '　A', 'A ']) {
      expect(classifyFieldRetypeConvertCell(true, v)).toEqual({ kind: 'rejected', reason: 'leading_trailing_whitespace' })
    }
  })

  test('non-empty whitespace-only ⇒ whitespace_only', () => {
    for (const v of [' ', '   ', '\n', '\t \r\n', '　']) {
      expect(classifyFieldRetypeConvertCell(true, v)).toEqual({ kind: 'rejected', reason: 'whitespace_only' })
    }
  })

  test('empty: missing key / null / "" ⇒ canonical empty (never an option)', () => {
    expect(classifyFieldRetypeConvertCell(false, null)).toEqual({ kind: 'empty' })
    expect(classifyFieldRetypeConvertCell(false, 'ignored when the key is missing')).toEqual({ kind: 'empty' })
    expect(classifyFieldRetypeConvertCell(true, null)).toEqual({ kind: 'empty' })
    expect(classifyFieldRetypeConvertCell(true, '')).toEqual({ kind: 'empty' })
  })

  test('the whole text is one option — separators are ordinary characters, no splitting', () => {
    for (const v of ['A,B', 'A、B', 'A;B', 'A\nB', 'A，B；C']) {
      expect(classifyFieldRetypeConvertCell(true, v)).toEqual({ kind: 'converted', option: v })
    }
    const p = plan([live('r1', 'A,B')], [], {}, 'multiSelect')
    expect(p.optionValues).toEqual(['A,B'])
  })

  test('non-string non-empty value ⇒ non_string_value ([] and {} are NOT empty)', () => {
    for (const v of [0, 1, -1.5, true, false, [], {}, ['A'], { value: 'A' }]) {
      expect(classifyFieldRetypeConvertCell(true, v)).toEqual({ kind: 'rejected', reason: 'non_string_value' })
    }
  })

  test('a single rejected cell rejects the whole run and lists EVERY offending recordId per reason', () => {
    const p = plan([
      live('r3', 'B '),
      live('r1', ' A'),
      live('r2', 'ok'),
      live('r5', '   '),
      live('r4', 42),
      live('r6', 'C\t'),
      live('r7', [], {}),
      live('r8', '', {}),
      live('r9', null, { missing: true }),
    ])
    expect(p.verdict).toBe('rejected')
    expect(p.cells).toEqual({ empty: 2, converted: 1, rejected: 6 })
    expect(p.rejections).toEqual([
      { reason: 'leading_trailing_whitespace', recordCount: 3, recordIds: ['r1', 'r3', 'r6'] },
      { reason: 'whitespace_only', recordCount: 1, recordIds: ['r5'] },
      { reason: 'non_string_value', recordCount: 2, recordIds: ['r4', 'r7'] },
    ])
  })
})

describe('option generation — dedupe and order', () => {
  test('dedupe is exact code-point equality: case-sensitive, no Unicode normalisation', () => {
    const composed = 'é' // é
    const decomposed = 'é' // e + combining acute
    const p = plan([live('r1', 'A'), live('r2', 'A'), live('r3', 'a'), live('r4', composed), live('r5', decomposed), live('r6', composed)])
    expect(p.optionValues).toEqual(['A', 'a', composed, decomposed])
    expect(p.cells.converted).toBe(6)
  })

  test('order = first occurrence while scanning recordIds sorted by the JS code-unit comparator (NOT localeCompare)', () => {
    // code units: 'B'(0x42) < 'a'(0x61); localeCompare would put 'a' first. The option order follows the code units.
    const p = plan([live('a', 'from-a'), live('B', 'from-B')])
    expect(p.optionValues).toEqual(['from-B', 'from-a'])
    expect('a'.localeCompare('B')).toBeLessThan(0) // the discriminator is real: a locale sort WOULD differ
    // 'r10' < 'r2' in code units; uppercase sorts before lowercase
    const q = plan([live('r2', 'two'), live('r10', 'ten'), live('R1', 'upper-one'), live('r1', 'one')])
    expect(q.optionValues).toEqual(['upper-one', 'one', 'ten', 'two'])
    expect(q.sortedLive.map((c) => c.recordId)).toEqual(['R1', 'r1', 'r10', 'r2'])
  })

  test('input order does not matter (any permutation ⇒ the same plan)', () => {
    const cells = [live('r3', 'C'), live('r1', 'A'), live('r2', 'B'), live('r4', 'A')]
    const a = plan(cells)
    const b = plan([...cells].reverse())
    expect(b.optionValues).toEqual(a.optionValues)
    expect(b.optionValues).toEqual(['A', 'B', 'C'])
  })

  test('compareCodeUnits is the hashScope comparator', () => {
    expect(compareCodeUnits('B', 'a')).toBe(-1)
    expect(compareCodeUnits('a', 'B')).toBe(1)
    expect(compareCodeUnits('x', 'x')).toBe(0)
  })

  test('comparator is UTF-16 code units, not code points: a surrogate pair sorts before U+FF61', () => {
    const astral = '\u{1F600}' // code units D83D DE00
    const bmpHigh = '\uFF61'
    expect(compareCodeUnits(astral, bmpHigh)).toBe(-1)
    expect(compareCodeUnits(bmpHigh, astral)).toBe(1)
    // the discriminator is real: by code point the astral character is the LARGER one
    expect(astral.codePointAt(0)!).toBeGreaterThan(bmpHigh.codePointAt(0)!)
    const p = plan([live(`r${bmpHigh}`, 'from-bmp'), live(`r${astral}`, 'from-astral')])
    expect(p.sortedLive.map((c) => c.recordId)).toEqual([`r${astral}`, `r${bmpHigh}`])
    expect(p.optionValues).toEqual(['from-astral', 'from-bmp'])
  })
})

describe('option cap — FIELD_RETYPE_MAX_OPTIONS = 5000, never truncated', () => {
  const distinct = (n: number) => Array.from({ length: n }, (_, i) => live(`r${String(i).padStart(5, '0')}`, `v${i}`))

  test('exactly 5000 distinct values is ok', () => {
    const p = plan(distinct(5000))
    expect(p.verdict).toBe('ok')
    expect(p.optionValues).toHaveLength(5000)
    expect(p.rejections).toEqual([])
  })

  test('5001 distinct values ⇒ rejected option_limit_exceeded, the full sequence is kept (no first-N)', () => {
    const p = plan(distinct(5001))
    expect(p.verdict).toBe('rejected')
    expect(p.optionValues).toHaveLength(5001)
    expect(p.rejections).toEqual([{ reason: 'option_limit_exceeded', recordCount: 0, recordIds: [] }])
    const response = toFieldRetypeConvertPreviewResponse(p, { recordCap: 10_000, previewToken: 'must-not-appear' })
    expect(response.options).toEqual({ new: 5001, final: 5001, limit: 5000, droppedValidationRuleCount: 0 })
    expect(response.previewToken).toBeUndefined()
  })
})

// ── 目标 property（ADR §4）─────────────────────────────────────────────────────────────────────────────
describe('target property = { ...source, options } with validation filtered to {required, enum}', () => {
  test('exact key set, options shape {value} without color, validation filtered + dropped count', () => {
    const source = {
      description: 'd',
      options: [{ value: 'stale', color: '#f00' }],
      validation: [
        { type: 'required' },
        { type: 'minLength', params: { value: 2 } },
        { type: 'enum', params: { values: ['A'] } },
        'junk',
        { type: 5 },
        ['required'],
      ],
      stockPreparation: { ownership: 'plm_system' },
      hidden: true,
    }
    const { property, droppedValidationRuleCount } = deriveFieldRetypeConvertTargetProperty(source, ['A', 'B'])
    expect(Object.keys(property).sort()).toEqual(['description', 'hidden', 'options', 'stockPreparation', 'validation'])
    expect(property.options).toEqual([{ value: 'A' }, { value: 'B' }])
    for (const option of property.options as Array<Record<string, unknown>>) expect(Object.keys(option)).toEqual(['value'])
    expect(property.validation).toEqual([{ type: 'required' }, { type: 'enum', params: { values: ['A'] } }])
    expect(droppedValidationRuleCount).toBe(4)
    expect(property.stockPreparation).toEqual({ ownership: 'plm_system' })
    // the source object is not mutated
    expect(source.options).toEqual([{ value: 'stale', color: '#f00' }])
    expect(source.validation).toHaveLength(6)
  })

  test('no validation key ⇒ none added; a non-array validation is left untouched and not counted', () => {
    const a = deriveFieldRetypeConvertTargetProperty({}, [])
    expect(Object.keys(a.property)).toEqual(['options'])
    expect(a.droppedValidationRuleCount).toBe(0)
    const b = deriveFieldRetypeConvertTargetProperty({ validation: { type: 'minLength' } }, ['X'])
    expect(b.property.validation).toEqual({ type: 'minLength' })
    expect(b.droppedValidationRuleCount).toBe(0)
  })

  test('the plan carries the derived target property and the dropped count', () => {
    const p = plan([live('r1', 'A')], [], { validation: [{ type: 'pattern' }, { type: 'required' }] }, 'multiSelect')
    expect(p.targetProperty).toEqual({ validation: [{ type: 'required' }], options: [{ value: 'A' }] })
    expect(p.droppedValidationRuleCount).toBe(1)
  })
})

// ── 回收站（ADR §2）────────────────────────────────────────────────────────────────────────────────────
describe('recycle-bin rows with a value block the whole run', () => {
  test('blocking predicate: any value but missing / null / "" blocks', () => {
    for (const v of ['A', ' A', 'ok', 0, false, [], {}, ['X']]) expect(isFieldRetypeConvertTrashBlocking(true, v)).toBe(true)
    expect(isFieldRetypeConvertTrashBlocking(true, null)).toBe(false)
    expect(isFieldRetypeConvertTrashBlocking(true, '')).toBe(false)
    expect(isFieldRetypeConvertTrashBlocking(false, 'A')).toBe(false)
  })

  test('clean live + one valued trash row ⇒ rejected trashed_rows_with_value; ids deduped and code-unit sorted', () => {
    const p = plan(
      [live('r1', 'A'), live('r2', 'B')],
      [trash('t2', 'A'), trash('t1', ''), trash('t3', null, { missing: true }), trash('t0', 7), trash('t2', 'B'), trash('T9', null)],
    )
    expect(p.verdict).toBe('rejected')
    expect(p.cells).toEqual({ empty: 0, converted: 2, rejected: 0 })
    expect(p.trash).toEqual({ scanned: 6, blocking: 3 })
    expect(p.rejections).toEqual([{ reason: 'trashed_rows_with_value', recordCount: 2, recordIds: ['t0', 't2'] }])
  })

  test('a row whose data is not a JSON object rejects the whole run — live or recycle bin, whatever its cell reads as', () => {
    // the cell of a non-object row READS as empty (missing key); it must not be converted as one
    const p = plan(
      [live('r1', 'A'), live('r3', null, { missing: true, notObject: true }), live('r2', 'B', { notObject: true })],
      [trash('t1', null, { missing: true, notObject: true }), trash('t2', '')],
    )
    expect(p.verdict).toBe('rejected')
    expect(p.cells).toEqual({ empty: 0, converted: 1, rejected: 2 })
    expect(p.trash).toEqual({ scanned: 2, blocking: 1 })
    expect(p.rejections).toEqual([{ reason: 'record_data_not_object', recordCount: 3, recordIds: ['r2', 'r3', 't1'] }])
    // the value of a non-object row never becomes an option
    expect(p.optionValues).toEqual(['A'])
    // only `true` passes: a loader that does not SAY the row is an object does not get it treated as one
    const unsaid = { recordId: 'r9', version: 1, hasKey: true, value: 'A' } as unknown as FieldRetypeConvertLiveCell
    expect(plan([unsaid]).rejections).toEqual([{ reason: 'record_data_not_object', recordCount: 1, recordIds: ['r9'] }])
    // and the response stays values-free
    expect(JSON.stringify(toFieldRetypeConvertPreviewResponse(p, { recordCap: 5000 }))).not.toMatch(/"A"|"B"/)
  })

  test('empty-shaped trash rows do not block', () => {
    const p = plan([live('r1', 'A')], [trash('t1', ''), trash('t2', null), trash('t3', null, { missing: true })])
    expect(p.verdict).toBe('ok')
    expect(p.trash).toEqual({ scanned: 3, blocking: 0 })
  })
})

// ── 响应投影 values-free（ADR §2）──────────────────────────────────────────────────────────────────────
describe('preview response is values-free', () => {
  test('never carries a cell value or option text; token + confirm only on verdict ok', () => {
    const secretValues = ['机密甲-7f3a', 'SECRET-OPTION-b91', 'B-ONLY-IN-TRASH']
    const okPlan = plan([live('r1', secretValues[0]), live('r2', secretValues[1]), live('r3', '', {})])
    const ok = toFieldRetypeConvertPreviewResponse(okPlan, { recordCap: 5000, previewToken: 'tok' })
    const okJson = JSON.stringify(ok)
    for (const v of secretValues) expect(okJson).not.toContain(v)
    expect(ok).toMatchObject({ verdict: 'ok', sourceType: 'string', targetType: 'select', scannedRecordCount: 3, recordCap: 5000, previewToken: 'tok', confirm: 'convert-field-type' })
    expect(ok.cells).toEqual({ empty: 1, converted: 2, rejected: 0 })
    expect(Object.keys(ok).sort()).toEqual(['cells', 'confirm', 'options', 'previewToken', 'recordCap', 'rejections', 'scannedRecordCount', 'sourceType', 'targetType', 'trash', 'verdict'])

    const badPlan = plan([live('r1', `${secretValues[0]} `)], [trash('t1', secretValues[2])])
    const bad = toFieldRetypeConvertPreviewResponse(badPlan, { recordCap: 5000, previewToken: 'tok' })
    const badJson = JSON.stringify(bad)
    for (const v of secretValues) expect(badJson).not.toContain(v)
    expect(bad.previewToken).toBeUndefined()
    expect(bad.confirm).toBeUndefined()
  })
})

// ── planHash（服务端密钥 HMAC）与凭证（ADR §2「凭证」）─────────────────────────────────────────────────
describe('planHash — keyed HMAC over the whole plan, stable and drift-sensitive', () => {
  const SECRET_ENV = 'RESTORE_PREVIEW_SECRET'
  const original = process.env[SECRET_ENV]
  beforeEach(() => {
    process.env[SECRET_ENV] = 'secret-alpha-0123456789abcdef'
  })
  afterEach(() => {
    if (original === undefined) delete process.env[SECRET_ENV]
    else process.env[SECRET_ENV] = original
  })

  const base = {
    live: [live('r1', 'A', { version: 3 }), live('r2', 'B', { version: 1 }), live('r3', null, { missing: true })],
    trash: [trash('t1', '')],
    sourceProperty: { description: 'x' },
  }
  const hashOf = (over: Partial<typeof base> & { targetType?: 'select' | 'multiSelect'; fieldId?: string } = {}) => {
    const input = { ...base, ...over }
    const p = planFieldRetypeConvert({ sourceProperty: input.sourceProperty, targetType: over.targetType ?? 'select', live: input.live, trash: input.trash })
    return hashFieldRetypeConvertPlan(
      canonicalFieldRetypeConvertPlanInput({ sheetId: 'sheet_1', fieldId: over.fieldId ?? 'fld_1', sourceType: 'string', sourceProperty: input.sourceProperty, plan: p }),
    )
  }

  test('stable: same plan ⇒ same hash, regardless of row order', () => {
    const a = hashOf()
    expect(hashOf()).toBe(a)
    expect(hashOf({ live: [...base.live].reverse() })).toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test('is a function of the SERVER SECRET, and is NOT the plain sha256 of its canonical input', () => {
    const p = planFieldRetypeConvert({ sourceProperty: base.sourceProperty, targetType: 'select', live: base.live, trash: base.trash })
    const canonical = canonicalFieldRetypeConvertPlanInput({ sheetId: 'sheet_1', fieldId: 'fld_1', sourceType: 'string', sourceProperty: base.sourceProperty, plan: p })
    const keyed = hashFieldRetypeConvertPlan(canonical)
    expect(keyed).not.toBe(createHash('sha256').update(canonical).digest('hex'))
    expect(keyed).toBe(createHmac('sha256', 'secret-alpha-0123456789abcdef').update(canonical).digest('hex'))
    process.env[SECRET_ENV] = 'secret-bravo-0123456789abcdef'
    expect(hashFieldRetypeConvertPlan(canonical)).not.toBe(keyed)
  })

  test('the canonical input binds options, versions, the trash set, the target and the field (every axis moves the hash)', () => {
    const a = hashOf()
    expect(hashOf({ live: [live('r1', 'A2', { version: 3 }), base.live[1]!, base.live[2]!] })).not.toBe(a) // a cell / an option
    expect(hashOf({ live: [live('r1', 'A', { version: 4 }), base.live[1]!, base.live[2]!] })).not.toBe(a) // a version
    expect(hashOf({ live: [base.live[0]!, base.live[1]!, live('r3', null)] })).not.toBe(a) // missing key → JSON null
    expect(hashOf({ live: [base.live[0]!, base.live[1]!, live('r3', '')] })).not.toBe(a) // missing key → ''
    expect(hashOf({ trash: [] })).not.toBe(a) // a trash row removed
    expect(hashOf({ trash: [trash('t1', ''), trash('t2', null)] })).not.toBe(a) // a trash row added
    expect(hashOf({ targetType: 'multiSelect' })).not.toBe(a)
    expect(hashOf({ fieldId: 'fld_2' })).not.toBe(a)
    expect(hashOf({ sourceProperty: { description: 'y' } })).not.toBe(a)
    // "same counts, swapped set": the same two values on swapped records reorders the options → different hash
    expect(hashOf({ live: [live('r1', 'B', { version: 3 }), live('r2', 'A', { version: 1 }), base.live[2]!] })).not.toBe(a)
  })

  test('the source-property axis binds on its own: editing a rule that is dropped anyway (target unchanged) moves the hash', () => {
    const withMinLength = (n: number) => ({ description: 'x', validation: [{ type: 'required' }, { type: 'minLength', params: { value: n } }] })
    const pa = planFieldRetypeConvert({ sourceProperty: withMinLength(2), targetType: 'select', live: base.live, trash: base.trash })
    const pb = planFieldRetypeConvert({ sourceProperty: withMinLength(3), targetType: 'select', live: base.live, trash: base.trash })
    // the discriminator is real: target property, options and dropped count are identical for both plans ...
    expect(pb.targetProperty).toEqual(pa.targetProperty)
    expect(pb.optionValues).toEqual(pa.optionValues)
    expect(pb.droppedValidationRuleCount).toBe(1)
    expect(pa.droppedValidationRuleCount).toBe(1)
    // ... so only the source axis can tell a stale preview from the current field
    expect(hashOf({ sourceProperty: withMinLength(3) })).not.toBe(hashOf({ sourceProperty: withMinLength(2) }))
  })

  test('recycle-bin rows sharing one record_id hash the same in either DB order (cellHash tie-break)', () => {
    // meta_records_trash has a surrogate PK: one record_id can hold several rows. Both twins here are non-blocking
    // (missing key / ""), so neither the verdict nor the rejections can pin their order -- only the hash can.
    const twins = [trash('t1', null, { missing: true }), trash('t1', '')]
    const a = hashOf({ trash: twins })
    expect(hashOf({ trash: [...twins].reverse() })).toBe(a)
    const p = planFieldRetypeConvert({ sourceProperty: {}, targetType: 'select', live: base.live, trash: twins })
    expect(p.verdict).toBe('ok')
    expect(p.trash).toEqual({ scanned: 2, blocking: 0 })
  })

  test('preview token: HS256, 10 minutes, exactly the locked claims', () => {
    const planHash = hashOf()
    const token = mintFieldRetypeConvertPreviewIdentity({ sheetId: 'sheet_1', fieldId: 'fld_1', actorId: 'user_1', sourceType: 'string', targetType: 'select', planHash })
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as { alg: string }
    expect(header.alg).toBe('HS256')
    const payload = jwt.verify(token, 'secret-alpha-0123456789abcdef') as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['actorId', 'exp', 'fieldId', 'iat', 'planHash', 'sheetId', 'sourceType', 'targetType', 'type'])
    expect(payload).toMatchObject({ type: 'field-retype-convert-preview', sheetId: 'sheet_1', fieldId: 'fld_1', actorId: 'user_1', sourceType: 'string', targetType: 'select', planHash })
    expect(Number(payload.exp) - Number(payload.iat)).toBe(600)
  })

  test('verify: every claim is checked, and the type discriminator keeps it disjoint', () => {
    const planHash = hashOf()
    const claims = { sheetId: 'sheet_1', fieldId: 'fld_1', actorId: 'user_1', sourceType: 'string' as const, targetType: 'select' as const, planHash }
    const token = mintFieldRetypeConvertPreviewIdentity(claims)
    expect(verifyFieldRetypeConvertPreviewIdentity(token, claims)).toEqual({ valid: true })
    expect(verifyFieldRetypeConvertPreviewIdentity(token, { ...claims, sheetId: 'sheet_2' }).reason).toBe('mismatch_sheetId')
    expect(verifyFieldRetypeConvertPreviewIdentity(token, { ...claims, fieldId: 'fld_2' }).reason).toBe('mismatch_fieldId')
    expect(verifyFieldRetypeConvertPreviewIdentity(token, { ...claims, actorId: 'user_2' }).reason).toBe('mismatch_actorId')
    expect(verifyFieldRetypeConvertPreviewIdentity(token, { ...claims, targetType: 'multiSelect' }).reason).toBe('mismatch_targetType')
    expect(verifyFieldRetypeConvertPreviewIdentity(token, { ...claims, planHash: 'f'.repeat(64) }).reason).toBe('plan_drift')
    const foreign = jwt.sign({ type: 'config-restore-preview', ...claims }, 'secret-alpha-0123456789abcdef', { algorithm: 'HS256', expiresIn: '10m' })
    expect(verifyFieldRetypeConvertPreviewIdentity(foreign, claims).reason).toBe('wrong_type')
    const forged = jwt.sign({ type: 'field-retype-convert-preview', ...claims }, 'some-other-secret-0123456789', { algorithm: 'HS256' })
    expect(verifyFieldRetypeConvertPreviewIdentity(forged, claims).reason).toBe('invalid')
  })

  test('verify: the expired branch and the source-type branch each answer their own reason', () => {
    const planHash = hashOf()
    const claims = { sheetId: 'sheet_1', fieldId: 'fld_1', actorId: 'user_1', sourceType: 'string' as const, targetType: 'select' as const, planHash }
    // expired: validly signed, every claim right, past its window
    const expired = jwt.sign({ type: 'field-retype-convert-preview', ...claims, exp: Math.floor(Date.now() / 1000) - 5 }, 'secret-alpha-0123456789abcdef', { algorithm: 'HS256' })
    expect(verifyFieldRetypeConvertPreviewIdentity(expired, claims)).toEqual({ valid: false, reason: 'expired' })
    // expiry is judged before any claim: an expired token with a wrong claim is still "expired"
    expect(verifyFieldRetypeConvertPreviewIdentity(expired, { ...claims, fieldId: 'fld_2' }).reason).toBe('expired')
    // source type: a token signed for another source type is refused on that claim alone
    const otherSource = jwt.sign({ type: 'field-retype-convert-preview', ...claims, sourceType: 'longText' }, 'secret-alpha-0123456789abcdef', { algorithm: 'HS256', expiresIn: '10m' })
    expect(verifyFieldRetypeConvertPreviewIdentity(otherSource, claims)).toEqual({ valid: false, reason: 'mismatch_sourceType' })
    // and it is checked before the target type and the plan hash
    expect(verifyFieldRetypeConvertPreviewIdentity(otherSource, { ...claims, targetType: 'multiSelect', planHash: 'f'.repeat(64) }).reason).toBe('mismatch_sourceType')
    // a token with NO sourceType claim is refused too
    const { sourceType: _dropped, ...withoutSource } = claims
    const missing = jwt.sign({ type: 'field-retype-convert-preview', ...withoutSource }, 'secret-alpha-0123456789abcdef', { algorithm: 'HS256', expiresIn: '10m' })
    expect(verifyFieldRetypeConvertPreviewIdentity(missing, claims).reason).toBe('mismatch_sourceType')
  })
})
