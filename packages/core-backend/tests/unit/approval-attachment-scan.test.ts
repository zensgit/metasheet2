/**
 * §6 scan seam — flag-gated, fail-closed when ON without a real scanner.
 *
 * Behavior guards only: if the missing-scanner path is ever replaced with a default `clean`,
 * the "flag ON without injected scanner" case below goes red. Injected positive control proves
 * a real scanner can still return clean.
 */
import { describe, expect, test } from 'vitest'

import {
  APPROVAL_ATTACHMENT_SCANNER_MISSING_MESSAGE,
  assertApprovalAttachmentScannerConfigured,
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

const SCAN_ON = { APPROVAL_ATTACHMENT_SCAN_ENABLED: 'true' } as NodeJS.ProcessEnv
const SCAN_OFF = {} as NodeJS.ProcessEnv

describe('approval attachment scan seam (§6)', () => {
  test('flag OFF (default): scan is a no-op pass-through → unscanned; hook is never invoked', async () => {
    expect(isApprovalAttachmentScanEnabled(SCAN_OFF)).toBe(false)
    let called = 0
    const state = await runApprovalAttachmentScan(input, {
      env: SCAN_OFF,
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

  test('flag ON without injected scanner: fail-closed to infected (NEVER clean by default)', async () => {
    // Discriminating mutation canary: replacing the missing-scanner refusal with `clean` reds this test.
    expect(await runApprovalAttachmentScan(input, { env: SCAN_ON })).toBe('infected')
    expect(await runApprovalAttachmentScan(input, { env: SCAN_ON, scanHook: undefined })).toBe('infected')
    // Explicitly NOT clean — the historical bug marked unscanned bytes clean when the flag was ON.
    expect(await runApprovalAttachmentScan(input, { env: SCAN_ON })).not.toBe('clean')
    expect(await runApprovalAttachmentScan(input, { env: SCAN_ON })).not.toBe('unscanned')
  })

  test('flag ON + injected scanner (positive control): clean|infected is persisted; unknown/throw fail-closed', async () => {
    expect(await runApprovalAttachmentScan(input, { env: SCAN_ON, scanHook: async () => 'clean' })).toBe('clean')
    expect(await runApprovalAttachmentScan(input, { env: SCAN_ON, scanHook: async () => 'infected' })).toBe('infected')
    expect(
      await runApprovalAttachmentScan(input, {
        env: SCAN_ON,
        scanHook: async () => 'weird' as 'clean',
      }),
    ).toBe('infected')
    expect(
      await runApprovalAttachmentScan(input, {
        env: SCAN_ON,
        scanHook: async () => {
          throw new Error('scanner exploded with secret path=/tmp/malware.pdf creds=AKIASECRET')
        },
      }),
    ).toBe('infected')
  })

  test('startup assert: flag OFF is dormant; flag ON without scanner refuses with values-free message', () => {
    expect(() => assertApprovalAttachmentScannerConfigured(SCAN_OFF)).not.toThrow()
    expect(() => assertApprovalAttachmentScannerConfigured(SCAN_OFF, undefined)).not.toThrow()
    expect(() => assertApprovalAttachmentScannerConfigured(SCAN_ON)).toThrow(APPROVAL_ATTACHMENT_SCANNER_MISSING_MESSAGE)
    expect(() => assertApprovalAttachmentScannerConfigured(SCAN_ON, undefined)).toThrow(
      APPROVAL_ATTACHMENT_SCANNER_MISSING_MESSAGE,
    )
    // Positive control: a real function satisfies the startup assert.
    expect(() => assertApprovalAttachmentScannerConfigured(SCAN_ON, async () => 'clean')).not.toThrow()
    // Values-free: the fixed message carries no secrets, paths, or file names.
    try {
      assertApprovalAttachmentScannerConfigured(SCAN_ON)
      expect.unreachable('expected throw')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).toBe(APPROVAL_ATTACHMENT_SCANNER_MISSING_MESSAGE)
      expect(msg).not.toMatch(/\/tmp|AKIA|secret|malware|\.pdf/i)
    }
  })
})
