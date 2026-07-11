import { describe, expect, it } from 'vitest'

import { ApprovalApiError } from '../src/approvals/api'
import { describeRoutePreviewError } from '../src/approvals/routePreviewErrors'

// RP-3 (route-preview lock, B3-06) — matrix coverage for the wedge-guard machine-code → Chinese
// message mapping the FE 试运行面板 uses instead of a generic failure flash. Covers all 5 codes
// the shared preview substrate (assembleCreationContext) can throw when the sample requester
// can't be routed (2× 422 REQUIRED genuine-absence, 3× 503 UNRESOLVED transient-read-failure —
// see ApprovalProductService.ts:3447-3492), plus the honest fallbacks for anything else.

describe('describeRoutePreviewError', () => {
  it('APPROVAL_REQUESTER_DEPARTMENT_REQUIRED (422) → actionable 会被拒 message', () => {
    const error = new ApprovalApiError('missing dept', 422, 'APPROVAL_REQUESTER_DEPARTMENT_REQUIRED')
    expect(describeRoutePreviewError(error)).toBe(
      '此样例发起人缺少部门，真实提交会被拒绝。换一个样例发起人，或先补全其目录信息。',
    )
  })

  it('APPROVAL_REQUESTER_TITLE_REQUIRED (422) → actionable 会被拒 message', () => {
    const error = new ApprovalApiError('missing title', 422, 'APPROVAL_REQUESTER_TITLE_REQUIRED')
    expect(describeRoutePreviewError(error)).toBe(
      '此样例发起人缺少职位，真实提交会被拒绝。换一个样例发起人，或先补全其目录信息。',
    )
  })

  it('APPROVAL_REQUESTER_DEPARTMENT_UNRESOLVED (503) → retry message, not blamed on the sample requester', () => {
    const error = new ApprovalApiError('transient', 503, 'APPROVAL_REQUESTER_DEPARTMENT_UNRESOLVED')
    expect(describeRoutePreviewError(error)).toBe('未能读取此样例发起人的部门信息，请稍后重试。')
  })

  it('APPROVAL_REQUESTER_TITLE_UNRESOLVED (503) → retry message', () => {
    const error = new ApprovalApiError('transient', 503, 'APPROVAL_REQUESTER_TITLE_UNRESOLVED')
    expect(describeRoutePreviewError(error)).toBe('未能读取此样例发起人的职位信息，请稍后重试。')
  })

  it('APPROVAL_REQUESTER_ROLE_UNRESOLVED (503) → retry message', () => {
    const error = new ApprovalApiError('transient', 503, 'APPROVAL_REQUESTER_ROLE_UNRESOLVED')
    expect(describeRoutePreviewError(error)).toBe('未能读取此样例发起人的角色信息，请稍后重试。')
  })

  it('keys off error.code, NOT HTTP status — an unexpected status on a known code still maps', () => {
    const error = new ApprovalApiError('missing dept', 999, 'APPROVAL_REQUESTER_DEPARTMENT_REQUIRED')
    expect(describeRoutePreviewError(error)).toBe(
      '此样例发起人缺少部门，真实提交会被拒绝。换一个样例发起人，或先补全其目录信息。',
    )
  })

  it('an unknown ApprovalApiError code falls back to the server message verbatim (honest, no invented diagnosis)', () => {
    const error = new ApprovalApiError('模板不存在', 404, 'APPROVAL_TEMPLATE_NOT_FOUND')
    expect(describeRoutePreviewError(error)).toBe('模板不存在')
  })

  it('an ApprovalApiError with no code falls back to its message', () => {
    const error = new ApprovalApiError('权限不足', 403)
    expect(describeRoutePreviewError(error)).toBe('权限不足')
  })

  it('a plain Error (non-ApprovalApiError) falls back to its message', () => {
    expect(describeRoutePreviewError(new Error('network down'))).toBe('network down')
  })

  it('a non-Error thrown value falls back to the caller-supplied fallback', () => {
    expect(describeRoutePreviewError('boom', '试运行失败')).toBe('试运行失败')
  })

  it('a non-Error thrown value falls back to the default fallback when none supplied', () => {
    expect(describeRoutePreviewError(null)).toBe('试运行失败')
  })

  it('an Error with a blank message falls back rather than rendering whitespace', () => {
    expect(describeRoutePreviewError(new Error('   '), '试运行失败')).toBe('试运行失败')
  })
})
