'use strict'
/**
 * R-69 1c — the plugin side of Bridge 2: ONE values-free `integration.run_finished` summary per pipeline run,
 * published through the host's `services.integrationRunEvents.publish` port after the runner's `finishRun`
 * (ADR adr-automation-pipeline-bridge-20261103 §4.2; design baseline v2.3 §10.2.4 1c row). R-69 is OPEN:
 * dry-run only, default OFF, not for merge until the owner rules.
 *
 *   - WHO: runs triggered by `api`, `manual` or `replay` only. A run triggered by `automation` is NEVER published
 *     here — the core action layer summarizes automation-originated jobs (and core refuses a plugin publish of
 *     one, AUTOMATION_ORIGIN_RESERVED); `cron` is not in the event vocabulary and is not published either.
 *   - WHEN: once per run, after `finishRun` returned (the run row is terminal). Never per page, never per row:
 *     a 1000-row run is ONE event. A run whose `finishRun` failed publishes nothing (ADR §4.2 accepted residual:
 *     the next run produces the next event).
 *   - WHAT: eventId = the run id (deterministic: a re-publish of the same run dedups per rule in core); job =
 *     { kind: 'pipeline', pipelineId }; status; counts = the run metrics (read / cleaned / written / failed);
 *     durationMs; attempts 1; errorClass (a bounded class, never the error message). No tenant, no URL, no row.
 *     The run's tenant goes BESIDE the event as `route.tenantId` (core routes by it, never forwards it).
 *   - SWITCH: INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED, exact literal 'true', read here before anything is built
 *     (core reads it again on receipt).
 *   - NEVER THROWS, NEVER AWAITED BY THE RUN: the publish is fire-and-forget; a refusal or a failure is logged
 *     with a closed code only. The run's HTTP response is byte-identical with or without this module.
 */

const PUBLISHABLE_TRIGGERS = new Set(['api', 'manual', 'replay'])
const ID_SHAPE = /^[A-Za-z0-9_:.-]{1,128}$/
const CLASS_SHAPE = /^[A-Za-z0-9_:.-]{1,80}$/
const TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed'])

function isRunEventPublishEnabled(env = process.env) {
  return env.INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED === 'true'
}

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Build the closed summary + route for one finished pipeline run, or null when this run is not published
 * (automation / cron trigger, non-terminal status, or an identifier that does not have the bounded shape).
 */
function buildPipelineRunFinishedSummary({ runId, pipelineId, tenantId, status, metrics, triggeredBy, errorClass, occurredAt }) {
  if (!PUBLISHABLE_TRIGGERS.has(triggeredBy)) return null
  if (!TERMINAL_STATUSES.has(status)) return null
  if (typeof runId !== 'string' || !ID_SHAPE.test(runId)) return null
  if (typeof pipelineId !== 'string' || !ID_SHAPE.test(pipelineId)) return null
  if (typeof tenantId !== 'string' || !/^[!-~]{1,128}$/.test(tenantId)) return null
  const m = metrics && typeof metrics === 'object' ? metrics : {}
  const summary = {
    eventId: runId,
    occurredAt: typeof occurredAt === 'string' ? occurredAt : new Date().toISOString(),
    job: { kind: 'pipeline', pipelineId },
    runId,
    status,
    counts: { read: count(m.rowsRead), cleaned: count(m.rowsCleaned), written: count(m.rowsWritten), failed: count(m.rowsFailed) },
    durationMs: count(m.durationMs),
    attempts: 1,
    triggeredBy,
    ...(status === 'failed' && typeof errorClass === 'string' && CLASS_SHAPE.test(errorClass) ? { errorClass } : {}),
    _automationDepth: 0,
  }
  return { summary, route: { tenantId } }
}

/**
 * The runner's notifier. `publish` is the host port (`services.integrationRunEvents.publish`) or absent (an
 * older host / another plugin build): absent ⇒ a no-op. Returns the started promise for tests; callers do not
 * await it.
 */
function createRunFinishedNotifier({ publish, env = process.env, logger } = {}) {
  const port = typeof publish === 'function' ? publish : null
  return function notifyRunFinished(input) {
    if (!port || !isRunEventPublishEnabled(env)) return null
    let built
    try {
      built = buildPipelineRunFinishedSummary(input || {})
    } catch {
      built = null
    }
    if (!built) return null
    return Promise.resolve()
      .then(() => port(built.summary, built.route))
      .then((result) => {
        if (result && result.published === false && result.code !== 'SINK_INACTIVE' && logger && typeof logger.warn === 'function') {
          logger.warn(`[plugin-integration-core] run summary not published (code ${String(result.code)})`)
        }
        return result
      }, () => {
        if (logger && typeof logger.warn === 'function') logger.warn('[plugin-integration-core] run summary publish failed')
        return null
      })
  }
}

module.exports = {
  createRunFinishedNotifier,
  buildPipelineRunFinishedSummary,
  isRunEventPublishEnabled,
  PUBLISHABLE_TRIGGERS,
}
