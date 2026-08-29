'use strict'

// ---------------------------------------------------------------------------
// plugin-integration-core
//
// PLM/ERP integration pipeline — system plugin MVP.
//
// Registers the integration health route, REST control plane, and cross-plugin
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
const { createReadSourceConfigStore } = require('./lib/read-source-config-store.cjs')
const { createStockPreparationAuditStore } = require('./lib/stock-preparation-audit-store.cjs')
const { createConfirmationDecisionReconcileLease } = require('./lib/stock-preparation-confirmation-decisions.cjs')
const {
  createStockPreparationPackInstallStore,
} = require('./lib/stock-preparation-pack-install-store.cjs')
const { createReadSourceCompositionConfigStore } = require('./lib/read-source-composition-config-store.cjs')
// BA-APPLY-2a (design-lock docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2
// 形态 B backend channel): approval gate + values-free checklist staging ONLY — this store never
// contacts the Bridge Agent.
const { createBridgeAgentChecklistStore } = require('./lib/bridge-agent-change-checklist-store.cjs')
const { createAdapterRegistry } = require('./lib/contracts.cjs')
const { createHttpAdapterFactory, HTTP_ADAPTER_METADATA } = require('./lib/adapters/http-adapter.cjs')
const { createYuantusPlmWrapperAdapterFactory, YUANTUS_PLM_ADAPTER_METADATA } = require('./lib/adapters/plm-yuantus-wrapper.cjs')
const { createK3WiseWebApiAdapterFactory, K3_WISE_WEBAPI_ADAPTER_METADATA } = require('./lib/adapters/k3-wise-webapi-adapter.cjs')
const { createK3WiseSqlServerChannelFactory, K3_WISE_SQLSERVER_ADAPTER_METADATA } = require('./lib/adapters/k3-wise-sqlserver-channel.cjs')
const { createK3WiseSqlServerReadOnlyExecutor } = require('./lib/adapters/k3-wise-sqlserver-executor.cjs')
const { createBridgeAgentReadonlyAdapterFactory, BRIDGE_READONLY_ADAPTER_METADATA } = require('./lib/adapters/bridge-agent-readonly-adapter.cjs')
const { createMetaSheetStagingSourceAdapterFactory, METASHEET_STAGING_ADAPTER_METADATA } = require('./lib/adapters/metasheet-staging-source-adapter.cjs')
const { createMetaSheetMultitableTargetAdapterFactory, METASHEET_MULTITABLE_ADAPTER_METADATA } = require('./lib/adapters/metasheet-multitable-target-adapter.cjs')
const { createDataSourceSqlReadonlySourceAdapterFactory, DATA_SOURCE_SQL_READONLY_ADAPTER_METADATA } = require('./lib/adapters/data-source-sql-readonly-source-adapter.cjs')
const { createDataSourceSqlWriteGatedTargetAdapterFactory, DATA_SOURCE_SQL_WRITE_GATED_ADAPTER_METADATA } = require('./lib/adapters/data-source-sql-write-gated-target-adapter.cjs')
const { createPipelineRegistry } = require('./lib/pipelines.cjs')
const { createIntegrationTemplateRegistry } = require('./lib/integration-templates.cjs')
const { createDeadLetterStore } = require('./lib/dead-letter.cjs')
const { createWatermarkStore } = require('./lib/watermark.cjs')
const { createRunLogger } = require('./lib/run-log.cjs')
const { createErpFeedbackWriter } = require('./lib/erp-feedback.cjs')
const { createPipelineRunner } = require('./lib/pipeline-runner.cjs')
// W-2: the B2a read-authorization registry, built HERE as well as in http-routes so the pipeline
// runner carries the fence too. The cross-plugin communication API below enters the runner directly
// — no route, no `requireAccess` — so a fence that lived only in the HTTP layer left that door open.
const { createB2aRegistry, B2A_AUTHORIZED_RUN_ID } = require('./lib/b2a-trial-registry.cjs')
const { installStaging, listStagingDescriptors } = require('./lib/staging-installer.cjs')
const { registerIntegrationRoutes } = require('./lib/http-routes.cjs')
const {
  loadStockPreparationRuntimeConfig,
} = require('./lib/sealed-export/stock-preparation-runtime-config.cjs')
const {
  createStockPreparationRuntimeDatabase,
} = require('./lib/sealed-export/stock-preparation-runtime-database.cjs')
const {
  createStockPreparationRuntimePersist,
} = require('./lib/sealed-export/stock-preparation-runtime-persist.cjs')
const {
  createStockPreparationSqlServerRuntime,
} = require('./lib/sealed-export/stock-preparation-sqlserver-runtime.cjs')
const manifest = require('./plugin.json')

const registeredRoutes = []
const PLUGIN_VERSION = manifest.version || '0.1.0'
const PLUGIN_PHASE = 'integration-core-mvp'
let activeContext = null
let credentialStore = null
let externalSystemRegistry = null
let readSourceConfigStore = null
let stockPreparationAuditStore = null
let stockPreparationPackInstallStore = null
let stockPreparationConfirmationDecisionLease = null
let readSourceCompositionConfigStore = null
let bridgeAgentChecklistStore = null
let adapterRegistry = null
let pipelineRegistry = null
let templateRegistry = null
let deadLetterStore = null
let watermarkStore = null
let runLogger = null
let erpFeedbackWriter = null
let pipelineRunner = null
let stagingInstaller = null
let stockPreparationSqlServerRuntime = null
let stockPreparationRuntimeDatabase = null

function buildCapabilityStatus() {
  return {
    externalSystems: Boolean(externalSystemRegistry),
    adapters: adapterRegistry ? adapterRegistry.listAdapterKinds() : [],
    pipelines: Boolean(pipelineRegistry),
    runner: Boolean(pipelineRunner),
    erpFeedback: Boolean(erpFeedbackWriter),
    deadLetters: Boolean(deadLetterStore),
    deadLetterReplay: Boolean(pipelineRunner && typeof pipelineRunner.replayDeadLetter === 'function'),
    staging: Boolean(stagingInstaller),
    stockPreparationSqlServerSealedSnapshot:
      Boolean(stockPreparationSqlServerRuntime),
  }
}

function buildHealthPayload() {
  return {
    ok: true,
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    phase: PLUGIN_PHASE,
    ts: Date.now(),
    milestone: PLUGIN_PHASE,
    capabilities: buildCapabilityStatus(),
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

/**
 * W-2. Strip the runner's already-asserted run marker off cross-plugin input.
 *
 * The marker is a SYMBOL, so it cannot be expressed in JSON and cannot arrive over a cross-plugin
 * call as things stand. Stripping it anyway costs one `hasOwnProperty` and removes the assumption:
 * "not expressible in JSON" is a property of today's transport, not a fence, and the marker decides
 * whether the runner CONTINUES an existing operation claim or takes its own. A caller able to set it
 * could ride an authorization somebody else was granted.
 *
 * Returns the input UNCHANGED — same object, not a copy — when the marker is absent, which is every
 * real call. The dormant path therefore hands the runner exactly what it handed it before.
 */
function withoutB2aAuthorizedRunMarker(input) {
  if (!input || typeof input !== 'object') return input
  if (!Object.prototype.hasOwnProperty.call(input, B2A_AUTHORIZED_RUN_ID)) return input
  const sanitized = { ...input }
  delete sanitized[B2A_AUTHORIZED_RUN_ID]
  return sanitized
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
      return {
        ok: true,
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        phase: PLUGIN_PHASE,
        ts: Date.now(),
      }
    },
    async getStatus() {
      const capabilities = buildCapabilityStatus()
      return {
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        phase: PLUGIN_PHASE,
        milestone: PLUGIN_PHASE,
        routesRegistered: registeredRoutes.length,
        credentialStore: credentialStore
          ? { source: credentialStore.source, format: credentialStore.format }
          : null,
        ...capabilities,
        capabilities,
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
      // W-2: this is an IN-PROCESS source read. It reaches the runner without passing a route, so the
      // B2a fence it meets is the runner's own — see `assertB2aPipelineSourceReadAuthorized`. On an
      // armed deployment an unregistered caller is refused here before any credential reload.
      return requireInitialized(pipelineRunner, 'pipeline runner is not initialized')
        .runPipeline(withoutB2aAuthorizedRunMarker(input))
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
      // W-2: replay's source-read leg is `runPipeline`, which carries the runner's B2a fence, so this
      // in-process door is gated on the same footing as the route.
      return redactReplayResultForCommunication(
        await runner.replayDeadLetter(withoutB2aAuthorizedRunMarker(input)),
      )
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
    const sqlServerQueryExecutor = createK3WiseSqlServerReadOnlyExecutor({ logger })
    externalSystemRegistry = createExternalSystemRegistry({
      db,
      credentialStore,
    })
    // S2-c (#1709): content-keyed read-source config versions + values-free audit.
    readSourceConfigStore = createReadSourceConfigStore({ db })
    // W5b (#3751/#3890): values-free audit trail for the stock-preparation write surface.
    stockPreparationAuditStore = createStockPreparationAuditStore({ db })
    // Customer-pack install LEDGER (migration 076). Terminal-state rows only; it is what makes a
    // pack's `ext_` columns enumerable, which is what lets a PLM refresh honour their ownership
    // bands instead of falling back to the frozen-template ones.
    stockPreparationPackInstallStore = createStockPreparationPackInstallStore({ db })
    // HG v1.2 PR-A: DB-backed single-active-reconciler lease (migration 077) for the
    // confirmation-decision ledger. The reconcile route fails closed without it.
    stockPreparationConfirmationDecisionLease = createConfirmationDecisionReconcileLease({ db })
    // C-R4-1 (#1709): the composition config store validates each step's read config is approved at
    // save time via readSourceConfigStore.getForRuntime, and the run route re-loads them at runtime.
    readSourceCompositionConfigStore = createReadSourceCompositionConfigStore({ db, readSourceConfigStore })
    // BA-APPLY-2a: content-keyed checklist versions + values-free audit + approval gate. Persists
    // ONLY — no credential/system dependency, and NOTHING here ever contacts the Bridge Agent.
    bridgeAgentChecklistStore = createBridgeAgentChecklistStore({ db })
    adapterRegistry = createAdapterRegistry({ logger })
      .registerAdapter('http', createHttpAdapterFactory(), { metadata: HTTP_ADAPTER_METADATA })
      .registerAdapter('plm:yuantus-wrapper', createYuantusPlmWrapperAdapterFactory(), { metadata: YUANTUS_PLM_ADAPTER_METADATA })
      .registerAdapter('erp:k3-wise-webapi', createK3WiseWebApiAdapterFactory(), { metadata: K3_WISE_WEBAPI_ADAPTER_METADATA })
      .registerAdapter('erp:k3-wise-sqlserver', createK3WiseSqlServerChannelFactory({ queryExecutor: sqlServerQueryExecutor }), { metadata: K3_WISE_SQLSERVER_ADAPTER_METADATA })
      .registerAdapter('bridge:legacy-sql-readonly', createBridgeAgentReadonlyAdapterFactory(), { metadata: BRIDGE_READONLY_ADAPTER_METADATA })
      .registerAdapter('metasheet:staging', createMetaSheetStagingSourceAdapterFactory({ context }), { metadata: METASHEET_STAGING_ADAPTER_METADATA })
      .registerAdapter('metasheet:multitable', createMetaSheetMultitableTargetAdapterFactory({ context }), { metadata: METASHEET_MULTITABLE_ADAPTER_METADATA })
      .registerAdapter('data-source:sql-readonly', createDataSourceSqlReadonlySourceAdapterFactory({ context }), { metadata: DATA_SOURCE_SQL_READONLY_ADAPTER_METADATA })
      .registerAdapter('data-source:sql-write-gated', createDataSourceSqlWriteGatedTargetAdapterFactory({ context }), { metadata: DATA_SOURCE_SQL_WRITE_GATED_ADAPTER_METADATA })
    pipelineRegistry = createPipelineRegistry({ db })
    // S3-2: the template registry needs externalSystemRegistry to bind + kind-validate the
    // caller-supplied source/target systems at instantiation (created above on line ~209).
    templateRegistry = createIntegrationTemplateRegistry({ db, externalSystemRegistry })
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
    // W-2: the B2a registry, built ONCE here at activation from server config, exactly as
    // http-routes builds its own copy — `createB2aRegistry` is pure in its config, so the two cannot
    // disagree, and a malformed registry now fails activation at this line instead of a few lines
    // later at route registration (still activation, still loudly, still before any request).
    // Unset env -> the host omits the key -> `null` -> the runner's fence is DORMANT and costs
    // nothing.
    const b2aTrialRegistry = createB2aRegistry({ config: context.config })
    pipelineRunner = createPipelineRunner({
      pipelineRegistry,
      externalSystemRegistry,
      adapterRegistry,
      deadLetterStore,
      watermarkStore,
      runLogger,
      erpFeedbackWriter,
      b2aTrialRegistry,
      // The SAME durable store the routes hand the guard. The one-time operation claim is a record
      // in it, so route and runner must look at one store or "one operation" would mean two.
      b2aClaimStore: context.storage,
    })

    try {
      const stockPreparationRuntimeConfig =
        loadStockPreparationRuntimeConfig()
      if (stockPreparationRuntimeConfig.enabled) {
        stockPreparationRuntimeDatabase =
          createStockPreparationRuntimeDatabase({
            connectionString:
              stockPreparationRuntimeConfig.runtimeDatabaseUrl,
            expectedRole:
              stockPreparationRuntimeConfig.runtimeDatabaseRole,
          })
        await stockPreparationRuntimeDatabase.assertReady()
        stockPreparationSqlServerRuntime =
          createStockPreparationSqlServerRuntime({
            artifactRoot: stockPreparationRuntimeConfig.artifactRoot,
            evidenceKey: stockPreparationRuntimeConfig.evidenceKey,
            externalSystemRegistry,
            identityKey: stockPreparationRuntimeConfig.identityKey,
            persistStockPreparation:
              createStockPreparationRuntimePersist({ context }),
            privateSignerMaterials:
              stockPreparationRuntimeConfig.privateSignerMaterials,
            qualificationKeyring:
              stockPreparationRuntimeConfig.qualificationKeyring,
            runtimeDatabase: stockPreparationRuntimeDatabase,
          })
      }
    } catch {
      if (stockPreparationRuntimeDatabase) {
        try {
          await stockPreparationRuntimeDatabase.close()
        } catch {
          // S6 remains unavailable; close is best effort here.
        }
      }
      stockPreparationSqlServerRuntime = null
      stockPreparationRuntimeDatabase = null
      if (typeof logger.warn === 'function') {
        logger.warn(
          `[${PLUGIN_ID}] sealed-snapshot runtime initialization refused; capability disabled`,
        )
      }
    }

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
        readSourceConfigStore,
        stockPreparationAuditStore,
        stockPreparationPackInstallStore,
        stockPreparationConfirmationDecisionLease,
        readSourceCompositionConfigStore,
        bridgeAgentChecklistStore,
        adapterRegistry,
        pipelineRegistry,
        templateRegistry,
        pipelineRunner,
        deadLetterStore,
        stagingInstaller,
        ...(stockPreparationSqlServerRuntime
          ? { stockPreparationSqlServerRuntime }
          : {}),
      },
    }))

    // --- Cross-plugin communication --------------------------------------
    context.communication.register(COMMUNICATION_NAMESPACE, buildCommunicationApi())

    logger.info(`[${PLUGIN_ID}] activated (${PLUGIN_PHASE}). routes=${registeredRoutes.length}`)
  },

  async deactivate() {
    if (!activeContext) return
    const logger = activeContext.logger || console
    if (stockPreparationRuntimeDatabase) {
      try {
        await stockPreparationRuntimeDatabase.close()
      } catch {
        if (typeof logger.warn === 'function') {
          logger.warn(
            `[${PLUGIN_ID}] sealed-snapshot runtime database close failed`,
          )
        }
      }
    }
    // PluginContext currently exposes no removeRoute hook for the addRoute
    // helper used above; host is expected to drop the router on deactivate.
    // We clear local state here so a re-activation starts clean.
    registeredRoutes.length = 0
    credentialStore = null
    externalSystemRegistry = null
    readSourceConfigStore = null
    readSourceCompositionConfigStore = null
    bridgeAgentChecklistStore = null
    adapterRegistry = null
    pipelineRegistry = null
    templateRegistry = null
    deadLetterStore = null
    watermarkStore = null
    runLogger = null
    erpFeedbackWriter = null
    pipelineRunner = null
    stagingInstaller = null
    stockPreparationSqlServerRuntime = null
    stockPreparationRuntimeDatabase = null
    activeContext = null
    logger.info(`[${PLUGIN_ID}] deactivated`)
  },
}
