// G-B2-25 — rule-editor per-action one-line summary (docs/research/approval-automation-operation-
// ux-benchmark-20260704.md, B2-25: "3 动作 ≈700 行控件长墙；渐进披露是关键").
//
// MetaSheet principle: progressive disclosure. Three fully-authored actions in the rule editor
// render ~700 lines of controls — a wall that hides the one thing an author wants at a glance:
// "what does this step actually do". This module owns ONLY that one sentence. Given a plain
// snapshot of an action's config (no Vue reactivity, no component state, no live field/template
// lookups), it returns a short, human-readable description.
//
// Honesty rule: a missing or unfilled field renders an explicit placeholder ("(not configured)",
// "(no field selected)", …) — this module NEVER guesses or fabricates a value that wasn't
// authored. The snapshot is assembled in MetaAutomationRuleEditor.vue (which already has the
// field-name / approval-template-name lookups this needs) and handed in pre-resolved, mirroring
// the automationSaveBlockReasons.ts precedent: aggregation/formatting of a UI sentence lives in
// its own pure, unit-testable module; the live lookups that produce the snapshot stay in the
// component.
//
// Scope note: this is a display-layer summary, NOT a save-gate. A "configured enough to render a
// meaningful sentence" action can still be missing something automationSaveBlockReasons.ts would
// block Save on (e.g. a group-message action with a destination but no body template) — that is
// intentional; the two modules answer different questions ("what would this do" vs "why can't I
// save").

import type { AutomationActionType } from './types'
import { automationActionTypeLabel } from './utils/meta-automation-labels'

export interface ActionSummaryFieldUpdate {
  /** Resolved field display name; '' when the pair has no field chosen yet. */
  fieldLabel: string
  /** Authored value text; '' when left blank. */
  value: string
}

export interface ActionSummaryUpdateRecord {
  fieldUpdates: ActionSummaryFieldUpdate[]
}

export interface ActionSummaryCreateRecord {
  targetSheetId: string
  fieldValueCount: number
}

export interface ActionSummaryWebhook {
  url: string
  method: string
}

export interface ActionSummaryNotification {
  userId: string
  message: string
}

export interface ActionSummaryStartApproval {
  /** Resolved template name, falling back to the raw template id; '' when nothing is chosen. */
  templateLabel: string
  mappingCount: number
}

export interface ActionSummaryEmail {
  recipientCount: number
  subjectTemplate: string
}

export interface ActionSummaryDingTalkGroupMessage {
  /** Explicit group destinations + record-field destination paths — a total reach COUNT, not a claim about which groups. */
  destinationCount: number
  titleTemplate: string
}

export interface ActionSummaryDingTalkPersonMessage {
  /** Users + member groups + recipient field paths + member-group field paths, summed. */
  recipientCount: number
  titleTemplate: string
}

export interface ActionSummaryLockRecord {
  locked: boolean
}

export interface ActionSummaryDeleteRecord {
  acknowledged: boolean
}

export interface ActionSummaryConditionBranch {
  branchCount: number
  hasDefaultBranch: boolean
}

export interface ActionSummaryParallelBranch {
  branchCount: number
}

export interface ActionSummaryFwbWriteback {
  mappingCount: number
  confirmed: boolean
  mode: 'create' | 'update'
}

export interface ActionSummarySnapshot {
  type: AutomationActionType
  updateRecord?: ActionSummaryUpdateRecord
  createRecord?: ActionSummaryCreateRecord
  webhook?: ActionSummaryWebhook
  notification?: ActionSummaryNotification
  startApproval?: ActionSummaryStartApproval
  email?: ActionSummaryEmail
  dingTalkGroupMessage?: ActionSummaryDingTalkGroupMessage
  dingTalkPersonMessage?: ActionSummaryDingTalkPersonMessage
  lockRecord?: ActionSummaryLockRecord
  deleteRecord?: ActionSummaryDeleteRecord
  conditionBranch?: ActionSummaryConditionBranch
  parallelBranch?: ActionSummaryParallelBranch
  fwbWriteback?: ActionSummaryFwbWriteback
}

function pick(isZh: boolean, zh: string, en: string): string {
  return isZh ? zh : en
}

function sep(isZh: boolean): string {
  return isZh ? '：' : ': '
}

function notConfigured(isZh: boolean): string {
  return pick(isZh, '（未配置）', ' (not configured)')
}

function noField(isZh: boolean): string {
  return pick(isZh, '(未选字段)', '(no field selected)')
}

function noValue(isZh: boolean): string {
  return pick(isZh, '(未填值)', '(empty value)')
}

function plural(count: number, singular: string, pluralWord: string): string {
  return count === 1 ? singular : pluralWord
}

/** Keeps the summary a genuine ONE-LINER — long template/value text is truncated, never wrapped. */
function truncate(text: string, max = 32): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`
}

export function summarizeAutomationAction(snapshot: ActionSummarySnapshot, isZh: boolean): string {
  const label = automationActionTypeLabel(snapshot.type, isZh)

  switch (snapshot.type) {
    case 'update_record': {
      const pairs = snapshot.updateRecord?.fieldUpdates ?? []
      if (pairs.length === 0) return `${label}${notConfigured(isZh)}`
      const first = pairs[0]
      const fieldText = first.fieldLabel.trim() || noField(isZh)
      const valueText = first.value.trim() ? truncate(first.value) : noValue(isZh)
      const base = `${label}${sep(isZh)}${fieldText} ← ${valueText}`
      if (pairs.length === 1) return base
      const extra = pairs.length - 1
      return pick(isZh, `${base} 等 ${pairs.length} 项`, `${base} and ${extra} more`)
    }

    case 'create_record': {
      const c = snapshot.createRecord
      const sheet = c?.targetSheetId.trim()
      if (!sheet) return `${label}${notConfigured(isZh)}`
      const count = c?.fieldValueCount ?? 0
      const countText = count > 0
        ? pick(isZh, `，${count} 个字段值`, `, ${count} field ${plural(count, 'value', 'values')}`)
        : pick(isZh, '（未填字段值）', ' (no field values)')
      // W1 G-10 (display layer only): label normalized to '目标数据表' — the interpolated sheet
      // id after it stays raw (this summary line never resolves it to a friendly sheet name).
      return `${label}${sep(isZh)}${pick(isZh, '目标数据表', 'target sheet')} ${sheet}${countText}`
    }

    case 'send_webhook': {
      const w = snapshot.webhook
      const url = w?.url.trim()
      if (!url) return `${label}${notConfigured(isZh)}`
      const method = w?.method.trim() || 'POST'
      return `${label}${sep(isZh)}${method} ${truncate(url)}`
    }

    case 'send_notification': {
      const n = snapshot.notification
      const userId = n?.userId.trim()
      if (!userId) return `${label}${notConfigured(isZh)}`
      const msgText = n?.message.trim() ? truncate(n.message) : pick(isZh, '(未填写内容)', '(no message)')
      return pick(isZh, `发送通知给 ${userId}：${msgText}`, `Send notification to ${userId}: ${msgText}`)
    }

    case 'start_approval': {
      const s = snapshot.startApproval
      const templateText = s?.templateLabel.trim()
      if (!templateText) return `${label}${notConfigured(isZh)}`
      const mappingCount = s?.mappingCount ?? 0
      const mappingText = mappingCount > 0
        ? pick(isZh, `，${mappingCount} 项字段映射`, `, ${mappingCount} field ${plural(mappingCount, 'mapping', 'mappings')}`)
        : ''
      return `${label}${sep(isZh)}${pick(isZh, '模板', 'template')} ${truncate(templateText)}${mappingText}`
    }

    case 'send_email': {
      const e = snapshot.email
      const count = e?.recipientCount ?? 0
      if (count === 0) return `${label}${notConfigured(isZh)}`
      const base = pick(isZh, `发送邮件给 ${count} 人`, `Send email to ${count} ${plural(count, 'recipient', 'recipients')}`)
      const subjectText = e?.subjectTemplate.trim() ? truncate(e.subjectTemplate) : pick(isZh, '(未填写主题)', '(no subject)')
      return `${base}${sep(isZh)}${subjectText}`
    }

    case 'send_dingtalk_group_message': {
      const g = snapshot.dingTalkGroupMessage
      const count = g?.destinationCount ?? 0
      if (count === 0) return `${label}${notConfigured(isZh)}`
      const base = pick(isZh, `发送群消息给 ${count} 个群`, `Send group message to ${count} ${plural(count, 'group', 'groups')}`)
      const titleText = g?.titleTemplate.trim() ? truncate(g.titleTemplate) : pick(isZh, '(未填写标题)', '(no title)')
      return `${base}${sep(isZh)}${titleText}`
    }

    case 'send_dingtalk_person_message': {
      const p = snapshot.dingTalkPersonMessage
      const count = p?.recipientCount ?? 0
      if (count === 0) return `${label}${notConfigured(isZh)}`
      const base = pick(isZh, `发送个人消息给 ${count} 人`, `Send person message to ${count} ${plural(count, 'recipient', 'recipients')}`)
      const titleText = p?.titleTemplate.trim() ? truncate(p.titleTemplate) : pick(isZh, '(未填写标题)', '(no title)')
      return `${base}${sep(isZh)}${titleText}`
    }

    case 'send_dingtalk_approval_card': {
      // Zero-config action: the recipient is fixed from the approval-task event (never
      // author-supplied), so there is nothing authored to summarize beyond that fact.
      return `${label}${sep(isZh)}${pick(isZh, '收件人固定（来自待办事件）', 'fixed recipient (from the pending-task event)')}`
    }

    case 'lock_record': {
      const locked = snapshot.lockRecord?.locked === true
      return pick(isZh, locked ? '锁定记录' : '解锁记录', locked ? 'Lock record' : 'Unlock record')
    }

    case 'delete_record': {
      const acknowledged = snapshot.deleteRecord?.acknowledged === true
      return acknowledged ? label : `${label}${pick(isZh, '（未确认）', ' (not confirmed)')}`
    }

    case 'wait_for_callback': {
      // Zero-param suspend point by design (A6-2) — the type label is already the full story.
      return label
    }

    case 'condition_branch': {
      const cb = snapshot.conditionBranch
      const count = cb?.branchCount ?? 0
      if (count === 0) return `${label}${notConfigured(isZh)}`
      const base = `${label}${sep(isZh)}${count} ${pick(isZh, '个分支', plural(count, 'branch', 'branches'))}`
      return cb?.hasDefaultBranch ? `${base}${pick(isZh, ' + 默认分支', ' + default branch')}` : base
    }

    case 'write_approval_form_values': {
      const fwb = snapshot.fwbWriteback
      const count = fwb?.mappingCount ?? 0
      if (count === 0) return `${label}${notConfigured(isZh)}`
      const mappingText = pick(
        isZh,
        `${count} 项映射`,
        `${count} field ${plural(count, 'mapping', 'mappings')}`,
      )
      const modeText = fwb?.mode === 'update'
        ? pick(isZh, '更新关联记录', 'update linked record')
        : pick(isZh, '新建记录', 'create record')
      const confirmText = fwb?.confirmed
        ? pick(isZh, '已确认', 'confirmed')
        : pick(isZh, '未确认', 'unconfirmed')
      return `${label}${sep(isZh)}${modeText} · ${mappingText}（${confirmText}）`
    }

    case 'parallel_branch': {
      const pb = snapshot.parallelBranch
      const count = pb?.branchCount ?? 0
      if (count === 0) return `${label}${notConfigured(isZh)}`
      return `${label}${sep(isZh)}${count} ${pick(isZh, '路并行', plural(count, 'parallel branch', 'parallel branches'))}`
    }

    default:
      // Legacy aliases ('notify' / 'update_field') and any future/unknown action type: the type
      // label is the only thing we can say honestly without a dedicated snapshot shape.
      return label
  }
}
