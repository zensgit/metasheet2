'use strict'

const { isStatsDailyProjectorEnabled, resolveStatsDailyProjectionPort } = require('./stats-daily-projector.cjs')

const PRODUCER_INTERVAL_MS = 60_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

let timer = null
let runtimeGeneration = 0
let runningGeneration = null
let activePort = null
let activeLogger = null

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function logValuesFree(logger, code) {
  if (!logger || typeof logger.warn !== 'function') return
  logger.warn('elearning stats daily producer', { code })
}

function validateProducerResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw codedError('STATS_DAILY_PRODUCER_UNAVAILABLE')
  }
  if (Object.keys(result).sort().join(',') !== 'enqueuedCount,statsDate') {
    throw codedError('STATS_DAILY_PRODUCER_UNAVAILABLE')
  }
  if (typeof result.statsDate !== 'string' || !DATE_RE.test(result.statsDate)) {
    throw codedError('STATS_DAILY_PRODUCER_UNAVAILABLE')
  }
  const date = new Date(`${result.statsDate}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== result.statsDate) {
    throw codedError('STATS_DAILY_PRODUCER_UNAVAILABLE')
  }
  if (!Number.isSafeInteger(result.enqueuedCount) || result.enqueuedCount < 0) {
    throw codedError('STATS_DAILY_PRODUCER_UNAVAILABLE')
  }
  return result
}

function getStatsDailyProducerRuntimeState() {
  return {
    generation: runtimeGeneration,
    intervalMs: PRODUCER_INTERVAL_MS,
    running: timer != null,
    timer,
  }
}

function stopStatsDailyProducerRuntime() {
  runtimeGeneration += 1
  if (timer != null) {
    clearInterval(timer)
    timer = null
  }
  activePort = null
  activeLogger = null
}

async function runStatsDailyProducerTick(override) {
  const options = override && typeof override === 'object' ? override : {}
  const port = options.port || activePort
  const generation = runtimeGeneration
  if (!isStatsDailyProjectorEnabled()) return { enqueuedCount: 0, skipped: true }
  if (!port || typeof port.enqueueDue !== 'function') {
    throw codedError('STATS_DAILY_PRODUCER_PORT_REQUIRED')
  }
  if (runningGeneration === generation) return { enqueuedCount: 0, skipped: true }
  runningGeneration = generation
  try {
    return validateProducerResult(await port.enqueueDue())
  } catch (error) {
    if (error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
      throw error
    }
    throw codedError('STATS_DAILY_PRODUCER_UNAVAILABLE')
  } finally {
    if (runningGeneration === generation) runningGeneration = null
  }
}

function startStatsDailyProducerRuntime(context) {
  stopStatsDailyProducerRuntime()
  if (!isStatsDailyProjectorEnabled()) return false
  const port = resolveStatsDailyProjectionPort(context)
  if (!port || typeof port.enqueueDue !== 'function') {
    throw codedError('STATS_DAILY_PRODUCER_PORT_REQUIRED')
  }
  activePort = port
  activeLogger = context && context.logger ? context.logger : null
  timer = setInterval(() => {
    const logger = activeLogger
    void runStatsDailyProducerTick().catch(() => {
      logValuesFree(logger, 'STATS_DAILY_PRODUCER_TICK_FAILED')
    })
  }, PRODUCER_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return true
}

module.exports = {
  PRODUCER_INTERVAL_MS,
  getStatsDailyProducerRuntimeState,
  runStatsDailyProducerTick,
  startStatsDailyProducerRuntime,
  stopStatsDailyProducerRuntime,
  validateProducerResult,
}
