// G-B2-22 — rule-editor "why is Save disabled" list.
//
// MetaSheet principle: a disabled control must be able to say why. Folding many independent
// guard conditions into a single boolean (the historic `canSave`) is silent by construction —
// the author sees a greyed-out button and nothing else. This module is the single place that
// turns the editor's full set of save-blocking guards into a human-readable, anchorable list.
//
// It owns ONLY the aggregation: each guard's own decision logic (whether a trigger config, a
// condition-branch, or a parallel-branch is valid) is evaluated elsewhere (MetaAutomationRuleEditor.vue,
// which already has the field/view context those checks need) and handed in here pre-evaluated as
// plain data. Counts and raw strings — not pre-combined booleans — are passed through for the
// checks that combine more than one signal (a destination made of several optional sources, the
// "keep the stored webhook secret" rule), so this module performs the AND/OR/negation itself and a
// test can exercise that combination directly instead of trusting a hidden reduction upstream.
//
// `anchor` is a CSS selector (evaluated against the editor's own root, never the whole document)
// that locates the control the reason is about, for scroll-to-reason navigation. A reason is only
// given an anchor when a real, always-rendered element exists for it — no invented anchors.

import { automationActionTypeLabel } from './utils/meta-automation-labels'
import type { AutomationActionType } from './types'

export interface SaveBlockReason {
  key: string
  message: string
  anchor?: string
}

export interface SaveBlockGroupMessageSnapshot {
  destinationIdCount: number
  destinationFieldPathCount: number
  titleTemplate: string
  bodyTemplate: string
  publicFormBlockingErrorCount: number
  internalViewBlockingErrorCount: number
}

export interface SaveBlockPersonMessageSnapshot {
  userIdCount: number
  memberGroupIdCount: number
  recipientFieldPathCount: number
  memberGroupRecipientFieldPathCount: number
  titleTemplate: string
  bodyTemplate: string
  publicFormBlockingErrorCount: number
  internalViewBlockingErrorCount: number
}

export interface SaveBlockEmailSnapshot {
  recipientCount: number
  subjectTemplate: string
  bodyTemplate: string
}

export interface SaveBlockDeleteRecordSnapshot {
  acknowledged: boolean
}

export interface SaveBlockFwbWritebackSnapshot {
  mappingCount: number
  confirmed: boolean
  readOnly: boolean
}

export interface SaveBlockActionSnapshot {
  index: number
  type: AutomationActionType
  groupMessage?: SaveBlockGroupMessageSnapshot
  personMessage?: SaveBlockPersonMessageSnapshot
  email?: SaveBlockEmailSnapshot
  deleteRecord?: SaveBlockDeleteRecordSnapshot
  fwbWriteback?: SaveBlockFwbWritebackSnapshot
}

export interface SaveBlockReasonsInput {
  isZh: boolean
  name: string
  actionsCount: number
  triggerType: string
  /** '' when the current trigger isn't approval.completed, or that trigger has no block reason. */
  approvalCompletedBlockReason: string
  /** '' when the current trigger isn't approval.task_created, or that trigger has no block reason. */
  approvalTaskCreatedBlockReason: string
  /**
   * Non-empty when a write_approval_form_values action is present under a non-approval.completed
   * trigger (FWB0 D11 placement). Independent of triggerType so it still blocks save after a
   * mid-edit trigger change.
   */
  fwbWrongTriggerBlockReason?: string
  webhookSecretPresent: boolean
  ruleHasId: boolean
  savedWebhookSecretConfigured: boolean
  conditionBranchReadOnlyReason: string | null
  conditionBranchKeyError: string | null
  parallelBranchReadOnlyReason: string | null
  parallelBranchKeyError: string | null
  parallelBranchActionError: string | null
  conditionsComplete: boolean
  /** Selector for the first incomplete condition/group, when one can be identified. */
  firstIncompleteConditionAnchor?: string
  actions: SaveBlockActionSnapshot[]
}

export function computeSaveBlockReasons(input: SaveBlockReasonsInput): SaveBlockReason[] {
  const zh = input.isZh
  const reasons: SaveBlockReason[] = []

  if (!input.name.trim()) {
    reasons.push({ key: 'name', message: zh ? '请填写规则名称。' : 'Enter a rule name.', anchor: '[data-field="name"]' })
  }

  if (input.actionsCount < 1) {
    reasons.push({
      key: 'actionsEmpty',
      message: zh ? '请至少添加一个动作。' : 'Add at least one action.',
      anchor: '[data-action="add-action"]',
    })
  }

  if (input.triggerType === 'approval.completed' && input.approvalCompletedBlockReason) {
    reasons.push({
      key: 'approvalCompletedBlockReason',
      message: input.approvalCompletedBlockReason,
      anchor: '[data-field="approvalCompletedBlockReason"]',
    })
  }

  if (input.fwbWrongTriggerBlockReason) {
    reasons.push({
      key: 'fwbWrongTrigger',
      message: input.fwbWrongTriggerBlockReason,
      anchor: '[data-testid="fwb-readonly-status"]',
    })
  }

  if (input.triggerType === 'approval.task_created' && input.approvalTaskCreatedBlockReason) {
    reasons.push({
      key: 'approvalTaskCreatedBlockReason',
      message: input.approvalTaskCreatedBlockReason,
      anchor: '[data-field="approvalTaskCreatedBlockReason"]',
    })
  }

  if (
    input.triggerType === 'webhook.received'
    && !input.webhookSecretPresent
    && !(input.ruleHasId && input.savedWebhookSecretConfigured)
  ) {
    reasons.push({
      key: 'webhookSecret',
      message: zh ? '请填写签名密钥（Secret）。' : 'Enter a signing secret.',
      anchor: '[data-field="webhookSecret"]',
    })
  }

  if (input.conditionBranchReadOnlyReason) {
    reasons.push({
      key: 'conditionBranchReadOnly',
      message: input.conditionBranchReadOnlyReason,
      anchor: '[data-field="condition-branch-readonly"]',
    })
  }
  if (input.conditionBranchKeyError) {
    reasons.push({
      key: 'conditionBranchKeyError',
      message: input.conditionBranchKeyError,
      anchor: '[data-field="branch-key-error"]',
    })
  }
  if (input.parallelBranchReadOnlyReason) {
    reasons.push({
      key: 'parallelBranchReadOnly',
      message: input.parallelBranchReadOnlyReason,
      anchor: '[data-field="parallel-branch-readonly"]',
    })
  }
  if (input.parallelBranchKeyError) {
    reasons.push({
      key: 'parallelBranchKeyError',
      message: input.parallelBranchKeyError,
      anchor: '[data-field="parallel-branch-key-error"]',
    })
  }
  if (input.parallelBranchActionError) {
    reasons.push({
      key: 'parallelBranchActionError',
      message: input.parallelBranchActionError,
      anchor: '[data-field="parallel-branch-action-error"]',
    })
  }

  if (!input.conditionsComplete) {
    reasons.push({
      key: 'conditionsIncomplete',
      message: zh
        ? '请完善所有筛选条件（字段与取值均为必填）。'
        : 'Complete all filter conditions (field and value are required).',
      anchor: input.firstIncompleteConditionAnchor,
    })
  }

  for (const action of input.actions) {
    const label = automationActionTypeLabel(action.type, zh)
    const scope = `[data-action-index="${action.index}"]`

    if (action.groupMessage) {
      const m = action.groupMessage
      if (m.destinationIdCount === 0 && m.destinationFieldPathCount === 0) {
        reasons.push({
          key: `action-${action.index}-destination`,
          message: zh
            ? `「${label}」未设置接收群组，请至少选择一个群或填写接收人字段路径。`
            : `"${label}" has no destination — select at least one group or a recipient field path.`,
          anchor: `${scope} [data-field="dingtalkDestinationPickerId"]`,
        })
      }
      if (!m.titleTemplate.trim()) {
        reasons.push({
          key: `action-${action.index}-title`,
          message: zh ? `「${label}」标题模板为空，请填写标题。` : `"${label}" is missing a title template.`,
          anchor: `${scope} [data-field="dingtalkTitleTemplate"]`,
        })
      }
      if (!m.bodyTemplate.trim()) {
        reasons.push({
          key: `action-${action.index}-body`,
          message: zh ? `「${label}」正文模板为空，请填写正文。` : `"${label}" is missing a body template.`,
          anchor: `${scope} [data-field="dingtalkBodyTemplate"]`,
        })
      }
      if (m.publicFormBlockingErrorCount > 0) {
        reasons.push({
          key: `action-${action.index}-publicFormLink`,
          message: zh
            ? `「${label}」引用的公开表单存在阻断性问题，请修正表单链接设置。`
            : `"${label}" references a public form with blocking issues — fix the form link settings.`,
          anchor: `${scope} [data-field="publicFormViewId"]`,
        })
      }
      if (m.internalViewBlockingErrorCount > 0) {
        reasons.push({
          key: `action-${action.index}-internalViewLink`,
          message: zh
            ? `「${label}」引用的内部视图存在阻断性问题，请修正视图链接设置。`
            : `"${label}" references an internal view with blocking issues — fix the view link settings.`,
          anchor: `${scope} [data-field="internalViewId"]`,
        })
      }
    }

    if (action.personMessage) {
      const m = action.personMessage
      if (
        m.userIdCount === 0
        && m.memberGroupIdCount === 0
        && m.recipientFieldPathCount === 0
        && m.memberGroupRecipientFieldPathCount === 0
      ) {
        reasons.push({
          key: `action-${action.index}-destination`,
          message: zh
            ? `「${label}」未设置接收人，请至少指定一个用户、成员组或接收人字段路径。`
            : `"${label}" has no recipient — specify at least one user, member group, or recipient field path.`,
          anchor: `${scope} [data-field="dingtalkPersonUserIds"]`,
        })
      }
      if (!m.titleTemplate.trim()) {
        reasons.push({
          key: `action-${action.index}-title`,
          message: zh ? `「${label}」标题模板为空，请填写标题。` : `"${label}" is missing a title template.`,
          anchor: `${scope} [data-field="dingtalkPersonTitleTemplate"]`,
        })
      }
      if (!m.bodyTemplate.trim()) {
        reasons.push({
          key: `action-${action.index}-body`,
          message: zh ? `「${label}」正文模板为空，请填写正文。` : `"${label}" is missing a body template.`,
          anchor: `${scope} [data-field="dingtalkPersonBodyTemplate"]`,
        })
      }
      if (m.publicFormBlockingErrorCount > 0) {
        reasons.push({
          key: `action-${action.index}-publicFormLink`,
          message: zh
            ? `「${label}」引用的公开表单存在阻断性问题，请修正表单链接设置。`
            : `"${label}" references a public form with blocking issues — fix the form link settings.`,
          anchor: `${scope} [data-field="dingtalkPersonPublicFormViewId"]`,
        })
      }
      if (m.internalViewBlockingErrorCount > 0) {
        reasons.push({
          key: `action-${action.index}-internalViewLink`,
          message: zh
            ? `「${label}」引用的内部视图存在阻断性问题，请修正视图链接设置。`
            : `"${label}" references an internal view with blocking issues — fix the view link settings.`,
          anchor: `${scope} [data-field="dingtalkPersonInternalViewId"]`,
        })
      }
    }

    if (action.email) {
      const m = action.email
      if (m.recipientCount === 0) {
        reasons.push({
          key: `action-${action.index}-recipients`,
          message: zh ? `「${label}」未填写收件人。` : `"${label}" has no recipients.`,
          anchor: `${scope} [data-field="emailRecipients"]`,
        })
      }
      if (!m.subjectTemplate.trim()) {
        reasons.push({
          key: `action-${action.index}-subject`,
          message: zh ? `「${label}」主题模板为空。` : `"${label}" is missing a subject template.`,
          anchor: `${scope} [data-field="emailSubjectTemplate"]`,
        })
      }
      if (!m.bodyTemplate.trim()) {
        reasons.push({
          key: `action-${action.index}-body`,
          message: zh ? `「${label}」正文模板为空。` : `"${label}" is missing a body template.`,
          anchor: `${scope} [data-field="emailBodyTemplate"]`,
        })
      }
    }

    if (action.deleteRecord && !action.deleteRecord.acknowledged) {
      reasons.push({
        key: `action-${action.index}-deleteAck`,
        message: zh
          ? `「${label}」需要勾选删除确认才能保存。`
          : `"${label}" requires the delete-confirmation checkbox before saving.`,
        anchor: `${scope} [data-field="deleteRecordAck"]`,
      })
    }

    if (action.fwbWriteback) {
      const fwb = action.fwbWriteback
      // Read-only (flag OFF / wrong trigger) preserves a persisted confirmed action — only block when
      // the author can edit and has not completed the server confirmation round-trip yet.
      if (!fwb.readOnly && !fwb.confirmed) {
        reasons.push({
          key: `action-${action.index}-fwbConfirm`,
          message: zh
            ? `「${label}」需先完成服务端映射确认才能保存。`
            : `"${label}" requires a completed server mapping confirmation before saving.`,
          anchor: `${scope} [data-testid="fwb-request-confirmation"]`,
        })
      }
      if (!fwb.readOnly && fwb.mappingCount < 1) {
        reasons.push({
          key: `action-${action.index}-fwbMappings`,
          message: zh
            ? `「${label}」至少需要一条字段映射。`
            : `"${label}" needs at least one field mapping.`,
          anchor: `${scope} [data-testid="fwb-add-mapping"]`,
        })
      }
    }
  }

  return reasons
}
