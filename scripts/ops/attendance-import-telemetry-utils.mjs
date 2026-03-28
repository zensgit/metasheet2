const importEngines = new Set(['standard', 'bulk'])
const importRecordUpsertStrategies = new Set(['values', 'unnest', 'staging'])

export function coerceNonNegativeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return null
}

export function assertImportTelemetry(payload, label, options = {}) {
  const minProcessedRows = Number.isFinite(options.minProcessedRows) ? Number(options.minProcessedRows) : null
  const requireUpsertStrategy = options.requireUpsertStrategy === true
  const requireExplicit = options.requireExplicit === true

  const engine = typeof payload?.engine === 'string' ? payload.engine.trim().toLowerCase() : ''
  if (!importEngines.has(engine)) {
    throw new Error(`${label}: telemetry.engine missing or invalid`)
  }

  const processedSource = requireExplicit
    ? payload?.processedRows
    : (payload?.processedRows ?? payload?.rowCount ?? payload?.imported)
  const processedRows = coerceNonNegativeNumber(processedSource)
  if (processedRows === null) {
    throw new Error(`${label}: telemetry.processedRows missing or invalid`)
  }
  if (minProcessedRows !== null && processedRows < minProcessedRows) {
    throw new Error(`${label}: telemetry.processedRows below minimum (${processedRows} < ${minProcessedRows})`)
  }

  const failedSource = requireExplicit
    ? payload?.failedRows
    : (payload?.failedRows ?? payload?.skippedCount ?? 0)
  const failedRows = coerceNonNegativeNumber(failedSource)
  if (failedRows === null) {
    throw new Error(`${label}: telemetry.failedRows missing or invalid`)
  }

  const elapsedSource = requireExplicit
    ? payload?.elapsedMs
    : (payload?.elapsedMs ?? payload?.jobElapsedMs)
  const elapsedMs = coerceNonNegativeNumber(elapsedSource)
  if (elapsedMs === null) {
    throw new Error(`${label}: telemetry.elapsedMs missing or invalid`)
  }

  const recordUpsertStrategy = typeof payload?.recordUpsertStrategy === 'string'
    ? payload.recordUpsertStrategy.trim().toLowerCase()
    : ''
  if (recordUpsertStrategy) {
    if (!importRecordUpsertStrategies.has(recordUpsertStrategy)) {
      throw new Error(`${label}: telemetry.recordUpsertStrategy invalid (${recordUpsertStrategy})`)
    }
  } else if (requireUpsertStrategy) {
    throw new Error(`${label}: telemetry.recordUpsertStrategy missing`)
  }

  return {
    engine,
    processedRows,
    failedRows,
    elapsedMs,
    recordUpsertStrategy: recordUpsertStrategy || null,
  }
}
