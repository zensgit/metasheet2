const { readAttendancePunchDetailRequestV1 } = require('./attendance-punch-detail-import.cjs')
const { createAttendancePunchDetailFrozenTargetResolverV1 } = require('./attendance-punch-detail-prepare.cjs')

const ERROR_STATUS = {
  ATTENDANCE_WRITE_NOT_AUTHORIZED: 403,
  ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED: 409,
  ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH: 409,
  ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT: 409,
  ATTENDANCE_OPERATION_IN_PROGRESS: 409,
  ATTENDANCE_OPERATION_CONFLICT: 409,
  ATTENDANCE_OPERATION_BATCH_CONFLICT: 409,
  ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH: 422,
  SEGMENT_CALCULATION_SUSPENDED: 503,
}

/** Named-format producer. Legacy requests return false before any dependency or SQL call. */
function createAttendancePunchDetailProducerV1(deps) {
  const { HttpError, port } = deps
  const resolveFrozenTarget = createAttendancePunchDetailFrozenTargetResolverV1({ ...deps, port })
  const fail = (status, code) => { throw new HttpError(status, code, code) }
  const conflict = () => fail(409, 'ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT')
  const replyError = (res, error) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ ok: false, error: { code: error.code, message: error.code } })
      return
    }
    const sourceCode = error?.code ?? error?.message
    const code = sourceCode === 'W4C3A_ENQUEUE_FULL_IMPORT_AUTHORIZATION_REJECTED'
      ? 'ATTENDANCE_WRITE_NOT_AUTHORIZED' : sourceCode
    const status = ERROR_STATUS[code]
    res.status(status ?? 500).json({ ok: false, error: {
      code: status ? code : 'ATTENDANCE_PUNCH_DETAIL_IMPORT_FAILED',
      message: status ? code : 'ATTENDANCE_PUNCH_DETAIL_IMPORT_FAILED',
    } })
  }
  const envelopeFor = (request) => {
    const rowCount = request.input.punches.length
    const engine = deps.resolveImportEngineByRowCount(rowCount)
    return Object.freeze({
      __jobType: 'commit', idempotencyKey: request.idempotencyKey, __importEngine: engine,
      recordUpsertStrategy: deps.resolveImportRecordUpsertStrategy({ rowCount, engine }),
      itemsInsertStrategy: deps.resolveImportItemsInsertStrategy({ rowCount, engine }),
      __w4ContractVersion: 1, __punchDetailInput: request.input,
    })
  }
  const scopeFor = (access) => Object.freeze({
    orgId: access.orgId, actorId: access.userId,
    // fullImport is not a platform-admin grant.
    actorPosture: 'attendance_admin', tokenSubjectUserId: access.userId,
  })
  const prepare = (scope, envelope, batchId) => {
    if (typeof port?.preparePunchDetailImport !== 'function') fail(503, 'ATTENDANCE_PUNCH_DETAIL_HOST_MISSING')
    return port.preparePunchDetailImport({
      scope, batchId, envelope, chunkConfig: deps.resolveImportChunkConfig(envelope.__importEngine),
    }, (trx, posture) => resolveFrozenTarget(trx, {
      orgId: scope.orgId, input: envelope.__punchDetailInput, referenceSegments: posture.referenceSegments,
    }))
  }
  const consumeToken = async (operation, request, access, client = deps.db) => {
    if (operation === 'preview' && !deps.requireImportCommitToken) return
    if (!request.commitToken && deps.requireImportCommitToken) fail(400, 'COMMIT_TOKEN_REQUIRED')
    if (!request.commitToken) return
    const valid = await deps.consumeImportCommitToken(request.commitToken, {
      db: client, orgId: access.orgId, userId: access.userId,
    })
    if (!valid && deps.requireImportCommitToken) fail(403, 'COMMIT_TOKEN_INVALID')
  }
  const eventShape = (request) => ({
    inputKind: 'punch_events_v1', eventCount: request.input.punches.length, targetCount: 1,
  })

  const mapPreviewJob = ({ job, record }) => ({
    ...deps.mapImportJobRow({
      ...job, punch_preview_version: null, idempotency_key: record.envelope.idempotencyKey,
      payload: { ...record.envelope, __jobType: 'preview',
        previewResult: job.status === 'completed' ? record.preview : null,
        ...(job.status === 'completed' ? { summary: { processedRows: record.preview.eventCount, failedRows: 0 } } : {}),
      },
    }),
    idempotencyKey: record.envelope.idempotencyKey,
  })

  return Object.freeze({
    async tryHandleAsyncPreview(req, res) {
      try {
        const request = readAttendancePunchDetailRequestV1(req.body ?? {}, { HttpError, parseInput: port?.parsePunchDetailInput })
        if (!request) return false
        const access = await deps.assertAttendanceImportPrepareAllowed(req, res)
        if (!access) return true
        if (request.orgId !== null && request.orgId !== access.orgId) fail(403, 'ATTENDANCE_ORG_MISMATCH')
        const allowed = await deps.assertAttendanceImportPreviewAllowed(req, res, {
          orgId: access.orgId, rows: [{ userId: request.input.userId, workDate: request.input.workDate }],
          payload: {}, fallbackUserId: request.input.userId, actorAccess: access,
        })
        if (!allowed) return true
        if (typeof port?.reservePunchDetailPreview !== 'function'
          || typeof deps.authorizePunchDetailPreview !== 'function') fail(503, 'ATTENDANCE_PUNCH_DETAIL_HOST_MISSING')
        const scope = scopeFor(access)
        const envelope = envelopeFor(request)
        const reserved = await port.reservePunchDetailPreview({ scope, envelope,
          previewLimit: request.previewLimit ?? request.input.punches.length, jobId: deps.randomUUID(), batchId: deps.randomUUID() }, {
          authorizeTarget: deps.authorizePunchDetailPreview,
          beforeCreate: (client) => consumeToken('preview', request, access, client),
          resolveFrozenTarget: (client, posture) => resolveFrozenTarget(client, {
            orgId: scope.orgId, input: request.input, referenceSegments: posture.referenceSegments,
          }),
        })
        if (reserved.created) await deps.enqueueImportJob(reserved.job.id)
        res.json({ ok: true, data: { job: mapPreviewJob(reserved), ...(!reserved.created ? { idempotent: true } : {}) } })
        return true
      } catch (error) { replyError(res, error); return true }
    },
    async handlePreviewJobRead(req, res, jobId) {
      try {
        const access = req.attendanceImportAccess
        if (!access?.userId || !access.orgId) fail(401, 'UNAUTHORIZED')
        if (typeof port?.readPunchDetailPreviewJob !== 'function'
          || typeof deps.authorizePunchDetailPreview !== 'function') fail(503, 'ATTENDANCE_PUNCH_DETAIL_HOST_MISSING')
        const result = await port.readPunchDetailPreviewJob({ jobId, scope: scopeFor(access) }, deps.authorizePunchDetailPreview)
        if (!result) fail(404, 'NOT_FOUND')
        res.json({ ok: true, data: mapPreviewJob(result) })
      } catch (error) { replyError(res, error) }
    },
    async tryHandleAsyncCommit(req, res) {
      try {
        const request = readAttendancePunchDetailRequestV1(req.body ?? {}, { HttpError, parseInput: port?.parsePunchDetailInput })
        if (!request) return false
        const access = await deps.assertAttendanceImportPrepareAllowed(req, res)
        if (!access) return true
        if (request.orgId !== null && request.orgId !== access.orgId) fail(403, 'ATTENDANCE_ORG_MISMATCH')
        if (!access.fullImport) fail(403, 'FORBIDDEN')
        if (!access.userId) fail(401, 'UNAUTHORIZED')
        const allowed = await deps.assertAttendanceImportCommitAllowed(req, res, {
          orgId: access.orgId, rows: [{ userId: request.input.userId, workDate: request.input.workDate }],
          payload: {}, fallbackUserId: request.input.userId, actorAccess: access,
        })
        if (!allowed) return true
        if (typeof port?.readPunchDetailImportJobReplay !== 'function'
          || typeof port?.reserveLegacyImportPlan !== 'function') fail(503, 'ATTENDANCE_PUNCH_DETAIL_HOST_MISSING')
        const scope = scopeFor(access)
        const envelope = envelopeFor(request)
        const existing = await port.readPunchDetailImportJobReplay({ scope, envelope })
        if (existing) {
          res.json({ ok: true, data: { job: deps.mapImportJobRow(existing), idempotent: true } })
          return true
        }
        await consumeToken('commit', request, access)
        const prepared = await prepare(scope, envelope, deps.randomUUID())
        const reservation = await port.reserveLegacyImportPlan(prepared.plan)
        const job = await port.readPunchDetailImportJobReplay({ scope, envelope, jobId: reservation.jobId })
        if (!job) fail(500, 'ATTENDANCE_PUNCH_DETAIL_RESERVED_JOB_MISSING')
        if (reservation.kind === 'created') await deps.enqueueImportJob(reservation.jobId)
        res.json({ ok: true, data: { job: deps.mapImportJobRow(job),
          ...(reservation.kind === 'existing' ? { idempotent: true } : {}) } })
        return true
      } catch (error) {
        replyError(res, error)
        return true
      }
    },
    async tryHandleSync(operation, req, res) {
      try {
        const request = readAttendancePunchDetailRequestV1(req.body ?? {}, { HttpError, parseInput: port?.parsePunchDetailInput })
        if (!request) return false
        const access = await deps.assertAttendanceImportPrepareAllowed(req, res)
        if (!access) return true
        if (request.orgId !== null && request.orgId !== access.orgId) fail(403, 'ATTENDANCE_ORG_MISMATCH')
        const authorize = operation === 'preview'
          ? deps.assertAttendanceImportPreviewAllowed : deps.assertAttendanceImportCommitAllowed
        // Authorization target only. This object is never sent to the daily importer.
        const allowed = await authorize(req, res, { orgId: access.orgId,
          rows: [{ userId: request.input.userId, workDate: request.input.workDate }],
          payload: {}, fallbackUserId: request.input.userId, actorAccess: access })
        if (!allowed) return true
        if (!['preview', 'commit'].includes(operation)) fail(400, 'ATTENDANCE_PUNCH_DETAIL_OPERATION_INVALID')
        if (typeof port?.fingerprintPunchDetailCommand !== 'function') fail(503, 'ATTENDANCE_PUNCH_DETAIL_HOST_MISSING')
        const scope = scopeFor(access)
        const envelope = envelopeFor(request)
        const fingerprint = port.fingerprintPunchDetailCommand(scope, envelope)
        if (operation === 'commit' && request.idempotencyKey) {
          if (typeof port?.readPunchDetailImportReplay !== 'function') fail(503, 'ATTENDANCE_PUNCH_DETAIL_HOST_MISSING')
          const existing = await port.readPunchDetailImportReplay({ scope, envelope })
          if (existing) {
            if (existing.meta?.punchDetailRequestFingerprint !== fingerprint) conflict()
            res.json({ ok: true, data: { ...eventShape(request), batchId: existing.batchId,
              imported: existing.imported, processedRows: existing.imported, failedRows: existing.skipped,
              elapsedMs: 0, engine: envelope.__importEngine, recordUpsertStrategy: envelope.recordUpsertStrategy,
              items: [], skipped: [], csvWarnings: [], groupWarnings: [], meta: existing.meta, idempotent: true } })
            return true
          }
        }
        await consumeToken(operation, request, access)
        const prepared = await prepare(scope, envelope, deps.randomUUID())
        if (operation === 'preview') {
          const limit = request.previewLimit ?? request.input.punches.length
          const items = request.input.punches.map((punch, sourceOrdinal) => ({ sourceOrdinal, ...punch }))
          res.json({ ok: true, data: { ...eventShape(request),
            total: items.length, rowCount: items.length, processedRows: items.length, failedRows: 0,
            items: items.slice(0, limit), previewLimit: limit, truncated: items.length > limit,
            targets: [{ userId: request.input.userId, workDate: request.input.workDate,
              outcome: prepared.calculation.outcome, reasonCode: prepared.calculation.outcomeReasonCode,
              dailyProjection: prepared.calculation.dailyProjection, segments: prepared.calculation.segments }],
            engine: envelope.__importEngine, recordUpsertStrategy: envelope.recordUpsertStrategy,
            csvWarnings: [], groupWarnings: [] } })
          return true
        }
        if (typeof port?.commitSyncImportPlan !== 'function') fail(503, 'ATTENDANCE_PUNCH_DETAIL_HOST_MISSING')
        const committed = await port.commitSyncImportPlan({
          ...prepared.plan,
          itemReturnPolicy: { returnItems: request.returnItems, itemsLimit: request.returnItems ? request.itemsLimit : null },
          csvWarnings: [], groupWarnings: [],
        })
        res.json({ ok: true, ...(committed.idempotent ? {} : { success: true }),
          data: { ...committed, ...eventShape(request) } })
        return true
      } catch (error) {
        replyError(res, error)
        return true
      }
    },
    rejectDailyReplay(existing, res) {
      if (existing?.meta?.punchDetailRequestFingerprint === undefined) return false
      replyError(res, new HttpError(409, 'ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT', 'ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT'))
      return true
    },
  })
}

module.exports = { createAttendancePunchDetailProducerV1 }
