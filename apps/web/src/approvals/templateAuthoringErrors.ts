import { ApprovalApiError } from './api'

const AUTHORING_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT: '多个并行分支的审批人可能重复，请调整审批人配置后重试',
  APPROVAL_CONDITION_BRANCH_RULES_EMPTY: '条件分支必须配置条件，默认分支请使用“其他情况”',
  APPROVAL_CONDITION_FORMULA_STATIC: '条件公式必须引用表单或发起人数据',
  APPROVAL_CONDITION_FORMULA_ALWAYS_TRUE: '条件公式会匹配所有有效申请，请改用“其他情况”分支',
}

/**
 * Authoring writes never echo arbitrary backend messages. Known machine codes
 * get actionable copy; everything else stays values-free and identifier-free.
 */
export function describeTemplateAuthoringError(error: unknown, fallback: string): string {
  if (!(error instanceof ApprovalApiError)) return fallback
  return (error.code && AUTHORING_ERROR_MESSAGES[error.code]) || fallback
}
