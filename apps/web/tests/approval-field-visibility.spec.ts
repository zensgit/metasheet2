import { describe, expect, it } from 'vitest'

import {
  describeFieldVisibilityRule,
  getVisibleFormFields,
  pruneHiddenFormData,
} from '../src/approvals/fieldVisibility'
import type { FormSchema } from '../src/types/approval'

const formSchema: FormSchema = {
  fields: [
    {
      id: 'showDetails',
      type: 'select',
      label: '是否补充说明',
      required: true,
      options: [
        { label: '是', value: 'yes' },
        { label: '否', value: 'no' },
      ],
    },
    {
      id: 'details',
      type: 'textarea',
      label: '补充说明',
      required: true,
      visibilityRule: {
        fieldId: 'showDetails',
        operator: 'eq',
        value: 'yes',
      },
    },
  ],
}

describe('approval field visibility helper', () => {
  it('hides dependent fields until the rule is satisfied', () => {
    expect(getVisibleFormFields(formSchema, { showDetails: 'no' }).map((field) => field.id)).toEqual(['showDetails'])
    expect(getVisibleFormFields(formSchema, { showDetails: 'yes' }).map((field) => field.id)).toEqual(['showDetails', 'details'])
  })

  it('prunes hidden values before submission', () => {
    expect(pruneHiddenFormData(formSchema, {
      showDetails: 'no',
      details: 'stale hidden text',
    })).toEqual({
      showDetails: 'no',
    })
  })

  it('renders a readable rule summary', () => {
    expect(describeFieldVisibilityRule(formSchema.fields[1], formSchema)).toBe(
      '当 是否补充说明 等于 yes 时显示',
    )
  })
})
