import { describe, expect, it } from 'vitest'

import {
  summarizeAutomationAction,
  type ActionSummarySnapshot,
} from '../src/multitable/automationActionSummary'

describe('automationActionSummary (G-B2-25)', () => {
  describe('update_record', () => {
    it('is honest about zero configured field updates', () => {
      const snapshot: ActionSummarySnapshot = { type: 'update_record', updateRecord: { fieldUpdates: [] } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Update record (not configured)')
      expect(summarizeAutomationAction(snapshot, true)).toBe('更新记录（未配置）')
    })

    it('renders a single fully-authored field update', () => {
      const snapshot: ActionSummarySnapshot = {
        type: 'update_record',
        updateRecord: { fieldUpdates: [{ fieldLabel: 'Status', value: 'Done' }] },
      }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Update record: Status ← Done')
      expect(summarizeAutomationAction(snapshot, true)).toBe('更新记录：Status ← Done')
    })

    it('placeholders a missing field and a missing value separately (never fabricates)', () => {
      const missingField: ActionSummarySnapshot = {
        type: 'update_record',
        updateRecord: { fieldUpdates: [{ fieldLabel: '', value: 'Done' }] },
      }
      expect(summarizeAutomationAction(missingField, false)).toBe('Update record: (no field selected) ← Done')

      const missingValue: ActionSummarySnapshot = {
        type: 'update_record',
        updateRecord: { fieldUpdates: [{ fieldLabel: 'Status', value: '' }] },
      }
      expect(summarizeAutomationAction(missingValue, false)).toBe('Update record: Status ← (empty value)')
    })

    it('counts additional pairs instead of listing them all (stays a one-liner)', () => {
      const snapshot: ActionSummarySnapshot = {
        type: 'update_record',
        updateRecord: {
          fieldUpdates: [
            { fieldLabel: 'Status', value: 'Done' },
            { fieldLabel: 'Owner', value: 'Alice' },
            { fieldLabel: 'Priority', value: 'High' },
          ],
        },
      }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Update record: Status ← Done and 2 more')
      expect(summarizeAutomationAction(snapshot, true)).toBe('更新记录：Status ← Done 等 3 项')
    })

    it('truncates an overlong authored value so the summary stays one line', () => {
      const snapshot: ActionSummarySnapshot = {
        type: 'update_record',
        updateRecord: { fieldUpdates: [{ fieldLabel: 'Notes', value: 'x'.repeat(80) }] },
      }
      const text = summarizeAutomationAction(snapshot, false)
      expect(text).toContain('…')
      expect(text.length).toBeLessThan(80)
    })
  })

  describe('create_record', () => {
    it('flags an unconfigured target sheet', () => {
      const snapshot: ActionSummarySnapshot = { type: 'create_record', createRecord: { targetSheetId: '', fieldValueCount: 3 } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Create record (not configured)')
    })

    it('reports the target sheet and field-value count', () => {
      const snapshot: ActionSummarySnapshot = { type: 'create_record', createRecord: { targetSheetId: 'sheet_2', fieldValueCount: 2 } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Create record: target sheet sheet_2, 2 field values')
      expect(summarizeAutomationAction(snapshot, true)).toBe('创建记录：目标数据表 sheet_2，2 个字段值')
    })

    it('is honest when the target sheet is set but no field values are authored', () => {
      const snapshot: ActionSummarySnapshot = { type: 'create_record', createRecord: { targetSheetId: 'sheet_2', fieldValueCount: 0 } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Create record: target sheet sheet_2 (no field values)')
    })
  })

  describe('send_webhook', () => {
    it('flags a missing URL', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_webhook', webhook: { url: '', method: 'POST' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send webhook (not configured)')
    })

    it('reports method + URL', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_webhook', webhook: { url: 'https://example.com/hook', method: 'PUT' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send webhook: PUT https://example.com/hook')
    })

    it('defaults the method label to POST when unset (matches the config default)', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_webhook', webhook: { url: 'https://example.com/hook', method: '' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send webhook: POST https://example.com/hook')
    })
  })

  describe('send_notification', () => {
    it('flags a missing recipient', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_notification', notification: { userId: '', message: 'hi' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send notification (not configured)')
    })

    it('reports recipient + message, placeholdering a blank message', () => {
      const withMessage: ActionSummarySnapshot = { type: 'send_notification', notification: { userId: 'user_1', message: 'Please review' } }
      expect(summarizeAutomationAction(withMessage, false)).toBe('Send notification to user_1: Please review')

      const noMessage: ActionSummarySnapshot = { type: 'send_notification', notification: { userId: 'user_1', message: '' } }
      expect(summarizeAutomationAction(noMessage, false)).toBe('Send notification to user_1: (no message)')
    })
  })

  describe('start_approval', () => {
    it('flags a missing template', () => {
      const snapshot: ActionSummarySnapshot = { type: 'start_approval', startApproval: { templateLabel: '', mappingCount: 0 } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Start approval (not configured)')
    })

    it('reports the resolved template name and mapping count', () => {
      const snapshot: ActionSummarySnapshot = { type: 'start_approval', startApproval: { templateLabel: 'Expense Approval', mappingCount: 2 } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Start approval: template Expense Approval, 2 field mappings')
      expect(summarizeAutomationAction(snapshot, true)).toBe('发起审批：模板 Expense Approval，2 项字段映射')
    })

    it('omits the mapping clause entirely when there are zero mappings', () => {
      const snapshot: ActionSummarySnapshot = { type: 'start_approval', startApproval: { templateLabel: 'tmpl_9', mappingCount: 0 } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Start approval: template tmpl_9')
    })
  })

  describe('write_approval_form_values', () => {
    it('distinguishes create and update mode in the collapsed summary', () => {
      const create: ActionSummarySnapshot = {
        type: 'write_approval_form_values',
        fwbWriteback: { mappingCount: 2, confirmed: true, mode: 'create' },
      }
      const update: ActionSummarySnapshot = {
        type: 'write_approval_form_values',
        fwbWriteback: { mappingCount: 1, confirmed: false, mode: 'update' },
      }
      expect(summarizeAutomationAction(create, true)).toBe('审批数据回写：新建记录 · 2 项映射（已确认）')
      expect(summarizeAutomationAction(update, false))
        .toBe('Write back approval data: update linked record · 1 field mapping（unconfirmed）')
    })
  })

  describe('send_email', () => {
    it('flags zero recipients', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_email', email: { recipientCount: 0, subjectTemplate: 'Hi' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send email (not configured)')
    })

    it('counts recipients and shows the subject, placeholdering a blank one', () => {
      const withSubject: ActionSummarySnapshot = { type: 'send_email', email: { recipientCount: 2, subjectTemplate: 'Weekly digest' } }
      expect(summarizeAutomationAction(withSubject, false)).toBe('Send email to 2 recipients: Weekly digest')

      const singular: ActionSummarySnapshot = { type: 'send_email', email: { recipientCount: 1, subjectTemplate: '' } }
      expect(summarizeAutomationAction(singular, false)).toBe('Send email to 1 recipient: (no subject)')
    })
  })

  describe('send_dingtalk_group_message', () => {
    it('flags zero destinations', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_dingtalk_group_message', dingTalkGroupMessage: { destinationCount: 0, titleTemplate: 'x' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send DingTalk group message (not configured)')
    })

    it('counts destinations (explicit groups + record-field paths) and shows the title', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_dingtalk_group_message', dingTalkGroupMessage: { destinationCount: 3, titleTemplate: 'Ticket {{recordId}}' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send group message to 3 groups: Ticket {{recordId}}')
      expect(summarizeAutomationAction(snapshot, true)).toBe('发送群消息给 3 个群：Ticket {{recordId}}')
    })

    it('placeholders a blank title', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_dingtalk_group_message', dingTalkGroupMessage: { destinationCount: 1, titleTemplate: '' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send group message to 1 group: (no title)')
    })
  })

  describe('send_dingtalk_person_message', () => {
    it('flags zero recipients', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_dingtalk_person_message', dingTalkPersonMessage: { recipientCount: 0, titleTemplate: 'x' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send DingTalk person message (not configured)')
    })

    it('sums users + member groups + field paths into one recipient count', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_dingtalk_person_message', dingTalkPersonMessage: { recipientCount: 5, titleTemplate: 'Reminder' } }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send person message to 5 recipients: Reminder')
    })
  })

  describe('send_dingtalk_approval_card', () => {
    it('always reports the same fixed-recipient sentence (zero config surface)', () => {
      const snapshot: ActionSummarySnapshot = { type: 'send_dingtalk_approval_card' }
      expect(summarizeAutomationAction(snapshot, false)).toBe('Send approval card (DingTalk): fixed recipient (from the pending-task event)')
      expect(summarizeAutomationAction(snapshot, true)).toBe('发送审批卡片（钉钉）：收件人固定（来自待办事件）')
    })
  })

  describe('lock_record / delete_record (boolean-config actions)', () => {
    it('reflects the locked flag both ways — false is a real state, not "unconfigured"', () => {
      expect(summarizeAutomationAction({ type: 'lock_record', lockRecord: { locked: true } }, false)).toBe('Lock record')
      expect(summarizeAutomationAction({ type: 'lock_record', lockRecord: { locked: false } }, false)).toBe('Unlock record')
      expect(summarizeAutomationAction({ type: 'lock_record' }, true)).toBe('解锁记录')
    })

    it('flags an unacknowledged delete (a real save-blocking condition) without hiding the action type', () => {
      expect(summarizeAutomationAction({ type: 'delete_record', deleteRecord: { acknowledged: true } }, false)).toBe('Delete record')
      expect(summarizeAutomationAction({ type: 'delete_record', deleteRecord: { acknowledged: false } }, false)).toBe('Delete record (not confirmed)')
      expect(summarizeAutomationAction({ type: 'delete_record' }, true)).toBe('删除记录（未确认）')
    })
  })

  describe('wait_for_callback (zero-param suspend point)', () => {
    it('is just the type label — there is nothing else authored to summarize', () => {
      expect(summarizeAutomationAction({ type: 'wait_for_callback' }, false)).toBe('Wait for callback (suspend)')
      expect(summarizeAutomationAction({ type: 'wait_for_callback' }, true)).toBe('等待回调（挂起）')
    })
  })

  describe('condition_branch / parallel_branch', () => {
    it('flags zero branches for condition_branch and counts branches + default', () => {
      expect(summarizeAutomationAction({ type: 'condition_branch', conditionBranch: { branchCount: 0, hasDefaultBranch: false } }, false))
        .toBe('Condition branch (not configured)')
      expect(summarizeAutomationAction({ type: 'condition_branch', conditionBranch: { branchCount: 2, hasDefaultBranch: false } }, false))
        .toBe('Condition branch: 2 branches')
      expect(summarizeAutomationAction({ type: 'condition_branch', conditionBranch: { branchCount: 1, hasDefaultBranch: true } }, false))
        .toBe('Condition branch: 1 branch + default branch')
      expect(summarizeAutomationAction({ type: 'condition_branch', conditionBranch: { branchCount: 2, hasDefaultBranch: true } }, true))
        .toBe('条件分支：2 个分支 + 默认分支')
    })

    it('flags zero branches for parallel_branch and counts branches', () => {
      expect(summarizeAutomationAction({ type: 'parallel_branch', parallelBranch: { branchCount: 0 } }, false))
        .toBe('Parallel branch (not configured)')
      expect(summarizeAutomationAction({ type: 'parallel_branch', parallelBranch: { branchCount: 3 } }, false))
        .toBe('Parallel branch: 3 parallel branches')
      expect(summarizeAutomationAction({ type: 'parallel_branch', parallelBranch: { branchCount: 3 } }, true))
        .toBe('并行分支：3 路并行')
    })
  })

  describe('legacy aliases and unknown types', () => {
    it('falls back to the plain type label for legacy action types (no dedicated snapshot shape)', () => {
      expect(summarizeAutomationAction({ type: 'notify' }, false)).toBe('Send notification')
      expect(summarizeAutomationAction({ type: 'update_field' }, true)).toBe('更新字段值')
    })
  })
})
