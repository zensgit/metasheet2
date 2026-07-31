import { describe, expect, it } from 'vitest'

import { previewTemplateRoute, templateRoutePreviewPath } from '../src/approvals/api'

// RP-3 (route-preview lock, B3-06) — coverage for the authoring-side dry-run API wrapper.
//
// `previewTemplateRoute` itself defaults to mock mode while DEV is true under this project's
// Vitest run (see `approvalApiErrorSurfacing.spec.ts`). This static import does not set the
// explicit false override, so calling it here exercises the mock branch. The templateId
// URL-encoding is therefore split into `templateRoutePreviewPath`, a pure helper independently
// testable for the path-building / `encodeURIComponent` behavior the real branch depends on.

describe('previewTemplateRoute (mock branch — USE_MOCK is always on under Vitest)', () => {
  it('resolves the honest empty-route shape regardless of the sample payload', async () => {
    await expect(
      previewTemplateRoute('tpl_1', { sampleFormData: { amount: 8000 } }),
    ).resolves.toEqual({ route: [], truncated: false })
  })

  it('resolves the same shape when a sampleRequesterId is supplied', async () => {
    await expect(
      previewTemplateRoute('tpl_1', { sampleFormData: {}, sampleRequesterId: 'user_42' }),
    ).resolves.toEqual({ route: [], truncated: false })
  })

  it('resolves the same shape for an empty sampleFormData', async () => {
    await expect(previewTemplateRoute('tpl_1', { sampleFormData: {} })).resolves.toEqual({
      route: [],
      truncated: false,
    })
  })
})

describe('templateRoutePreviewPath', () => {
  it('builds the route-preview path for a plain templateId', () => {
    expect(templateRoutePreviewPath('tpl_1')).toBe('/api/approval-templates/tpl_1/route-preview')
  })

  it('percent-encodes a templateId containing a path-breaking slash', () => {
    expect(templateRoutePreviewPath('tpl/evil')).toBe('/api/approval-templates/tpl%2Fevil/route-preview')
  })

  it('percent-encodes a templateId containing a query-breaking ampersand/space', () => {
    expect(templateRoutePreviewPath('tpl 1&x=2')).toBe('/api/approval-templates/tpl%201%26x%3D2/route-preview')
  })

  it('percent-encodes non-ASCII characters', () => {
    expect(templateRoutePreviewPath('模板1')).toBe(`/api/approval-templates/${encodeURIComponent('模板1')}/route-preview`)
  })
})
