/** Test-only public-route witness for the owned local backup driver. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { hash } from 'bcryptjs'
import type { Pool } from 'pg'

import type { RecoveryArchiveRestoreJobQuery, RecoveryArchiveRestoreJobTransaction } from '../src/multitable/recovery-archive-restore-jobs'
import type { RecoveryArchivePreviewRuntime } from '../src/multitable/recovery-archive-preview'
import type { RecoveryArchiveTransactionDepthProbe } from '../src/multitable/recovery-archive-crypto'

const require = createRequire(import.meta.url)

interface Runtime {
  readonly query: RecoveryArchiveRestoreJobQuery
  readonly transaction: RecoveryArchiveRestoreJobTransaction
  readonly depth: RecoveryArchiveTransactionDepthProbe
  readonly nativePool: Pick<Pool, 'connect' | 'options'>
}

interface Identity {
  readonly sheetId: string
  readonly actorId: string
}

export async function createAndCaptureManualFixture(input: {
  readonly runtime: Runtime
  readonly archive: RecoveryArchivePreviewRuntime
  readonly workspaceId: string
  readonly prefix: string
  readonly attachmentPath: string
  readonly keyId: string
}): Promise<{
  readonly actorId: string
  readonly password: string
  readonly baseId: string
  readonly sheetId: string
  readonly fieldId: string
  readonly attachmentFieldId: string
  readonly attachmentId: string
  readonly recordId: string
  readonly recordIds: readonly string[]
  readonly attachmentBytes: Buffer
  readonly generationId: string
}> {
  const actorId = randomUUID()
  const password = randomBytes(24).toString('hex')
  const baseId = `${input.prefix}_manual_base`
  const sheetId = `${input.prefix}_manual_sheet`
  const fieldId = `${input.prefix}_manual_field`
  const attachmentFieldId = `${input.prefix}_manual_attachment_field`
  const attachmentId = `${input.prefix}_manual_attachment`
  const recordIds = Array.from({ length: 5001 }, (_, index) => `${input.prefix}_manual_record_${String(index).padStart(5, '0')}`)
  const recordId = recordIds[2500]
  const attachmentBytes = Buffer.from('synthetic-backup-attachment')
  await input.runtime.query(
    `INSERT INTO public.users
      (id, email, name, password_hash, role, permissions, is_active, activation_status,
       local_password_set, must_change_password)
     VALUES ($1, $2, 'Synthetic manual backup', $3, 'admin', $4::jsonb, true, 'activated', true, false)`,
    [actorId, `${actorId}@example.test`, await hash(password, 10),
      JSON.stringify(['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema'])],
  )
  await input.runtime.query(
    `INSERT INTO public.meta_bases (id, name, workspace_id, owner_id)
     VALUES ($1, 'Synthetic manual backup', $2, $3)`,
    [baseId, input.workspaceId, actorId],
  )
  await input.runtime.query(
    `INSERT INTO public.meta_sheets (id, base_id, name) VALUES ($1, $2, 'Synthetic manual backup')`,
    [sheetId, baseId],
  )
  await input.runtime.query(
    `INSERT INTO public.meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
     VALUES ($1, $2, 'active', 1)`, [`${input.prefix}_manual_trust`, sheetId],
  )
  await input.runtime.query(
    `INSERT INTO public.meta_fields (id, sheet_id, name, type, property, "order")
     VALUES ($1, $2, 'Synthetic manual value', 'string', '{}'::jsonb, 1)`,
    [fieldId, sheetId],
  )
  await input.runtime.query(
    `INSERT INTO public.meta_fields (id, sheet_id, name, type, property, "order")
     VALUES ($1, $2, 'Synthetic manual file', 'attachment', '{}'::jsonb, 2)`,
    [attachmentFieldId, sheetId],
  )
  const { LocalStorageProvider } = require('../src/services/StorageService.ts') as typeof import('../src/services/StorageService')
  const attachmentStore = new LocalStorageProvider(input.attachmentPath)
  const uploaded = await attachmentStore.uploadContentAddressed(attachmentBytes, {
    filename: 'synthetic.bin', contentType: 'application/octet-stream',
  })
  await input.runtime.query(
    `INSERT INTO public.multitable_attachments
      (id, sheet_id, storage_file_id, filename, mime_type, size, storage_path, storage_provider)
     VALUES ($1, $2, $3, 'synthetic.bin', 'application/octet-stream', $4, $5, 'local')`,
    [attachmentId, sheetId, `${input.prefix}_manual_file`, attachmentBytes.length, uploaded.path],
  )
  await input.runtime.query(
    `INSERT INTO public.meta_records (id, sheet_id, data, version, created_by, modified_by)
     SELECT id, $2, jsonb_build_object($3::text, 'captured', $4::text,
       CASE WHEN id=$7 THEN jsonb_build_array($5::text) ELSE '[]'::jsonb END), 1, $6, $6
       FROM unnest($1::text[]) AS fixture(id)`,
    [recordIds, sheetId, fieldId, attachmentFieldId, attachmentId, actorId, recordId],
  )
  await input.runtime.query(
    `UPDATE public.multitable_attachments SET record_id=$2, field_id=$3 WHERE id=$1`,
    [attachmentId, recordId, attachmentFieldId],
  )
  const generationId = await captureLocalManualArchive({
    runtime: input.runtime, archive: input.archive, identity: { sheetId, actorId }, keyId: input.keyId,
  })
  return { actorId, password, baseId, sheetId, fieldId, attachmentFieldId,
    attachmentId, recordId, recordIds, attachmentBytes, generationId }
}

export async function captureLocalManualArchive(input: {
  readonly runtime: Runtime
  readonly archive: RecoveryArchivePreviewRuntime
  readonly identity: Identity
  readonly keyId: string
}): Promise<string> {
  return withRoute(input, async (base, headers) => {
    const requestId = randomUUID()
    const url = `${base}/api/multitable/sheets/${encodeURIComponent(input.identity.sheetId)}/recovery-archive/captures`
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ requestId }) })
    if (response.status !== 200) {
      const failure = await response.clone().json().catch(() => ({})) as { error?: { code?: unknown } }
      const code = typeof failure.error?.code === 'string' && /^RECOVERY_[A-Z0-9_]+$/.test(failure.error.code)
        ? failure.error.code : 'RECOVERY_LOCAL_BACKUP_MANUAL_CAPTURE_FAILED'
      console.log(JSON.stringify({ phase: 'manual-capture', status: response.status, code }))
    }
    assert.equal(response.status, 200, 'RECOVERY_LOCAL_BACKUP_MANUAL_CAPTURE_FAILED')
    const body = await response.json() as { ok?: boolean; data?: { requestId?: string; generationId?: string; state?: string } }
    assert.equal(body.ok, true)
    assert.equal(body.data?.requestId, requestId)
    assert.equal(body.data?.state, 'recoverable')
    assert.match(body.data?.generationId ?? '', /^[a-f0-9-]{36}$/)
    const replay = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ requestId }) })
    assert.equal(replay.status, 200)
    assert.deepEqual(await replay.json(), body)
    return body.data!.generationId!
  })
}

interface ManualRestoreInput {
  readonly runtime: Pick<Runtime, 'query'>
  readonly identity: Identity
  readonly generationId: string
  readonly recordId: string
  readonly recordIds: readonly string[]
  readonly fieldId: string
  readonly attachmentFieldId: string
  readonly attachmentId: string
}

export async function restoreImportedManualArchiveOverHttp(
  input: ManualRestoreInput, base: string, headers: Record<string, string>,
): Promise<string> {
  const route = `${base}/api/multitable/sheets/${encodeURIComponent(input.identity.sheetId)}/recovery-archive`
  const response = await fetch(`${route}/catalog/${input.generationId}`, { headers })
  assert.equal(response.status, 200, 'RECOVERY_LOCAL_BACKUP_IMPORTED_MANUAL_CATALOG_FAILED')
  const body = await response.json() as { ok?: boolean; data?: { generationId?: string } }
  assert.equal(body.ok, true)
  assert.equal(body.data?.generationId, input.generationId)

  const before = await input.runtime.query(
    `SELECT data, version FROM public.meta_records WHERE id=$1 AND sheet_id=$2`,
    [input.recordId, input.identity.sheetId],
  )
  const capturedData = { [input.fieldId]: 'captured', [input.attachmentFieldId]: [input.attachmentId] }
  assert.deepEqual(before.rows, [{ data: capturedData, version: 1 }])
  const priorRestores = await input.runtime.query(
    `SELECT count(*)::int AS count FROM public.meta_record_revisions
      WHERE record_id=$1 AND source='restore'`, [input.recordId],
  )
  await input.runtime.query(
    `UPDATE public.meta_records
        SET data=jsonb_set(jsonb_set(data, ARRAY[$2::text], to_jsonb('edited'::text)),
                           ARRAY[$3::text], '[]'::jsonb), version=version+1
      WHERE id=ANY($1::text[]) AND sheet_id=$4`,
    [input.recordIds, input.fieldId, input.attachmentFieldId, input.identity.sheetId],
  )

  const scope = { kind: 'selected_fields', recordIds: [input.recordId], fieldIds: [input.attachmentFieldId] }
  const preview = await fetch(`${route}/preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ generationId: input.generationId, mode: 'revert', scope }),
  })
  assert.equal(preview.status, 200, 'RECOVERY_LOCAL_BACKUP_IMPORTED_MANUAL_PREVIEW_FAILED')
  const previewBody = await preview.json() as { ok?: boolean; data?: {
    generationId?: string; executable?: boolean; blockedReason?: string | null; previewIdentity?: string; executionKind?: string
    summary?: { effectiveWriteCount?: number; reverts?: Array<{ recordId: string; fieldIds: string[] }> }
  } }
  assert.equal(previewBody.ok, true)
  assert.equal(previewBody.data?.generationId, input.generationId)
  if (previewBody.data?.executable !== true) {
    const blocked = previewBody.data?.blockedReason
    if (typeof blocked === 'string' && /^[a-z_]+$/.test(blocked)) {
      throw new Error(`RECOVERY_LOCAL_BACKUP_MANUAL_${blocked.toUpperCase()}`)
    }
  }
  assert.equal(previewBody.data?.executable, true)
  assert.equal(previewBody.data?.blockedReason, null)
  assert.equal(previewBody.data?.summary?.reverts?.length, 1)
  assert.equal(previewBody.data?.summary?.reverts?.[0]?.recordId, input.recordId)
  assert.deepEqual(previewBody.data?.summary?.reverts?.[0]?.fieldIds?.slice().sort(),
    [input.attachmentFieldId])
  assert.equal(previewBody.data?.summary?.effectiveWriteCount, 1)
  assert.equal(typeof previewBody.data?.previewIdentity, 'string')
  assert.deepEqual((await input.runtime.query(
    `SELECT data, version FROM public.meta_records WHERE id=$1`, [input.recordId],
  )).rows, [{ data: { ...capturedData, [input.fieldId]: 'edited', [input.attachmentFieldId]: [] }, version: 2 }])

  const executeBody = JSON.stringify({ previewIdentity: previewBody.data!.previewIdentity, scope })
  const applied = await fetch(`${route}/execute`, { method: 'POST', headers, body: executeBody })
  assert.equal(applied.status, 200, 'RECOVERY_LOCAL_BACKUP_IMPORTED_MANUAL_EXECUTE_FAILED')
  const appliedBody = await applied.json() as { ok?: boolean; data?: {
    revertedCount?: number; resurrectedCount?: number; deletedCount?: number
  } }
  assert.equal(appliedBody.ok, true)
  assert.equal(appliedBody.data?.revertedCount, 1)
  assert.equal(appliedBody.data?.resurrectedCount, 0)
  assert.equal(appliedBody.data?.deletedCount, 0)
  const after = (await input.runtime.query(
    `SELECT data, version FROM public.meta_records WHERE id=$1`, [input.recordId],
  )).rows
  assert.deepEqual(after, [{ data: { ...capturedData, [input.fieldId]: 'edited' }, version: 3 }])
  const restoreCount = await input.runtime.query(
    `SELECT count(*)::int AS count FROM public.meta_record_revisions
      WHERE record_id=$1 AND source='restore'`, [input.recordId],
  )
  assert.equal((restoreCount.rows[0] as { count?: number } | undefined)?.count,
    Number((priorRestores.rows[0] as { count?: number } | undefined)?.count) + 1)
  const replay = await fetch(`${route}/execute`, { method: 'POST', headers, body: executeBody })
  assert.equal(replay.status, 409)
  assert.deepEqual((await input.runtime.query(
    `SELECT data, version FROM public.meta_records WHERE id=$1`, [input.recordId],
  )).rows, after)
  // Fresh preview after attachment-only apply preserves every scalar delta.
  assert.deepEqual((await input.runtime.query(
    `SELECT count(*)::int AS count FROM public.meta_records
      WHERE sheet_id=$1 AND data->>$2='edited'`, [input.identity.sheetId, input.fieldId],
  )).rows, [{ count: 5001 }])
  const asyncPreview = await fetch(`${route}/preview`, { method: 'POST', headers,
    body: JSON.stringify({ generationId: input.generationId, mode: 'revert', scope: { kind: 'whole_sheet' } }) })
  assert.equal(asyncPreview.status, 200)
  const asyncBody = await asyncPreview.json() as typeof previewBody
  assert.equal(asyncBody.ok, true)
  assert.equal(asyncBody.data?.generationId, input.generationId)
  assert.equal(asyncBody.data?.executable, true)
  assert.equal(asyncBody.data?.executionKind, 'async')
  assert.equal(asyncBody.data?.summary?.effectiveWriteCount, 5001)
  assert.equal(typeof asyncBody.data?.previewIdentity, 'string')
  const accepted = await fetch(`${base}/api/multitable/sheets/${encodeURIComponent(input.identity.sheetId)}/recovery-archive/jobs/accept`, {
    method: 'POST', headers, body: JSON.stringify({ previewIdentity: asyncBody.data!.previewIdentity }),
  })
  assert.equal(accepted.status, 202)
  const acceptedBody = await accepted.json() as { ok?: boolean; data?: { jobId?: string; totalCount?: string } }
  assert.equal(acceptedBody.ok, true)
  assert.equal(acceptedBody.data?.totalCount, '5001')
  assert.match(acceptedBody.data?.jobId ?? '', /^[a-f0-9-]{36}$/)
  return acceptedBody.data!.jobId!
}

async function withRoute<T>(input: {
  readonly runtime: Runtime
  readonly archive: RecoveryArchivePreviewRuntime
  readonly identity: Identity
  readonly keyId: string
}, work: (base: string, headers: Record<string, string>) => Promise<T>): Promise<T> {
  const express = require('express') as typeof import('express')
  const { univerMetaRouter } = require('../src/routes/univer-meta.ts') as typeof import('../src/routes/univer-meta')
  const { isRecoveryArchiveRestoreWorkerEnabled } = require('../src/multitable/recovery-archive-restore-worker.ts') as typeof import('../src/multitable/recovery-archive-restore-worker')
  assert.equal(isRecoveryArchiveRestoreWorkerEnabled(), true, 'RECOVERY_LOCAL_BACKUP_MANUAL_FLAGS_OFF')
  const bearer = `synthetic-${randomUUID()}`
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    if (request.headers.authorization === `Bearer ${bearer}`) {
      request.user = { id: input.identity.actorId, role: 'admin' }
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter({
    recoveryArchiveRuntime: input.archive,
    recoveryArchiveDatabaseRuntime: {
      query: input.runtime.query,
      transaction: input.runtime.transaction,
      transactionDepthProbe: input.runtime.depth,
      nativePool: input.runtime.nativePool,
    },
    recoveryArchiveAuditedReplayHorizonMs: 60_000,
    recoveryArchiveManualPolicy: {
      keyId: input.keyId,
      keyRowVersion: '1',
      leaseSeconds: 3600,
      expiresAfterSeconds: 7200,
    },
    recoveryArchiveManualCaptureLimits: { maxBytes: 64 * 1024 * 1024, timeoutMs: 60_000 },
  }))
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return await work(`http://127.0.0.1:${address.port}`, {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
    })
  } finally {
    server.closeIdleConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
