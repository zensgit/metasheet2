'use strict'

const { transformRecord } = require('./transform-engine.cjs')
const { validateRecord } = require('./validator.cjs')
const { computeRecordIdempotencyKey } = require('./idempotency.cjs')
const { deriveNextWatermark } = require('./watermark.cjs')
const { sanitizeIntegrationPayload } = require('./payload-redaction.cjs')

class PipelineRunnerError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PipelineRunnerError'
    this.details = details
  }
}

// REST API request fields like dryRun / allowInactive arrive over JSON, but
// admin tools, curl one-liners, and form helpers commonly serialize booleans
// as strings ("true" / "false") or numerics (0 / 1). Strict `=== true` on
// dryRun would silently fall through to a LIVE run when the operator typed
// dryRun: "true" in their request body. Coerce with a small allow-list so
// known truthy variants enable the flag and unknown values fail loudly.
const TRUE_BOOLEAN_TEXT = new Set(['true', '1', 'yes', 'y', 'on', '是', '启用', '开启'])
const FALSE_BOOLEAN_TEXT = new Set(['false', '0', 'no', 'n', 'off', '否', '禁用', '关闭'])

function coerceTruthyFlag(value, field) {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PipelineRunnerError(`${field} must be a finite boolean, 0/1, or boolean-like string`, { field })
    }
    if (value === 1) return true
    if (value === 0) return false
    throw new PipelineRunnerError(`${field} must be 0 or 1 when given as a number`, { field, received: value })
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) return false
    if (TRUE_BOOLEAN_TEXT.has(normalized)) return true
    if (FALSE_BOOLEAN_TEXT.has(normalized)) return false
  }
  throw new PipelineRunnerError(`${field} must be a boolean, 0/1, or boolean-like string`, { field })
}

function requireDependency(deps, name, methods) {
  const value = deps[name]
  if (!value) throw new Error(`createPipelineRunner: ${name} is required`)
  for (const method of methods) {
    if (typeof value[method] !== 'function') {
      throw new Error(`createPipelineRunner: ${name}.${method} is required`)
    }
  }
  return value
}

function createMetrics() {
  return {
    rowsRead: 0,
    rowsCleaned: 0,
    rowsWritten: 0,
    rowsFailed: 0,
    durationMs: 0,
  }
}

function summarizeErrors(errors) {
  if (!errors || errors.length === 0) return null
  return errors.slice(0, 3).map((error) => error.message || error.code || String(error)).join('; ')
}

function formatValidationErrors(errors) {
  return errors.map((error) => `${error.field || 'record'}:${error.code}`).join(', ')
}

function normalizeTargetWriteResult(writeResult = {}, cleanRecords = []) {
  const errors = Array.isArray(writeResult.errors) ? writeResult.errors : []
  const written = Number(writeResult.written) || 0
  const skipped = Number(writeResult.skipped) || 0
  const failed = Number(writeResult.failed) || 0
  const reportedFailed = Math.max(failed, errors.length)
  const reportedAccounted = written + skipped + reportedFailed
  const unaccountedFailed = Math.max(0, cleanRecords.length - reportedAccounted)
  const overReported = reportedAccounted > cleanRecords.length
  const effectiveFailed = reportedFailed + unaccountedFailed + (overReported && reportedFailed === 0 ? 1 : 0)
  const accounted = written + skipped + effectiveFailed
  return {
    ...writeResult,
    written,
    skipped,
    failed: effectiveFailed,
    errors,
    inconsistent: reportedAccounted !== cleanRecords.length || failed !== reportedFailed,
    reportedFailed: failed,
    unaccountedFailed,
    accounted,
  }
}

function errorKey(error = {}) {
  return error.idempotencyKey ||
    error.key ||
    (error.record && error.record._integration_idempotency_key) ||
    (error.record && error.record.idempotencyKey)
}

function findCleanRecordForTargetError(cleanRecords, error = {}) {
  if (!Array.isArray(cleanRecords)) return null
  if (Number.isInteger(error.index) && error.index >= 0 && error.index < cleanRecords.length) {
    return cleanRecords[error.index]
  }
  const key = errorKey(error)
  if (!key) return null
  return cleanRecords.find((item) => (
    item.targetRecord._integration_idempotency_key === key ||
    item.targetRecord.idempotencyKey === key ||
    item.targetRecord.FNumber === key ||
    item.targetRecord.code === key
  )) || null
}

function buildUnmatchedTargetErrorPayload(error = {}) {
  return {
    adapterError: true,
    index: Number.isInteger(error.index) ? error.index : null,
    key: errorKey(error) || null,
    code: error.code || null,
    message: error.message || null,
  }
}

function isTruncatedReplayPayload(value) {
  return Boolean(value && typeof value === 'object' && value.payloadTruncated === true)
}

function resolveWatermarkConfig(pipeline) {
  const options = pipeline.options || {}
  return options.watermark || {
    type: 'updated_at',
    field: 'updatedAt',
  }
}

function assertActiveSystem(system, field) {
  if (!system) {
    throw new PipelineRunnerError(`${field} external system not found`, { field })
  }
  if (system.status && system.status !== 'active') {
    throw new PipelineRunnerError(`${field} external system is not active`, {
      field,
      systemId: system.id,
      status: system.status,
    })
  }
}

function createPipelineRunner(deps = {}) {
  const pipelineRegistry = requireDependency(deps, 'pipelineRegistry', ['getPipeline'])
  const externalSystemRegistry = requireDependency(deps, 'externalSystemRegistry', ['getExternalSystem'])
  const adapterRegistry = requireDependency(deps, 'adapterRegistry', ['createAdapter'])
  const deadLetterStore = requireDependency(deps, 'deadLetterStore', ['createDeadLetter'])
  const watermarkStore = requireDependency(deps, 'watermarkStore', ['getWatermark', 'setWatermark'])
  const runLogger = requireDependency(deps, 'runLogger', ['startRun', 'finishRun'])
  const erpFeedbackWriter = deps.erpFeedbackWriter && typeof deps.erpFeedbackWriter.writeBack === 'function'
    ? deps.erpFeedbackWriter
    : null
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now()

  async function loadExternalSystemForAdapter(input) {
    if (typeof externalSystemRegistry.getExternalSystemForAdapter === 'function') {
      return externalSystemRegistry.getExternalSystemForAdapter(input)
    }
    return externalSystemRegistry.getExternalSystem(input)
  }

  async function loadPipelineContext(input) {
    const tenantId = input.tenantId
    const workspaceId = input.workspaceId ?? null
    const pipeline = await pipelineRegistry.getPipeline({
      tenantId,
      workspaceId,
      id: input.pipelineId,
      includeFieldMappings: true,
    })
    if (pipeline.status !== 'active' && !coerceTruthyFlag(input.allowInactive, 'input.allowInactive')) {
      throw new PipelineRunnerError('pipeline is not active', {
        pipelineId: pipeline.id,
        status: pipeline.status,
      })
    }
    const sourceSystem = await loadExternalSystemForAdapter({
      tenantId,
      workspaceId,
      id: pipeline.sourceSystemId,
    })
    const targetSystem = await loadExternalSystemForAdapter({
      tenantId,
      workspaceId,
      id: pipeline.targetSystemId,
    })
    assertActiveSystem(sourceSystem, 'sourceSystem')
    assertActiveSystem(targetSystem, 'targetSystem')
    return {
      tenantId,
      workspaceId,
      pipeline,
      sourceSystem,
      targetSystem,
      sourceAdapter: adapterRegistry.createAdapter(sourceSystem, { role: 'source' }),
      targetAdapter: adapterRegistry.createAdapter(targetSystem, { role: 'target' }),
    }
  }

  async function writeDeadLetter(input) {
    if (input.dryRun) return
    await deadLetterStore.createDeadLetter(input)
  }

  async function writeErpFeedback({ context, run, writeResult, cleanRecords }) {
    if (!erpFeedbackWriter || cleanRecords.length === 0) return null
    try {
      const feedback = await erpFeedbackWriter.writeBack({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        runId: run.id,
        pipeline: context.pipeline,
        cleanRecords,
        writeResult,
      })
      return {
        ok: feedback.ok !== false,
        skipped: feedback.skipped === true,
        reason: feedback.reason || null,
        projectId: feedback.projectId || null,
        objectId: feedback.objectId || null,
        keyField: feedback.keyField || null,
        items: Array.isArray(feedback.items) ? feedback.items.length : 0,
        written: feedback.result && Number.isFinite(Number(feedback.result.written))
          ? Number(feedback.result.written)
          : undefined,
      }
    } catch (error) {
      return {
        ok: false,
        skipped: false,
        reason: 'ERP_FEEDBACK_THROWN',
        error: error && error.message ? error.message : String(error),
      }
    }
  }

  async function processRecord({ context, run, sourceRecord, cleanRecords, metrics, preview, dryRun }) {
    metrics.rowsRead += 1
    if (sourceRecord === null || sourceRecord === undefined ||
        typeof sourceRecord !== 'object' || Array.isArray(sourceRecord)) {
      metrics.rowsFailed += 1
      const failure = {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        runId: run.id,
        pipelineId: context.pipeline.id,
        sourcePayload: sourceRecord === null || sourceRecord === undefined
          ? { _adapterReturnedNullRecord: true }
          : sanitizeIntegrationPayload({ _adapterReturnedNonObject: true, value: sourceRecord }),
        transformedPayload: null,
        errorCode: 'INVALID_SOURCE_RECORD',
        errorMessage: `adapter returned ${
          sourceRecord === null ? 'null'
          : sourceRecord === undefined ? 'undefined'
          : Array.isArray(sourceRecord) ? 'array'
          : typeof sourceRecord
        } instead of a record object`,
        dryRun,
      }
      await writeDeadLetter(failure)
      if (preview) preview.errors.push({ ...failure, dryRun: undefined })
      return
    }
    const transformed = transformRecord(sourceRecord, context.pipeline.fieldMappings || [])
    if (!transformed.ok) {
      metrics.rowsFailed += 1
      const failure = {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        runId: run.id,
        pipelineId: context.pipeline.id,
        sourcePayload: sanitizeIntegrationPayload(sourceRecord),
        transformedPayload: sanitizeIntegrationPayload(transformed.value),
        errorCode: 'TRANSFORM_FAILED',
        errorMessage: summarizeErrors(transformed.errors) || 'transform failed',
        dryRun,
      }
      await writeDeadLetter(failure)
      if (preview) preview.errors.push({ ...failure, dryRun: undefined })
      return
    }

    const validation = validateRecord(transformed.value, context.pipeline.fieldMappings || [])
    if (!validation.ok) {
      metrics.rowsFailed += 1
      const failure = {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        runId: run.id,
        pipelineId: context.pipeline.id,
        sourcePayload: sanitizeIntegrationPayload(sourceRecord),
        transformedPayload: sanitizeIntegrationPayload(transformed.value),
        errorCode: 'VALIDATION_FAILED',
        errorMessage: formatValidationErrors(validation.errors),
        dryRun,
      }
      await writeDeadLetter(failure)
      if (preview) preview.errors.push({ ...failure, dryRun: undefined })
      return
    }

    let idempotencyKey
    try {
      idempotencyKey = computeRecordIdempotencyKey({
        record: sourceRecord,
        pipeline: context.pipeline,
        sourceSystem: context.sourceSystem,
        targetSystem: context.targetSystem,
      })
    } catch (error) {
      metrics.rowsFailed += 1
      const failure = {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        runId: run.id,
        pipelineId: context.pipeline.id,
        sourcePayload: sanitizeIntegrationPayload(sourceRecord),
        transformedPayload: sanitizeIntegrationPayload(transformed.value),
        errorCode: 'IDEMPOTENCY_FAILED',
        errorMessage: error.message || 'idempotency key failed',
        dryRun,
      }
      await writeDeadLetter(failure)
      if (preview) preview.errors.push({ ...failure, dryRun: undefined })
      return
    }
    cleanRecords.push({
      sourceRecord,
      targetRecord: {
        ...transformed.value,
        _integration_idempotency_key: idempotencyKey,
      },
    })
    if (preview) {
      preview.records.push({
        source: sanitizeIntegrationPayload(sourceRecord),
        transformed: sanitizeIntegrationPayload({
          ...transformed.value,
          _integration_idempotency_key: idempotencyKey,
        }),
      })
    }
    metrics.rowsCleaned += 1
  }

  async function runPipeline(input) {
    const context = await loadPipelineContext(input)
    const mode = input.mode || context.pipeline.mode || 'manual'
    const triggeredBy = input.triggeredBy || 'manual'
    const dryRun = coerceTruthyFlag(input.dryRun, 'input.dryRun')
    const started = clock()
    const metrics = createMetrics()
    const preview = dryRun ? { records: [], errors: [] } : null

    // Best-effort: recover any runs left stuck in 'running' by a previous crash.
    // Wrapped in try-catch so a transient DB failure here never blocks the main run.
    if (typeof pipelineRegistry.abandonStaleRuns === 'function') {
      try {
        await pipelineRegistry.abandonStaleRuns({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          pipelineId: context.pipeline.id,
        })
      } catch {
        // Non-fatal — stale-run cleanup is best-effort; proceed with the pipeline run.
      }
    }

    let run = await runLogger.startRun({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      pipelineId: context.pipeline.id,
      mode,
      triggeredBy,
      details: {
        sourceObject: context.pipeline.sourceObject,
        targetObject: context.pipeline.targetObject,
        dryRun,
      },
    })

    try {
      const watermarkConfig = resolveWatermarkConfig(context.pipeline)
      const currentWatermark = mode === 'incremental'
        ? await watermarkStore.getWatermark(context.pipeline.id)
        : null
      const batchSize = Number.isInteger(context.pipeline.options?.batchSize)
        ? context.pipeline.options.batchSize
        : 1000
      const effectiveBatchSize = dryRun && Number.isInteger(input.sampleLimit) && input.sampleLimit > 0
        ? Math.min(input.sampleLimit, batchSize)
        : batchSize
      const maxPages = Number.isInteger(context.pipeline.options?.maxPages)
        ? context.pipeline.options.maxPages
        : 100
      let cursor = input.cursor || null
      let page = 0
      let lastSuccessfulWatermark = null
      let exitedNormally = false
      const erpFeedback = []
      let remainingDryRunSamples = dryRun && Number.isInteger(input.sampleLimit) && input.sampleLimit > 0
        ? input.sampleLimit
        : null

      while (page < maxPages) {
        page += 1
        const readResult = Array.isArray(input.sourceRecords)
          ? {
              records: input.sourceRecords,
              done: true,
              nextCursor: null,
            }
          : await context.sourceAdapter.read({
              object: context.pipeline.sourceObject,
              limit: effectiveBatchSize,
              cursor,
              watermark: currentWatermark ? { [watermarkConfig.field]: currentWatermark.value } : {},
            })
        const cleanRecords = []
        const records = remainingDryRunSamples === null
          ? readResult.records
          : readResult.records.slice(0, remainingDryRunSamples)
        for (const sourceRecord of records) {
          await processRecord({ context, run, sourceRecord, cleanRecords, metrics, preview, dryRun })
          if (remainingDryRunSamples !== null) remainingDryRunSamples -= 1
        }

        if (!dryRun && cleanRecords.length > 0) {
          const writeResult = normalizeTargetWriteResult(await context.targetAdapter.upsert({
            object: context.pipeline.targetObject,
            records: cleanRecords.map((item) => item.targetRecord),
            keyFields: ['_integration_idempotency_key'],
          }), cleanRecords)
          metrics.rowsWritten += writeResult.written || 0
          metrics.rowsFailed += writeResult.failed || 0
          const targetErrors = writeResult.errors || []
          for (const error of targetErrors) {
            const matched = findCleanRecordForTargetError(cleanRecords, error)
            await writeDeadLetter({
              tenantId: context.tenantId,
              workspaceId: context.workspaceId,
              runId: run.id,
              pipelineId: context.pipeline.id,
              idempotencyKey: errorKey(error) || matched?.targetRecord?._integration_idempotency_key,
              sourcePayload: sanitizeIntegrationPayload(error.sourcePayload || matched?.sourceRecord || buildUnmatchedTargetErrorPayload(error)),
              transformedPayload: sanitizeIntegrationPayload(error.record || matched?.targetRecord || null),
              errorCode: matched ? (error.code || 'TARGET_WRITE_FAILED') : 'TARGET_WRITE_UNMATCHED_ERROR',
              errorMessage: error.message || 'target write failed',
            })
          }
          const unitemizedFailures = Math.max(0, (writeResult.failed || 0) - targetErrors.length)
          if (unitemizedFailures > 0) {
            await writeDeadLetter({
              tenantId: context.tenantId,
              workspaceId: context.workspaceId,
              runId: run.id,
              pipelineId: context.pipeline.id,
              sourcePayload: {
                aggregateTargetFailure: true,
                failed: unitemizedFailures,
                reportedFailed: writeResult.reportedFailed,
                unaccountedFailed: writeResult.unaccountedFailed || 0,
                inconsistent: writeResult.inconsistent === true,
                cleanRecords: cleanRecords.length,
              },
              transformedPayload: null,
              errorCode: 'TARGET_WRITE_AGGREGATE_FAILED',
              errorMessage: `target write failed for ${unitemizedFailures} record(s) without itemized errors`,
            })
          }
          const feedback = await writeErpFeedback({ context, run, writeResult, cleanRecords })
          if (feedback) erpFeedback.push(feedback)
        }

        if (metrics.rowsFailed === 0) {
          lastSuccessfulWatermark = deriveNextWatermark(records, watermarkConfig) || lastSuccessfulWatermark
        }
        if (remainingDryRunSamples !== null && remainingDryRunSamples <= 0) {
          exitedNormally = true
          break
        }
        if (readResult.done || !readResult.nextCursor) {
          exitedNormally = true
          break
        }
        cursor = readResult.nextCursor
      }
      const maxPagesReached = !exitedNormally && page >= maxPages

      if (!dryRun && metrics.rowsFailed === 0 && lastSuccessfulWatermark) {
        const advance = typeof watermarkStore.advanceWatermark === 'function'
          ? watermarkStore.advanceWatermark.bind(watermarkStore)
          : watermarkStore.setWatermark.bind(watermarkStore)
        await advance({
          pipelineId: context.pipeline.id,
          type: lastSuccessfulWatermark.type,
          value: lastSuccessfulWatermark.value,
        })
      }

      metrics.durationMs = Math.max(0, clock() - started)
      const status = metrics.rowsFailed > 0 ? 'partial' : 'succeeded'
      let finishRunWarning = null
      try {
        run = await runLogger.finishRun(run, metrics, status, {
          details: {
            dryRun,
            watermarkAdvanced: !dryRun && metrics.rowsFailed === 0 && Boolean(lastSuccessfulWatermark),
            nextCursor: cursor,
            erpFeedback,
            maxPagesReached,
            pagesProcessed: page,
          },
        })
      } catch (finishError) {
        // ERP writes already committed — don't propagate to catch block where
        // callers would see a failure and potentially retry (duplicate writes).
        finishRunWarning = {
          code: 'FINISH_RUN_FAILED',
          message: finishError.message || String(finishError),
        }
      }
      return {
        run,
        metrics,
        preview,
        ...(finishRunWarning && { warning: finishRunWarning }),
      }
    } catch (error) {
      metrics.durationMs = Math.max(0, clock() - started)
      // Best-effort: mark the run as failed. If finishRun itself fails (e.g. DB
      // is down) we suppress that secondary error and still throw the original.
      // The stuck 'running' run will be recovered by abandonStaleRuns on next trigger.
      try {
        run = await runLogger.finishRun(run, metrics, 'failed', {
          errorSummary: error.message || String(error),
        })
      } catch {
        // Secondary failure — original error takes priority
      }
      throw new PipelineRunnerError('pipeline run failed', {
        run,
        cause: error.message || String(error),
      })
    }
  }

  async function replayDeadLetter(input = {}) {
    if (typeof deadLetterStore.getDeadLetter !== 'function' || typeof deadLetterStore.markReplayed !== 'function') {
      throw new PipelineRunnerError('dead-letter replay requires getDeadLetter() and markReplayed()')
    }
    const deadLetter = await deadLetterStore.getDeadLetter(input)
    if (!deadLetter) {
      throw new PipelineRunnerError('dead letter not found', { id: input.id })
    }
    // Only 'open' letters can be replayed. 'replayed' or 'discarded' letters must not
    // trigger another live ERP write — idempotency would block the write but the run
    // record and K3 WISE session calls still fire, polluting the run log.
    if (deadLetter.status !== 'open') {
      throw new PipelineRunnerError('dead letter cannot be replayed: status is not open', {
        id: deadLetter.id,
        status: deadLetter.status,
      })
    }
    if (isTruncatedReplayPayload(deadLetter.sourcePayload)) {
      throw new PipelineRunnerError('dead letter payload is truncated and cannot be replayed safely', {
        id: deadLetter.id,
        reason: 'PAYLOAD_TRUNCATED',
      })
    }
    if (deadLetter.sourcePayload === null || deadLetter.sourcePayload === undefined) {
      throw new PipelineRunnerError('dead letter source payload is null and cannot be replayed', {
        id: deadLetter.id,
        reason: 'NULL_PAYLOAD',
      })
    }
    if (typeof deadLetter.sourcePayload !== 'object' || Array.isArray(deadLetter.sourcePayload)) {
      throw new PipelineRunnerError('dead letter source payload is not a record object and cannot be replayed', {
        id: deadLetter.id,
        reason: 'INVALID_PAYLOAD_TYPE',
      })
    }
    const result = await runPipeline({
      tenantId: deadLetter.tenantId,
      workspaceId: deadLetter.workspaceId,
      pipelineId: deadLetter.pipelineId,
      mode: 'replay',
      triggeredBy: input.triggeredBy || 'replay',
      allowInactive: input.allowInactive,
      sourceRecords: [deadLetter.sourcePayload],
    })
    if (result.metrics.rowsFailed > 0) return { deadLetter, replay: result }
    // Best-effort bookkeeping: the ERP write already succeeded, so even if
    // markReplayed fails (DB down at cleanup time) we must NOT throw — the
    // caller would see 500 and retry, causing a duplicate ERP write.
    let replayed = deadLetter
    let markReplayedWarning = null
    try {
      replayed = await deadLetterStore.markReplayed({
        tenantId: deadLetter.tenantId,
        workspaceId: deadLetter.workspaceId,
        id: deadLetter.id,
        replayRunId: result.run.id,
        retryCount: (deadLetter.retryCount || 0) + 1,
      })
    } catch (markError) {
      markReplayedWarning = {
        code: 'MARK_REPLAYED_FAILED',
        message: markError.message || String(markError),
      }
    }
    return {
      deadLetter: replayed,
      replay: result,
      ...(markReplayedWarning && { warning: markReplayedWarning }),
    }
  }

  return {
    runPipeline,
    replayDeadLetter,
  }
}

module.exports = {
  PipelineRunnerError,
  createPipelineRunner,
}
