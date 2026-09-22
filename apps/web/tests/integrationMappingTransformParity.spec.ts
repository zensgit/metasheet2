import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// G27 — cleaning-rules UI ⇄ engine parity.
//
// The data-factory workbench used to expose HALF of the transform engine and HALF of the
// validator: the select offered trim/upper/lower/toNumber/dictMap while the engine had also
// supported toDate, defaultValue, concat and multi-step chains since day one, and the rule inputs
// offered required/min/max while the validator had also supported pattern and enum. Everything a
// pipeline could legally do but the UI could not author was, in practice, unreachable.
//
// This file is the tripwire that keeps the two halves equal. Same discipline as
// k3-endpoint-vocab-mirror.spec.ts: `require()` the server module and compare against the client
// constant — never re-declare the server's list here, never text-parse it. Adding a transform to
// the engine (or removing one from the UI) is a RED, not a silent half-exposed engine.
//
// It also runs the ENGINE over the payloads this UI builds. A shape assertion alone would only
// prove "the UI is self-consistent"; feeding transformRecord()/validateRecord() proves the bytes
// we send are the bytes the engine reads.
import {
  UI_TRANSFORM_FNS,
  UI_VALIDATION_RULES,
  buildFieldMappingPayload,
  buildTransformPayload,
  buildTransformStepPayload,
  buildValidationPayload,
  createEditableMapping,
  createTransformArgs,
  createTransformStep,
  editableMappingFromPayload,
  mappingTransformSteps,
} from '../src/components/integration/integrationMappingTransform'
import type { EditableMapping } from '../src/components/integration/integrationWorkbenchSectionTypes'

const require = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../plugins/plugin-integration-core/lib')
const { SUPPORTED_TRANSFORMS, transformRecord } = require(path.join(pluginLib, 'transform-engine.cjs'))
const { SUPPORTED_RULES, validateRecord } = require(path.join(pluginLib, 'validator.cjs'))
// The API-layer normalizer the save route runs before anything reaches storage. Required (not
// re-implemented) so the "store -> read back -> engine" leg is the real one.
const { __internals: { normalizeFieldMappings } } = require(path.join(pluginLib, 'pipelines.cjs'))

const sorted = (values: Iterable<string>): string[] => Array.from(values).sort()

function mapping(overrides: Partial<EditableMapping>): EditableMapping {
  return createEditableMapping({ id: 'm1', sourceField: 'code', targetField: 'FNumber', ...overrides })
}

describe('G27 cleaning-rules parity: UI list vs engine whitelist', () => {
  it('offers exactly the engine SUPPORTED_TRANSFORMS set', () => {
    expect(sorted(UI_TRANSFORM_FNS)).toEqual(sorted(SUPPORTED_TRANSFORMS as Set<string>))
  })

  it('mutation probe: dropping one transform from the UI list turns that assertion red', () => {
    const mutant = UI_TRANSFORM_FNS.filter((fn) => fn !== 'concat')
    expect(() => expect(sorted(mutant)).toEqual(sorted(SUPPORTED_TRANSFORMS as Set<string>))).toThrow()
    // ...and an extra UI-only transform is just as red (the assertion is two-sided).
    expect(() => expect(sorted([...UI_TRANSFORM_FNS, 'evalScript']))
      .toEqual(sorted(SUPPORTED_TRANSFORMS as Set<string>))).toThrow()
  })

  it('offers exactly the validator SUPPORTED_RULES set', () => {
    expect(sorted(UI_VALIDATION_RULES)).toEqual(sorted(SUPPORTED_RULES as Set<string>))
  })

  it('mutation probe: dropping enum from the UI rule list turns that assertion red', () => {
    const mutant = UI_VALIDATION_RULES.filter((rule) => rule !== 'enum')
    expect(() => expect(sorted(mutant)).toEqual(sorted(SUPPORTED_RULES as Set<string>))).toThrow()
  })
})

describe('G27 cleaning-rules parity: transform payload shapes', () => {
  it('keeps the pre-G27 single-step payloads byte-for-byte', () => {
    for (const fn of ['trim', 'upper', 'lower', 'toNumber'] as const) {
      expect(buildTransformPayload(mapping({ transformFn: fn }))).toEqual({ fn })
      expect(JSON.stringify(buildTransformPayload(mapping({ transformFn: fn })))).toBe(`{"fn":"${fn}"}`)
    }
    const dict = mapping({ transformFn: 'dictMap', dictMapText: 'EA=Pcs\nKG=Kg' })
    expect(JSON.stringify(buildTransformPayload(dict))).toBe('{"fn":"dictMap","map":{"EA":"Pcs","KG":"Kg"}}')
    expect(buildTransformPayload(mapping({ transformFn: '' }))).toBeUndefined()
  })

  it('builds toDate / defaultValue / concat in the shapes the engine reads', () => {
    expect(buildTransformPayload(mapping({
      transformFn: 'toDate',
      transformArgs: createTransformArgs({ dateFormat: 'date' }),
    }))).toEqual({ fn: 'toDate', format: 'date' })

    expect(buildTransformPayload(mapping({ transformFn: 'toDate' })))
      .toEqual({ fn: 'toDate', format: 'iso' })

    expect(buildTransformPayload(mapping({
      transformFn: 'defaultValue',
      transformArgs: createTransformArgs({ defaultValueText: 'UNKNOWN' }),
    }))).toEqual({ fn: 'defaultValue', value: 'UNKNOWN' })

    expect(buildTransformPayload(mapping({
      transformFn: 'concat',
      transformArgs: createTransformArgs({ concatFields: ['spec', 'color'], concatSeparator: '-' }),
    }))).toEqual({ fn: 'concat', fields: ['spec', 'color'], separator: '-' })
  })

  it('builds a multi-step chain as the array normalizeTransformList reduces', () => {
    const chained = mapping({
      transformFn: 'trim',
      extraSteps: [
        createTransformStep('m1:step_1', { fn: 'upper' }),
        createTransformStep('m1:step_2', {
          fn: 'concat',
          args: createTransformArgs({ concatFields: ['spec'], concatSeparator: '-' }),
        }),
      ],
    })
    expect(buildTransformPayload(chained)).toEqual([
      { fn: 'trim' },
      { fn: 'upper' },
      { fn: 'concat', fields: ['spec'], separator: '-' },
    ])
  })

  it('mutation probe: a builder that keeps only the first step fails the chain expectation', () => {
    const chained = mapping({
      transformFn: 'trim',
      extraSteps: [createTransformStep('m1:step_1', { fn: 'upper' })],
    })
    const firstStepOnly = (editable: EditableMapping): unknown =>
      buildTransformStepPayload(mappingTransformSteps(editable)[0])
    expect(() => expect(firstStepOnly(chained)).toEqual([{ fn: 'trim' }, { fn: 'upper' }])).toThrow()
    // The real builder passes the very same expectation — so the probe isolates the mutation.
    expect(buildTransformPayload(chained)).toEqual([{ fn: 'trim' }, { fn: 'upper' }])
  })

  it('ignores steps whose transform is still empty', () => {
    const withEmptyStep = mapping({
      transformFn: 'trim',
      extraSteps: [createTransformStep('m1:step_1'), createTransformStep('m1:step_2', { fn: 'upper' })],
    })
    expect(buildTransformPayload(withEmptyStep)).toEqual([{ fn: 'trim' }, { fn: 'upper' }])
    const onlyChainStep = mapping({ transformFn: '', extraSteps: [createTransformStep('m1:s', { fn: 'upper' })] })
    // A single effective step collapses back to the legacy single-object shape.
    expect(buildTransformPayload(onlyChainStep)).toEqual({ fn: 'upper' })
  })

  it('refuses the argument shapes the engine would silently no-op or reject', () => {
    expect(() => buildTransformPayload(mapping({ transformFn: 'defaultValue' })))
      .toThrow('defaultValue 兜底值不能为空')
    expect(() => buildTransformPayload(mapping({ transformFn: 'concat' })))
      .toThrow('concat 至少需要选择一个拼接字段')
    expect(() => buildTransformPayload(mapping({ transformFn: 'dictMap', dictMapText: '' })))
      .toThrow('dictMap 字典映射不能为空')
  })
})

describe('G27 cleaning-rules parity: validation payload shapes', () => {
  it('keeps required/min/max in their pre-G27 order and shape', () => {
    expect(buildValidationPayload(mapping({ required: true, minValueText: '0.000001', maxValueText: '99' })))
      .toEqual([{ type: 'required' }, { type: 'min', value: 0.000001 }, { type: 'max', value: 99 }])
    expect(buildValidationPayload(mapping({}))).toBeUndefined()
  })

  it('emits pattern and enum only when authored', () => {
    expect(buildValidationPayload(mapping({ patternText: '^MAT-\\d+$' })))
      .toEqual([{ type: 'pattern', params: { regex: '^MAT-\\d+$' } }])
    expect(buildValidationPayload(mapping({ enumText: 'active, inactive ,active' })))
      .toEqual([{ type: 'enum', params: { values: ['active', 'inactive'] } }])
    expect(buildValidationPayload(mapping({ patternText: '   ', enumText: ' , ' }))).toBeUndefined()
  })

  it('rejects an invalid regex at build time instead of one INVALID_RULE per row', () => {
    expect(() => buildValidationPayload(mapping({ patternText: '[' }))).toThrow('pattern 正则无效')
  })
})

describe('G27 cleaning-rules parity: field-mapping payload', () => {
  it('is byte-identical to the pre-G27 payload for an untouched row', () => {
    const payload = buildFieldMappingPayload(mapping({ transformFn: 'upper', required: true }), 3)
    expect(Object.keys(payload)).toEqual(['sourceField', 'targetField', 'transform', 'validation', 'sortOrder'])
    expect(JSON.stringify(payload)).toBe(
      '{"sourceField":"code","targetField":"FNumber","transform":{"fn":"upper"},'
      + '"validation":[{"type":"required"}],"sortOrder":3}',
    )
  })

  it('adds the mapping-level defaultValue only when authored', () => {
    expect(buildFieldMappingPayload(mapping({ defaultValueText: '  ' }), 0)).not.toHaveProperty('defaultValue')
    const withDefault = buildFieldMappingPayload(mapping({ transformFn: 'upper', defaultValueText: 'N/A' }), 0)
    expect(withDefault.defaultValue).toBe('N/A')
    expect(Object.keys(withDefault)).toEqual(
      ['sourceField', 'targetField', 'transform', 'validation', 'sortOrder', 'defaultValue'],
    )
  })
})

describe('G27 cleaning-rules parity: the engine accepts what the UI builds', () => {
  const sourceRecord = {
    code: '  mat-001  ',
    quantity: '1,234',
    effectiveDate: '2024-01-31',
    blankName: '   ',
    unit: 'EA',
    spec: 'M8',
    color: 'red',
  }

  it('transforms every UI-authored shape, including the chain and the mapping-level default', () => {
    const fieldMappings = [
      buildFieldMappingPayload(mapping({ id: 'a', sourceField: 'code', targetField: 'FNumber', transformFn: 'trim' }), 0),
      buildFieldMappingPayload(mapping({
        id: 'b',
        sourceField: 'code',
        targetField: 'FUpper',
        transformFn: 'trim',
        extraSteps: [createTransformStep('b:1', { fn: 'upper' })],
      }), 1),
      buildFieldMappingPayload(mapping({ id: 'c', sourceField: 'quantity', targetField: 'FQty', transformFn: 'toNumber' }), 2),
      buildFieldMappingPayload(mapping({
        id: 'd',
        sourceField: 'effectiveDate',
        targetField: 'FDateOnly',
        transformFn: 'toDate',
        transformArgs: createTransformArgs({ dateFormat: 'date' }),
      }), 3),
      buildFieldMappingPayload(mapping({
        id: 'e',
        sourceField: 'effectiveDate',
        targetField: 'FDateTime',
        transformFn: 'toDate',
      }), 4),
      buildFieldMappingPayload(mapping({
        id: 'f',
        sourceField: 'blankName',
        targetField: 'FName',
        transformFn: 'defaultValue',
        transformArgs: createTransformArgs({ defaultValueText: 'UNKNOWN' }),
      }), 5),
      buildFieldMappingPayload(mapping({
        id: 'g',
        sourceField: 'code',
        targetField: 'FSyncKey',
        transformFn: 'trim',
        extraSteps: [createTransformStep('g:1', {
          fn: 'concat',
          args: createTransformArgs({ concatFields: ['spec', 'color'], concatSeparator: '-' }),
        })],
      }), 6),
      buildFieldMappingPayload(mapping({
        id: 'h',
        sourceField: 'unit',
        targetField: 'FBaseUnitID',
        transformFn: 'dictMap',
        dictMapText: 'EA=Pcs\nKG=Kg',
      }), 7),
      buildFieldMappingPayload(mapping({
        id: 'i',
        sourceField: 'missingSpec',
        targetField: 'FModel',
        transformFn: 'upper',
        defaultValueText: 'n/a',
      }), 8),
    ]

    const result = transformRecord(sourceRecord, fieldMappings)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      FNumber: 'mat-001',
      FUpper: 'MAT-001',
      FQty: 1234,
      FDateOnly: '2024-01-31',
      FDateTime: '2024-01-31T00:00:00.000Z',
      FName: 'UNKNOWN',
      FSyncKey: 'mat-001-M8-red',
      FBaseUnitID: 'Pcs',
      // mapping-level defaultValue lands BEFORE the chain, so `upper` still runs on it.
      FModel: 'N/A',
    })
  })

  it('validates with the pattern and enum rules the UI now authors', () => {
    const fieldMappings = [
      buildFieldMappingPayload(mapping({ sourceField: 'code', targetField: 'FNumber', patternText: '^MAT-\\d+$' }), 0),
      buildFieldMappingPayload(mapping({ sourceField: 'status', targetField: 'FStatus', enumText: 'active,inactive' }), 1),
      buildFieldMappingPayload(mapping({ sourceField: 'qty', targetField: 'FQty', required: true, minValueText: '1' }), 2),
    ]

    const good = validateRecord({ FNumber: 'MAT-001', FStatus: 'active', FQty: 5 }, fieldMappings)
    expect(good.errors).toEqual([])
    expect(good.ok).toBe(true)

    const bad = validateRecord({ FNumber: 'X-1', FStatus: 'archived', FQty: 0 }, fieldMappings)
    expect(bad.ok).toBe(false)
    expect(bad.errors.map((error: { code: string }) => error.code)).toEqual(['PATTERN', 'ENUM', 'MIN'])
    // No rule of ours is ever reported as unknown by the validator.
    expect(bad.errors.some((error: { code: string }) => error.code === 'UNSUPPORTED_RULE')).toBe(false)
    expect(bad.errors.some((error: { code: string }) => error.code === 'INVALID_RULE')).toBe(false)
  })
})

describe('G27 cleaning-rules parity: editor round trip (G08 pre-work)', () => {
  const authored: EditableMapping[] = [
    mapping({ transformFn: 'trim', required: true }),
    mapping({ transformFn: 'dictMap', dictMapText: 'EA=Pcs\nKG=Kg' }),
    mapping({ transformFn: 'toDate', transformArgs: createTransformArgs({ dateFormat: 'date' }) }),
    mapping({ transformFn: 'defaultValue', transformArgs: createTransformArgs({ defaultValueText: 'UNKNOWN' }) }),
    mapping({
      transformFn: 'concat',
      transformArgs: createTransformArgs({ concatFields: ['spec', 'color'], concatSeparator: '-' }),
    }),
    mapping({
      transformFn: 'trim',
      extraSteps: [
        createTransformStep('m1:1', { fn: 'upper' }),
        createTransformStep('m1:2', { fn: 'dictMap', dictMapText: 'A=B' }),
      ],
    }),
    mapping({
      transformFn: 'upper',
      required: true,
      patternText: '^MAT-\\d+$',
      enumText: 'active, inactive',
      minValueText: '1',
      maxValueText: '9',
      defaultValueText: 'N/A',
    }),
  ]

  it('re-parses every payload it builds back into the same payload', () => {
    for (const editable of authored) {
      const payload = buildFieldMappingPayload(editable, 0)
      const reparsed = editableMappingFromPayload(payload, 'rt')
      expect(buildFieldMappingPayload(reparsed, 0)).toEqual(payload)
    }
  })

  it('re-parses into an editor state that renders the same controls', () => {
    const payload = buildFieldMappingPayload(authored[4], 0)
    const reparsed = editableMappingFromPayload(payload, 'rt')
    expect(reparsed.transformFn).toBe('concat')
    expect(reparsed.transformArgs).toEqual({
      dateFormat: 'iso',
      defaultValueText: '',
      concatFields: ['spec', 'color'],
      concatSeparator: '-',
    })

    const chainPayload = buildFieldMappingPayload(authored[5], 0)
    const chainReparsed = editableMappingFromPayload(chainPayload, 'rt')
    expect(chainReparsed.transformFn).toBe('trim')
    expect(chainReparsed.extraSteps.map((step) => step.fn)).toEqual(['upper', 'dictMap'])
    expect(chainReparsed.extraSteps[1].dictMapText).toBe('A=B')

    const rulesReparsed = editableMappingFromPayload(buildFieldMappingPayload(authored[6], 0), 'rt')
    expect(rulesReparsed.required).toBe(true)
    expect(rulesReparsed.patternText).toBe('^MAT-\\d+$')
    expect(rulesReparsed.enumText).toBe('active, inactive')
    expect(rulesReparsed.minValueText).toBe('1')
    expect(rulesReparsed.maxValueText).toBe('9')
    expect(rulesReparsed.defaultValueText).toBe('N/A')
  })

  it('also reads engine-legal shapes this UI never writes', () => {
    const fromSteps = editableMappingFromPayload({
      sourceField: 'code',
      targetField: 'FNumber',
      // normalizeTransformList also accepts { steps: [...] } and bare strings.
      transform: { steps: ['trim', { type: 'upper' }, { fn: 'toDate', args: { format: 'date' } }] },
      validation: [
        { type: 'pattern', regex: '^A$' },
        { type: 'enum', allowedValues: ['a', 'b'] },
        { type: 'min', min: 2 },
      ],
      defaultValue: 7,
    } as never, 'rt')

    expect(fromSteps.transformFn).toBe('trim')
    expect(fromSteps.extraSteps.map((step) => step.fn)).toEqual(['upper', 'toDate'])
    expect(fromSteps.extraSteps[1].args.dateFormat).toBe('date')
    expect(fromSteps.patternText).toBe('^A$')
    expect(fromSteps.enumText).toBe('a, b')
    expect(fromSteps.minValueText).toBe('2')
    expect(fromSteps.defaultValueText).toBe('7')
  })

  it('drops a transform the UI cannot author instead of pretending it round-tripped', () => {
    const parsed = editableMappingFromPayload({
      sourceField: 'code',
      targetField: 'FNumber',
      transform: [{ fn: 'evalScript', src: 'nope' }, { fn: 'trim' }],
    } as never, 'rt')
    expect(parsed.transformFn).toBe('trim')
    expect(parsed.extraSteps).toEqual([])
    expect(buildTransformPayload(parsed)).toEqual({ fn: 'trim' })
  })
})

// ---------------------------------------------------------------------------
// #5596 adversarial review follow-ups. Each test below pins a behavior the review found either
// UNSTATED (so a later reader could only guess) or MIRRORED-BY-EYE (so it could drift silently).
// Where the claim is "we behave like the engine", the ENGINE runs in the test — a hand-written
// expectation would only prove we still agree with our own reading of it.
// ---------------------------------------------------------------------------
describe('G27 cleaning-rules parity: #5596 final-review fixes', () => {
  it('F07: a build error names the row and keeps the original message verbatim', () => {
    const broken = mapping({ targetField: 'FQty', transformFn: 'concat' })
    expect(() => buildFieldMappingPayload(broken, 4)).toThrow('第 5 条清洗规则（FQty）：')
    expect(() => buildFieldMappingPayload(broken, 4)).toThrow('concat 至少需要选择一个拼接字段')
    // The regex message keeps its substring too (the §3 test matches on it).
    expect(() => buildFieldMappingPayload(mapping({ patternText: '[' }), 0)).toThrow('pattern 正则无效')
    // A row with neither target nor source still gets a usable label instead of "（）".
    expect(() => buildFieldMappingPayload(
      createEditableMapping({ id: 'x', transformFn: 'defaultValue' }),
      0,
    )).toThrow('第 1 条清洗规则（未命名字段）：')
  })

  it('F02: a step carrying BOTH args.* and top-level keys is read the way the engine reads it', () => {
    // normalizeTransformStep: `isPlainObject(step.args) ? { ...step.args } : { ...step }` — a
    // plain `args` object REPLACES the top level. The engine therefore uses format 'date' here.
    const step = { fn: 'toDate', args: { format: 'date' }, format: 'iso' }
    const engineResult = transformRecord({ d: '2024-01-31' }, [
      { sourceField: 'd', targetField: 'FDate', transform: step },
    ])
    expect(engineResult.value.FDate).toBe('2024-01-31')

    const parsed = editableMappingFromPayload(
      { sourceField: 'd', targetField: 'FDate', transform: step } as never,
      'rt',
    )
    expect(parsed.transformArgs.dateFormat).toBe('date')
    // ...and re-emitting it keeps the engine's answer identical.
    const rebuilt = transformRecord({ d: '2024-01-31' }, [buildFieldMappingPayload(parsed, 0)])
    expect(rebuilt.value.FDate).toBe(engineResult.value.FDate)

    // THE DISCRIMINATING CASE (a merge and a replace disagree only here): `args` exists but does
    // NOT carry `format`, while the top level does. The engine IGNORES the top-level one, so the
    // output is a full ISO timestamp — an editor that merged would have shown "仅日期" for a
    // pipeline that emits date-times.
    const shadowed = { fn: 'toDate', args: { unrelated: 1 }, format: 'date' }
    const shadowedEngine = transformRecord({ d: '2024-01-31' }, [
      { sourceField: 'd', targetField: 'FDate', transform: shadowed },
    ])
    expect(shadowedEngine.value.FDate).toBe('2024-01-31T00:00:00.000Z')
    const shadowedParsed = editableMappingFromPayload(
      { sourceField: 'd', targetField: 'FDate', transform: shadowed } as never,
      'rt',
    )
    expect(shadowedParsed.transformArgs.dateFormat).toBe('iso')
    expect(transformRecord({ d: '2024-01-31' }, [buildFieldMappingPayload(shadowedParsed, 0)]).value.FDate)
      .toBe(shadowedEngine.value.FDate)
  })

  it('F02: a rule carrying BOTH a top-level and a params value is read the way the validator reads it', () => {
    // normalizeRule copies rule.params first and THEN folds stray top-level keys in, so on a
    // collision the TOP LEVEL wins (validator.cjs:42-46).
    const rule = { type: 'pattern', regex: '^TOP$', params: { regex: '^NESTED$' } }
    const engineMappings = [{ targetField: 'FNumber', validation: [rule] }]
    expect(validateRecord({ FNumber: 'TOP' }, engineMappings).ok).toBe(true)
    expect(validateRecord({ FNumber: 'NESTED' }, engineMappings).ok).toBe(false)

    const parsed = editableMappingFromPayload(
      { sourceField: 'code', targetField: 'FNumber', validation: [rule] } as never,
      'rt',
    )
    expect(parsed.patternText).toBe('^TOP$')
    const rebuilt = [buildFieldMappingPayload(parsed, 0)]
    expect(validateRecord({ FNumber: 'TOP' }, rebuilt).ok).toBe(true)
    expect(validateRecord({ FNumber: 'NESTED' }, rebuilt).ok).toBe(false)
  })

  it('F01/F11: pattern flags and custom messages are DROPPED on read — the loss is asserted, not hidden', () => {
    const authored = {
      sourceField: 'code',
      targetField: 'FNumber',
      validation: [{ type: 'pattern', params: { regex: '^mat-\\d+$', flags: 'i' }, message: '编码不合规' }],
    }
    // As authored, the engine is case-INsensitive and uses the custom message.
    const asAuthored = validateRecord({ FNumber: 'MAT-1' }, [authored])
    expect(asAuthored.ok).toBe(true)
    expect(validateRecord({ FNumber: 'X' }, [authored]).errors[0].message).toBe('编码不合规')

    const reemitted = buildFieldMappingPayload(editableMappingFromPayload(authored as never, 'rt'), 0)
    expect(reemitted.validation).toEqual([{ type: 'pattern', params: { regex: '^mat-\\d+$' } }])
    // KNOWN LOSS, pinned: flags gone -> case-sensitive now; message gone -> engine default text.
    expect(validateRecord({ FNumber: 'MAT-1' }, [reemitted]).ok).toBe(false)
    expect(validateRecord({ FNumber: 'X' }, [reemitted]).errors[0].message).not.toBe('编码不合规')
  })

  it('F04/F08: the mapping-level default does NOT fire on a whitespace-only source value', () => {
    const record = { blank: '   ', empty: '' }
    const result = transformRecord(record, [
      // mapping-level default: isBlank() is undefined/null/'' ONLY.
      buildFieldMappingPayload(mapping({ sourceField: 'blank', targetField: 'FKeepsSpaces', defaultValueText: 'N/A' }), 0),
      buildFieldMappingPayload(mapping({ sourceField: 'empty', targetField: 'FFromEmpty', defaultValueText: 'N/A' }), 1),
      buildFieldMappingPayload(mapping({ sourceField: 'absent', targetField: 'FFromMissing', defaultValueText: 'N/A' }), 2),
      // the defaultValue STEP additionally treats a whitespace-only string as blank.
      buildFieldMappingPayload(mapping({
        sourceField: 'blank',
        targetField: 'FFromStep',
        transformFn: 'defaultValue',
        transformArgs: createTransformArgs({ defaultValueText: 'N/A' }),
      }), 3),
    ])
    expect(result.errors).toEqual([])
    expect(result.value.FKeepsSpaces).toBe('   ')
    expect(result.value.FFromEmpty).toBe('N/A')
    expect(result.value.FFromMissing).toBe('N/A')
    expect(result.value.FFromStep).toBe('N/A')
  })

  // dictMap serialize/parse convention (#5596 follow-up). ONE convention, obeyed by both halves:
  // split at the FIRST `=` (so a key may not contain one, a value may), one entry per line, both
  // sides trimmed, neither empty. Everything outside it is skipped WITH a warning instead of being
  // silently written back as a different dictionary.
  it('round-trips a dictMap VALUE containing "=" (only the first "=" splits)', () => {
    const payload = {
      sourceField: 'unit',
      targetField: 'FBaseUnitID',
      transform: { fn: 'dictMap', map: { EA: 'a=b', KG: 'Kg' } },
    }
    const parsed = editableMappingFromPayload(payload as never, 'rt')
    expect(parsed.dictMapText).toBe('EA=a=b\nKG=Kg')
    expect(parsed.loadWarnings).toBeUndefined()
    const rebuilt = buildFieldMappingPayload(parsed, 0)
    expect(rebuilt.transform).toEqual({ fn: 'dictMap', map: { EA: 'a=b', KG: 'Kg' } })
    // ...and the engine still maps EA to the full value, `=` and all.
    expect(transformRecord({ unit: 'EA' }, [rebuilt]).value.FBaseUnitID).toBe('a=b')
  })

  it('skips (and reports) a dictMap entry the textarea convention cannot express', () => {
    const payload = {
      sourceField: 'unit',
      targetField: 'FBaseUnitID',
      transform: {
        fn: 'dictMap',
        map: {
          'A=B': 'keyHasEquals',   // a key may not contain '=' — the parser would split it there
          multi: 'line1\nline2',   // a newline IS the record separator
          blank: '   ',            // trims to empty, which the parser rejects
          KG: 'Kg',                // the only representable entry
        },
      },
    }
    const parsed = editableMappingFromPayload(payload as never, 'rt')
    expect(parsed.dictMapText).toBe('KG=Kg')
    expect(parsed.loadWarnings).toHaveLength(3)
    expect(parsed.loadWarnings?.join(' ')).toContain('A=B')
    expect(parsed.loadWarnings?.join(' ')).toContain('multi')
    expect(parsed.loadWarnings?.join(' ')).toContain('blank')
    // The re-emitted payload carries ONLY what the editor could show — never a corrupted entry
    // like { A: 'B=keyHasEquals' }, which is what the old serializer produced.
    expect(buildFieldMappingPayload(parsed, 0).transform).toEqual({ fn: 'dictMap', map: { KG: 'Kg' } })
  })

  it('pins the dictMap trim loss: parse(serialize(map)) equals the TRIMMED map, and says so', () => {
    const map = { ' EA ': ' Pcs ', KG: 'Kg' }
    const parsed = editableMappingFromPayload(
      { sourceField: 'unit', targetField: 'FBaseUnitID', transform: { fn: 'dictMap', map } } as never,
      'rt',
    )
    const rebuilt = buildFieldMappingPayload(parsed, 0)
    expect(rebuilt.transform).toEqual({ fn: 'dictMap', map: { EA: 'Pcs', KG: 'Kg' } })
    expect(parsed.loadWarnings).toHaveLength(1)
    expect(parsed.loadWarnings?.[0]).toContain('首尾空格')
    // Why it is a real loss and not cosmetics: the engine looks the key up by String(value), so
    // the padded key matched ' EA ' before and matches 'EA' after.
    const before = [{ sourceField: 'unit', targetField: 'FBaseUnitID', transform: { fn: 'dictMap', map } }]
    expect(transformRecord({ unit: ' EA ' }, before).value.FBaseUnitID).toBe(' Pcs ')
    expect(transformRecord({ unit: ' EA ' }, [rebuilt]).value.FBaseUnitID).toBe(' EA ')
    expect(transformRecord({ unit: 'EA' }, [rebuilt]).value.FBaseUnitID).toBe('Pcs')
    // Second pass is stable — the canonical form round-trips exactly.
    expect(buildFieldMappingPayload(editableMappingFromPayload(rebuilt, 'rt2'), 0).transform)
      .toEqual(rebuilt.transform)
  })

  it('survives the API layer: normalizeFieldMappings -> transformRecord keeps chains and pins null defaults', () => {
    const uiPayloads = [
      buildFieldMappingPayload(mapping({
        sourceField: 'code',
        targetField: 'FUpper',
        transformFn: 'trim',
        extraSteps: [createTransformStep('s1', { fn: 'upper' })],
      }), 0),
      buildFieldMappingPayload(mapping({ sourceField: 'missing', targetField: 'FPlain', transformFn: 'trim' }), 1),
      buildFieldMappingPayload(mapping({
        sourceField: 'missing',
        targetField: 'FDefaulted',
        transformFn: 'upper',
        defaultValueText: 'n/a',
      }), 2),
    ]

    const stored = normalizeFieldMappings(uiPayloads)

    // The array chain survives the registry's optionalJson() untouched...
    expect(stored[0].transform).toEqual([{ fn: 'trim' }, { fn: 'upper' }])
    // ...and an un-authored default becomes an OWN key holding null (pipelines.cjs:201), which is
    // NOT the same thing as the key being absent: transformRecord's hasOwnProperty check then
    // substitutes null for a missing source value.
    expect(Object.prototype.hasOwnProperty.call(uiPayloads[1], 'defaultValue')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(stored[1], 'defaultValue')).toBe(true)
    expect(stored[1].defaultValue).toBeNull()
    expect(stored[2].defaultValue).toBe('n/a')
    expect(stored[1].validation).toBeNull()

    const record = { code: '  mat-001  ' }
    const beforeStore = transformRecord(record, uiPayloads)
    const afterStore = transformRecord(record, stored)

    expect(afterStore.errors).toEqual([])
    expect(afterStore.value.FUpper).toBe('MAT-001')
    expect(afterStore.value.FDefaulted).toBe('N/A')
    // The one observable difference the round trip introduces, pinned rather than discovered in
    // production: undefined before the store, null after it.
    expect(beforeStore.value.FPlain).toBeUndefined()
    expect(afterStore.value.FPlain).toBeNull()
  })
})
