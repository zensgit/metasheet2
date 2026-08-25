import { describe, expect, it } from 'vitest'
import { isApprovalCanvasV2Enabled } from '../../src/services/approval-canvas-flag'

describe('approval Canvas V2 feature flag', () => {
  it.each([
    [{}, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: '' }, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: '1' }, false],
    [{ APPROVAL_CANVAS_V2_ENABLED: 'invalid' }, false],
    [{ APPROVAL_CANVAS_V2_ENABLED: 'false' }, false],
    [{ APPROVAL_CANVAS_V2_ENABLED: ' true ' }, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: 'TRUE' }, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: ' FALSE ' }, false],
  ] as const)('defaults on and keeps an explicit false rollback', (env, expected) => {
    expect(isApprovalCanvasV2Enabled(env as NodeJS.ProcessEnv)).toBe(expected)
  })
})
