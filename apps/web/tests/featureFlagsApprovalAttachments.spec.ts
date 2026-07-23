import { describe, expect, it } from 'vitest'
import { extractFeaturesFromPayload } from '../src/stores/featureFlags'

describe('approval attachment feature flag parsing', () => {
  it.each([
    [{ data: { user: { features: { approvalAttachments: true } } } }, true],
    [{ data: { user: { features: { approval_attachments: true } } } }, true],
    [{ data: { user: { features: { approvalAttachments: false, approval_attachments: true } } } }, false],
    [{ data: { user: { features: { approvalAttachments: 'true' } } } }, undefined],
  ])('parses only an explicit boolean from supported payload keys', (payload, expected) => {
    expect(extractFeaturesFromPayload(payload).approvalAttachments).toBe(expected)
  })
})

describe('approval Canvas V2 feature flag parsing', () => {
  it.each([
    [{ data: { user: { features: { approvalCanvasV2: true } } } }, true],
    [{ data: { user: { features: { approval_canvas_v2: true } } } }, true],
    [{ data: { user: { features: { approvalCanvasV2: false, approval_canvas_v2: true } } } }, false],
    [{ data: { user: { features: { approvalCanvasV2: 'true' } } } }, undefined],
    [{ data: { user: { features: {} } } }, undefined],
  ])('parses only an explicit boolean from supported payload keys', (payload, expected) => {
    expect(extractFeaturesFromPayload(payload).approvalCanvasV2).toBe(expected)
  })
})
