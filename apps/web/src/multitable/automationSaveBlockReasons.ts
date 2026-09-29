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
import type { AutomationActionType, AutomationRule } from './types'

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

/**
 * send_notification: the backend refuses an empty recipient list at save (400 NO_RECIPIENTS) and at
 * run (AUTOMATION_NO_RECIPIENTS_ERROR). Mirroring that one rule here turns the 400 into an inline
 * "why is Save disabled" reason; membership/authorization of each id stays a server decision.
 */
export interface SaveBlockNotificationSnapshot {
  userIdCount: number
}

export interface SaveBlockDeleteRecordSnapshot {
  acknowledged: boolean
}

/**
 * #5739 泛化 round-2 — the cross-base target triple of a record-mutating action (update_record /
 * delete_record / lock_record), read from the config as LOADED. The editor does not author these keys but
 * preserves them on save, so an INCOMPLETE triple (targetBaseId without targetSheetId + targetRecordId)
 * now reaches the backend, which refuses it at save time (automation-service.ts validateCrossBaseWriteConfig
 * → HTTP 400) and would fail the step at run time. Mirroring that one shape rule here turns the opaque 400
 * into an inline, anchored "why is Save disabled" line; authority over the target base stays server-side.
 */
export interface SaveBlockCrossBaseTargetSnapshot {
  targetBaseId: string
  targetSheetId: string
  targetRecordId: string
}

export interface SaveBlockFwbWritebackSnapshot {
  mappingCount: number
  confirmed: boolean
  readOnly: boolean
}

/**
 * #5742 — one "the status select has no such option" blocker for a start_approval action, pre-evaluated by
 * the editor (it owns the field list + the label catalogue). `outcome` is the approval outcome the value
 * would be written for; it keys both the reason and the anchor, so two failing outcomes are two lines.
 */
export interface StartApprovalOutcomeValueBlock {
  actionIndex: number
  outcome: string
  message: string
}

export interface SaveBlockActionSnapshot {
  index: number
  type: AutomationActionType
  groupMessage?: SaveBlockGroupMessageSnapshot
  personMessage?: SaveBlockPersonMessageSnapshot
  email?: SaveBlockEmailSnapshot
  notification?: SaveBlockNotificationSnapshot
  deleteRecord?: SaveBlockDeleteRecordSnapshot
  crossBaseTarget?: SaveBlockCrossBaseTargetSnapshot
  fwbWriteback?: SaveBlockFwbWritebackSnapshot
  /**
   * 客户反馈 2026-09-24 #3: the trigger is `record.deleted` and this action (or a branch sub-action inside it)
   * would update/delete/lock the TRIGGER record — which no longer exists at that point. The backend refuses the
   * save with DELETED_TRIGGER_SELF_MUTATION; pre-evaluated by the editor (it knows the trigger and the
   * cross-base target), mirrored here as an anchored reason.
   */
  deletedTriggerSelfMutation?: boolean
}

// ── The ONE client-side detector for "record.deleted + an action that mutates the trigger record" ──────────
// 客户反馈 2026-09-24 #3 (裁定 PR #6074) / #6155. Under a `record.deleted` trigger the trigger record no longer
// exists, so a SAME-BASE update_record / delete_record / lock_record of it can only no-op (a delete step ends as
// skipped, an update / lock step as success with no row touched). Two consumers share this decision so they
// cannot drift: the rule editor (the pre-evaluated
// `deletedTriggerSelfMutation` above → its save-block reason, inline hint and disabled option) and the automation
// panel (a non-blocking notice on a LISTED rule that is on or being switched on). It mirrors the backend's
// STRUCTURAL check (automation-service.ts validateDeletedTriggerSelfMutation): a mutating action without a
// COMPLETE cross-base target resolves to the trigger record, and a branch sub-action counts by its type alone.
// Not mirrored (it needs the database): the backend's same-base resolution of a complete target.

/** The action types that address the trigger record unless they carry a complete cross-base target. */
export const TRIGGER_RECORD_MUTATING_ACTION_TYPES: ReadonlySet<string> = new Set(['update_record', 'delete_record', 'lock_record'])

export interface DeletedTriggerActionShape {
  type: string
  /** The action's config carries a COMPLETE cross-base target (targetBaseId + targetSheetId + targetRecordId). */
  completeCrossBaseTarget: boolean
  /** The `type` of every sub-action inside it (condition_branch / parallel_branch branches). */
  nestedActionTypes: readonly string[]
}

/** Does this action (or a branch sub-action inside it) mutate the trigger record under this trigger? */
export function isDeletedTriggerSelfMutation(triggerType: string, action: DeletedTriggerActionShape): boolean {
  if (triggerType !== 'record.deleted') return false
  if (TRIGGER_RECORD_MUTATING_ACTION_TYPES.has(action.type)) return !action.completeCrossBaseTarget
  return action.nestedActionTypes.some((type) => TRIGGER_RECORD_MUTATING_ACTION_TYPES.has(type))
}

function isPlainConfig(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A RAW (as-stored) action config names all three cross-base target ids (non-blank). */
export function hasCompleteCrossBaseTarget(config: unknown): boolean {
  if (!isPlainConfig(config)) return false
  const text = (key: string): string => (typeof config[key] === 'string' ? (config[key] as string).trim() : '')
  return Boolean(text('targetBaseId') && text('targetSheetId') && text('targetRecordId'))
}

/** The `type` of every sub-action inside a RAW (as-stored) condition_branch / parallel_branch config. */
export function rawBranchActionTypes(raw: unknown): string[] {
  if (!isPlainConfig(raw)) return []
  const out: string[] = []
  const collect = (branch: unknown): void => {
    if (!isPlainConfig(branch) || !Array.isArray(branch.actions)) return
    for (const sub of branch.actions) {
      if (isPlainConfig(sub) && typeof sub.type === 'string') out.push(sub.type)
    }
  }
  if (Array.isArray(raw.branches)) raw.branches.forEach(collect)
  collect(raw.defaultBranch)
  return out
}

/**
 * The panel's adapter: a STORED rule as listed. Its actions are `actions[]` when non-empty, else the legacy
 * top-level pair — the same choice the editor makes when it opens the rule (draftFromRule) — and the v0 alias
 * `update_field` counts as the `update_record` it executes as.
 */
export function storedRuleHasDeletedTriggerSelfMutation(
  rule: Pick<AutomationRule, 'triggerType' | 'actionType' | 'actionConfig' | 'actions'>,
): boolean {
  const stored: Array<{ type: string; config: unknown }> = rule.actions && rule.actions.length
    ? rule.actions.map((action) => ({ type: action.type, config: action.config }))
    : [{ type: rule.actionType, config: rule.actionConfig }]
  return stored.some(({ type, config }) => isDeletedTriggerSelfMutation(rule.triggerType, {
    type: type === 'update_field' ? 'update_record' : type,
    completeCrossBaseTarget: hasCompleteCrossBaseTarget(config),
    nestedActionTypes: rawBranchActionTypes(config),
  }))
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
  /**
   * 客户反馈 2026-09-24 #4b: false when a condition_branch condition row is incomplete (no field, or a value
   * that cannot be saved in its field type's shape). Omitted = complete (callers without branch rows).
   */
  branchConditionsComplete?: boolean
  /** Selector for the first incomplete condition_branch condition row. */
  firstIncompleteBranchConditionAnchor?: string
  actions: SaveBlockActionSnapshot[]
  /** #5742: pre-evaluated result-writeback outcome→value blockers (empty / omitted when none). */
  startApprovalOutcomeValueBlocks?: StartApprovalOutcomeValueBlock[]
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

  if (input.branchConditionsComplete === false) {
    reasons.push({
      key: 'branchConditionsIncomplete',
      message: zh
        ? '请完善条件分支中的所有条件（字段与取值均为必填）。'
        : 'Complete all conditions in the condition branches (field and value are required).',
      anchor: input.firstIncompleteBranchConditionAnchor,
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

    if (action.notification && action.notification.userIdCount === 0) {
      reasons.push({
        key: `action-${action.index}-recipients`,
        message: zh
          ? `「${label}」未设置通知接收人，请搜索并选择至少一个用户。`
          : `"${label}" has no recipients — search and select at least one user.`,
        anchor: `${scope} [data-field="notificationRecipientSearch"]`,
      })
    }

    if (
      action.crossBaseTarget
      && action.crossBaseTarget.targetBaseId
      && (!action.crossBaseTarget.targetSheetId || !action.crossBaseTarget.targetRecordId)
    ) {
      reasons.push({
        key: `action-${action.index}-crossBaseTarget`,
        message: zh
          ? `「${label}」跨 base 目标不完整：设置 targetBaseId 后必须同时有 targetSheetId 与 targetRecordId，服务端会拒绝保存。请通过 API 修复该规则。`
          : `"${label}" has an incomplete cross-base target: targetSheetId and targetRecordId are both required once targetBaseId is set, and the server refuses to save it. Fix the rule through the API.`,
        anchor: `${scope} [data-field="crossBaseTarget"]`,
      })
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

    if (action.deletedTriggerSelfMutation) {
      reasons.push({
        key: `action-${action.index}-deletedTriggerSelfMutation`,
        message: zh
          ? `「${label}」：记录删除时触发记录已不存在，不能再修改/删除/锁定它。`
          : `"${label}": when a record is deleted its trigger record no longer exists, so it cannot be updated, deleted or locked.`,
        anchor: `${scope} [data-field="deletedTriggerSelfMutationHint"]`,
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

  // #5742: mirrors the backend save gate (a select status field must contain the value the backwrite would
  // write). The message arrives pre-composed; the anchor points at the very picker that fixes it.
  for (const block of input.startApprovalOutcomeValueBlocks ?? []) {
    reasons.push({
      key: `action-${block.actionIndex}-writebackOutcome-${block.outcome}`,
      message: block.message,
      anchor: `[data-action-index="${block.actionIndex}"] [data-field="resultWritebackOutcomeValue-${block.outcome}"]`,
    })
  }

  return reasons
}
