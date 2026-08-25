'use strict'

const { isMasterEnabled, getCapabilitiesPayload, isHydratedCaller } = require('./lib/feature-flags.cjs')
const { sendFeatureDisabled } = require('./lib/http-errors.cjs')

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

async function activate(context) {
  if (!isMasterEnabled()) {
    return
  }

  if (!context || !context.api || !context.api.http || typeof context.api.http.addRoute !== 'function') {
    throw new Error('plugin-elearning requires context.api.http.addRoute')
  }

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
    res.json(getCapabilitiesPayload(undefined, caller))
  })
}

async function deactivate() {}

module.exports = {
  activate,
  deactivate,
  CANONICAL_METHOD,
  CANONICAL_PATH,
}
