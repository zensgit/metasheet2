import { describe, expect, it } from 'vitest'
import { isApprovalCanvasV2Enabled } from '../../src/services/approval-canvas-flag'

describe('approval Canvas V2 feature flag', () => {
  it.each([
    [{}, false],
    [{ APPROVAL_CANVAS_V2_ENABLED: '' }, false],
    [{ APPROVAL_CANVAS_V2_ENABLED: '1' }, false],
    [{ APPROVAL_CANVAS_V2_ENABLED: 'false' }, false],
    [{ APPROVAL_CANVAS_V2_ENABLED: ' true ' }, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: 'TRUE' }, true],
  ] as const)('is explicit and defaults off', (env, expected) => {
    expect(isApprovalCanvasV2Enabled(env as NodeJS.ProcessEnv)).toBe(expected)
  })
})
