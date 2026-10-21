import { describe, expect, it } from 'vitest'

import {
  httpStatusForElearningMediaRejects,
  isIsoBmffFtyp,
  readElearningMediaQuotaConfig,
  readPositiveSafeInteger,
  validateElearningMediaUpload,
} from '../../src/services/elearning-media-validation'

const MAX = 10 * 1024 * 1024

function isoBmffFtypBuffer(extraBytes = 16): Buffer {
  const buf = Buffer.alloc(8 + extraBytes)
  buf.writeUInt32BE(buf.length, 0)
  buf.write('ftyp', 4)
  buf.write('isom', 8)
  return buf
}

const LOOKALIKES = ['', '0', '-1', '1.5', '1e3', 'true', ' 10', '10 ', '+10', 'NaN']

describe('elearning media validation', () => {
  it('accepts strict .mp4 + video/mp4 + ISO-BMFF ftyp', () => {
    const content = isoBmffFtypBuffer()
    expect(isIsoBmffFtyp(content)).toBe(true)
    expect(validateElearningMediaUpload({
      fileName: 'lesson.mp4',
      mimeType: 'video/mp4',
      sizeBytes: content.length,
      content,
    }, MAX)).toEqual({ ok: true, magicMimeType: 'video/mp4' })
  })

  it('rejects lookalike MIME, extension, and magic mismatches without echoing filenames', () => {
    const content = isoBmffFtypBuffer()
    const cases = [
      { fileName: 'lesson.mp4', mimeType: 'video/quicktime', code: 'mime_not_allowed' },
      { fileName: 'lesson.mp4', mimeType: 'application/octet-stream', code: 'mime_not_allowed' },
      { fileName: 'lesson.mov', mimeType: 'video/mp4', code: 'extension_mime_mismatch' },
      { fileName: 'lesson', mimeType: 'video/mp4', code: 'extension_not_allowed' },
      { fileName: 'lesson.MP4.exe', mimeType: 'video/mp4', code: 'extension_mime_mismatch' },
    ]
    for (const row of cases) {
      const result = validateElearningMediaUpload({
        ...row,
        sizeBytes: content.length,
        content,
      }, MAX)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.rejected.some((r) => r.code === row.code)).toBe(true)
        expect(JSON.stringify(result.rejected)).not.toContain(row.fileName)
      }
    }
    const notFtyp = Buffer.from('not-an-mp4-file-body')
    const magic = validateElearningMediaUpload({
      fileName: 'lesson.mp4',
      mimeType: 'video/mp4',
      sizeBytes: notFtyp.length,
      content: notFtyp,
    }, MAX)
    expect(magic.ok).toBe(false)
    if (!magic.ok) expect(magic.rejected.some((r) => r.code === 'content_mime_mismatch')).toBe(true)
  })

  it('rejects oversized and invalid sizes; maps cap rejects to 413 and type rejects to 415', () => {
    const content = isoBmffFtypBuffer()
    const tooBig = validateElearningMediaUpload({
      fileName: 'lesson.mp4',
      mimeType: 'video/mp4',
      sizeBytes: MAX + 1,
      content,
    }, MAX)
    expect(tooBig.ok).toBe(false)
    expect(httpStatusForElearningMediaRejects(tooBig.ok ? [] : tooBig.rejected)).toBe(413)
    const empty = validateElearningMediaUpload({
      fileName: 'lesson.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 0,
      content,
    }, MAX)
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.rejected.some((r) => r.code === 'invalid_size')).toBe(true)
    expect(httpStatusForElearningMediaRejects([{ code: 'invalid_size' }])).toBe(400)
    expect(httpStatusForElearningMediaRejects([{ code: 'mime_not_allowed' }])).toBe(415)
  })

  it('rejects a declared size that differs from content.length as invalid_size', () => {
    const content = isoBmffFtypBuffer()
    const bigger = validateElearningMediaUpload({
      fileName: 'lesson.mp4',
      mimeType: 'video/mp4',
      sizeBytes: content.length + 1,
      content,
    }, MAX)
    expect(bigger.ok).toBe(false)
    if (!bigger.ok) {
      expect(bigger.rejected).toEqual([{ code: 'invalid_size' }])
      expect(httpStatusForElearningMediaRejects(bigger.rejected)).toBe(400)
      expect(JSON.stringify(bigger.rejected)).not.toContain('lesson.mp4')
    }
    const smaller = validateElearningMediaUpload({
      fileName: 'lesson.mp4',
      mimeType: 'video/mp4',
      sizeBytes: content.length - 1,
      content,
    }, MAX)
    expect(smaller.ok).toBe(false)
    if (!smaller.ok) {
      expect(smaller.rejected).toEqual([{ code: 'invalid_size' }])
      expect(httpStatusForElearningMediaRejects(smaller.rejected)).toBe(400)
    }
  })

  it('quota config is exact positive integers with no defaults', () => {
    expect(readElearningMediaQuotaConfig({} as NodeJS.ProcessEnv)).toBeNull()
    expect(readElearningMediaQuotaConfig({
      ELEARNING_MEDIA_MAX_OBJECT_BYTES: '1048576',
    } as NodeJS.ProcessEnv)).toBeNull()
    expect(readElearningMediaQuotaConfig({
      ELEARNING_MEDIA_ORG_QUOTA_BYTES: '10485760',
    } as NodeJS.ProcessEnv)).toBeNull()
    for (const value of LOOKALIKES) {
      expect(readPositiveSafeInteger({ K: value } as NodeJS.ProcessEnv, 'K')).toBeNull()
    }
    expect(readElearningMediaQuotaConfig({
      ELEARNING_MEDIA_MAX_OBJECT_BYTES: '1048576',
      ELEARNING_MEDIA_ORG_QUOTA_BYTES: '10485760',
    } as NodeJS.ProcessEnv)).toEqual({ maxObjectBytes: 1_048_576, orgQuotaBytes: 10_485_760 })
  })
})
