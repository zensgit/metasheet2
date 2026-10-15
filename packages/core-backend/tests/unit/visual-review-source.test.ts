import { describe, expect, it } from 'vitest'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { assertVisualReviewSourceScope, visualReviewSourceConfigured } from '../../src/auth/visual-review-source'

function source(options: Record<string, unknown> = {}, type = 'plm'): DataSourceConfig {
  return {
    id: 'visual',
    name: 'Visual',
    type,
    connection: { url: 'https://provider.example' },
    options,
  }
}

describe('visual review source scope', () => {
  it('stays off unless a PLM source is exactly enabled for its own tenant', () => {
    expect(visualReviewSourceConfigured(source())).toBe(false)
    expect(visualReviewSourceConfigured(source({ tenantId: 'tenant-visual', visualReviewEnabled: false }))).toBe(false)
    expect(visualReviewSourceConfigured(source({ tenantId: 'tenant-visual', visualReviewEnabled: 'true' }))).toBe(false)
    expect(visualReviewSourceConfigured(source({ tenantId: 'tenant-visual', visualReviewEnabled: true }, 'http'))).toBe(false)
    expect(visualReviewSourceConfigured(source({ tenantId: '', visualReviewEnabled: true }))).toBe(false)
    expect(visualReviewSourceConfigured(source({ tenantId: ' tenant-visual', visualReviewEnabled: true }))).toBe(false)
    expect(visualReviewSourceConfigured(source({ tenantId: 't'.repeat(129), visualReviewEnabled: true }))).toBe(false)
    expect(visualReviewSourceConfigured(source({ tenantId: 'tenant-visual', visualReviewEnabled: true }))).toBe(true)
    expect(visualReviewSourceConfigured(source({ tenantId: 'tenant-visual', visualReviewEnabled: true }), 'other')).toBe(false)
    expect(visualReviewSourceConfigured(source({ tenantId: 'tenant-visual', visualReviewEnabled: true }), 'tenant-visual')).toBe(true)
  })

  it('rejects an enabled source that is not bound to the stored tenant', () => {
    const enabled = source({ tenantId: 'tenant-visual', visualReviewEnabled: true })
    expect(() => assertVisualReviewSourceScope(enabled, 'tenant-visual')).not.toThrow()
    expect(() => assertVisualReviewSourceScope(source(), 'tenant-visual')).not.toThrow()
    expect(() => assertVisualReviewSourceScope(source({ visualReviewEnabled: false, tenantId: 'other' }), null)).not.toThrow()
    for (const [config, tenantId] of [
      [source({ visualReviewEnabled: true, tenantId: 'other' }), 'tenant-visual'],
      [source({ visualReviewEnabled: true, tenantId: '' }), 'tenant-visual'],
      [source({ visualReviewEnabled: 'true', tenantId: 'tenant-visual' }), 'tenant-visual'],
      [enabled, null],
      [enabled, ''],
    ] as const) {
      expect(() => assertVisualReviewSourceScope(config, tenantId)).toThrowError(
        expect.objectContaining({ status: 400, code: 'VISUAL_REVIEW_SOURCE_SCOPE_INVALID' }),
      )
    }
  })
})
