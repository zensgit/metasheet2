import { describe, expectTypeOf, it } from 'vitest'

import type { components, paths } from '../index.js'

describe('approval OpenAPI paths', () => {
  it('exposes the live inbox and action routes in generated SDK types', () => {
    expectTypeOf<paths['/api/approvals']>().toBeObject()
    expectTypeOf<paths['/api/approvals/pending']>().toBeObject()
    expectTypeOf<paths['/api/approvals/pending-count']>().toBeObject()
    expectTypeOf<paths['/api/approvals/sync/plm']>().toBeObject()
    expectTypeOf<paths['/api/approvals/{id}/actions']>().toBeObject()
    expectTypeOf<paths['/api/approvals/{id}/mark-read']>().toBeObject()
    expectTypeOf<paths['/api/approvals/mark-all-read']>().toBeObject()
    expectTypeOf<paths['/api/approvals/{id}/remind']>().toBeObject()
    expectTypeOf<paths['/api/approvals/metrics/report']>().toBeObject()

    expectTypeOf<
      paths['/api/approvals']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['ApprovalListResponse']>()
    expectTypeOf<
      paths['/api/approvals/pending']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['LegacyPendingApprovalListResponse']>()
    expectTypeOf<
      paths['/api/approvals/pending-count']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['ApprovalPendingCountResponse']>()
    expectTypeOf<
      paths['/api/approvals/{id}/mark-read']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['MarkApprovalReadResponse']>()
    expectTypeOf<
      paths['/api/approvals/mark-all-read']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['MarkAllApprovalsReadResponse']>()
    expectTypeOf<
      paths['/api/approvals/{id}/remind']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['RemindApprovalResponse']>()
    expectTypeOf<
      paths['/api/approvals/sync/plm']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['ApprovalPlmSyncResponse']>()
  })

  it('matches the direct-response template and approval detail contracts', () => {
    expectTypeOf<
      paths['/api/approvals/{id}']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['UnifiedApprovalDTO']>()
    expectTypeOf<
      paths['/api/approvals']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['UnifiedApprovalDTO']>()
    expectTypeOf<
      paths['/api/approval-templates']['post']['responses']['201']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['ApprovalTemplateDetail']>()
    expectTypeOf<
      paths['/api/approval-templates/{id}']['get']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['ApprovalTemplateDetail']>()
    expectTypeOf<
      paths['/api/approval-templates/{id}/publish']['post']['responses']['200']['content']['application/json']
    >().toEqualTypeOf<components['schemas']['ApprovalTemplateVersionDetail']>()
    expectTypeOf<
      components['schemas']['FormField']
    >().toMatchTypeOf<{ visibilityRule?: components['schemas']['FormFieldVisibilityRule'] }>()
    expectTypeOf<
      components['schemas']['FormFieldVisibilityRule']['operator']
    >().toEqualTypeOf<'eq' | 'neq' | 'in' | 'isEmpty' | 'notEmpty'>()
  })
})
