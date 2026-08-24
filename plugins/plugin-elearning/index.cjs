'use strict'

const { isMasterEnabled, getCapabilitiesPayload } = require('./lib/feature-flags.cjs')
const { sendFeatureDisabled } = require('./lib/http-errors.cjs')

const CANONICAL_METHOD = 'GET'
const CANONICAL_PATH = '/api/elearning/capabilities'

async function activate(context) {
  if (!isMasterEnabled()) {
    return
  }

  if (!context || !context.api || !context.api.http || typeof context.api.http.addRoute !== 'function') {
    throw new Error('plugin-elearning requires context.api.http.addRoute')
  }

  context.api.http.addRoute(CANONICAL_METHOD, CANONICAL_PATH, async (_req, res) => {
    if (!isMasterEnabled()) {
      sendFeatureDisabled(res)
      return
    }
    res.json(getCapabilitiesPayload())
  })
}

async function deactivate() {}

module.exports = {
  activate,
  deactivate,
  CANONICAL_METHOD,
  CANONICAL_PATH,
}
