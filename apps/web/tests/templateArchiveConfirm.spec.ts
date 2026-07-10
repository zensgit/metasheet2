/**
 * B3-08 (模板治理 — 停用/启用确认文案) — pure-function unit tests. Mirrors
 * templateGalleryFilter.spec.ts's "test the pure function, don't mount the view" approach.
 */
import { describe, expect, it } from 'vitest'
import {
  templateArchiveConfirmMessage,
  templateUnarchiveConfirmMessage,
} from '../src/approvals/templateArchiveConfirm'
import type { ApprovalTemplateUsageDTO } from '../src/types/approval'

describe('approvals/templateArchiveConfirm', () => {
  it('names the template and states the blast radius when usage is known', () => {
    const usage: ApprovalTemplateUsageDTO = {
      templateId: 'tpl-1',
      instanceCount: 12,
      activeInstanceCount: 3,
    }
    const message = templateArchiveConfirmMessage('出差申请', usage)
    expect(message).toContain('出差申请')
    expect(message).toContain('3')
    expect(message).toContain('12')
    expect(message).toContain('不受影响')
  })

  it('omits the usage numbers (but still confirms) when usage is unavailable', () => {
    const message = templateArchiveConfirmMessage('出差申请', undefined)
    expect(message).toContain('出差申请')
    expect(message).toContain('不受影响')
    expect(message).not.toMatch(/\d个进行中/)
  })

  it('states zero in-flight instances plainly when the template has never been used', () => {
    const usage: ApprovalTemplateUsageDTO = {
      templateId: 'tpl-1',
      instanceCount: 0,
      activeInstanceCount: 0,
    }
    const message = templateArchiveConfirmMessage('新模板', usage)
    expect(message).toContain('0 个进行中的审批')
  })

  it('unarchive confirm names the template and describes the reversal', () => {
    const message = templateUnarchiveConfirmMessage('出差申请')
    expect(message).toContain('出差申请')
    expect(message).toContain('启用')
  })
})
