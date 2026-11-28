import { describe, expect, it } from 'vitest'
import { attachmentLimitError, validateAttachmentSelection } from '../src/multitable/utils/field-config'
import type { MetaField } from '../src/multitable/types'

function file(name: string, type: string): File {
  return new File(['x'], name, { type })
}

describe('validateAttachmentSelection i18n fallbacks', () => {
  it('keeps attachment validation fallbacks in English by default', () => {
    const field: MetaField = {
      id: 'avatar',
      name: 'Avatar',
      type: 'attachment',
      property: { maxFiles: 1 } as unknown as MetaField['property'],
    }

    expect(validateAttachmentSelection(field, [file('b.png', 'image/png'), file('c.png', 'image/png')], 1)).toBe(
      'This field only allows one attachment. Clear the current file before adding another.',
    )
  })

  it('localizes attachment max-file validation fallbacks when requested', () => {
    const field: MetaField = {
      id: 'files',
      name: 'Files',
      type: 'attachment',
      property: { maxFiles: 2 } as unknown as MetaField['property'],
    }

    expect(validateAttachmentSelection(field, [file('a.png', 'image/png'), file('b.png', 'image/png')], 1, true)).toBe(
      '该字段最多允许 2 个附件。',
    )
  })

  it('localizes rejected MIME fallbacks while preserving MIME values raw', () => {
    const field: MetaField = {
      id: 'files',
      name: 'Files',
      type: 'attachment',
      property: { acceptedMimeTypes: ['image/png'] } as unknown as MetaField['property'],
    }

    expect(validateAttachmentSelection(field, [file('brief.pdf', 'application/pdf')], 0, true)).toBe(
      '不允许的文件类型：application/pdf',
    )
  })
})

describe('attachmentLimitError: a list of attachment ids counted against the field\'s file limit', () => {
  function filesField(property: Record<string, unknown>, type: MetaField['type'] = 'attachment'): MetaField {
    return { id: 'files', name: 'Files', type, property: property as unknown as MetaField['property'] }
  }

  it('gives the one-file text, in English by default and in Chinese when asked', () => {
    expect(attachmentLimitError(filesField({ maxFiles: 1 }), 2)).toBe(
      'This field only allows one attachment. Clear the current file before adding another.',
    )
    expect(attachmentLimitError(filesField({ maxFiles: 1 }), 2, true)).toBe(
      '该字段只允许一个附件。添加新文件前请先清除当前文件。',
    )
  })

  it('gives the up-to text for a larger limit', () => {
    expect(attachmentLimitError(filesField({ maxFiles: 2 }), 3)).toBe('This field allows up to 2 attachments.')
    expect(attachmentLimitError(filesField({ maxFiles: 2 }), 3, true)).toBe('该字段最多允许 2 个附件。')
  })

  it('is null at the limit, with no limit set, and for a field that is not an attachment field', () => {
    expect(attachmentLimitError(filesField({ maxFiles: 2 }), 2)).toBeNull()
    expect(attachmentLimitError(filesField({}), 5)).toBeNull()
    expect(attachmentLimitError(filesField({ maxFiles: 1 }, 'string'), 2)).toBeNull()
  })
})
