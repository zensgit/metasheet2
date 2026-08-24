import { describe, expect, it } from 'vitest'
import { isApprovalCanvasV2Enabled } from '../../src/services/approval-canvas-flag'

describe('approval Canvas V2 feature flag', () => {
  // Rollout posture flipped 2026-08-24 (owner: 「默认就画布」). The canvas is the default authoring
  // surface; `false` is the explicit escape hatch back to the structured editor. The prior table
  // pinned the opposite default — it is replaced, not extended, so a silent regression to
  // default-off reds here rather than passing under a widened matrix.
  it.each([
    [{}, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: '' }, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: 'true' }, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: 'TRUE' }, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: ' true ' }, true],
    // Anything that is not the literal opt-out keeps the default surface — matching the repo's
    // established default-on convention (`!== 'false'`), which treats only `false` as a disable.
    [{ APPROVAL_CANVAS_V2_ENABLED: '1' }, true],
    [{ APPROVAL_CANVAS_V2_ENABLED: '0' }, true],
    // The explicit opt-out, case- and whitespace-insensitive.
    [{ APPROVAL_CANVAS_V2_ENABLED: 'false' }, false],
    [{ APPROVAL_CANVAS_V2_ENABLED: 'FALSE' }, false],
    [{ APPROVAL_CANVAS_V2_ENABLED: ' false ' }, false],
  ] as const)('defaults ON and honours the explicit false opt-out', (env, expected) => {
    expect(isApprovalCanvasV2Enabled(env as NodeJS.ProcessEnv)).toBe(expected)
  })
})
