/**
 * E-learning M1 upload validation: strict MP4 H.264/AAC gate (MIME + extension + ISO-BMFF ftyp).
 * Size caps come from deployment config; this module never invents a default quota.
 */

export const ELEARNING_MEDIA_MIME = 'video/mp4'
export const ELEARNING_MEDIA_EXTENSION = 'mp4'

/** ISO-BMFF `ftyp` box type at the canonical first-box offset. */
const FTYP = Buffer.from('ftyp')

export type ElearningMediaRejectCode =
  | 'file_too_large'
  | 'too_many_files'
  | 'mime_not_allowed'
  | 'extension_not_allowed'
  | 'extension_mime_mismatch'
  | 'content_mime_mismatch'
  | 'invalid_size'
  | 'org_quota_exceeded'

export interface ElearningMediaUploadCandidate {
  fileName: string
  mimeType: string
  sizeBytes: number
  content?: Buffer
}

export type ElearningMediaValidationResult =
  | { ok: true; magicMimeType: typeof ELEARNING_MEDIA_MIME }
  | { ok: false; rejected: Array<{ code: ElearningMediaRejectCode }> }

const CAP_CODES: ReadonlySet<ElearningMediaRejectCode> = new Set([
  'file_too_large',
  'too_many_files',
  'org_quota_exceeded',
])

const TYPE_CODES: ReadonlySet<ElearningMediaRejectCode> = new Set([
  'mime_not_allowed',
  'extension_not_allowed',
  'extension_mime_mismatch',
  'content_mime_mismatch',
])

export function httpStatusForElearningMediaRejects(
  rejected: ReadonlyArray<{ code: string }>,
): 400 | 413 | 415 {
  if (rejected.some((entry) => CAP_CODES.has(entry.code as ElearningMediaRejectCode))) return 413
  if (rejected.some((entry) => TYPE_CODES.has(entry.code as ElearningMediaRejectCode))) return 415
  return 400
}

function extOf(name: string): string {
  const i = String(name ?? '').lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** First-box ISO-BMFF ftyp magic. Declared MIME is not trusted. */
export function isIsoBmffFtyp(content: Buffer): boolean {
  if (!Buffer.isBuffer(content) || content.length < 8) return false
  return content.subarray(4, 8).equals(FTYP)
}

/**
 * Reject-by-default for a single one-shot upload. `maxObjectBytes` is the already-validated
 * positive integer from ELEARNING_MEDIA_MAX_OBJECT_BYTES — never a built-in default.
 */
export function validateElearningMediaUpload(
  file: ElearningMediaUploadCandidate,
  maxObjectBytes: number,
): ElearningMediaValidationResult {
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0) {
    throw new RangeError('maxObjectBytes must be a positive safe integer')
  }
  const rejected: Array<{ code: ElearningMediaRejectCode }> = []
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
    rejected.push({ code: 'invalid_size' })
  } else if (file.sizeBytes > maxObjectBytes) {
    rejected.push({ code: 'file_too_large' })
  } else if (file.content && file.sizeBytes !== file.content.length) {
    rejected.push({ code: 'invalid_size' })
  }
  const mime = (file.mimeType ?? '').toLowerCase().trim()
  const ext = extOf(file.fileName ?? '')
  if (mime !== ELEARNING_MEDIA_MIME) rejected.push({ code: 'mime_not_allowed' })
  else if (ext !== ELEARNING_MEDIA_EXTENSION) {
    rejected.push({ code: ext ? 'extension_mime_mismatch' : 'extension_not_allowed' })
  }
  if (file.content) {
    if (!isIsoBmffFtyp(file.content)) rejected.push({ code: 'content_mime_mismatch' })
  } else {
    rejected.push({ code: 'content_mime_mismatch' })
  }
  if (rejected.length > 0) return { ok: false, rejected }
  return { ok: true, magicMimeType: ELEARNING_MEDIA_MIME }
}

/** Positive safe integer from env. Missing/zero/float/lookalike → null (fail-closed, no default). */
export function readPositiveSafeInteger(
  env: NodeJS.ProcessEnv,
  key: string,
): number | null {
  const raw = env[key]
  if (typeof raw !== 'string') return null
  if (!/^[1-9][0-9]*$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) return null
  return value
}

export interface ElearningMediaQuotaConfig {
  maxObjectBytes: number
  orgQuotaBytes: number
}

export function readElearningMediaQuotaConfig(
  env: NodeJS.ProcessEnv = process.env,
): ElearningMediaQuotaConfig | null {
  const maxObjectBytes = readPositiveSafeInteger(env, 'ELEARNING_MEDIA_MAX_OBJECT_BYTES')
  const orgQuotaBytes = readPositiveSafeInteger(env, 'ELEARNING_MEDIA_ORG_QUOTA_BYTES')
  if (maxObjectBytes === null || orgQuotaBytes === null) return null
  return { maxObjectBytes, orgQuotaBytes }
}
