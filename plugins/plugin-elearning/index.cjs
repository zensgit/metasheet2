'use strict'

const { isMasterEnabled, getCapabilitiesPayload, isHydratedCaller, authenticatedOrgId } = require('./lib/feature-flags.cjs')
const { sendFeatureDisabled } = require('./lib/http-errors.cjs')
const { startJobsWorker, stopJobsWorker, resolveDatabasePort, clearJobHandlers } = require('./lib/jobs.cjs')
const { registerAssignmentReminderProducer } = require('./lib/reminder-producer.cjs')
const { registerExamExpirySettlement } = require('./lib/exam-expiry.cjs')
const { startNotificationRuntime, stopNotificationRuntime } = require('./lib/notification-runtime.cjs')

const CANONICAL_METHOD = 'GET'
const CANONICAL_PATH = '/api/elearning/capabilities'

function sendUnauthenticated(res) {
  res.status(401).json({
    ok: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    },
  })
}

function sendOrgContextRequired(res) {
  res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
}

async function activate(context) {
  // Hot reload: host does not call deactivate() before re-activate, including
  // when the re-run throws. Stop the prior timer before every subsequent exit.
  stopNotificationRuntime()
  stopJobsWorker()
  clearJobHandlers()
  if (!isMasterEnabled()) {
    return
  }

  if (!context || !context.api || !context.api.http || typeof context.api.http.addRoute !== 'function') {
    throw new Error('plugin-elearning requires context.api.http.addRoute')
  }
  if (!resolveDatabasePort(context)) {
    throw new Error('plugin-elearning requires context.api.database.query')
  }

  try {
    registerAssignmentReminderProducer(context)
    registerExamExpirySettlement(context)
    context.api.http.addRoute(CANONICAL_METHOD, CANONICAL_PATH, async (req, res) => {
      if (!isMasterEnabled()) {
        sendFeatureDisabled(res)
        return
      }
      const caller = req && req.user
      if (!isHydratedCaller(caller)) {
        sendUnauthenticated(res)
        return
      }
      if (!authenticatedOrgId(req)) {
        sendOrgContextRequired(res)
        return
      }
      res.json(getCapabilitiesPayload(undefined, caller))
    })

    startJobsWorker(context)
    startNotificationRuntime(context)
  } catch (error) {
    stopNotificationRuntime()
    stopJobsWorker()
    clearJobHandlers()
    throw error
  }
}

async function deactivate() {
  stopNotificationRuntime()
  stopJobsWorker()
  clearJobHandlers()
}

module.exports = {
  activate,
  deactivate,
  CANONICAL_METHOD,
  CANONICAL_PATH,
}
