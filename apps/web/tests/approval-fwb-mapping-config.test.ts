/** FWB-1 config model — fail-closed draft validation goldens (web guard lane). */
import { describe, expect, test } from 'vitest'

import { toExecutorMappings, validateFwbMappingConfig } from '../src/approvals/fwbMappingConfig'

const TPL = [{ id: 'f1', label: '金额' }, { id: 'f2', label: '等级' }]
const TGT = [
  { id: 't_text', label: 'T', type: 'string' },
  { id: 't_num', label: 'N', type: 'number' },
  { id: 't_sel', label: 'S', type: 'select', selectOptions: ['低', '高'] },
  { id: 't_sel_empty', label: 'SE', type: 'select', selectOptions: [] },
  { id: 't_formula', label: 'F', type: 'formula' },
]

describe('FWB mapping config model', () => {
  test('valid draft → no issues; executor mappings carry types + select options', () => {
    const draft = [
      { formFieldId: 'f1', targetFieldId: 't_text' },
      { formFieldId: 'f1', targetFieldId: 't_num' },
      { formFieldId: 'f2', targetFieldId: 't_sel' },
    ]
    expect(validateFwbMappingConfig(draft, TPL, TGT)).toEqual([])
    expect(toExecutorMappings(draft, TGT)).toEqual([
      { formFieldId: 'f1', targetFieldId: 't_text', targetType: 'text' },
      { formFieldId: 'f1', targetFieldId: 't_num', targetType: 'number' },
      { formFieldId: 'f2', targetFieldId: 't_sel', targetType: 'select', selectOptions: ['低', '高'] },
    ])
  })

  test('fail-closed legs: empty config / unknown fields / unsupported type / empty select options / duplicate target', () => {
    expect(validateFwbMappingConfig([], TPL, TGT)).toEqual([{ code: 'empty_config' }])
    expect(validateFwbMappingConfig([{ formFieldId: 'ghost', targetFieldId: 't_text' }], TPL, TGT)).toEqual([{ code: 'unknown_form_field', index: 0 }])
    expect(validateFwbMappingConfig([{ formFieldId: 'f1', targetFieldId: 'ghost' }], TPL, TGT)).toEqual([{ code: 'unknown_target_field', index: 0 }])
    expect(validateFwbMappingConfig([{ formFieldId: 'f1', targetFieldId: 't_formula' }], TPL, TGT)).toEqual([{ code: 'unsupported_target_type', index: 0 }])
    expect(validateFwbMappingConfig([{ formFieldId: 'f1', targetFieldId: 't_sel_empty' }], TPL, TGT)).toEqual([{ code: 'select_options_missing', index: 0 }])
    expect(
      validateFwbMappingConfig(
        [
          { formFieldId: 'f1', targetFieldId: 't_text' },
          { formFieldId: 'f2', targetFieldId: 't_text' },
        ],
        TPL,
        TGT,
      ),
    ).toEqual([{ code: 'duplicate_target', index: 1 }])
  })

  test('toExecutorMappings refuses an unvalidated draft (programmer-error guard)', () => {
    expect(() => toExecutorMappings([{ formFieldId: 'f1', targetFieldId: 'ghost' }], TGT)).toThrow(/unvalidated/)
    expect(() => toExecutorMappings([{ formFieldId: 'f1', targetFieldId: 't_formula' }], TGT)).toThrow(/unvalidated/)
  })
})
