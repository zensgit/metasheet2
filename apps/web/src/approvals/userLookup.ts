// 按人查单（管理员）— pure helpers for ApprovalUserLookupView. Kept out of the SFC so they can be
// unit-tested directly (a `<script setup>` block cannot export functions).
import type { ApprovalByUserKind, ApprovalByUserRow } from './api'

export const USER_LOOKUP_KIND_LABELS: Record<ApprovalByUserKind, { zh: string; en: string }> = {
  pending: { zh: '当前待审批', en: 'Pending' },
  decided: { zh: '已审批', en: 'Decided' },
  involved: { zh: '参与过', en: 'Involved' },
}

/** What each kind means, shown under the switch so the admin knows what the list answers. */
export const USER_LOOKUP_KIND_HINTS: Record<ApprovalByUserKind, { zh: string; en: string }> = {
  pending: {
    zh: '此人当前持有待办席位的审批（与批量转交载入的待办一致）。',
    en: 'Approvals in which this person currently holds a pending seat (the same set batch transfer loads).',
  },
  decided: {
    zh: '此人做过同意、拒绝、退回或办理提交的审批，不论当前状态。',
    en: 'Approvals this person approved, rejected, returned or submitted as handler, whatever their current status.',
  },
  involved: {
    zh: '此人发起、审批、办理或被抄送过的审批。只按个人统计，经角色分派且未处理过的不计入。',
    en: 'Approvals this person submitted, acted on, handled or was copied on. Counted per person; role-only assignments never acted on are not included.',
  },
}

export function userLookupKindLabel(kind: ApprovalByUserKind, isZh: boolean): string {
  const entry = USER_LOOKUP_KIND_LABELS[kind]
  return isZh ? entry.zh : entry.en
}

export function userLookupKindHint(kind: ApprovalByUserKind, isZh: boolean): string {
  const entry = USER_LOOKUP_KIND_HINTS[kind]
  return isZh ? entry.zh : entry.en
}

/**
 * Values-free row label, the 批量转交 convention: title, then request number, then a per-page
 * ordinal — never the raw instance id.
 */
export function userLookupRowLabel(row: Pick<ApprovalByUserRow, 'title' | 'requestNo'>, index: number, isZh: boolean): string {
  const title = row.title?.trim()
  if (title) return title
  const requestNo = row.requestNo?.trim()
  if (requestNo) return requestNo
  return isZh ? `审批 ${index + 1}` : `Approval ${index + 1}`
}

/** At least one page, so "第 1 / 1 页" renders even for an empty result. */
export function userLookupTotalPages(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(pageSize) || pageSize <= 0) return 1
  return Math.ceil(total / pageSize)
}

export function userLookupEmptyText(kind: ApprovalByUserKind, isZh: boolean): string {
  if (kind === 'pending') return isZh ? '此人当前没有待审批的单据。' : 'This person has nothing pending.'
  if (kind === 'decided') return isZh ? '没有此人做过审批决定的单据。' : 'This person has not decided any approval.'
  return isZh ? '没有此人参与过的单据。' : 'This person is not involved in any approval.'
}
