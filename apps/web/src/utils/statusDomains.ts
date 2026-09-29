// UF-3 — status-color convergence (docs/development/ui-foundation-design-lock-20260706.md §3.4,
// §6). Six views previously each declared their own status → color/label map (or, for
// ApprovalInboxView, rendered the raw enum with no color at all). This is the ONE place status
// semantics live: a domain table of `status → { tone, zh, en }` per StatusTag consumer, plus the
// `resolveStatusDisplay` lookup StatusTag.vue calls.
//
// Governance (design-lock §2): this file converges PRESENTATION only. It does not recompute or
// fork any domain's status LOGIC — `delegation` calls the existing `delegationDisplayStatus`
// (approvals/delegationStatus.ts) upstream of this module and only maps its already-computed
// display status to a tone; `automationRun` derives its zh/en labels by calling the existing
// `automationStatusLabel` (multitable/utils/meta-automation-labels.ts) rather than re-declaring
// automation copy here.
//
// UF-3b — closes the 4th "status domain" gap UF-3 flagged but didn't land: `approvalTemplate`
// (TemplateCenterView's tab/column tag, TemplateDetailView's header tag, ApprovalNewView's
// info-card tag) previously each hand-rolled a `published`/`draft`/`archived` ternary or a
// two-branch `status === 'published' ? ... : ...` map. Vocabulary is the `ApprovalTemplateStatus`
// type (types/approval.ts) — verified against source, NOT the three-value guess ("draft/
// published/disabled") floated before grounding; the real third state is `archived`.

import { automationStatusLabel } from '../multitable/utils/meta-automation-labels'
import type { WorkflowJobStatus } from '../multitable/types'
import type { DelegationDisplayStatus } from '../approvals/delegationStatus'
import type { ApprovalTemplateStatus } from '../types/approval'

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'neutral'

export type StatusDomain = 'approvalInstance' | 'approvalTemplate' | 'delegation' | 'automationRun' | 'cancelRound'

export interface StatusDisplayEntry {
  tone: StatusTone
  zh: string
  en: string
}

export interface StatusDisplayResult {
  tone: StatusTone
  label: string
}

// ---------------------------------------------------------------------------
// approvalInstance — the shared instance-status vocabulary rendered by
// ApprovalCenterView (all 4 tabs), ApprovalMobileList, and ApprovalDetailView's header tag.
// Enumerated from what those views' now-deleted local
// `statusTagType`/`statusLabel` maps actually handled (pending/approved/rejected/revoked/
// cancelled) — `ApprovalStatus` also allows `draft`, and the underlying instance model separately
// tracks a `returned` terminal state (approvals/api.ts `terminalState`), but neither ever reached
// these status-tag call sites as a literal `row.status` value, so both fall through to the
// fail-safe neutral/raw-text branch below rather than being asserted as colored here.
const APPROVAL_INSTANCE_STATUS_DOMAIN: Record<string, StatusDisplayEntry> = {
  pending: { tone: 'warning', zh: '待处理', en: 'Pending' },
  approved: { tone: 'success', zh: '已通过', en: 'Approved' },
  rejected: { tone: 'danger', zh: '已驳回', en: 'Rejected' },
  revoked: { tone: 'info', zh: '已撤回', en: 'Revoked' },
  cancelled: { tone: 'info', zh: '已取消', en: 'Cancelled' },
}

// ---------------------------------------------------------------------------
// cancelRound — 请假撤销(撤销轮)的状态词表 V1–V8(撤销锁 v5.9 抬头「RATIFY 追记 —— 产品入口增补 v2」
// P-2;词表见 docs/development/approval-cancel-entry-phase-b-fe-design-20260929.md §3). A SEPARATE
// domain on purpose: `approvalInstance` above stays byte-for-byte as it was (changing it would repaint
// every approval list), and a cancel-round instance is switched onto this table by the one selector
// `approvalStatusTagProps` (approvals/cancelRound.ts) keyed on `workflowKey === 'approval.cancel-round'`.
//  - Every label names its subject (撤销申请 / 请假): the approval instance's own `revoked` /
//    `cancelled` words say neither, and on the same screen as the leave they read as the same thing.
//  - V3 (an approver's rejection) and V5 / V6 (system closure) share the engine status `rejected`;
//    they differ ONLY by the close-reason criterion (lock:131), resolved upstream — this table never
//    guesses. `status_resolving` / `status_unavailable` are for a surface that has not read that
//    criterion yet; they are not V-words and never say 驳回.
//  - V7 / V8 are NOT terminal (the round stays pending, the action may be retried): warning tone,
//    never the danger tone of a failure.
const CANCEL_ROUND_STATUS_DOMAIN: Record<string, StatusDisplayEntry> = {
  cancellation_pending_approval: { tone: 'warning', zh: '撤销申请审批中', en: 'Cancellation pending approval' },
  leave_cancelled: { tone: 'success', zh: '请假已取消', en: 'Leave cancelled' },
  cancellation_rejected: { tone: 'danger', zh: '撤销申请被驳回', en: 'Cancellation rejected' },
  cancellation_withdrawn: { tone: 'info', zh: '撤销申请已撤回', en: 'Cancellation withdrawn' },
  cancellation_window_closed: { tone: 'neutral', zh: '撤销窗口已过,申请自动关闭', en: 'Cancellation window closed' },
  cancellation_blocked: { tone: 'neutral', zh: '该请假已无法撤销(业务原因)', en: 'Cancellation blocked' },
  action_incomplete_retry: { tone: 'warning', zh: '本次操作未完成,请稍后重试', en: 'Action failed, still pending' },
  system_busy_retry: { tone: 'warning', zh: '系统繁忙,请稍后重试', en: 'System busy' },
  status_resolving: { tone: 'neutral', zh: '撤销结果读取中', en: 'Loading cancellation result' },
  status_unavailable: { tone: 'neutral', zh: '撤销结果暂时无法读取', en: 'Cancellation result unavailable' },
}

// ---------------------------------------------------------------------------
// approvalTemplate — the THREE `ApprovalTemplateStatus` values (types/approval.ts). Tone/label
// values carried over unchanged from the three call sites' now-deleted local
// `statusTagType`/`statusLabel` maps (semantics preserved, not re-decided here): `published`
// mapped to EP `success`, `draft` to `warning`, `archived` to `info`.
const APPROVAL_TEMPLATE_STATUS_DOMAIN: Record<ApprovalTemplateStatus, StatusDisplayEntry> = {
  published: { tone: 'success', zh: '已发布', en: 'Published' },
  draft: { tone: 'warning', zh: '草稿', en: 'Draft' },
  archived: { tone: 'info', zh: '已归档', en: 'Archived' },
}

// ---------------------------------------------------------------------------
// delegation — the FOUR display statuses `delegationDisplayStatus()` computes (never a raw
// `active` boolean or an English enum). This table only adds tone + an English label; the status
// derivation itself (window-vs-now precedence, disabled-overrides-window, etc.) stays owned by
// delegationStatus.ts. Tone values are carried over unchanged from that file's
// `DELEGATION_STATUS_TAG_TYPE` (semantics preserved, not re-decided here).
const DELEGATION_STATUS_DOMAIN: Record<DelegationDisplayStatus, StatusDisplayEntry> = {
  未开始: { tone: 'info', zh: '未开始', en: 'Not started' },
  生效中: { tone: 'success', zh: '生效中', en: 'Active' },
  已过期: { tone: 'warning', zh: '已过期', en: 'Expired' },
  已停用: { tone: 'danger', zh: '已停用', en: 'Disabled' },
}

// ---------------------------------------------------------------------------
// automationRun — the full WorkflowJobStatus set AutomationExecutionsView surfaces for both runs
// and steps. zh/en labels are NOT re-declared here — they're read straight off the existing
// `automationStatusLabel` chrome table so this module can never drift from it.
const AUTOMATION_RUN_STATUSES: WorkflowJobStatus[] = [
  'queued',
  'running',
  'suspended',
  'resolved',
  'failed',
  'skipped',
  'rejected',
  'errored',
]

const AUTOMATION_RUN_TONE: Record<WorkflowJobStatus, StatusTone> = {
  queued: 'primary',
  running: 'primary',
  suspended: 'primary',
  resolved: 'success',
  failed: 'danger',
  errored: 'danger',
  rejected: 'danger',
  skipped: 'neutral',
}

const AUTOMATION_RUN_STATUS_DOMAIN: Record<string, StatusDisplayEntry> = Object.fromEntries(
  AUTOMATION_RUN_STATUSES.map((status) => [
    status,
    {
      tone: AUTOMATION_RUN_TONE[status],
      zh: automationStatusLabel(status, true),
      en: automationStatusLabel(status, false),
    },
  ]),
)

const DOMAIN_TABLES: Record<StatusDomain, Record<string, StatusDisplayEntry>> = {
  approvalInstance: APPROVAL_INSTANCE_STATUS_DOMAIN,
  approvalTemplate: APPROVAL_TEMPLATE_STATUS_DOMAIN,
  delegation: DELEGATION_STATUS_DOMAIN,
  automationRun: AUTOMATION_RUN_STATUS_DOMAIN,
  cancelRound: CANCEL_ROUND_STATUS_DOMAIN,
}

/**
 * Resolve a `(domain, status)` pair to a tone + localized label. Fail-safe: a status absent from
 * the domain's table (including domains passed a stale/unexpected value) never throws and never
 * renders blank — it degrades to tone `'neutral'` with the raw status string as the label.
 */
export function resolveStatusDisplay(domain: StatusDomain, status: string, isZh: boolean): StatusDisplayResult {
  const entry = DOMAIN_TABLES[domain]?.[status]
  if (!entry) return { tone: 'neutral', label: status }
  return { tone: entry.tone, label: isZh ? entry.zh : entry.en }
}
