// Label table for ApprovalCardDecisionView (the DingTalk card's mobile decision page) — report
// item O-8, slice F8-1 (approval member-surface locale). Same convention as templateCenterLabels.ts
// / templateDetailLabels.ts (#5545): a flat `CARD_ZH` / `CARD_EN` pair (`EN: Record<keyof typeof
// ZH, string>` so vue-tsc enforces key parity), consumed as `computed(() => (isZh.value ? CARD_ZH :
// CARD_EN))` from the module-scope `useLocale()` singleton. Server-supplied messages (a card
// error's `message`) render as the server sent them.

export const CARD_ZH = {
  loginRequired: '需要登录后处理该审批待办。',
  loginWithDingTalk: '使用钉钉登录',
  titleFallback: '审批待办',
  requestNo: '编号：',
  node: '节点：',
  notRecipient: '此待办的受理人不是当前账号；提交将按服务端受理校验执行。',
  commentLabel: '处理意见',
  commentRequired: '（必填）',
  commentRequiredOnReject: '（驳回必填）',
  commentPlaceholder: '填写处理意见',
  approve: '同意',
  reject: '驳回',
  rejectHint: '驳回前请先填写处理意见。',
  approveHint: '此节点要求填写审批意见后才能同意。',
  staleClosed: '该审批已办结，无需处理。',
  staleUndelivered: '该卡片未成功投递，无法在此处理。',
  staleMoved: '该待办已流转（转办/新一轮），此卡片不再有效。',
  invalidLink: '链接无效：缺少必要参数。',
  linkExpired: '链接无效或已失效。',
  loadFailed: '加载失败，请稍后重试。',
  submitFailed: '提交失败，请重试。',
}

export const CARD_EN: Record<keyof typeof CARD_ZH, string> = {
  loginRequired: 'Sign in to handle this approval task.',
  loginWithDingTalk: 'Sign in with DingTalk',
  titleFallback: 'Approval task',
  requestNo: 'Request no.: ',
  node: 'Node: ',
  notRecipient: 'This task is not assigned to the current account; the server checks the assignee when you submit.',
  commentLabel: 'Comment',
  commentRequired: ' (required)',
  commentRequiredOnReject: ' (required to reject)',
  commentPlaceholder: 'Enter a comment',
  approve: 'Approve',
  reject: 'Reject',
  rejectHint: 'Enter a comment before rejecting.',
  approveHint: 'This node requires a comment before you can approve.',
  staleClosed: 'This approval has ended; nothing to handle.',
  staleUndelivered: 'This card was not delivered, so it cannot be handled here.',
  staleMoved: 'This task has moved on (transferred or a new round); this card is no longer valid.',
  invalidLink: 'Invalid link: required parameters are missing.',
  linkExpired: 'The link is invalid or has expired.',
  loadFailed: 'Loading failed. Please try again later.',
  submitFailed: 'Submitting failed. Please try again.',
}

/** Keys of the page's own error copy (kept as keys so a later locale switch re-renders them). */
export type CardOwnErrorKey = 'invalidLink' | 'linkExpired' | 'loadFailed' | 'submitFailed'
