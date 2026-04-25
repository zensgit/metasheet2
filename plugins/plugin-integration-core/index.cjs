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
const { createCredentialStore } = require('./lib/credential-store.cjs')
const { createDb } = require('./lib/db.cjs')
const { createExternalSystemRegistry } = require('./lib/external-systems.cjs')
const { createAdapterRegistry } = require('./lib/contracts.cjs')
const { createHttpAdapterFactory } = require('./lib/adapters/http-adapter.cjs')
const { createPipelineRegistry } = require('./lib/pipelines.cjs')

const registeredRoutes = []
let activeContext = null
let credentialStore = null
let externalSystemRegistry = null
let adapterRegistry = null
let pipelineRegistry = null

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
    // M0/M1 seam. Later slices will add pipeline-runner / dead-letter replay.
    async ping() {
      return { ok: true, plugin: PLUGIN_ID, ts: Date.now() }
    },
    async getStatus() {
      return {
        plugin: PLUGIN_ID,
        version: '0.1.0',
        milestone: 'M0-spike',
        routesRegistered: registeredRoutes.length,
        credentialStore: credentialStore
          ? { source: credentialStore.source, format: credentialStore.format }
          : null,
        externalSystems: Boolean(externalSystemRegistry),
        adapters: adapterRegistry ? adapterRegistry.listAdapterKinds() : [],
        pipelines: Boolean(pipelineRegistry),
      }
    },
    async upsertExternalSystem(input) {
      if (!externalSystemRegistry) throw new Error('external system registry is not initialized')
      return externalSystemRegistry.upsertExternalSystem(input)
    },
    async getExternalSystem(input) {
      if (!externalSystemRegistry) throw new Error('external system registry is not initialized')
      return externalSystemRegistry.getExternalSystem(input)
    },
    async listExternalSystems(input) {
      if (!externalSystemRegistry) throw new Error('external system registry is not initialized')
      return externalSystemRegistry.listExternalSystems(input)
    },
    async listAdapterKinds() {
      if (!adapterRegistry) throw new Error('adapter registry is not initialized')
      return adapterRegistry.listAdapterKinds()
    },
    async upsertPipeline(input) {
      if (!pipelineRegistry) throw new Error('pipeline registry is not initialized')
      return pipelineRegistry.upsertPipeline(input)
    },
    async getPipeline(input) {
      if (!pipelineRegistry) throw new Error('pipeline registry is not initialized')
      return pipelineRegistry.getPipeline(input)
    },
    async listPipelines(input) {
      if (!pipelineRegistry) throw new Error('pipeline registry is not initialized')
      return pipelineRegistry.listPipelines(input)
    },
    async createPipelineRun(input) {
      if (!pipelineRegistry) throw new Error('pipeline registry is not initialized')
      return pipelineRegistry.createPipelineRun(input)
    },
    async updatePipelineRun(input) {
      if (!pipelineRegistry) throw new Error('pipeline registry is not initialized')
      return pipelineRegistry.updatePipelineRun(input)
    },
    async listPipelineRuns(input) {
      if (!pipelineRegistry) throw new Error('pipeline registry is not initialized')
      return pipelineRegistry.listPipelineRuns(input)
    },
  }
}

module.exports = {
  async activate(context) {
    activeContext = context
    const logger = context.logger || console
    credentialStore = createCredentialStore({
      logger,
      security: context.services && context.services.security,
    })
    const db = createDb({
      database: context.api && context.api.database,
      logger,
    })
    externalSystemRegistry = createExternalSystemRegistry({
      db,
      credentialStore,
    })
    adapterRegistry = createAdapterRegistry({ logger })
      .registerAdapter('http', createHttpAdapterFactory())
    pipelineRegistry = createPipelineRegistry({ db })

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
    credentialStore = null
    externalSystemRegistry = null
    adapterRegistry = null
    pipelineRegistry = null
    activeContext = null
    logger.info(`[${PLUGIN_ID}] deactivated`)
  },
}
