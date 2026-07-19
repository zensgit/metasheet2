/** FWB-1 config model — fail-closed draft validation goldens (web guard lane). */
import { describe, expect, test } from 'vitest'

import {
  isFwbV1SourceFieldType,
  normalizeFwbTargetFieldType,
  validateFwbMappingConfig,
} from '../src/approvals/fwbMappingConfig'

const TPL = [
  { id: 'f1', label: '金额', type: 'number' },
  { id: 'f2', label: '等级', type: 'datetime' },
  { id: 'f_link', label: '链接', type: 'record-link' },
]
const TGT = [
  { id: 't_text', label: 'T', type: 'text' },
  { id: 't_num', label: 'N', type: 'number' },
  { id: 't_sel', label: 'S', type: 'select' },
  { id: 't_dt', label: 'DT', type: 'dateTime' },
  { id: 't_formula', label: 'F', type: 'formula' },
]

describe('FWB mapping config model', () => {
  test('valid draft → no issues, including a dateTime target', () => {
    const draft = [
      { formFieldId: 'f1', targetFieldId: 't_num' },
      { formFieldId: 'f2', targetFieldId: 't_dt' },
    ]
    expect(validateFwbMappingConfig(draft, TPL, TGT)).toEqual([])
    expect(normalizeFwbTargetFieldType('datetime')).toBe('dateTime')
  })

  test('fail-closed legs: empty config / unknown fields / unsupported type / empty select options / duplicate target', () => {
    expect(validateFwbMappingConfig([], TPL, TGT)).toEqual([{ code: 'empty_config' }])
    expect(validateFwbMappingConfig([{ formFieldId: 'ghost', targetFieldId: 't_text' }], TPL, TGT)).toEqual([{ code: 'unknown_form_field', index: 0 }])
    expect(validateFwbMappingConfig([{ formFieldId: 'f_link', targetFieldId: 't_text' }], TPL, TGT)).toEqual([{ code: 'unsupported_source_type', index: 0 }])
    expect(validateFwbMappingConfig([{ formFieldId: 'f1', targetFieldId: 'ghost' }], TPL, TGT)).toEqual([{ code: 'unknown_target_field', index: 0 }])
    expect(validateFwbMappingConfig([{ formFieldId: 'f1', targetFieldId: 't_formula' }], TPL, TGT)).toEqual([{ code: 'unsupported_target_type', index: 0 }])
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

  test('source type boundary excludes record-link and attachment values', () => {
    expect(isFwbV1SourceFieldType('datetime')).toBe(true)
    expect(isFwbV1SourceFieldType('record-link')).toBe(false)
    expect(isFwbV1SourceFieldType('attachment')).toBe(false)
  })
})
