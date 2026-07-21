/** §6 scan seam — flag-gated default no-op; only ratified states. */
import { describe, expect, test } from 'vitest'

import {
  isApprovalAttachmentScanEnabled,
  isInfectedScanState,
  runApprovalAttachmentScan,
} from '../../src/services/approval-attachment-scan'

const input = {
  fileName: 'a.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 4,
  content: Buffer.from('%PDF'),
}

describe('approval attachment scan seam (§6)', () => {
  test('flag OFF (default): scan is a no-op pass-through → unscanned; hook is never invoked', async () => {
    expect(isApprovalAttachmentScanEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    let called = 0
    const state = await runApprovalAttachmentScan(input, {
      env: {} as NodeJS.ProcessEnv,
      scanHook: async () => {
        called += 1
        return 'infected'
      },
    })
    expect(state).toBe('unscanned')
    expect(called).toBe(0)
    expect(isInfectedScanState('unscanned')).toBe(false)
    expect(isInfectedScanState('clean')).toBe(false)
    expect(isInfectedScanState('infected')).toBe(true)
  })

  test('flag ON: hook result clean|infected is persisted; unknown/throw fail-closed to infected', async () => {
    const env = { APPROVAL_ATTACHMENT_SCAN_ENABLED: 'true' } as NodeJS.ProcessEnv
    expect(await runApprovalAttachmentScan(input, { env, scanHook: async () => 'clean' })).toBe('clean')
    expect(await runApprovalAttachmentScan(input, { env, scanHook: async () => 'infected' })).toBe('infected')
    expect(
      await runApprovalAttachmentScan(input, {
        env,
        scanHook: async () => 'weird' as 'clean',
      }),
    ).toBe('infected')
    expect(
      await runApprovalAttachmentScan(input, {
        env,
        scanHook: async () => {
          throw new Error('scanner exploded with secret')
        },
      }),
    ).toBe('infected')
  })
})
