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
