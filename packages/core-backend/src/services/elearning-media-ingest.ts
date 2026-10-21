/**
 * One-shot elearning media ingest.
 * Order: reserve (uploading) → CAS probing → probe → store.put (valid probe only) → CAS ready.
 * Probe rejection returns rejected only after probing→rejected CAS succeeds; never stores.
 * Store failure must delete; delete resolve then CAS rejected; delete throw leaves probing.
 * Ready CAS miss after put must delete before 500. Delete resolve then best-effort probing→rejected
 * so quota is released while the row is still probing. Delete throw still 500 and does not reject
 * a possibly-present blob (later stale/rejected reconciliation recovers). Every CAS miss or DB
 * error returns 500. Never reject a row whose object may still be present.
 */
import { createHash, randomUUID } from 'node:crypto'

import {
  probeElearningMediaBuffer,
  type ProbeElearningMediaBufferDeps,
} from './elearning-media-probe'
import {
  ElearningMediaQuotaError,
  reserveElearningMediaQuotaAndInsert,
  updateElearningMediaStatus,
  type ElearningMediaDb,
  type ElearningMediaStatus,
} from './elearning-media-quota'
import { deriveElearningMediaStorageKey, type ElearningMediaStore } from './elearning-media-storage'
import {
  ELEARNING_MEDIA_MIME,
  validateElearningMediaUpload,
  type ElearningMediaRejectCode,
} from './elearning-media-validation'

export interface ElearningMediaMetadata {
  id: string
  status: 'ready' | 'rejected'
  durationMs: number | null
  sizeBytes: number
  sha256: string
}

export class ElearningMediaIngestError extends Error {
  constructor(
    readonly httpStatus: 400 | 413 | 415 | 500,
    readonly body: { error: string; rejected?: Array<{ code: ElearningMediaRejectCode }> },
  ) {
    super(body.error)
    this.name = 'ElearningMediaIngestError'
  }
}

export interface IngestElearningMediaInput {
  db: ElearningMediaDb
  store: ElearningMediaStore
  orgId: string
  createdBy: string
  fileName: string
  mimeType: string
  sizeBytes: number
  content: Buffer
  maxObjectBytes: number
  orgQuotaBytes: number
  probe?: ProbeElearningMediaBufferDeps
  now?: () => Date
}

function internalError(): never {
  throw new ElearningMediaIngestError(500, { error: 'internal_error' })
}

async function casStatus(
  db: ElearningMediaDb,
  orgId: string,
  id: string,
  fromStatus: ElearningMediaStatus,
  toStatus: ElearningMediaStatus,
  durationMs: number | null,
): Promise<boolean> {
  try {
    return await updateElearningMediaStatus(db, {
      orgId,
      id,
      fromStatus,
      toStatus,
      durationMs,
    })
  } catch {
    return false
  }
}

export async function ingestElearningMediaUpload(
  input: IngestElearningMediaInput,
): Promise<ElearningMediaMetadata> {
  const verdict = validateElearningMediaUpload(
    {
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      content: input.content,
    },
    input.maxObjectBytes,
  )
  if (verdict.ok === false) {
    throw new ElearningMediaIngestError(httpStatusForRejects(verdict.rejected), {
      error: 'rejected',
      rejected: verdict.rejected,
    })
  }

  const sha256 = createHash('sha256').update(input.content).digest('hex')
  const id = randomUUID()
  const storageKey = deriveElearningMediaStorageKey(input.now)
  try {
    await reserveElearningMediaQuotaAndInsert(
      input.db,
      {
        id,
        orgId: input.orgId,
        storageKey,
        mimeType: ELEARNING_MEDIA_MIME,
        magicMimeType: verdict.magicMimeType,
        sizeBytes: input.sizeBytes,
        sha256,
        createdBy: input.createdBy,
      },
      input.orgQuotaBytes,
    )
  } catch (error) {
    if (error instanceof ElearningMediaQuotaError) {
      throw new ElearningMediaIngestError(413, {
        error: 'rejected',
        rejected: [{ code: 'org_quota_exceeded' }],
      })
    }
    throw new ElearningMediaIngestError(500, { error: 'internal_error' })
  }

  const probing = await casStatus(input.db, input.orgId, id, 'uploading', 'probing', null)
  if (!probing) internalError()

  const probe = await probeElearningMediaBuffer(input.content, input.probe)
  if (!probe.ok) {
    const rejected = await casStatus(input.db, input.orgId, id, 'probing', 'rejected', null)
    if (!rejected) internalError()
    return { id, status: 'rejected', durationMs: null, sizeBytes: input.sizeBytes, sha256 }
  }

  try {
    await input.store.put(storageKey, input.content, ELEARNING_MEDIA_MIME)
  } catch {
    try {
      await input.store.delete(storageKey)
    } catch {
      internalError()
    }
    await casStatus(input.db, input.orgId, id, 'probing', 'rejected', null)
    internalError()
  }

  const ready = await casStatus(input.db, input.orgId, id, 'probing', 'ready', probe.durationMs)
  if (!ready) {
    try {
      await input.store.delete(storageKey)
    } catch {
      internalError()
    }
    await casStatus(input.db, input.orgId, id, 'probing', 'rejected', null)
    internalError()
  }

  return {
    id,
    status: 'ready',
    durationMs: probe.durationMs,
    sizeBytes: input.sizeBytes,
    sha256,
  }
}

function httpStatusForRejects(
  rejected: Array<{ code: ElearningMediaRejectCode }>,
): 400 | 413 | 415 {
  if (rejected.some((entry) => entry.code === 'file_too_large' || entry.code === 'org_quota_exceeded')) {
    return 413
  }
  if (
    rejected.some((entry) =>
      entry.code === 'mime_not_allowed'
      || entry.code === 'extension_not_allowed'
      || entry.code === 'extension_mime_mismatch'
      || entry.code === 'content_mime_mismatch',
    )
  ) {
    return 415
  }
  return 400
}
