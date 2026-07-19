import { describe, expect, test } from 'vitest'

import {
  defaultPassThroughScanHook,
  isScanStateBindable,
  isScanStateDownloadable,
  runScanHook,
  type ScanHook,
} from '../../src/services/approval-attachment-scan'

const input = {
  mimeType: 'application/pdf',
  sizeBytes: 4,
  content: Buffer.from('%PDF'),
  fileName: 'a.pdf',
}

describe('approval attachment scan seam (§6)', () => {
  test('default pass-through returns unscanned (bindable + downloadable)', async () => {
    expect(await defaultPassThroughScanHook(input)).toBe('unscanned')
    expect(isScanStateBindable('unscanned')).toBe(true)
    expect(isScanStateBindable('clean')).toBe(true)
    expect(isScanStateDownloadable('unscanned')).toBe(true)
  })

  test('infected is never bindable and never downloadable (positive control: clean is)', () => {
    expect(isScanStateBindable('infected')).toBe(false)
    expect(isScanStateDownloadable('infected')).toBe(false)
    expect(isScanStateBindable('clean')).toBe(true)
    expect(isScanStateDownloadable('clean')).toBe(true)
  })

  test('runScanHook: throw or unknown return fail-closed to infected', async () => {
    const boom: ScanHook = async () => {
      throw new Error('scanner crashed with secret AKIAXXXX')
    }
    expect(await runScanHook(boom, input)).toBe('infected')
    const weird: ScanHook = async () => 'maybe' as never
    expect(await runScanHook(weird, input)).toBe('infected')
  })
})
