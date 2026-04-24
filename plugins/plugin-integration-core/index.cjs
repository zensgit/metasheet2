'use strict'

// ---------------------------------------------------------------------------
// plugin-integration-core
//
// PLM/ERP integration pipeline — system plugin MVP.
//
// M0 scope: minimal runtime spike. Registers a health route and a cross-plugin
// communication namespace so the rest of the plugin family can call into this
// one via `context.communication.call('integration-core', ...)`.
//
// Runtime path confirmed by spike: activated from
// packages/core-backend/src/index.ts:1087 (createPluginContext), discovered by
// PluginLoader scanning ./plugins (core/plugin-loader.ts:221).
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'plugin-integration-core'
const COMMUNICATION_NAMESPACE = 'integration-core'

const registeredRoutes = []
let activeContext = null

function buildHealthPayload() {
  return {
    ok: true,
    plugin: PLUGIN_ID,
    ts: Date.now(),
    milestone: 'M0-spike',
  }
}

function buildCommunicationApi() {
  return {
    // M0: bare skeleton. M1 will wire adapter-registry / pipeline-runner /
    // dead-letter / credential-store into this namespace.
    async ping() {
      return { ok: true, plugin: PLUGIN_ID, ts: Date.now() }
    },
    async getStatus() {
      return {
        plugin: PLUGIN_ID,
        version: '0.1.0',
        milestone: 'M0-spike',
        routesRegistered: registeredRoutes.length,
      }
    },
  }
}

module.exports = {
  async activate(context) {
    activeContext = context
    const logger = context.logger || console

    // --- HTTP routes ------------------------------------------------------
    context.api.http.addRoute('GET', '/api/integration/health', async (_req, res) => {
      res.json(buildHealthPayload())
    })
    registeredRoutes.push('GET /api/integration/health')

    // --- Cross-plugin communication --------------------------------------
    context.communication.register(COMMUNICATION_NAMESPACE, buildCommunicationApi())

    logger.info(`[${PLUGIN_ID}] activated (M0 spike). routes=${registeredRoutes.length}`)
  },

  async deactivate() {
    if (!activeContext) return
    const logger = activeContext.logger || console
    // PluginContext currently exposes no removeRoute hook for the addRoute
    // helper used above; host is expected to drop the router on deactivate.
    // We clear local state here so a re-activation starts clean.
    registeredRoutes.length = 0
    activeContext = null
    logger.info(`[${PLUGIN_ID}] deactivated`)
  },
}
