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
