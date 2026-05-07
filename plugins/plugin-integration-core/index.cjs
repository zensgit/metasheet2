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
const { createYuantusPlmWrapperAdapterFactory } = require('./lib/adapters/plm-yuantus-wrapper.cjs')
const { createK3WiseWebApiAdapterFactory } = require('./lib/adapters/k3-wise-webapi-adapter.cjs')
const { createK3WiseSqlServerChannelFactory } = require('./lib/adapters/k3-wise-sqlserver-channel.cjs')
const { createPipelineRegistry } = require('./lib/pipelines.cjs')
const { createDeadLetterStore } = require('./lib/dead-letter.cjs')
const { createWatermarkStore } = require('./lib/watermark.cjs')
const { createRunLogger } = require('./lib/run-log.cjs')
const { createErpFeedbackWriter } = require('./lib/erp-feedback.cjs')
const { createPipelineRunner } = require('./lib/pipeline-runner.cjs')
const { installStaging, listStagingDescriptors } = require('./lib/staging-installer.cjs')
const { registerIntegrationRoutes } = require('./lib/http-routes.cjs')

const registeredRoutes = []
let activeContext = null
let credentialStore = null
let externalSystemRegistry = null
let adapterRegistry = null
let pipelineRegistry = null
let deadLetterStore = null
let watermarkStore = null
let runLogger = null
let erpFeedbackWriter = null
let pipelineRunner = null
let stagingInstaller = null

function buildHealthPayload() {
  return {
    ok: true,
    plugin: PLUGIN_ID,
    ts: Date.now(),
    milestone: 'M0-spike',
  }
}

function requireInitialized(service, message) {
  if (!service) throw new Error(message)
  return service
}

function redactDeadLetterForCommunication(deadLetter) {
  if (!deadLetter || typeof deadLetter !== 'object') return deadLetter
  const { sourcePayload: _sourcePayload, transformedPayload: _transformedPayload, ...safe } = deadLetter
  return {
    ...safe,
    payloadRedacted: true,
  }
}

function redactReplayResultForCommunication(result) {
  if (!result || typeof result !== 'object') return result
  return {
    ...result,
    deadLetter: redactDeadLetterForCommunication(result.deadLetter),
  }
}

function buildCommunicationApi() {
  return {
    // Cross-plugin control seam for the integration plugin family.
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
        runner: Boolean(pipelineRunner),
        erpFeedback: Boolean(erpFeedbackWriter),
        deadLetters: Boolean(deadLetterStore),
        deadLetterReplay: Boolean(pipelineRunner && typeof pipelineRunner.replayDeadLetter === 'function'),
        staging: Boolean(stagingInstaller),
      }
    },
    async upsertExternalSystem(input) {
      return requireInitialized(externalSystemRegistry, 'external system registry is not initialized')
        .upsertExternalSystem(input)
    },
    async getExternalSystem(input) {
      return requireInitialized(externalSystemRegistry, 'external system registry is not initialized')
        .getExternalSystem(input)
    },
    async listExternalSystems(input) {
      return requireInitialized(externalSystemRegistry, 'external system registry is not initialized')
        .listExternalSystems(input)
    },
    async listAdapterKinds() {
      return requireInitialized(adapterRegistry, 'adapter registry is not initialized').listAdapterKinds()
    },
    async upsertPipeline(input) {
      return requireInitialized(pipelineRegistry, 'pipeline registry is not initialized').upsertPipeline(input)
    },
    async getPipeline(input) {
      return requireInitialized(pipelineRegistry, 'pipeline registry is not initialized').getPipeline(input)
    },
    async listPipelines(input) {
      return requireInitialized(pipelineRegistry, 'pipeline registry is not initialized').listPipelines(input)
    },
    async createPipelineRun(input) {
      return requireInitialized(pipelineRegistry, 'pipeline registry is not initialized').createPipelineRun(input)
    },
    async updatePipelineRun(input) {
      return requireInitialized(pipelineRegistry, 'pipeline registry is not initialized').updatePipelineRun(input)
    },
    async listPipelineRuns(input) {
      return requireInitialized(pipelineRegistry, 'pipeline registry is not initialized').listPipelineRuns(input)
    },
    async runPipeline(input) {
      return requireInitialized(pipelineRunner, 'pipeline runner is not initialized').runPipeline(input)
    },
    async listDeadLetters(input) {
      const rows = await requireInitialized(deadLetterStore, 'dead-letter store is not initialized')
        .listDeadLetters(input)
      return rows.map(redactDeadLetterForCommunication)
    },
    async getDeadLetter(input) {
      const deadLetter = await requireInitialized(deadLetterStore, 'dead-letter store is not initialized')
        .getDeadLetter(input)
      return redactDeadLetterForCommunication(deadLetter)
    },
    async replayDeadLetter(input) {
      const runner = requireInitialized(pipelineRunner, 'pipeline runner is not initialized')
      if (typeof runner.replayDeadLetter !== 'function') {
        throw new Error('dead-letter replay is not implemented')
      }
      return redactReplayResultForCommunication(await runner.replayDeadLetter(input))
    },
    async listStagingDescriptors() {
      return requireInitialized(stagingInstaller, 'staging installer is not initialized').listStagingDescriptors()
    },
    async installStaging(input) {
      return requireInitialized(stagingInstaller, 'staging installer is not initialized').installStaging(input)
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
      .registerAdapter('plm:yuantus-wrapper', createYuantusPlmWrapperAdapterFactory())
      .registerAdapter('erp:k3-wise-webapi', createK3WiseWebApiAdapterFactory())
      .registerAdapter('erp:k3-wise-sqlserver', createK3WiseSqlServerChannelFactory())
    pipelineRegistry = createPipelineRegistry({ db })
    deadLetterStore = createDeadLetterStore({ db })
    watermarkStore = createWatermarkStore({ db })
    runLogger = createRunLogger({ pipelineRegistry })
    erpFeedbackWriter = createErpFeedbackWriter({
      context,
      logger,
    })
    stagingInstaller = {
      listStagingDescriptors,
      installStaging(input = {}) {
        return installStaging({
          context,
          projectId: input.projectId,
          baseId: input.baseId || null,
          logger,
        })
      },
    }
    pipelineRunner = createPipelineRunner({
      pipelineRegistry,
      externalSystemRegistry,
      adapterRegistry,
      deadLetterStore,
      watermarkStore,
      runLogger,
      erpFeedbackWriter,
    })

    // --- HTTP routes ------------------------------------------------------
    context.api.http.addRoute('GET', '/api/integration/health', async (_req, res) => {
      res.json(buildHealthPayload())
    })
    registeredRoutes.push('GET /api/integration/health')
    registeredRoutes.push(...registerIntegrationRoutes({
      context,
      logger,
      services: {
        externalSystemRegistry,
        adapterRegistry,
        pipelineRegistry,
        pipelineRunner,
        deadLetterStore,
        stagingInstaller,
      },
    }))

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
    deadLetterStore = null
    watermarkStore = null
    runLogger = null
    erpFeedbackWriter = null
    pipelineRunner = null
    stagingInstaller = null
    activeContext = null
    logger.info(`[${PLUGIN_ID}] deactivated`)
  },
}
