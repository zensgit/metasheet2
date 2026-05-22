import { describe, expect, it } from 'vitest'
import { formatFieldDisplay } from '../src/multitable/utils/field-display'
import type { MetaField } from '../src/multitable/types'

describe('formatFieldDisplay i18n fallbacks', () => {
  it('keeps English boolean labels by default and localizes them when requested', () => {
    const field: MetaField = { id: 'done', name: 'Done', type: 'boolean' }

    expect(formatFieldDisplay({ field, value: true })).toBe('Yes')
    expect(formatFieldDisplay({ field, value: false })).toBe('No')
    expect(formatFieldDisplay({ field, value: true, isZh: true })).toBe('是')
    expect(formatFieldDisplay({ field, value: false, isZh: true })).toBe('否')
  })

  it('localizes link count summaries without translating linked record display names', () => {
    const personField: MetaField = {
      id: 'owner',
      name: 'Owner',
      type: 'link',
      property: { refKind: 'user' } as unknown as MetaField['property'],
    }
    const recordField: MetaField = { id: 'task', name: 'Task', type: 'link' }

    expect(formatFieldDisplay({ field: personField, value: ['u1', 'u2'], isZh: true })).toBe('2 个人员')
    expect(formatFieldDisplay({ field: recordField, value: ['r1'], isZh: true })).toBe('1 条关联记录')
    expect(formatFieldDisplay({
      field: personField,
      value: ['u1'],
      linkSummaries: [{ id: 'u1', display: 'Amy Wong' }],
      isZh: true,
    })).toBe('Amy Wong')
  })

  it('localizes attachment count summaries without translating file names', () => {
    const field: MetaField = { id: 'files', name: 'Files', type: 'attachment' }

    expect(formatFieldDisplay({ field, value: ['a1', 'a2'], isZh: true })).toBe('2 个附件')
    expect(formatFieldDisplay({
      field,
      value: ['a1'],
      attachmentSummaries: [{ id: 'a1', filename: 'Design Brief.pdf', mimeType: 'application/pdf', size: 1, url: '', thumbnailUrl: null, uploadedAt: '' }],
      isZh: true,
    })).toBe('Design Brief.pdf')
  })
})
