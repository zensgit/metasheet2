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

export type StatusDomain = 'approvalInstance' | 'approvalTemplate' | 'delegation' | 'automationRun'

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
// ApprovalCenterView (all 4 tabs), ApprovalMobileList, ApprovalDetailView's header tag, and
// ApprovalInboxView's status column. Enumerated from what those views' now-deleted local
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
