import { describe, expect, it } from 'vitest'
import { buildPlmDocumentDegradationMessage } from '../src/views/plm/plmDocumentDegradation'

describe('plmDocumentDegradation', () => {
  it('names the failed side explicitly when attachments are down', () => {
    expect(buildPlmDocumentDegradationMessage([
      { name: 'attachments', ok: false, count: 0, error: 'file endpoint down' },
      { name: 'related_documents', ok: true, count: 1 },
    ])).toEqual({
      warning: 'attachments（文件附件）（file endpoint down）不可用，当前显示可能不完整',
    })
  })

  it('names the failed side explicitly when AML related docs are down', () => {
    expect(buildPlmDocumentDegradationMessage([
      { name: 'attachments', ok: true, count: 1 },
      { name: 'related_documents', ok: false, count: 0, error: 'aml query down' },
    ])).toEqual({
      warning: 'AML related docs（关联文档）（aml query down）不可用，当前显示可能不完整',
    })
  })

  it('returns an error when both sides fail', () => {
    expect(buildPlmDocumentDegradationMessage([
      { name: 'attachments', ok: false, count: 0, error: 'file side down' },
      { name: 'related_documents', ok: false, count: 0, error: 'aml side down' },
    ])).toEqual({
      error: '文档数据源均不可用：attachments（文件附件）（file side down）、AML related docs（关联文档）（aml side down）',
    })
  })

  it('returns an empty message when both sides are healthy', () => {
    expect(buildPlmDocumentDegradationMessage([
      { name: 'attachments', ok: true, count: 1 },
      { name: 'related_documents', ok: true, count: 1 },
    ])).toEqual({})
  })
})
