/**
 * B3-08 (模板治理 — 停用确认文案): 纯函数，独立于 ElMessageBox 之外，便于单测钉死措辞而不必
 * 挂载整个视图。镜像既有的两个 precedent：
 *   - DelegationSettingsView.disable() 的「停用后…不受影响」句式（B2-05）。
 *   - automationDeleteRuleConfirmMessage 的「命名对象 + 用量/blast-radius 数字 + 结果说明」结构
 *     （apps/web/src/multitable/utils/meta-automation-labels.ts）。
 *
 * 用量数字来自 GET /api/approval-templates/:id/usage（ApprovalTemplateUsageDTO）。`usage` 为
 * `undefined` 时（例如用量查询失败，best-effort 不阻塞停用流程）省略数字行，只保留「不受影响」
 * 的定性说明 —— 宁可缺一行数字，也不能让用量查询失败卡住整个停用动作。
 */
import type { ApprovalTemplateUsageDTO } from '../types/approval'

export function templateArchiveConfirmMessage(
  name: string,
  usage: ApprovalTemplateUsageDTO | undefined,
): string {
  const usageLine = usage
    ? `该模板下有 ${usage.activeInstanceCount} 个进行中的审批（历史累计 ${usage.instanceCount} 个）。`
    : ''
  return `确定停用模板「${name}」？停用后该模板将无法再发起新的审批。${usageLine}已在进行中的审批不受影响，会按原流程继续走完。`
}

export function templateUnarchiveConfirmMessage(name: string): string {
  return `确定启用模板「${name}」？启用后该模板可以重新发起审批。`
}
