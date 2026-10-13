import { describe, expect, it } from 'vitest'

import { ApprovalApiError } from '../src/approvals/api'
import {
  describeRoutePreviewError,
  ROUTE_PREVIEW_REQUIRED_COPY_EN,
  ROUTE_PREVIEW_REQUIRED_COPY_ZH,
  routePreviewMissingRequiredFieldIds,
} from '../src/approvals/routePreviewErrors'
import { NEW_EN, NEW_ZH } from '../src/views/approval/approvalNewLabels'

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

// R-43 follow-up (a) — the server validates the try-run sample against the WHOLE form; a visible
// required field left empty fails with 400 VALIDATION_ERROR "Approval form data is invalid" and
// `details.errors: ['<fieldId> is required', ...]`. Only that shape gets the localized hint (field
// NAMES only — never a value, never a raw id); every other failure keeps its current text.
describe('describeRoutePreviewError — missing required sample fields (follow-up (a))', () => {
  const SERVER_MESSAGE = 'Approval form data is invalid'
  const validation = (errors: unknown) =>
    new ApprovalApiError(SERVER_MESSAGE, 400, 'VALIDATION_ERROR', { errors } as Record<string, unknown>)
  const labels: Record<string, string> = { remark_field: '备注', items: '明细' }
  const fieldLabel = (id: string) => labels[id] ?? null
  const zh = ROUTE_PREVIEW_REQUIRED_COPY_ZH
  const en = ROUTE_PREVIEW_REQUIRED_COPY_EN

  it('R1: names the empty required field in Chinese (default) and English, without the server text or the raw id', () => {
    const error = validation(['remark_field is required'])
    const zhText = describeRoutePreviewError(error, undefined, { fieldLabel })
    expect(zhText).toBe(`${zh.withNames('「备注」')}${zh.cannotFillHint}`)
    expect(describeRoutePreviewError(error, undefined, { fieldLabel, isZh: true })).toBe(zhText)
    const enText = describeRoutePreviewError(error, undefined, { fieldLabel, isZh: false })
    expect(enText).toBe(`${en.withNames('"备注"')} ${en.cannotFillHint}`)
    for (const text of [zhText, enText]) {
      expect(text).not.toContain(SERVER_MESSAGE)
      expect(text).not.toContain('remark_field')
    }
  })

  it('R2: detail cells collapse to the detail field (deduplicated, first occurrence first)', () => {
    const error = validation(['items[0].qty is required', 'items[1].qty is required', 'remark_field is required'])
    expect(routePreviewMissingRequiredFieldIds(error)).toEqual(['items', 'remark_field'])
    expect(describeRoutePreviewError(error, undefined, { fieldLabel })).toBe(
      `${zh.withNames('「明细」、「备注」')}${zh.cannotFillHint}`,
    )
    expect(describeRoutePreviewError(error, undefined, { fieldLabel, isZh: false })).toBe(
      `${en.withNames('"明细", "备注"')} ${en.cannotFillHint}`,
    )
  })

  it('R3: an unknown / blank name is left out — the raw id is never shown', () => {
    const error = validation(['remark_field is required'])
    for (const resolver of [() => null, () => '', () => '   ', undefined]) {
      const text = describeRoutePreviewError(error, undefined, { fieldLabel: resolver })
      expect(text).toBe(`${zh.withoutNames}${zh.cannotFillHint}`)
      expect(text).not.toContain('remark_field')
    }
    expect(describeRoutePreviewError(validation(['remark_field is required', 'ghost_field is required']), undefined, { fieldLabel }))
      .toBe(`${zh.withNames('「备注」')}${zh.cannotFillHint}`)
  })

  it('R4: a mix of missing-required and other entries gets the required-field hint', () => {
    const error = validation(['remark_field is required', 'amount must be a number'])
    expect(describeRoutePreviewError(error, undefined, { fieldLabel })).toBe(`${zh.withNames('「备注」')}${zh.cannotFillHint}`)
  })

  it('R5: other validation failures keep the server message (no details / errors not a list / no required entry)', () => {
    expect(describeRoutePreviewError(new ApprovalApiError(SERVER_MESSAGE, 400, 'VALIDATION_ERROR'), undefined, { fieldLabel })).toBe(SERVER_MESSAGE)
    expect(describeRoutePreviewError(new ApprovalApiError(SERVER_MESSAGE, 400, 'VALIDATION_ERROR', {}), undefined, { fieldLabel })).toBe(SERVER_MESSAGE)
    expect(describeRoutePreviewError(validation('remark_field is required'), undefined, { fieldLabel })).toBe(SERVER_MESSAGE)
    expect(describeRoutePreviewError(validation(['amount must be a number']), undefined, { fieldLabel })).toBe(SERVER_MESSAGE)
    expect(describeRoutePreviewError(validation([]), undefined, { fieldLabel })).toBe(SERVER_MESSAGE)
  })

  it("R6: the route's own missing-body 400 keeps its message", () => {
    const error = new ApprovalApiError('templateId (path) and sampleFormData are required', 400, 'VALIDATION_ERROR')
    expect(describeRoutePreviewError(error, undefined, { fieldLabel })).toBe('templateId (path) and sampleFormData are required')
  })

  it('R7: a required entry under another code keeps the message', () => {
    const error = new ApprovalApiError(SERVER_MESSAGE, 400, 'SOMETHING_ELSE', { errors: ['remark_field is required'] })
    expect(describeRoutePreviewError(error, undefined, { fieldLabel })).toBe(SERVER_MESSAGE)
  })

  it('R8: a plain Error with the same text is not an ApprovalApiError and keeps its message', () => {
    expect(describeRoutePreviewError(new Error(SERVER_MESSAGE), undefined, { fieldLabel })).toBe(SERVER_MESSAGE)
  })

  it('R9: the wedge codes keep their Chinese copy even with options passed', () => {
    const error = new ApprovalApiError('missing dept', 422, 'APPROVAL_REQUESTER_DEPARTMENT_REQUIRED', { errors: ['remark_field is required'] })
    expect(describeRoutePreviewError(error, undefined, { fieldLabel, isZh: false })).toBe(
      '此样例发起人缺少部门，真实提交会被拒绝。换一个样例发起人，或先补全其目录信息。',
    )
  })

  it('R10: only string entries of the exact shape count', () => {
    // a nested array would stringify to a matching entry — it must still be ignored
    expect(routePreviewMissingRequiredFieldIds(validation([['ghost is required'], { id: 'x' }, 7, 'a b is required']))).toBeNull()
    expect(routePreviewMissingRequiredFieldIds(validation([['ghost is required'], 'remark_field is required']))).toEqual(['remark_field'])
    expect(routePreviewMissingRequiredFieldIds(validation(['remark_field is required.']))).toBeNull()
    expect(routePreviewMissingRequiredFieldIds(validation(['remark_field must be one of the options']))).toBeNull()
    expect(routePreviewMissingRequiredFieldIds(new Error(SERVER_MESSAGE))).toBeNull()
    expect(routePreviewMissingRequiredFieldIds(null)).toBeNull()
  })

  it('R11: copy — en has no CJK, both point at the submit-page preview by its exact label and say it needs publishing', () => {
    const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
    for (const [key, value] of Object.entries(en)) {
      const rendered = typeof value === 'function' ? value('x') : value
      expect(CJK.test(rendered), key).toBe(false)
    }
    expect(zh.cannotFillHint).toContain(`「${NEW_ZH.routePreview}」`)
    expect(en.cannotFillHint).toContain(`"${NEW_EN.routePreview}"`)
    expect(zh.cannotFillHint).toContain('发布')
    expect(en.cannotFillHint).toContain('publish')
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
