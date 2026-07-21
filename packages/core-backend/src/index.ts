/**
 * MetaSheet Backend Core
 * 后端核心服务器入口
 * CI trigger for pnpm lockfile sync
 */

import type { Application, Request, Response, NextFunction, RequestHandler } from 'express';
import type { Server as HttpServer } from 'http';
import express from 'express'
import { createServer } from 'http'
import cors from 'cors'
import crypto from 'crypto'
import { EventEmitter } from 'eventemitter3'
import { Injector } from '@wendellhu/redi' // IoC Container
import { createContainer } from './di/container'
import { IConfigService, ILogger, ICollabService, ICoreAPI, IPluginLoader, ICollectionManager, IPLMAdapter, IAthenaAdapter, IDedupCADAdapter, ICADMLAdapter, IVisionAdapter, IFormulaService, ICommentService } from './di/identifiers'
import { PluginLoader, type LoadedPlugin } from './core/plugin-loader'
import { Logger, setLogContext } from './core/logger'
import {
  getWorkdayCalendarRegistry,
  type WorkdayCalendarPort,
} from './core/workday-calendar-port'
import type {
  CoreAPI,
  UserInfo,
  TokenOptions,
  UploadOptions,
  MessageHandler,
  RpcHandler,
  QueueJobData,
  PluginContext,
  PluginCommunication,
  PluginStorage,
  PluginApiMethod,
  PluginLifecycle,
} from './types/plugin'
import type { User } from './auth/AuthService'
import { poolManager } from './integration/db/connection-pool'
import { reconcileOrphanedBulkJobs } from './services/ai-bulk-job-service'
import type { AiUsageQueryFn } from './services/ai-usage-ledger'
import { eventBus } from './integration/events/event-bus'
import { initializeEventBusService } from './integration/events/event-bus-service'
import { messageBus } from './integration/messaging/message-bus'
import { jwtAuthMiddleware, optionalJwtAuthMiddleware, isPublicFormAuthBypass, isWhitelisted } from './auth/jwt-middleware'
import { authService } from './auth/AuthService'
import { cache } from './cache-init'
import {
  findObjectSheet as findProvisionedObjectSheet,
  getObjectSheetId as getProvisionedObjectSheetId,
  getObjectFieldId as getProvisionedObjectFieldId,
  resolveObjectFieldIds as resolveProvisionedObjectFieldIds,
  ensureObject as ensureMultitableObject,
  ensureView as ensureMultitableView,
  patchObjectFieldProperty as patchProvisionedObjectFieldProperty,
  getObjectField as getProvisionedObjectField,
  type MultitableProvisioningQueryFn,
} from './multitable/provisioning'
import {
  createRecord as createMultitableRecord,
  deleteRecord as deleteMultitableRecord,
  getRecord as getMultitableRecord,
  listRecords as listMultitableRecords,
  patchRecord as patchMultitableRecord,
  queryRecords as queryMultitableRecords,
  type MultitableRecordsQueryFn,
} from './multitable/records'
import { resolveSheetCapabilitiesForUser } from './multitable/sheet-capabilities'
import { isRecordReadDeniedForUser, loadRowLevelReadDenyEnabled } from './multitable/permission-service'
import {
  assertPluginOwnsObject,
  assertPluginOwnsSheet,
  claimPluginObjectScope,
  createPluginScopedMultitableApi,
  MultitableObjectScopeError,
  MultitableSheetScopeError,
} from './multitable/plugin-scope'
import {
  acquireStockPreparationPersistUnitOfWorkLocks,
  validateStockPreparationPersistUnitOfWorkInput,
} from './multitable/stock-preparation-persist-unit-of-work'
import { installMetrics, metrics as promMetrics, requestMetricsMiddleware } from './metrics/metrics'
import { APIGateway } from './gateway/APIGateway'
import { getPoolStats } from './db/pg'
import { getBuildInfo } from './config/build-info'
import { isDatabaseSchemaError } from './utils/database-errors'
import { startOperationAuditRetention } from './audit/operation-audit-retention'
import { startMultitableAttachmentCleanup, startMultitableAttachmentBlobPurge } from './multitable/attachment-orphan-retention'
import { startMetaRevisionRetention } from './multitable/meta-revision-retention'
import { startFilesOrphanBlobRetention } from './services/files-orphan-blob-retention'
import { isFieldAlwaysReadOnly, deriveFieldPermissions, isFieldWriteForbidden, FieldWritePermissionDeniedError } from './multitable/permission-derivation'
import { AutomationService, setAutomationServiceInstance } from './multitable/automation-service'
import { tenantContext } from './db/sharding/tenant-context'
import { attendanceAuditMiddleware, attendanceSecurityMiddleware } from './middleware/attendance-production'
import {
  correlationContextEnrichmentMiddleware,
  correlationErrorHandler,
  correlationIdMiddleware,
} from './middleware/correlation'
import { approvalsRouter } from './routes/approvals'
import { authRouter } from './routes/auth'
import { auditLogsRouter } from './routes/audit-logs'
import { approvalHistoryRouter } from './routes/approval-history'
import { approvalMetricsRouter } from './routes/approval-metrics'
import {
  resolveApprovalSlaSchedulerLeaderOptions,
  startApprovalSlaScheduler,
  stopApprovalSlaScheduler,
} from './services/ApprovalSlaScheduler'
import { ApprovalProductService } from './services/ApprovalProductService'
// S7-1/S7-2/S7-3 (OD-S7-5=d): host-resolved chain-depth cap + org-scoped directory-read path the
// attendance dynamic-assignee resolver PORT exposes to plugin-attendance. The plugin validates
// `manager_at_level.level` against MAX (never re-parses APPROVAL_MANAGER_CHAIN_MAX_LEVELS) and freezes
// direct_manager / dept_head via resolveApprovalRequesterOrgRelations (org-anchored, read-only).
import {
  MAX_MANAGER_CHAIN_LEVELS,
  resolveApprovalRequesterOrgRelations,
} from './services/ApprovalDirectoryOrg'
import { query as pgQuery } from './db/pg'
import {
  resolveAttendanceSchedulerIntervalMs,
  resolveAttendanceSchedulerLeaderOptions,
  resolveAttendanceNotificationDeliveryJob,
  resolveCompTimeExpiryReminderJob,
  resolveUnscheduledReminderJob,
  registerAttendanceSchedulerJob,
  startAttendanceScheduler,
  stopAttendanceScheduler,
} from './services/AttendanceScheduler'
import {
  resolveWebhookRetrySchedulerIntervalMs,
  resolveWebhookRetrySchedulerLeaderOptions,
  startWebhookRetryScheduler,
  stopWebhookRetryScheduler,
} from './services/WebhookRetryScheduler'
import {
  resolveLedgerRetentionSchedulerIntervalMs,
  resolveLedgerRetentionSchedulerLeaderOptions,
  startLedgerRetentionScheduler,
  stopLedgerRetentionScheduler,
} from './services/LedgerRetentionScheduler'
import {
  resolveDingTalkGroupDeliveryRetentionSchedulerIntervalMs,
  resolveDingTalkGroupDeliveryRetentionSchedulerLeaderOptions,
  startDingTalkGroupDeliveryRetentionScheduler,
  stopDingTalkGroupDeliveryRetentionScheduler,
} from './services/dingtalk-group-delivery-retention-scheduler'
import {
  resolveDingTalkCardPersonDeliveryRetentionSchedulerIntervalMs,
  resolveDingTalkCardPersonDeliveryRetentionSchedulerLeaderOptions,
  startDingTalkCardPersonDeliveryRetentionScheduler,
  stopDingTalkCardPersonDeliveryRetentionScheduler,
} from './services/dingtalk-card-person-delivery-retention-scheduler'
import { initWebhookEventBridge } from './multitable/webhook-event-bridge'
import { ApprovalBreachNotifier } from './services/ApprovalBreachNotifier'
import {
  createApprovalBreachChannelsFromEnv,
} from './services/breach-channels'
import { rolesRouter } from './routes/roles'
import { snapshotsRouter } from './routes/snapshots'
import changeManagementRouter from './routes/change-management'
import { permissionsRouter } from './routes/permissions'
import { attendanceAdminRouter } from './routes/attendance-admin'
import { filesRouter } from './routes/files'
import { spreadsheetsRouter } from './routes/spreadsheets'
import { spreadsheetPermissionsRouter } from './routes/spreadsheet-permissions'
import { eventsRouter } from './routes/events'
import { commentsRouter } from './routes/comments'
import { dataSourcesRouter, getDataSourceManager } from './routes/data-sources'
import { createDataSourcePluginFacade, createDataSourceWritePluginFacade } from './data-adapters/data-source-plugin-facade'
import { federationRouter } from './routes/federation'
import internalRouter from './routes/internal'
import cacheTestRouter from './routes/cache-test'
import { kanbanRouter } from './routes/kanban'
import { createPlatformAppsRouter } from './routes/platform-apps'
import { viewsRouter } from './routes/views'
import { initAdminRoutes } from './routes/admin-routes'
import { adminUsersRouter } from './routes/admin-users'
import { adminDirectoryRouter } from './routes/admin-directory'
import { adminDirectoryLocalRouter } from './routes/admin-directory-local'
import { adminDirectoryDepartmentBindingsRouter } from './routes/admin-directory-department-bindings'
import { adminDirectoryRoutingPolicyRouter } from './routes/admin-directory-routing-policy'
import { adminDirectoryOrgTransfersRouter } from './routes/admin-directory-org-transfers'
import { startDirectorySyncScheduler, stopDirectorySyncScheduler } from './directory/directory-sync-scheduler'
import { canaryRoutes } from './routes/canary-routes'
import { CanaryRouter } from './canary/CanaryRouter'
import { createCanaryInterceptor } from './canary/CanaryInterceptor'
import { PluginRuntimeSecurityService } from './security/plugin-runtime-security-service'
import workflowRouter from './routes/workflow'
import workflowDesignerRouter from './routes/workflow-designer'
import plmWorkbenchRouter from './routes/plm-workbench'
import plmEmbedRouter from './routes/plm-embed'
import plmEmbedDiscussionWriteRouter from './routes/plm-embed-discussion'
import plmEmbedDiscussionReadRouter from './routes/plm-embed-discussion-read'
import { createHostPluginStorage } from './plugins/plugin-durable-storage'
import { univerMockRouter } from './routes/univer-mock'
import { univerMetaRouter } from './routes/univer-meta'
import { isOapiAllowlistRequest } from './multitable/oapi-read-allowlist'
import { dashboardRouter } from './routes/dashboard'
import { automationWebhookJsonParser, createAutomationRoutes } from './routes/automation'
import { createMultitableAiRoutes } from './routes/multitable-ai'
import { QueueServiceImpl } from './services/QueueService'
import { createMultitableButtonRoutes } from './routes/multitable-button'
import { apiTokensRouter } from './routes/api-tokens'
import { SnapshotService } from './services/SnapshotService'
import { MetricsStreamService } from './services/MetricsStreamService'
import { DingTalkInteractiveCardStreamWorker } from './integrations/dingtalk/interactive-card-stream'
import { notificationService } from './services/NotificationService'
import { AfterSalesApprovalBridgeService } from './services/AfterSalesApprovalBridgeService'
import {
  listAutomationRules,
  upsertAutomationRules,
  type AutomationRegistryQueryFn,
} from './services/PluginAutomationRegistryService'
import {
  applyRoleMatrix,
  type RbacProvisioningQueryFn,
} from './services/PluginRbacProvisioningService'
import {
  getPlatformAppInstance,
  listPlatformAppInstances,
  upsertPlatformAppInstance,
  type PlatformAppInstanceRegistryQueryFn,
} from './services/PlatformAppInstanceRegistryService'
import type { UnifiedApprovalDTO } from './services/approval-bridge-types'
import { cacheRegistry } from '../core/cache/CacheRegistry'
import { loadObservabilityConfig } from './config/observability'
import { initObservability } from './observability/otel'
import { isPlmEnabled } from './config/product-mode'
import { resolvePluginRuntimeConfig } from './plugin-runtime-config'

type PluginRuntimeState = {
  status: 'active' | 'inactive' | 'failed'
  error?: string
  lastAttempt?: string
}

type PluginRouteRegistration = {
  active: boolean
  method: string
  path: string
}

function disabledFeatureHandler(message: string): RequestHandler {
  return (_req, res) => {
    res.status(404).json({
      ok: false,
      error: {
        code: 'FEATURE_DISABLED',
        message,
      },
    })
  }
}

export class MetaSheetServer {
  private app: Application
  private httpServer: HttpServer
  private logger: Logger
  private eventBus: EventEmitter
  private pluginStatus = new Map<string, PluginRuntimeState>()
  private disabledPlugins = new Set<string>()
  private pluginApis = new Map<string, Record<string, PluginApiMethod>>()
  private pluginRouteRegistrationSeq = 0
  private pluginRouteRegistrations = new Map<string, PluginRouteRegistration>()
  private pluginRouteRegistrationIdsByPlugin = new Map<string, Set<string>>()
  private pluginCommunicationNamespacesByPlugin = new Map<string, Set<string>>()
  private pluginCommunicationNamespaceOwners = new Map<string, string>()
  private pluginAttendanceSchedulerUnregistersByPlugin = new Map<string, Set<() => void>>()
  // T3-2: the plugin (if any) that currently owns the bound WorkdayCalendarPort provider, so a
  // reload/deactivate of that plugin unbinds it and the SLA path fails open again.
  private workdayCalendarProviderOwner: string | null = null
  private port: number
  private host?: string
  private portLocked: boolean
  private shuttingDown = false
  private snapshotService: SnapshotService
  private observabilityShutdown?: () => Promise<void>
  private observabilityEnabled = false
  private stopOperationAuditRetention?: () => void
  private stopMultitableAttachmentCleanup?: () => void
  private stopMetaRevisionRetention?: () => void
  private stopFilesOrphanBlobRetention?: () => void
  private stopMultitableAttachmentBlobPurge?: () => void
  private stopApprovalAttachmentWorkers?: () => void | Promise<void>
  private automationService?: AutomationService
  // Owner P1 (head 1d3854c7a): explicit readiness bit for the durable fail-closed chain. TRUE only after
  // the FULL AutomationService init sequence (constructor + init() + loadAndRegisterAllScheduled()) has
  // succeeded — `Boolean(this.automationService)` alone was bypassable, because the field used to be
  // assigned right after construction and never cleared when init()/load threw. The init block below is
  // publish-last (field + this bit + singleton set only on full success), so the two can never disagree;
  // the durable boot asserts THIS bit.
  private automationServiceReady = false
  private apiGateway?: APIGateway
  private yjsCleanupTimer?: NodeJS.Timeout
  private yjsSyncMetricsSource?: { getMetrics(): { activeDocCount: number; docIds: string[] } }
  private yjsBridgeMetricsSource?: { getMetrics(): { pendingWriteCount: number; observedDocCount: number; flushSuccessCount: number; flushFailureCount: number } }
  private yjsSocketMetricsSource?: { getMetrics(): { activeRecordCount: number; activeSocketCount: number } }
  private afterSalesApprovalBridgeService: AfterSalesApprovalBridgeService
  private pluginRuntimeSecurityService = new PluginRuntimeSecurityService()
  // Optional bypass/degraded-mode flags for local debug
  private disableWorkflow = process.env.DISABLE_WORKFLOW === 'true'
  private disableEventBus = process.env.DISABLE_EVENT_BUS === 'true'
  private metricsStreamService?: MetricsStreamService
  private dingtalkInteractiveCardStreamWorker?: DingTalkInteractiveCardStreamWorker
  // P2 durable-delivery S5: the outbox dispatch loop handle. null unless AUTOMATION_DURABLE_DELIVERY_ENABLED
  // is ON (bootDurableDelivery returns null when the flag is off → no loop, no reads, byte-identical startup).
  private durableDeliveryLoop: import('./multitable/automation-durable-dispatch-loop').DispatchLoopHandle | null = null

  // IoC Container
  private injector: Injector

  // Helper to get PluginLoader from container
  private get pluginLoader(): PluginLoader {
    return this.injector.get(IPluginLoader)
  }

  constructor(options: { port?: number; host?: string; pluginDirs?: string[] } = {}) {
    // Initialize IoC Container
    this.injector = createContainer({ pluginDirs: options.pluginDirs })
    
    this.app = express()
    this.httpServer = createServer(this.app)
    this.eventBus = new EventEmitter()
    this.logger = new Logger('MetaSheetServer')
    this.portLocked = typeof options.port === 'number'
    this.port = options.port ?? parseInt(process.env.PORT || '7778')
    this.host = options.host ?? process.env.HOST

    // 创建核心API
    const coreAPI = this.createCoreAPI()
    
    // Bind CoreAPI to container (needed by PluginLoader)
    this.injector.add([ICoreAPI, { useValue: coreAPI }])
    this.afterSalesApprovalBridgeService = new AfterSalesApprovalBridgeService(
      undefined,
      undefined,
      {
        onApproved: async (approval, decision) => {
          await this.handleAfterSalesApprovalDecisionCallback(approval, decision)
        },
        onRejected: async (approval, decision) => {
          await this.handleAfterSalesApprovalDecisionCallback(approval, decision)
        },
      },
    )
    
    this.snapshotService = new SnapshotService()

    this.setupMiddleware()
    // WebSocket setup is now handled by CollabService via start()
    this.initializeCache()
    this.registerInternalPluginApis()
  }

  /**
   * 创建核心API
   */

  private createCoreAPI(): CoreAPI {
    const routes = new Map<string, RequestHandler>()

    return {
      injector: this.injector,
      tenant: {
        getTenantId: () => tenantContext.getTenantId(),
        requireTenantId: () => tenantContext.requireTenantId(),
      },
      formula: {
        calculate: (name, ...args) => this.injector.get(IFormulaService).calculate(name, ...args),
        calculateFormula: (exp, resolver) => this.injector.get(IFormulaService).calculateFormula(exp, resolver),
        getAvailableFunctions: () => this.injector.get(IFormulaService).getAvailableFunctions()
      },
      collection: {
        register: (definition) => {
          this.injector.get(ICollectionManager).register(definition)
        },
        getRepository: (name) => {
          return this.injector.get(ICollectionManager).getRepository(name)
        },
        sync: async () => {
          await this.injector.get(ICollectionManager).sync()
        }
      },

      http: {
        // ... (existing http impl)
        addRoute: (method: string, path: string, handler: RequestHandler) => {
          const key = `${method.toUpperCase()}:${path}`
          routes.set(key, handler)

          // 动态注册路由到Express
          const methodLower = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch'
          this.app[methodLower](path,
            // 保护 /api/**（auth 白名单在全局中间件判定）
            async (req: Request, res: Response, next: NextFunction) => {
              const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
              try {
                await handler(req, res, next)
              } catch (error) {
                this.logger.error(`Route handler error: ${path}`, error as Error)
                if (!res.headersSent) {
                  res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
                }
              } finally {
                // 结束计时（如果已安装指标中间件）
                if (typeof endTimer === 'function') endTimer({ route: path, method: req.method })(res.statusCode)
              }
            }
          )

          this.logger.info(`Route registered: ${method} ${path}`)
        },
        removeRoute: (path: string) => {
          // Express doesn't support removing routes easily
          // In production, you'd need a more sophisticated solution
          this.logger.warn(`Route removal not implemented: ${path}`)
        },
        middleware: (_name: string) => {
          // Return middleware by name
          return undefined
        }
      },

      plm: {
        getProducts: (options) => this.injector.get(IPLMAdapter).getProducts(options),
        getProductBOM: (id) => this.injector.get(IPLMAdapter).getProductBOM(id)
      },

      athena: {
        listFolders: (parentId) => this.injector.get(IAthenaAdapter).listFolders(parentId),
        searchDocuments: (params) => this.injector.get(IAthenaAdapter).searchDocuments(params),
        getDocument: (id) => this.injector.get(IAthenaAdapter).getDocument(id),
        uploadDocument: (params) => this.injector.get(IAthenaAdapter).uploadDocument(params)
      },

      dedup: {
        search: (fileId, threshold) => this.injector.get(IDedupCADAdapter).search(fileId, threshold),
        compare: (sourceId, targetId) => this.injector.get(IDedupCADAdapter).compare(sourceId, targetId)
      },

      ai: {
        analyze: (fileId) => this.injector.get(ICADMLAdapter).analyze(fileId),
        extractText: (fileId) => this.injector.get(ICADMLAdapter).extractText(fileId),
        predictCost: (fileId, params) => this.injector.get(ICADMLAdapter).predictCost(fileId, params)
      },

      vision: {
        generateDiff: (sourceId, targetId) => this.injector.get(IVisionAdapter).generateDiff(sourceId, targetId)
      },

      database: {
        query: async (sql: string, params?: unknown[]) => {
          return (await poolManager.get().query(sql, params)).rows
        },
        transaction: async <T>(callback: (trx: import('./types/plugin').DatabaseTransaction) => Promise<T>): Promise<T> => {
          return poolManager.get().transaction(async (client) => {
            // Adapt the pool client to DatabaseTransaction interface
            const trx: import('./types/plugin').DatabaseTransaction = {
              query: async (sql: string, params?: unknown[]) => {
                const result = await client.query(sql, params)
                return result.rows
              },
              rawQuery: async (queryConfig: unknown) => {
                return client.query(queryConfig as any)
              },
              __rawClient: client,
              commit: async () => {
                // Commit is handled by the pool manager
              },
              rollback: async () => {
                // Rollback is handled by the pool manager
              }
            }
            return callback(trx)
          })
        },
        model: (_name: string): import('./types/plugin').DatabaseModel => ({
          find: async () => [],
          findOne: async () => null,
          create: async (data) => data,
          update: async () => 0,
          delete: async () => 0
        })
      },

      multitable: {
        provisioning: {
          getObjectSheetId: (projectId, objectId) => getProvisionedObjectSheetId(projectId, objectId),
          getFieldId: (projectId, objectId, fieldId) => getProvisionedObjectFieldId(projectId, objectId, fieldId),
          findObjectSheet: async ({ projectId, objectId }) => {
            const txQuery: MultitableProvisioningQueryFn = async (sql, params) => {
              const result = await poolManager.get().query(sql, params)
              return {
                rows: Array.isArray((result as { rows?: unknown[] }).rows)
                  ? (result as { rows: unknown[] }).rows
                  : [],
                rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                  ? (result as { rowCount: number }).rowCount
                  : undefined,
              }
            }
            return findProvisionedObjectSheet(txQuery, projectId, objectId)
          },
          resolveFieldIds: async ({ projectId, objectId, fieldIds }) => {
            return resolveProvisionedObjectFieldIds(projectId, objectId, fieldIds)
          },
          ensureObject: async ({ projectId, baseId, descriptor }) => {
            return poolManager.get().transaction(async ({ query }) => {
              const txQuery: MultitableProvisioningQueryFn = async (sql, params) => {
                const result = await query(sql, params)
                return {
                  rows: Array.isArray((result as { rows?: unknown[] }).rows)
                    ? (result as { rows: unknown[] }).rows
                    : [],
                }
              }
              return ensureMultitableObject({
                query: txQuery,
                projectId,
                baseId,
                descriptor,
              })
            })
          },
          ensureView: async ({ projectId, sheetId, descriptor }) => {
            return poolManager.get().transaction(async ({ query }) => {
              const txQuery: MultitableProvisioningQueryFn = async (sql, params) => {
                const result = await query(sql, params)
                return {
                  rows: Array.isArray((result as { rows?: unknown[] }).rows)
                    ? (result as { rows: unknown[] }).rows
                    : [],
                }
              }
              return ensureMultitableView({
                query: txQuery,
                projectId,
                sheetId,
                descriptor,
              })
            })
          },
          patchObjectFieldProperty: async ({ projectId, objectId, fieldId, propertyPatch }) => {
            return poolManager.get().transaction(async ({ query }) => {
              const txQuery: MultitableProvisioningQueryFn = async (sql, params) => {
                const result = await query(sql, params)
                return {
                  rows: Array.isArray((result as { rows?: unknown[] }).rows)
                    ? (result as { rows: unknown[] }).rows
                    : [],
                  rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                    ? (result as { rowCount: number }).rowCount
                    : undefined,
                }
              }
              return patchProvisionedObjectFieldProperty({
                query: txQuery,
                projectId,
                objectId,
                fieldId,
                propertyPatch,
              })
            })
          },
          getObjectField: async ({ projectId, objectId, fieldId }) => {
            // Read-only — a plain pooled query (no transaction needed for a SELECT).
            const readQuery: MultitableProvisioningQueryFn = async (sql, params) => {
              const result = await poolManager.get().query(sql, params)
              return {
                rows: Array.isArray((result as { rows?: unknown[] }).rows)
                  ? (result as { rows: unknown[] }).rows
                  : [],
                rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                  ? (result as { rowCount: number }).rowCount
                  : undefined,
              }
            }
            return getProvisionedObjectField({ query: readQuery, projectId, objectId, fieldId })
          },
        },
        records: {
          listRecords: async ({ sheetId, limit, offset }) => {
            const txQuery: MultitableRecordsQueryFn = async (sql, params) => {
              const result = await poolManager.get().query(sql, params)
              return {
                rows: Array.isArray((result as { rows?: unknown[] }).rows)
                  ? (result as { rows: unknown[] }).rows
                  : [],
                rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                  ? (result as { rowCount: number }).rowCount
                  : undefined,
              }
            }
            return listMultitableRecords({
              query: txQuery,
              sheetId,
              limit,
              offset,
            })
          },
          queryRecords: async ({ sheetId, filters, search, orderBy, limit, offset }) => {
            const txQuery: MultitableRecordsQueryFn = async (sql, params) => {
              const result = await poolManager.get().query(sql, params)
              return {
                rows: Array.isArray((result as { rows?: unknown[] }).rows)
                  ? (result as { rows: unknown[] }).rows
                  : [],
                rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                  ? (result as { rowCount: number }).rowCount
                  : undefined,
              }
            }
            return queryMultitableRecords({
              query: txQuery,
              sheetId,
              filters,
              search,
              orderBy,
              limit,
              offset,
            })
          },
          createRecord: async ({ sheetId, data }) => {
            return poolManager.get().transaction(async ({ query }) => {
              const txQuery: MultitableRecordsQueryFn = async (sql, params) => {
                const result = await query(sql, params)
                return {
                  rows: Array.isArray((result as { rows?: unknown[] }).rows)
                    ? (result as { rows: unknown[] }).rows
                    : [],
                  rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                    ? (result as { rowCount: number }).rowCount
                    : undefined,
                }
              }
              return createMultitableRecord({
                query: txQuery,
                sheetId,
                data,
              })
            })
          },
          getRecord: async ({ sheetId, recordId }) => {
            const txQuery: MultitableRecordsQueryFn = async (sql, params) => {
              const result = await poolManager.get().query(sql, params)
              return {
                rows: Array.isArray((result as { rows?: unknown[] }).rows)
                  ? (result as { rows: unknown[] }).rows
                  : [],
                rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                  ? (result as { rowCount: number }).rowCount
                  : undefined,
              }
            }
            return getMultitableRecord({
              query: txQuery,
              sheetId,
              recordId,
            })
          },
          patchRecord: async ({ sheetId, recordId, changes }) => {
            return poolManager.get().transaction(async ({ query }) => {
              const txQuery: MultitableRecordsQueryFn = async (sql, params) => {
                const result = await query(sql, params)
                return {
                  rows: Array.isArray((result as { rows?: unknown[] }).rows)
                    ? (result as { rows: unknown[] }).rows
                    : [],
                  rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                    ? (result as { rowCount: number }).rowCount
                    : undefined,
                }
              }
              return patchMultitableRecord({
                query: txQuery,
                sheetId,
                recordId,
                changes,
              })
            })
          },
          deleteRecord: async ({ sheetId, recordId }) => {
            return poolManager.get().transaction(async ({ query }) => {
              const txQuery: MultitableRecordsQueryFn = async (sql, params) => {
                const result = await query(sql, params)
                return {
                  rows: Array.isArray((result as { rows?: unknown[] }).rows)
                    ? (result as { rows: unknown[] }).rows
                    : [],
                  rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                    ? (result as { rowCount: number }).rowCount
                    : undefined,
                }
              }
              return deleteMultitableRecord({
                query: txQuery,
                sheetId,
                recordId,
              })
            })
          },
        },
      },

      auth: {
        verifyToken: async (token: string) => {
          return await authService.verifyToken(token)
        },
        checkPermission: (user: UserInfo, resource: string, action: string) => {
          // Convert UserInfo to User for authService
          const userAsUser: User = {
            id: user.id,
            email: user.email || '',
            name: user.name || '',
            role: user.roles?.[0] || 'user',
            permissions: user.permissions || [],
            created_at: new Date(),
            updated_at: new Date()
          }
          return authService.checkPermission(userAsUser, resource, action)
        },
        createToken: (user: UserInfo, _options?: TokenOptions) => {
          // Convert UserInfo to User for authService
          const userAsUser: User = {
            id: user.id,
            email: user.email || '',
            name: user.name || '',
            role: user.roles?.[0] || 'user',
            permissions: user.permissions || [],
            created_at: new Date(),
            updated_at: new Date()
          }
          return authService.createToken(userAsUser)
        }
      },

      events: {
        on: (evt: string | RegExp, handler: MessageHandler) => {
          // Adapt MessageHandler to eventBus handler signature
          const adaptedHandler = (payload: unknown) => handler(payload, evt as string)
          return eventBus.subscribe(evt as string, adaptedHandler)
        },
        once: (evt: string, handler: MessageHandler) => {
          const subscriptionId: { value: string } = { value: '' }
          const wrappedHandler = (data: unknown) => {
            handler(data, evt)
            eventBus.unsubscribe(subscriptionId.value)
          }
          subscriptionId.value = eventBus.subscribe(evt, wrappedHandler)
          return subscriptionId.value
        },
        emit: (evt: string, data?: unknown) => eventBus.emit(evt, data),
        off: (idOrPlugin: string) => eventBus.unsubscribe(idOrPlugin)
      },

      storage: {
        upload: async (_file: Buffer, _options: UploadOptions) => {
          const fileId = `file_${Date.now()}`
          this.logger.info(`File uploaded: ${fileId}`)
          return fileId
        },
        download: async (_fileId: string) => {
          return Buffer.from('mock file content')
        },
        delete: async (fileId: string) => {
          this.logger.info(`File deleted: ${fileId}`)
        },
        getUrl: (fileId: string) => {
          return `http://localhost:${this.port}/files/${fileId}`
        }
      },

      cache: {
        get: async <T = unknown>(key: string): Promise<T | null> => {
          const result = await cache.get(key)
          return result.ok ? (result.value as T) : null
        },
        set: async <T = unknown>(key: string, value: T, ttl?: number): Promise<void> => {
          await cache.set(key, value, ttl)
        },
        delete: async (key: string): Promise<void> => {
          await cache.del(key)
        },
        clear: async (): Promise<void> => {
          // 清空缓存 - 对于内存缓存，需要扩展API
          this.logger.warn('Cache clear not implemented for all cache types')
        }
      },

      queue: {
        push: async <T = unknown>(job: QueueJobData | T): Promise<string> => {
          const jobId = `job_${Date.now()}`
          this.logger.info(`Job queued: ${jobId}`, { job })
          return jobId
        },
        process: <T = unknown>(type: string, _handler: (job: import('./types/plugin').Job<T>) => Promise<unknown>) => {
          this.logger.info(`Queue processor registered: ${type}`)
        },
        cancel: async (jobId: string) => {
          this.logger.info(`Job cancelled: ${jobId}`)
        }
      },

      websocket: {
        broadcast: (event: string, data: unknown) => {
          this.injector.get(ICollabService).broadcast(event, data)
        },
        broadcastTo: (room: string, event: string, data: unknown) => {
          this.injector.get(ICollabService).broadcastTo(room, event, data)
        },
        sendTo: (userId: string, event: string, data: unknown) => {
          this.injector.get(ICollabService).sendTo(userId, event, data)
        },
        join: (room: string, options?: { userId?: string; socketId?: string }) => {
          return this.injector.get(ICollabService).join(room, options)
        },
        leave: (room: string, options?: { userId?: string; socketId?: string }) => {
          return this.injector.get(ICollabService).leave(room, options)
        },
        onConnection: (handler: (socket: import('./types/plugin').SocketInfo) => void | Promise<void>) => {
          this.injector.get(ICollabService).onConnection(handler)
        }
      },
      messaging: {
        publish: <T = unknown>(topic: string, payload: T, opts?: import('./types/plugin').PublishOptions) => {
          // Adapt PublishOptions - messageBus uses MessagePriority string, plugin uses number
          const adaptedOpts = opts ? {
            ...opts,
            priority: opts.priority !== undefined
              ? (opts.priority <= 3 ? 'low' : opts.priority <= 6 ? 'normal' : 'high') as 'low' | 'normal' | 'high'
              : undefined
          } : undefined
          messageBus.publish(topic, payload, adaptedOpts)
        },
        subscribe: <T = unknown>(topic: string, handler: MessageHandler<T>) => {
          // Adapt MessageHandler to messageBus Handler signature
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const adaptedHandler = (msg: any) => handler(msg.payload as T, msg.topic)
          return messageBus.subscribe(topic, adaptedHandler)
        },
        subscribePattern: <T = unknown>(pattern: string, handler: MessageHandler<T>) => {
          // Adapt MessageHandler to messageBus Handler signature
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const adaptedHandler = (msg: any) => handler(msg.payload as T, msg.topic)
          return messageBus.subscribePattern(pattern, adaptedHandler)
        },
        unsubscribe: (id: string) => messageBus.unsubscribe(id),
        request: <T = unknown, R = unknown>(topic: string, payload: T, timeoutMs?: number): Promise<R> => messageBus.request(topic, payload, timeoutMs),
        rpcHandler: <T = unknown, R = unknown>(topic: string, handler: RpcHandler<T, R>) => messageBus.createRpcHandler(topic, handler)
      }
    }
  }

  private registerPluginRoute(pluginName: string, method: string, path: string, handler: RequestHandler): void {
    const methodUpper = method.toUpperCase()
    const methodLower = method.toLowerCase()
    if (!['get', 'post', 'put', 'delete', 'patch'].includes(methodLower)) {
      throw new Error(`Unsupported plugin route method: ${method}`)
    }

    const registrationId = `${pluginName}:${methodUpper}:${path}:${++this.pluginRouteRegistrationSeq}`
    const registration: PluginRouteRegistration = {
      active: true,
      method: methodUpper,
      path,
    }
    this.pluginRouteRegistrations.set(registrationId, registration)

    const registrationIds = this.pluginRouteRegistrationIdsByPlugin.get(pluginName) ?? new Set<string>()
    registrationIds.add(registrationId)
    this.pluginRouteRegistrationIdsByPlugin.set(pluginName, registrationIds)

    this.app[methodLower as 'get' | 'post' | 'put' | 'delete' | 'patch'](
      path,
      async (req: Request, res: Response, next: NextFunction) => {
        if (!registration.active) {
          return next()
        }

        const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
        try {
          await handler(req, res, next)
        } catch (error) {
          this.logger.error(`Plugin route handler error: ${pluginName} ${methodUpper} ${path}`, error as Error)
          if (!res.headersSent) {
            res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
          }
        } finally {
          if (typeof endTimer === 'function') endTimer({ route: path, method: req.method })(res.statusCode)
        }
      },
    )

    this.logger.info(`Plugin route registered: ${pluginName} ${methodUpper} ${path}`)
  }

  private removePluginRoutes(pluginName: string, path?: string): void {
    const registrationIds = this.pluginRouteRegistrationIdsByPlugin.get(pluginName)
    if (!registrationIds) return

    for (const registrationId of Array.from(registrationIds)) {
      const registration = this.pluginRouteRegistrations.get(registrationId)
      if (!registration) {
        registrationIds.delete(registrationId)
        continue
      }
      if (path && registration.path !== path) {
        continue
      }

      registration.active = false
      this.pluginRouteRegistrations.delete(registrationId)
      registrationIds.delete(registrationId)
      this.logger.info(`Plugin route disabled: ${pluginName} ${registration.method} ${registration.path}`)
    }

    if (registrationIds.size === 0) {
      this.pluginRouteRegistrationIdsByPlugin.delete(pluginName)
    }
  }

  private registerPluginCommunicationNamespace(pluginName: string, namespace: string, api: Record<string, PluginApiMethod>): void {
    const owner = this.pluginCommunicationNamespaceOwners.get(namespace)
    if (owner && owner !== pluginName) {
      throw new Error(`Plugin communication namespace already registered: ${namespace}`)
    }

    this.pluginApis.set(namespace, api)
    this.pluginCommunicationNamespaceOwners.set(namespace, pluginName)
    const namespaces = this.pluginCommunicationNamespacesByPlugin.get(pluginName) ?? new Set<string>()
    namespaces.add(namespace)
    this.pluginCommunicationNamespacesByPlugin.set(pluginName, namespaces)
  }

  private unregisterPluginCommunicationNamespace(pluginName: string, namespace: string): boolean {
    if (this.pluginCommunicationNamespaceOwners.get(namespace) !== pluginName) return false

    const namespaces = this.pluginCommunicationNamespacesByPlugin.get(pluginName)
    if (!namespaces?.has(namespace)) return false

    namespaces.delete(namespace)
    this.pluginApis.delete(namespace)
    this.pluginCommunicationNamespaceOwners.delete(namespace)
    if (namespaces.size === 0) {
      this.pluginCommunicationNamespacesByPlugin.delete(pluginName)
    }
    this.logger.info(`Plugin communication namespace unregistered: ${pluginName} -> ${namespace}`)
    return true
  }

  private registerPluginAttendanceSchedulerJob(pluginName: string, job: { name?: string; run(): Promise<unknown> }): (() => void) | null {
    const unregister = registerAttendanceSchedulerJob(job)
    if (!unregister) return null

    const unregisters = this.pluginAttendanceSchedulerUnregistersByPlugin.get(pluginName) ?? new Set<() => void>()
    const wrappedUnregister = () => {
      unregister()
      unregisters.delete(wrappedUnregister)
      if (unregisters.size === 0) {
        this.pluginAttendanceSchedulerUnregistersByPlugin.delete(pluginName)
      }
    }
    unregisters.add(wrappedUnregister)
    this.pluginAttendanceSchedulerUnregistersByPlugin.set(pluginName, unregisters)
    return wrappedUnregister
  }

  // S7-1..S7-4 (RATIFIED attendance-approval-s7 resolver lock, OD-S7-5=d): construct the host
  // binding for the narrow, org-scoped dynamic approval-assignee resolver port plugin-attendance
  // consumes. Exposes the SAME MAX_MANAGER_CHAIN_LEVELS constant the kernel uses (no plugin env
  // re-parse). S7-2 wires `direct_manager` (byte-identical to ApprovalDirectoryOrg §2.1); S7-3 adds
  // `dept_head` (byte-identical to §2.2); S7-4 adds `manager_at_level` (dense chain positional pick,
  // §2.3 B1 — includeManagerChain walk, self-exclusion, no continuous_managers). Directory READ-ONLY.
  private buildApprovalAssigneeResolverPort(): NonNullable<
    import('./types/plugin').PluginServices['approvalAssigneeResolver']
  > {
    return {
      maxManagerChainLevels: MAX_MANAGER_CHAIN_LEVELS,
      implementedKinds: ['direct_manager', 'dept_head', 'manager_at_level'],
      resolve: async (orgId, request) => {
        const kind = typeof request?.kind === 'string' ? request.kind.trim() : ''
        if (kind !== 'direct_manager' && kind !== 'dept_head' && kind !== 'manager_at_level') {
          return { status: 'unimplemented' as const }
        }

        const normalizedOrgId = typeof orgId === 'string' ? orgId.trim() : ''
        const requesterUserId =
          typeof request?.requesterUserId === 'string' ? request.requesterUserId.trim() : ''
        if (!normalizedOrgId || !requesterUserId) {
          return { status: 'unresolved' as const, reason: 'missing_org_or_requester' }
        }

        // CREATE-TIME freeze only (§3.3/§3.4). Always directory-resolve with the attendance org anchor;
        // never trust a caller-supplied snapshot for live re-resolution (step-advance must not call this).
        // QueryFn is unconstrained (Row not bound to QueryResultRow); adapt pg's typed query.
        const queryFn = <Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }> =>
          pgQuery(text, params).then((r) => ({ rows: r.rows as Row[] }))

        // manager_at_level needs the dense manager chain (includeManagerChain); other kinds do not.
        const relations = await resolveApprovalRequesterOrgRelations(requesterUserId, queryFn, {
          orgId: normalizedOrgId,
          includeManagerChain: kind === 'manager_at_level',
        })

        // S7-2 direct_manager — preserved byte-for-byte (reads only managerId).
        if (kind === 'direct_manager') {
          const managerId =
            typeof relations.managerId === 'string' && relations.managerId.trim().length > 0
              ? relations.managerId.trim()
              : null
          // Self-exclusion at the resolver (§2.1): a manager that resolves to the requester is treated
          // as unresolved — never written as a self-assignment.
          if (!managerId || managerId === requesterUserId) {
            return {
              status: 'unresolved' as const,
              reason: managerId === requesterUserId ? 'self_manager' : 'no_manager_linked',
            }
          }
          return {
            status: 'resolved' as const,
            assignees: [{ assignmentType: 'user' as const, assigneeId: managerId }],
          }
        }

        // S7-3 dept_head — same org-anchored relations call; read ONLY deptHeadId (§2.2).
        if (kind === 'dept_head') {
          const deptHeadId =
            typeof relations.deptHeadId === 'string' && relations.deptHeadId.trim().length > 0
              ? relations.deptHeadId.trim()
              : null
          // Self-exclusion at the resolver (§2.2): a dept head that resolves to the requester is treated
          // as unresolved — never written as a self-assignment.
          if (!deptHeadId || deptHeadId === requesterUserId) {
            return {
              status: 'unresolved' as const,
              reason: deptHeadId === requesterUserId ? 'self_dept_head' : 'no_dept_head_linked',
            }
          }
          return {
            status: 'resolved' as const,
            assignees: [{ assignmentType: 'user' as const, assigneeId: deptHeadId }],
          }
        }

        // S7-4 manager_at_level — dense chain from includeManagerChain walk (§2.3 B1).
        // CREATE-TIME freeze (no level): return the FULL dense chain as ordered assignees so the
        // plugin freezes requesterSnapshot.managerChainIds once; step-advance never re-calls this.
        // With integer level: single positional pick chain[level-1] (1 = direct manager).
        // Self-exclusion / unlinked walk-through / cycle / maxLevels are owned by ApprovalDirectoryOrg.
        const rawChain = Array.isArray(relations.managerChainIds) ? relations.managerChainIds : []
        const chain = rawChain
          .map((id) => (typeof id === 'string' ? id.trim() : ''))
          .filter((id) => id.length > 0 && id !== requesterUserId)

        const level = request?.level
        if (typeof level === 'number' && Number.isInteger(level) && level >= 1) {
          const managerId = chain[level - 1] ?? null
          if (!managerId) {
            return {
              status: 'unresolved' as const,
              reason: chain.length === 0 ? 'no_manager_chain' : 'chain_shorter_than_level',
            }
          }
          return {
            status: 'resolved' as const,
            assignees: [{ assignmentType: 'user' as const, assigneeId: managerId }],
          }
        }

        // Freeze path (no level): empty chain ⇒ unresolved; else ordered assignees = dense chain.
        if (chain.length === 0) {
          return { status: 'unresolved' as const, reason: 'no_manager_chain' }
        }
        return {
          status: 'resolved' as const,
          assignees: chain.map((assigneeId) => ({ assignmentType: 'user' as const, assigneeId })),
        }
      },
    }
  }

  private registerPluginWorkdayCalendarProvider(pluginName: string, provider: WorkdayCalendarPort): (() => void) {
    getWorkdayCalendarRegistry().register(provider)
    this.workdayCalendarProviderOwner = pluginName
    this.logger.info(`WorkdayCalendarPort provider bound by plugin: ${pluginName}`)
    return () => {
      if (this.workdayCalendarProviderOwner === pluginName) {
        getWorkdayCalendarRegistry().unregister()
        this.workdayCalendarProviderOwner = null
      }
    }
  }

  private cleanupPluginRuntimeRegistrations(pluginName: string): void {
    this.removePluginRoutes(pluginName)

    // T3-2: unbind this plugin's working-day calendar provider so the SLA path fails open again.
    if (this.workdayCalendarProviderOwner === pluginName) {
      getWorkdayCalendarRegistry().unregister()
      this.workdayCalendarProviderOwner = null
    }

    const namespaces = this.pluginCommunicationNamespacesByPlugin.get(pluginName)
    if (namespaces) {
      for (const namespace of Array.from(namespaces)) {
        this.unregisterPluginCommunicationNamespace(pluginName, namespace)
      }
    }

    const unregisters = this.pluginAttendanceSchedulerUnregistersByPlugin.get(pluginName)
    if (unregisters) {
      for (const unregister of Array.from(unregisters)) {
        unregister()
      }
      this.pluginAttendanceSchedulerUnregistersByPlugin.delete(pluginName)
    }
  }

  /**
   * 配置中间件
   */
  private setupMiddleware(): void {
    // Correlation-id must wrap every downstream middleware so AsyncLocalStorage
    // is populated before CORS, request logging, auth, and route handlers run.
    this.app.use(correlationIdMiddleware)

    // CORS
    this.app.use(cors({
      exposedHeaders: ['X-Correlation-ID'],
    }))

    // API responses should always opt out of MIME sniffing, including early 4xx replies.
    this.app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      next()
    })

    // 请求上下文（requestId + trace bridge）
    this.app.use((req, _res, next) => {
      const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID()
      setLogContext({ requestId })
      next()
    })

    // Attendance import endpoints accept large `csvText` payloads for bulk runs.
    // Keep global JSON limits low, and only relax them for the import prefix.
    const attendanceImportJsonLimit = String(process.env.ATTENDANCE_IMPORT_JSON_LIMIT || '').trim() || '50mb'
    this.app.use('/api/attendance/import', (req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
      const hasAuth = Boolean(req.headers.authorization) || Boolean(req.headers.cookie)
      if (!hasAuth) {
        res.status(401).json({ success: false, error: 'Missing authentication' })
        return
      }
      next()
    })
    this.app.use('/api/attendance/import', express.json({ limit: attendanceImportJsonLimit }))

    // T1-2 inbound automation webhooks need the exact raw JSON bytes for HMAC verification and a
    // narrower body limit than the general API. Parse this prefix before the global JSON parser.
    this.app.use('/api/multitable/automation/webhooks', automationWebhookJsonParser)

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }))
    this.app.use(express.urlencoded({ extended: true }))

    // 指标端点与请求指标（尽早注册）
    installMetrics(this.app)
    this.app.use(requestMetricsMiddleware)

    // Production safety guards
    if (process.env.NODE_ENV === 'production') {
      if (process.env.ALLOW_UNSAFE_ADMIN === 'true') {
        this.logger.error('FATAL: ALLOW_UNSAFE_ADMIN set to true in production')
        process.exit(1)
      }
      if (process.env.ENABLE_FALLBACK_TEST === 'true') {
        this.logger.warn('WARNING: ENABLE_FALLBACK_TEST should be false in production')
      }
    }

    // 请求日志
    this.app.use((req, res, next) => {
      this.logger.info(`${req.method} ${req.path}`)
      next()
    })

    // 全局 JWT 保护 `/api/**`（白名单在中间件内判定）
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (isWhitelisted(req.path)) return next()
      if (isPublicFormAuthBypass(req)) return optionalJwtAuthMiddleware(req, res, next)
      // OAPI-1/2a: let an `mst_` API token reach the per-route apiTokenAuth + requireScope guards on the
      // method-bound allowlist (read GETs ∪ the 4 OAPI-2a write routes), fail-closed. An `mst_` bearer on
      // any non-allowlisted (method, path) falls through to jwtAuthMiddleware → 401, so a token can never
      // reach a write/side-effecting route outside the allowlist (kept in lockstep with the mounted guards).
      if (isOapiAllowlistRequest(req.method, req.path, req.headers.authorization)) return next()
      if (req.path.startsWith('/api/')) return jwtAuthMiddleware(req, res, next)
      return next()
    })

    // Post-auth enrichment: correlation ALS starts before auth so preflights
    // are covered; once auth runs, attach user/tenant for downstream logs.
    this.app.use(correlationContextEnrichmentMiddleware)

    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      const tenantId = typeof req.user?.tenantId === 'string' && req.user.tenantId.trim().length > 0
        ? req.user.tenantId.trim()
        : undefined
      if (!tenantId) {
        return next()
      }
      tenantContext.runAsync(tenantId, async () => {
        next()
      }).catch(next)
    })

    // Attendance production guards (audit + security). Must run after auth so req.user is available.
    this.app.use(attendanceAuditMiddleware())
    this.app.use(attendanceSecurityMiddleware())

    // 健康检查
    const healthHandler = (req: Request, res: Response) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        const stats = getPoolStats()
        // 尽量不破坏现有字段，同时补充插件摘要，便于快速可见
        let pluginsSummary: Record<string, unknown> | undefined = undefined
        try {
          // 与 /api/plugins 的 summary 保持一致结构
          pluginsSummary = (this.pluginLoader as unknown as Record<string, () => Record<string, unknown>>).getSummary?.()
        } catch { /* ignore plugin summary errors */ }
        res.json({
          status: 'ok',
          ok: true,
          success: true,
          timestamp: new Date().toISOString(),
          plugins: this.pluginLoader.getPlugins().size,
          pluginsSummary: pluginsSummary || undefined,
          dbPool: stats || undefined,
          build: getBuildInfo(),
        })
        endTimer?.({ route: '/health', method: 'GET' })(200)
      } catch (err) {
        endTimer?.({ route: '/health', method: 'GET' })(500)
        throw err
      }
    }
    this.app.get('/health', healthHandler)
    this.app.get('/api/health', healthHandler)

    // 路由：认证（登录/注册/token管理）
    this.app.use('/api/auth', authRouter)

    // 路由：审批（示例）
    this.app.use(approvalsRouter({
      injector: this.injector,
      afterSalesApprovalBridgeService: this.afterSalesApprovalBridgeService,
    }))
    // 路由：审计日志（管理员）
    this.app.use(auditLogsRouter())
    // 路由：审批历史（从审计表衍生）
    this.app.use(approvalHistoryRouter({ injector: this.injector }))
    // 路由：审批 SLA / 耗时指标（Wave 2 WP5）
    this.app.use(approvalMetricsRouter())
    // 路由：角色/权限/表/文件/表权限（占位）
    this.app.use(rolesRouter())
    this.app.use(permissionsRouter())
    this.app.use(attendanceAdminRouter())
    this.app.use(filesRouter())
    this.app.use(spreadsheetsRouter(this.injector))
    this.app.use(spreadsheetPermissionsRouter())
    this.app.use(commentsRouter(this.injector))
    // 路由：看板（Kanban MVP API）
    this.app.use('/api/kanban', kanbanRouter())
    // 路由：快照（Snapshot MVP）
    this.app.use(snapshotsRouter())

    // 路由：变更管理 (Sprint 3)
    this.app.use('/api', changeManagementRouter)

    // 路由：工作流引擎 (V2 BPMN)
    this.app.use('/api/workflow', workflowRouter)
    // 路由：工作流设计器 (V2 Visual Designer)
    this.app.use('/api/workflow-designer', workflowDesignerRouter)
    const plmEnabled = isPlmEnabled(process.env.PRODUCT_MODE, process.env.ENABLE_PLM)
    if (plmEnabled) {
      this.app.use(plmWorkbenchRouter)
      this.app.use(plmEmbedRouter())
      this.app.use(plmEmbedDiscussionWriteRouter())
      this.app.use(plmEmbedDiscussionReadRouter())
    } else {
      this.app.use('/api/plm-workbench', disabledFeatureHandler('PLM workbench is disabled in this deployment'))
      this.app.use('/api/plm-embed', disabledFeatureHandler('PLM embed is disabled in this deployment'))
      this.app.use('/api/federation/plm', disabledFeatureHandler('PLM federation APIs are disabled in this deployment'))
      this.app.use('/api/federation/import/plm', disabledFeatureHandler('PLM import APIs are disabled in this deployment'))
    }

    // 路由：工作流 Echo/Mock API（用于前端并行开发）
    // 当后端引擎未完全就绪时，返回 echo 响应
    this.app.post('/api/workflow-mock/echo', (req, res) => {
      res.json({
        ok: true,
        echo: req.body,
        timestamp: new Date().toISOString(),
        message: 'Workflow mock endpoint - use for frontend development'
      })
    })
    this.app.get('/api/workflow-mock/status', (_req, res) => {
      res.json({
        ok: true,
        engine: 'mock',
        ready: false,
        message: 'Workflow engine is in development. Use /api/workflow for real endpoints.'
      })
    })

    // 路由：Univer Mock API（用于前端 POC，不依赖数据库；仅非生产环境启用）
    if (process.env.NODE_ENV !== 'production') {
      this.app.use('/api/univer-mock', univerMockRouter())
    }

    // Canonical multitable API used by the frontend and OpenAPI contracts.
    this.app.use('/api/multitable', univerMetaRouter())
    // Chart / Dashboard CRUD (paths: /sheets/:sheetId/charts, /sheets/:sheetId/dashboards).
    // Mounted separately from univerMetaRouter because it lives in its own
    // module with a dedicated DashboardService.
    this.app.use('/api/multitable', dashboardRouter())
    // Automation test/logs/stats (paths: /sheets/:sheetId/automations/:ruleId/{test,logs,stats}).
    // Uses a lazy resolver because AutomationService is initialized later
    // in the startup sequence than route mounting happens.
    this.app.use('/api/multitable', createAutomationRoutes(() => this.automationService))
    // AI routes — internal/not-in-OpenAPI, per-route guards; platform JWT
    // comes from the global /api/** middleware above:
    //   A1 readiness (GET /ai/readiness, admin-only) +
    //   A2 shortcut (POST /sheets/:sheetId/ai/shortcut/{preview,run}, record RBAC).
    // See routes/multitable-ai.ts header.
    // B-4: inject a real in-process queue so the async bulk-fill job's generate phase
    // runs the worker (runJob) out-of-band via `enqueue`. WITHOUT it, a large bulk-fill
    // creates a job + returns a jobId but the worker never executes in production.
    this.app.use('/api/multitable', createMultitableAiRoutes({ queue: new QueueServiceImpl() }))
    // B1-a1 button field run endpoint. See routes/multitable-button.ts header.
    this.app.use('/api/multitable', createMultitableButtonRoutes())
    this.app.use(apiTokensRouter())
    // Keep the legacy dev alias while existing tools/worktrees still reference it.
    if (process.env.NODE_ENV !== 'production') {
      this.app.use('/api/univer-meta', univerMetaRouter())
    }

    // 路由：事件总线
    this.app.use(eventsRouter())

    // 路由：外部数据源管理 (V2)
    this.app.use(dataSourcesRouter())

    // 路由：联邦系统（PLM/Athena 等）
    this.app.use(federationRouter(this.injector))

    // 路由：内部调试端点 (dev/staging only)
    this.app.use('/internal', internalRouter)
    // 路由：降级测试端点 (dev only)
    // 使用静态导入，避免在某些运行环境中 transpile 为顶层 await 导致语法错误
    // 动态导入（无需使用 await，避免编译为顶层 await）
    try {
      import('./routes/fallback-test')
        .then(m => {
          if (m?.default) this.app.use('/internal/test', m.default)
        })
        .catch(() => { /* fallback-test route not available */ })
    } catch { /* dynamic import error */ }

    // 路由：缓存测试端点 (dev only)
    this.app.use('/api/cache-test', cacheTestRouter)

    // 路由：模拟错误 (用于观测 HTTP 成功率下降 & Burn Rate 测试，仅在非生产且允许不安全 admin 时暴露)
    if (process.env.ALLOW_UNSAFE_ADMIN === 'true') {
      this.app.get('/api/sim-error', (req, res) => {
        const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
        endTimer?.({ route: '/api/sim-error', method: 'GET' })(500)
        res.status(500).json({ ok: false, error: { code: 'SIMULATED_ERROR', message: 'Simulated failure' } })
      })
    }

    // 路由：视图管理 (V2 Unified)
    this.app.use('/api/views', viewsRouter())

    // 路由：管理员端点 (带 SafetyGuard 保护)
    this.app.use('/api/admin', initAdminRoutes({
      pluginLoader: this.pluginLoader,
      pluginStatus: this.pluginStatus,
      activatePlugin: this.activatePluginByName.bind(this),
      deactivatePlugin: this.deactivatePluginByName.bind(this),
      snapshotService: this.snapshotService,
      getYjsStatus: () => ({
        enabled: process.env.ENABLE_YJS_COLLAB === 'true',
        initialized: !!(this.yjsSyncMetricsSource && this.yjsBridgeMetricsSource && this.yjsSocketMetricsSource),
        sync: this.yjsSyncMetricsSource?.getMetrics() ?? null,
        bridge: this.yjsBridgeMetricsSource?.getMetrics() ?? null,
        socket: this.yjsSocketMetricsSource?.getMetrics() ?? null,
      }),
    }))
    this.app.use(adminUsersRouter())
    // Transfer MVP T1 — mounted BEFORE the broader /api/admin/directory router so the more
    // specific path wins outright; same `ensurePlatformAdmin` RBAC gate.
    this.app.use('/api/admin/directory/org-transfers', adminDirectoryOrgTransfersRouter())
    this.app.use('/api/admin/directory', adminDirectoryRouter())
    // Canonical Org MVP B2 (local departments/accounts/memberships CRUD) — mounted alongside
    // adminDirectoryRouter under the same base path, sharing its `ensurePlatformAdmin` RBAC gate.
    this.app.use('/api/admin/directory/local', adminDirectoryLocalRouter())
    this.app.use('/api/admin/directory/department-bindings', adminDirectoryDepartmentBindingsRouter())
    this.app.use('/api/admin/directory/routing-policy', adminDirectoryRoutingPolicyRouter())

    // Canary routing (behind ENABLE_CANARY_ROUTING feature flag)
    const canaryEnabled = process.env.ENABLE_CANARY_ROUTING === 'true'
    const canaryRouter = new CanaryRouter(canaryEnabled)
    this.app.use('/api/admin/canary', canaryRoutes(canaryRouter))

    if (canaryEnabled) {
      const canaryInterceptor = createCanaryInterceptor(canaryRouter)
      messageBus.setInterceptor(canaryInterceptor)
    }

    // V2 测试端点
    this.app.get('/api/v2/hello', (req, res) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        res.json({ ok: true, message: 'Hello from MetaSheet V2!', version: '2.0.0-alpha.1' })
        endTimer?.({ route: '/api/v2/hello', method: 'GET' })(200)
      } catch (err) {
        endTimer?.({ route: '/api/v2/hello', method: 'GET' })(500)
        throw err
      }
    })

    this.app.get('/api/v2/rpc-test', async (req, res) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        // 测试 RPC 功能
        const testTopic = 'test.rpc'
        const testPayload = { message: 'ping' }

        // 创建测试 RPC handler
        messageBus.createRpcHandler(testTopic, async (payload: { message: string }) => {
          return { ok: true, echo: payload, timestamp: Date.now() }
        })

        // 发送 RPC 请求
        const result = await messageBus.request(testTopic, testPayload, 1000)
        res.json({ ok: true, rpcTest: 'passed', result })
        endTimer?.({ route: '/api/v2/rpc-test', method: 'GET' })(200)
      } catch (error: unknown) {
        res.json({ ok: true, rpcTest: 'skipped', reason: error instanceof Error ? error.message : String(error) })
        endTimer?.({ route: '/api/v2/rpc-test', method: 'GET' })(200)
      }
    })

    // 插件信息
    this.app.get('/api/plugins', (req, res) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        const list = Array.from(this.pluginLoader.getPlugins().values()).map((loaded) => {
          const state = this.pluginStatus.get(loaded.manifest.name)
          return {
            name: loaded.manifest.name,
            version: loaded.manifest.version,
            displayName: loaded.manifest.displayName,
            status: state?.status ?? 'inactive',
            error: state?.error,
            lastAttempt: state?.lastAttempt,
            contributes: loaded.manifest.contributes ?? undefined,
          }
        })
        const summary = (this.pluginLoader as unknown as Record<string, () => Record<string, unknown>>).getSummary?.() || {}
        res.json({ list, summary })
        endTimer?.({ route: '/api/plugins', method: 'GET' })(200)
      } catch (e: unknown) {
        res.json({ list: [], summary: { error: e instanceof Error ? e.message : String(e) } })
        endTimer?.({ route: '/api/plugins', method: 'GET' })(500)
      }
    })

    this.app.use('/api/platform/apps', createPlatformAppsRouter({
      pluginLoader: this.pluginLoader,
      pluginStatus: this.pluginStatus,
    }))

    // Metrics (JSON minimal)
    this.app.get('/internal/metrics', async (_req, res) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        const { coreMetrics } = await import('./integration/metrics/metrics')
        res.json(coreMetrics.get())
        endTimer?.({ route: '/internal/metrics', method: 'GET' })(200)
      } catch (err) {
        endTimer?.({ route: '/internal/metrics', method: 'GET' })(500)
        throw err
      }
    })

    // Note: /metrics/prom endpoint is registered by installMetrics() in setupMiddleware()
  }

  private installGlobalErrorHandler(): void {
    // Global error handler — emits `correlationId` in the response body so API
    // clients can reference the request when filing bug reports. It must be
    // registered after all routes/plugin routes; Express only dispatches errors
    // to handlers that appear later in the middleware stack.
    this.app.use(correlationErrorHandler(this.logger))
  }

  /**
   * 初始化缓存 (Phase 1)
   *
   * Phase 1: Always use NullCache for observability
   * Phase 3: Will register RedisCache here based on feature flag
   */
  private initializeCache(): void {
    // Phase 1: NullCache is already default in CacheRegistry
    const enabled = process.env.FEATURE_CACHE === 'true'
    this.logger.info(`Cache: ${enabled ? 'observing' : 'disabled'} (impl: ${cacheRegistry.getStatus().implName})`)

    // Phase 3: Plugin will register RedisCache when FEATURE_CACHE_REDIS=true
  }

  private async handleAfterSalesApprovalDecisionCallback(
    approval: UnifiedApprovalDTO,
    decision: {
      action: 'approve' | 'reject'
      actorId: string
      actorName?: string
      comment?: string
    },
  ): Promise<void> {
    const api = this.pluginApis.get('after-sales')
    const handler = api?.handleRefundApprovalDecisionCallback
    if (typeof handler !== 'function') {
      this.logger.warn('after-sales approval callback skipped: plugin callback not registered')
      return
    }

    try {
      await handler({
        approval,
        projectId: approval.subject?.projectId,
        ticketId: approval.subject?.ticketId,
        decision: approval.status === 'approved' ? 'approved' : 'rejected',
        actorId: decision.actorId,
        actorName: decision.actorName,
        comment: decision.comment,
      })
    } catch (error) {
      this.logger.error('after-sales approval callback failed', error as Error)
    }
  }

  private registerInternalPluginApis(): void {
    this.pluginApis.set('after-sales-approval-bridge', {
      submitRefundApproval: async (command: unknown) =>
        this.afterSalesApprovalBridgeService.submitRefundApproval(
          command as import('./services/AfterSalesApprovalBridgeService').AfterSalesRefundApprovalCommand,
        ),
      getRefundApproval: async (input: unknown) =>
        this.afterSalesApprovalBridgeService.getRefundApproval(
          input as import('./services/AfterSalesApprovalBridgeService').AfterSalesRefundApprovalQueryInput,
        ),
      submitRefundApprovalDecision: async (input: unknown) =>
        this.afterSalesApprovalBridgeService.submitRefundApprovalDecision(
          input as import('./services/AfterSalesApprovalBridgeService').AfterSalesRefundApprovalDecisionInput,
        ),
    })
  }

  private createPluginContext(loaded: LoadedPlugin): PluginContext {
    const coreApi = this.injector.get(ICoreAPI)
    const manifest = loaded.manifest
    const pluginName = manifest.name
    const pluginHttpApi = coreApi.http
      ? {
          ...coreApi.http,
          addRoute: (method: string, path: string, handler: RequestHandler) => {
            this.registerPluginRoute(pluginName, method, path, handler)
          },
          removeRoute: (path: string) => {
            this.removePluginRoutes(pluginName, path)
          },
        }
      : coreApi.http
    const pluginBaseCoreApi = {
      ...coreApi,
      http: pluginHttpApi,
    }
    const pluginCoreApi = coreApi.multitable
      ? {
          ...pluginBaseCoreApi,
          multitable: createPluginScopedMultitableApi(coreApi.multitable, manifest.name, {
            ensureObjectInScope: async ({ pluginName, projectId, baseId, descriptor }) => {
              return poolManager.get().transaction(async ({ query }) => {
                const txQuery: MultitableProvisioningQueryFn = async (sql, params) => {
                  const result = await query(sql, params)
                  return {
                    rows: Array.isArray((result as { rows?: unknown[] }).rows)
                      ? (result as { rows: unknown[] }).rows
                      : [],
                    rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                      ? (result as { rowCount: number }).rowCount
                      : undefined,
                  }
                }
                await assertPluginOwnsObject(txQuery, {
                  pluginName,
                  projectId,
                  objectId: descriptor.id,
                })
                const result = await ensureMultitableObject({
                  query: txQuery,
                  projectId,
                  baseId,
                  descriptor,
                })
                await claimPluginObjectScope(txQuery, {
                  pluginName,
                  projectId,
                  objectId: descriptor.id,
                  sheetId: result.sheet.id,
                })
                return result
              })
            },
            assertObjectScope: async ({ projectId, objectId, pluginName }) => {
              const txQuery: MultitableProvisioningQueryFn = async (sql, params) => {
                const result = await poolManager.get().query(sql, params)
                return {
                  rows: Array.isArray((result as { rows?: unknown[] }).rows)
                    ? (result as { rows: unknown[] }).rows
                    : [],
                  rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                    ? (result as { rowCount: number }).rowCount
                    : undefined,
                }
              }
              const ownsObject = await assertPluginOwnsObject(txQuery, {
                pluginName,
                projectId,
                objectId,
              })
              if (!ownsObject) {
                throw new MultitableObjectScopeError(pluginName, projectId, objectId, 'unclaimed')
              }
            },
            claimObjectScope: async ({ projectId, objectId, sheetId, pluginName }) => {
              await poolManager.get().transaction(async ({ query }) => {
                const txQuery: MultitableProvisioningQueryFn = async (sql, params) => {
                  const result = await query(sql, params)
                  return {
                    rows: Array.isArray((result as { rows?: unknown[] }).rows)
                      ? (result as { rows: unknown[] }).rows
                      : [],
                    rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                      ? (result as { rowCount: number }).rowCount
                      : undefined,
                  }
                }
                await claimPluginObjectScope(txQuery, {
                  pluginName,
                  projectId,
                  objectId,
                  sheetId,
                })
              })
            },
            assertSheetScope: async ({ sheetId, pluginName }) => {
              const txQuery: MultitableProvisioningQueryFn = async (sql, params) => {
                const result = await poolManager.get().query(sql, params)
                return {
                  rows: Array.isArray((result as { rows?: unknown[] }).rows)
                    ? (result as { rows: unknown[] }).rows
                    : [],
                  rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                    ? (result as { rowCount: number }).rowCount
                    : undefined,
                }
              }
              await assertPluginOwnsSheet(txQuery, {
                pluginName,
                sheetId,
              })
            },
            runStockPreparationPersistUnitOfWork: async (
              { pluginName, ...rawInput },
              operation,
            ) => {
              const input = validateStockPreparationPersistUnitOfWorkInput(rawInput)
              return poolManager.get().transaction(async ({ query }) => {
                const txQuery: MultitableRecordsQueryFn = async (sql, params) => {
                  const result = await query(sql, params)
                  return {
                    rows: Array.isArray((result as { rows?: unknown[] }).rows)
                      ? (result as { rows: unknown[] }).rows
                      : [],
                    rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                      ? (result as { rowCount: number }).rowCount
                      : undefined,
                  }
                }

                for (const sheetId of input.sheetIds) {
                  const ownsSheet = await assertPluginOwnsSheet(txQuery, { pluginName, sheetId })
                  if (!ownsSheet) {
                    throw new MultitableSheetScopeError(pluginName, sheetId, 'unclaimed')
                  }
                }
                await acquireStockPreparationPersistUnitOfWorkLocks(txQuery, input)

                return operation({
                  queryRecords: ({ sheetId, filters, search, orderBy, limit, offset }) =>
                    queryMultitableRecords({
                      query: txQuery,
                      sheetId,
                      filters,
                      search,
                      orderBy,
                      limit,
                      offset,
                    }),
                  createRecord: ({ sheetId, data }) =>
                    createMultitableRecord({ query: txQuery, sheetId, data }),
                  patchRecord: ({ sheetId, recordId, changes }) =>
                    patchMultitableRecord({
                      query: txQuery,
                      sheetId,
                      recordId,
                      changes,
                    }),
                })
              })
            },
          }),
        }
      : pluginBaseCoreApi
    const storage: PluginStorage = createHostPluginStorage({
      pluginName,
      query: (sql, params) => poolManager.get().query(sql, params),
    })
    const pluginApis = this.pluginApis
    const eventBus = this.eventBus
    const automationRegistry = {
      upsertRules: async (input: import('./types/plugin').PluginAutomationRegistryService extends { upsertRules: infer T } ? T extends (input: infer I) => Promise<unknown> ? I : never : never) => {
        return poolManager.get().transaction(async ({ query }) => {
          const txQuery: AutomationRegistryQueryFn = async (sql, params) => {
            const result = await query(sql, params)
            return {
              rows: Array.isArray((result as { rows?: unknown[] }).rows)
                ? (result as { rows: unknown[] }).rows
                : [],
              rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                ? (result as { rowCount: number }).rowCount
                : undefined,
            }
          }
          return upsertAutomationRules(txQuery, input)
        })
      },
      listRules: async (input: import('./types/plugin').PluginAutomationRegistryService extends { listRules: infer T } ? T extends (input: infer I) => Promise<unknown> ? I : never : never) => {
        const txQuery: AutomationRegistryQueryFn = async (sql, params) => {
          const result = await poolManager.get().query(sql, params)
          return {
            rows: Array.isArray((result as { rows?: unknown[] }).rows)
              ? (result as { rows: unknown[] }).rows
              : [],
            rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
              ? (result as { rowCount: number }).rowCount
              : undefined,
          }
        }
        return listAutomationRules(txQuery, input)
      },
    }
    const rbacProvisioning = {
      applyRoleMatrix: async (input: import('./types/plugin').PluginRbacProvisioningService extends { applyRoleMatrix: infer T } ? T extends (input: infer I) => Promise<unknown> ? I : never : never) => {
        return poolManager.get().transaction(async ({ query }) => {
          const txQuery: RbacProvisioningQueryFn = async (sql, params) => {
            const result = await query(sql, params)
            return {
              rows: Array.isArray((result as { rows?: unknown[] }).rows)
                ? (result as { rows: unknown[] }).rows
                : [],
              rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
                ? (result as { rowCount: number }).rowCount
                : undefined,
            }
          }
          return applyRoleMatrix(txQuery, input)
        })
      },
    }
    const platformAppInstances = {
      upsertInstance: async (input: import('./types/plugin').PluginPlatformAppInstanceRegistryService extends { upsertInstance: infer T } ? T extends (input: infer I) => Promise<unknown> ? I : never : never) => {
        const tenantId =
          (typeof input.tenantId === 'string' && input.tenantId.trim().length > 0 ? input.tenantId.trim() : '')
          || (typeof input.workspaceId === 'string' && input.workspaceId.trim().length > 0 ? input.workspaceId.trim() : '')
          || tenantContext.getTenantId()
          || ''
        const txQuery: PlatformAppInstanceRegistryQueryFn = async (sql, params) => {
          const shardedPoolManager = tenantContext.getPoolManager()
          const result = tenantId && shardedPoolManager
            ? await shardedPoolManager.queryForTenant(tenantId, sql, params)
            : await poolManager.get().query(sql, params)
          return {
            rows: Array.isArray((result as { rows?: unknown[] }).rows)
              ? (result as { rows: unknown[] }).rows
              : [],
            rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
              ? (result as { rowCount: number }).rowCount
              : undefined,
          }
        }
        return upsertPlatformAppInstance(txQuery, input)
      },
      getInstance: async (input: import('./types/plugin').PluginPlatformAppInstanceRegistryService extends { getInstance: infer T } ? T extends (input: infer I) => Promise<unknown> ? I : never : never) => {
        const tenantId =
          (typeof input.workspaceId === 'string' && input.workspaceId.trim().length > 0 ? input.workspaceId.trim() : '')
          || tenantContext.getTenantId()
          || ''
        const txQuery: PlatformAppInstanceRegistryQueryFn = async (sql, params) => {
          const shardedPoolManager = tenantContext.getPoolManager()
          const result = tenantId && shardedPoolManager
            ? await shardedPoolManager.queryForTenant(tenantId, sql, params)
            : await poolManager.get().query(sql, params)
          return {
            rows: Array.isArray((result as { rows?: unknown[] }).rows)
              ? (result as { rows: unknown[] }).rows
              : [],
            rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
              ? (result as { rowCount: number }).rowCount
              : undefined,
          }
        }
        return getPlatformAppInstance(txQuery, input)
      },
      listInstances: async (input: import('./types/plugin').PluginPlatformAppInstanceRegistryService extends { listInstances: infer T } ? T extends (input: infer I) => Promise<unknown> ? I : never : never) => {
        const tenantId =
          (typeof input.workspaceId === 'string' && input.workspaceId.trim().length > 0 ? input.workspaceId.trim() : '')
          || tenantContext.getTenantId()
          || ''
        const txQuery: PlatformAppInstanceRegistryQueryFn = async (sql, params) => {
          const shardedPoolManager = tenantContext.getPoolManager()
          const result = tenantId && shardedPoolManager
            ? await shardedPoolManager.queryForTenant(tenantId, sql, params)
            : await poolManager.get().query(sql, params)
          return {
            rows: Array.isArray((result as { rows?: unknown[] }).rows)
              ? (result as { rows: unknown[] }).rows
              : [],
            rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
              ? (result as { rowCount: number }).rowCount
              : undefined,
          }
        }
        return listPlatformAppInstances(txQuery, input)
      },
    }
    const communication: PluginCommunication = {
      call: async <R = unknown>(plugin: string, method: string, ...args: unknown[]): Promise<R> => {
        const api = pluginApis.get(plugin)
        const fn = api?.[method]
        if (!fn) {
          throw new Error(`Plugin method not found: ${plugin}.${method}`)
        }
        return fn(...args) as Promise<R>
      },
      register: (name: string, api: Record<string, PluginApiMethod>) => {
        this.registerPluginCommunicationNamespace(pluginName, name, api)
      },
      unregister: (name: string) => {
        return this.unregisterPluginCommunicationNamespace(pluginName, name)
      },
      on: (event: string, handler: (data: unknown) => void) => {
        eventBus.on(event, handler)
      },
      emit: (event: string, data?: unknown) => {
        eventBus.emit(event, data)
      },
    }

    // Least-privilege host→plugin capability: only the integration plugin receives the read-only
    // data-source facade (the `data-source:sql-readonly` bridge source), mirroring how the scoped
    // multitable api is provided. The facade is read-only by construction and principal-gated; an
    // unknown plugin gets the unchanged api. (A drifted allowlist key fails LOUD in the adapter's
    // context.api.dataSources guard, not silently.)
    const pluginApiSurface = manifest.name === 'plugin-integration-core'
      ? {
          ...pluginCoreApi,
          dataSources: createDataSourcePluginFacade(getDataSourceManager),
          dataSourceWrites: createDataSourceWritePluginFacade(getDataSourceManager)
        }
      : pluginCoreApi

    return {
      metadata: {
        name: manifest.name,
        version: manifest.version,
        displayName: manifest.displayName,
        description: manifest.description,
        author: typeof manifest.author === 'string' ? manifest.author : manifest.author?.name,
        path: loaded.path,
      },
      api: pluginApiSurface,
      core: pluginApiSurface,
      services: {
        notification: notificationService,
        attendanceScheduler: {
          registerJob: (job: { name?: string; run(): Promise<unknown> }) => this.registerPluginAttendanceSchedulerJob(pluginName, job),
        },
        // T3-2: let a plugin bind the working-day calendar provider the approval SLA path consults.
        // Registration is tracked per-plugin so a plugin reload/deactivate unbinds it (fail-open again).
        workdayCalendar: {
          register: (provider: WorkdayCalendarPort) => this.registerPluginWorkdayCalendarProvider(pluginName, provider),
        },
        // S7-1 (OD-S7-5=d): the host binding for the dynamic approval-assignee resolver port. Unlike
        // workdayCalendar (plugin-provided), core-backend is the PROVIDER here; plugin-attendance
        // consumes it and fail-closes when it is absent. At S7-1 it reports every dynamic kind
        // unimplemented, so a dynamic-kind step can never round-trip inert — see buildApprovalAssigneeResolverPort.
        // S7-2 precursor (owner P3 on #4415): least-privilege — ONLY plugin-attendance receives the
        // port (same posture as the plugin-integration-core dataSources facade above). Before the
        // resolver reads real directory data, "narrow port" must be a capability boundary, not a type
        // description; every other plugin gets undefined and the consumer's fail-closed path.
        approvalAssigneeResolver:
          manifest.name === 'plugin-attendance' ? this.buildApprovalAssigneeResolverPort() : undefined,
        automationRegistry,
        rbacProvisioning,
        platformAppInstances,
        security: this.pluginRuntimeSecurityService,
      } as unknown as import('./types/plugin').PluginServices,
      storage,
      config: resolvePluginRuntimeConfig(manifest.name),
      communication,
      logger: new Logger(`Plugin:${manifest.name}`),
    }
  }

  private setPluginRuntimeState(name: string, status: PluginRuntimeState['status'], error?: string): PluginRuntimeState {
    const lastAttempt = new Date().toISOString()
    const state: PluginRuntimeState = { status, lastAttempt }
    if (error) state.error = error
    this.pluginStatus.set(name, state)
    return state
  }

  private ensurePluginInstance(loaded: LoadedPlugin): PluginLifecycle | null {
    let pluginInstance: PluginLifecycle | null = loaded.plugin
    if (typeof pluginInstance === 'function') {
      const proto = (pluginInstance as { prototype?: { activate?: unknown; deactivate?: unknown } }).prototype
      if (proto && (typeof proto.activate === 'function' || typeof proto.deactivate === 'function')) {
        pluginInstance = new (pluginInstance as new () => PluginLifecycle)()
        loaded.plugin = pluginInstance
      }
    }
    return pluginInstance
  }

  private async activatePluginInstance(name: string, loaded: LoadedPlugin): Promise<PluginRuntimeState> {
    const pluginInstance = this.ensurePluginInstance(loaded)
    if (!pluginInstance || typeof pluginInstance.activate !== 'function') {
      return this.setPluginRuntimeState(name, 'inactive')
    }

    this.cleanupPluginRuntimeRegistrations(name)
    const context = this.createPluginContext(loaded)
    try {
      await pluginInstance.activate(context)
      return this.setPluginRuntimeState(name, 'active')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Plugin activation failed: ${name}`, error as Error)
      this.cleanupPluginRuntimeRegistrations(name)
      return this.setPluginRuntimeState(name, 'failed', message)
    }
  }

  private async activatePluginByName(name: string): Promise<PluginRuntimeState> {
    this.disabledPlugins.delete(name)
    const loaded = this.pluginLoader.get(name)
    if (!loaded) {
      return this.setPluginRuntimeState(name, 'failed', 'Plugin not loaded')
    }
    return this.activatePluginInstance(name, loaded)
  }

  private async deactivatePluginByName(name: string): Promise<PluginRuntimeState> {
    const loaded = this.pluginLoader.get(name)
    if (!loaded) {
      this.disabledPlugins.add(name)
      return this.setPluginRuntimeState(name, 'inactive')
    }

    const pluginInstance = this.ensurePluginInstance(loaded)
    let deactivationError: string | undefined
    if (pluginInstance && typeof pluginInstance.deactivate === 'function') {
      try {
        await pluginInstance.deactivate()
      } catch (error) {
        deactivationError = error instanceof Error ? error.message : String(error)
        this.logger.error(`Plugin deactivation failed: ${name}`, error as Error)
      }
    }

    this.cleanupPluginRuntimeRegistrations(name)
    this.disabledPlugins.add(name)
    if (deactivationError) {
      return this.setPluginRuntimeState(name, 'failed', deactivationError)
    }
    return this.setPluginRuntimeState(name, 'inactive')
  }

  private async refreshDisabledPluginsFromRegistry(): Promise<void> {
    try {
      const pool = poolManager.get()
      const result = await pool.query<{ name: string }>(
        `SELECT name FROM plugin_registry WHERE status = $1`,
        ['disabled']
      )
      this.disabledPlugins = new Set(result.rows.map(row => row.name))
    } catch (error) {
      if (isDatabaseSchemaError(error)) {
        return
      }
      this.logger.warn('Failed to load plugin registry status; continuing without registry overrides', error as Error)
    }
  }

  private async activateLoadedPlugins(): Promise<void> {
    const plugins = this.pluginLoader.getPlugins()
    for (const [name, loaded] of plugins) {
      if (this.disabledPlugins.has(name)) {
        this.setPluginRuntimeState(name, 'inactive')
        continue
      }
      await this.activatePluginInstance(name, loaded)
    }
  }

  /**
   * 获取服务器地址
   */
  getAddress() {
    return this.httpServer.address()
  }

  /**
   * 停止服务器
   */
  async stop(signal = 'SIGTERM'): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.logger.info(`Received ${signal}, shutting down gracefully...`)

    const shutdownTasks: Promise<void>[] = []

    // 0. Stop background tasks
    shutdownTasks.push(Promise.resolve().then(() => {
      try {
        this.stopOperationAuditRetention?.()
      } catch (err) {
        this.logger.warn(`Operation audit retention stop error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
    shutdownTasks.push(Promise.resolve().then(() => {
      try {
        this.automationService?.shutdown()
        this.automationServiceReady = false
        setAutomationServiceInstance(null)
      } catch (err) {
        this.logger.warn(`AutomationService shutdown error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
    // P2 durable-delivery S5: stop the outbox dispatch loop (no-op when the flag was OFF — the handle is null).
    // A clean stop lets in-flight adapters finish/abort and prevents a claimed row from being abandoned mid-lease.
    if (this.durableDeliveryLoop) {
      const loop = this.durableDeliveryLoop
      this.durableDeliveryLoop = null
      shutdownTasks.push(
        loop.stop().catch((err) => {
          this.logger.warn(`Durable delivery dispatch loop stop error: ${err instanceof Error ? err.message : String(err)}`)
        }) as Promise<void>,
      )
    }
    shutdownTasks.push(Promise.resolve().then(() => {
      try {
        this.stopMetaRevisionRetention?.()
        this.stopMultitableAttachmentCleanup?.()
      } catch (err) {
        this.logger.warn(`Multitable attachment cleanup stop error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
    shutdownTasks.push(Promise.resolve().then(() => {
      try {
        this.stopFilesOrphanBlobRetention?.()
      } catch (err) {
        this.logger.warn(`Files orphan blob retention stop error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
    shutdownTasks.push(Promise.resolve().then(() => {
      try {
        this.stopMultitableAttachmentBlobPurge?.()
      } catch (err) {
        this.logger.warn(`Multitable attachment blob purge sweep stop error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
    shutdownTasks.push(Promise.resolve().then(async () => {
      try {
        // stop awaits any in-flight GC/purge/reconcile tick before the pool closes.
        await this.stopApprovalAttachmentWorkers?.()
        this.stopApprovalAttachmentWorkers = undefined
      } catch (err) {
        this.logger.warn(`Approval attachment workers stop error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
    shutdownTasks.push(Promise.resolve().then(() => {
      try {
        if (this.yjsCleanupTimer) {
          clearInterval(this.yjsCleanupTimer)
          this.yjsCleanupTimer = undefined
        }
      } catch (err) {
        this.logger.warn(`Yjs cleanup timer stop error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))

    // 0b. Shut down MetricsStreamService
    if (this.metricsStreamService) {
      shutdownTasks.push(
        this.metricsStreamService.shutdown().catch((err) => {
          this.logger.warn(`MetricsStreamService shutdown error: ${err instanceof Error ? err.message : String(err)}`)
        }) as Promise<void>,
      )
    }

    // 0c. Shut down optional DingTalk interactive-card Stream worker
    if (this.dingtalkInteractiveCardStreamWorker) {
      shutdownTasks.push(
        this.dingtalkInteractiveCardStreamWorker.shutdown().catch((err) => {
          this.logger.warn(`DingTalk interactive-card Stream shutdown error: ${err instanceof Error ? err.message : String(err)}`)
        }) as Promise<void>,
      )
    }

    // 1. Close HTTP server
    shutdownTasks.push(new Promise<void>((resolve) => {
      try {
        if (this.httpServer.listening) {
          this.httpServer.close((err: Error | undefined) => {
            if (err) {
              this.logger.warn(`HTTP server close error: ${err.message}`)
            } else {
              this.logger.info('HTTP server closed')
            }
            resolve()
          })
        } else {
          resolve()
        }
      } catch (err) {
        this.logger.warn(`HTTP server close error: ${err instanceof Error ? err.message : String(err)}`)
        resolve()
      }
    }))

    // 2. Close database pool
    shutdownTasks.push((async () => {
      try {
        const { pool } = await import('./db/pg')
        if (pool) {
          await pool.end()
          this.logger.info('Database pool closed')
        }
      } catch (err) {
        this.logger.warn(`Database pool close error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    // 3. Unload plugins gracefully
    shutdownTasks.push((async () => {
      try {
        await this.pluginLoader.unloadAll()
        this.logger.info('Plugins unloaded')
      } catch (err) {
        this.logger.warn(`Plugin unload error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    // 4. Shutdown observability SDK if enabled
    if (this.observabilityShutdown) {
      shutdownTasks.push((async () => {
        try {
          await this.observabilityShutdown?.()
          this.logger.info('Observability shutdown complete')
        } catch (err) {
          this.logger.warn(`Observability shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })())
    }

    shutdownTasks.push((async () => {
      try {
        await stopDirectorySyncScheduler()
        this.logger.info('Directory sync scheduler stopped')
      } catch (err) {
        this.logger.warn(`Directory sync scheduler shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    shutdownTasks.push((async () => {
      try {
        stopApprovalSlaScheduler()
      } catch (err) {
        this.logger.warn(`Approval SLA scheduler shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    shutdownTasks.push((async () => {
      try {
        stopAttendanceScheduler()
      } catch (err) {
        this.logger.warn(`Attendance scheduler shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    shutdownTasks.push((async () => {
      try {
        stopWebhookRetryScheduler()
      } catch (err) {
        this.logger.warn(`Webhook retry scheduler shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    shutdownTasks.push((async () => {
      try {
        stopLedgerRetentionScheduler()
      } catch (err) {
        this.logger.warn(`Ledger retention scheduler shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    shutdownTasks.push((async () => {
      try {
        stopDingTalkGroupDeliveryRetentionScheduler()
      } catch (err) {
        this.logger.warn(`DingTalk group-delivery retention scheduler shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    shutdownTasks.push((async () => {
      try {
        stopDingTalkCardPersonDeliveryRetentionScheduler()
      } catch (err) {
        this.logger.warn(`DingTalk approval-card/person delivery retention scheduler shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    // 4. Destroy API Gateway resources (only if one was constructed during start()).
    shutdownTasks.push((async () => {
      try {
        if (this.apiGateway) {
          this.apiGateway.destroy()
          this.logger.info('API Gateway resources released')
        }
      } catch (err) {
        this.logger.warn(`API Gateway cleanup error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    // Wait for all shutdown tasks with timeout
    await Promise.race([
      Promise.all(shutdownTasks),
      new Promise<void>((resolve) => setTimeout(() => {
        this.logger.warn('Shutdown timeout, forcing exit')
        resolve()
      }, 10000)) // 10 second timeout
    ])

    this.logger.info('Shutdown complete')
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    // IoC: Load configuration
    if (!this.portLocked) {
      try {
        const configService = this.injector.get(IConfigService)
        const configPort = await configService.get<number>('app.port')
        if (typeof configPort === 'number') {
          this.port = configPort
          this.logger.info(`Port configured via ConfigService: ${this.port}`)
        }
      } catch (e) {
        this.logger.warn(`Failed to load config from IoC container, using default/env port: ${this.port}`, e as Error)
      }
    }

    // 初始化可观测性（可选）
    const observabilityConfig = loadObservabilityConfig()
    try {
      const obsResult = await initObservability(observabilityConfig, this.logger)
      this.observabilityEnabled = obsResult.started
      this.observabilityShutdown = obsResult.shutdown
    } catch (err) {
      this.logger.error('OpenTelemetry initialization failed', err as Error)
      if (observabilityConfig.strict) {
        throw err
      }
    }

    // 初始化EventBusService (允许降级跳过以保证度量端可用)
    if (this.disableEventBus) {
      this.logger.warn('Skipping EventBusService initialization (DISABLE_EVENT_BUS set to true)')
    } else {
      this.logger.info('Initializing EventBusService...')
      const coreAPI = this.createCoreAPI()
      try {
        await initializeEventBusService(coreAPI)
      } catch (e) {
        // 降级容错：记录错误但继续启动，使 Redis / metrics 在缺表或总线故障时仍可观测
        this.logger.error('EventBusService initialization failed; continuing in degraded mode', e as Error)
      }
    }

    // Initialize APIGateway + attempt Redis-backed circuit breaker store.
    // The gateway itself is a long-lived container for request-routing
    // primitives (rate limiters / circuit breakers).  Even when no code
    // path currently calls `registerEndpoint` on the running server, we
    // still need a live instance so future callers can reuse it AND so
    // `initRedisCircuitBreakerStore()` runs at boot (instead of being
    // dead library code — the follow-up captured in PR #1080's review).
    try {
      this.apiGateway = new APIGateway(this.app, {
        // Keep the gateway passive for now — main routing still lives in
        // the Express router chain above.  We disable CORS/metrics/logging
        // middleware on this instance to avoid double-registration under
        // `/api`; those concerns are already owned by MetaSheetServer.
        enableCors: false,
        enableLogging: false,
        enableMetrics: false,
        enableCircuitBreaker: true,
        initOutcomeCounter: promMetrics.apigwCbInitTotal,
        circuitBreakerStoreUsedCounter: promMetrics.apigwCbStoreUsedTotal,
      })
      const activated = await this.apiGateway.initRedisCircuitBreakerStore()
      this.logger.info(
        `APIGateway initialized (redis circuit breaker store: ${activated ? 'attached' : 'memory fallback'})`,
      )
    } catch (e) {
      this.logger.error(
        'APIGateway initialization failed; continuing in degraded mode',
        e as Error,
      )
    }

    // Initialize AutomationService — PUBLISH-LAST (owner P1, head 1d3854c7a). The field, the readiness
    // bit, and the module singleton are set ONLY after the FULL init chain (constructor + init() +
    // loadAndRegisterAllScheduled()) has succeeded. Previously `this.automationService` was assigned right
    // after construction and never cleared on failure, so an init()/load throw left a half-initialized
    // service that `Boolean(this.automationService)` happily accepted — bypassing the durable fail-closed
    // assert. Now a mid-chain failure rolls the instance back (best-effort shutdown: unsubscribe bus
    // handlers, destroy scheduler timers) and publishes NOTHING: flag-OFF this is the legacy
    // degrade-and-continue, flag-ON the durable boot below fail-closes on automationServiceReady=false.
    let pendingAutomationService: AutomationService | undefined
    try {
      const pool = poolManager.get()
      const { db: kyselyDb } = await import('./db/db')
      const { resolveAutomationSchedulerLeaderOptions } = await import(
        './multitable/automation-service'
      )
      // Opt-in: respects ENABLE_SCHEDULER_LEADER_LOCK. Returns null (legacy
      // behaviour) when the flag is off or Redis is unavailable, so this
      // call is safe in every deployment.
      const schedulerLeaderOptions = await resolveAutomationSchedulerLeaderOptions()
      pendingAutomationService = new AutomationService(
        eventBus,
        kyselyDb,
        pool.query.bind(pool),
        undefined,
        schedulerLeaderOptions,
        { leaderStateGauge: promMetrics.automationSchedulerLeaderGauge },
        notificationService,
      )
      pendingAutomationService.init()
      await pendingAutomationService.loadAndRegisterAllScheduled()
      // Full chain succeeded — publish atomically (nothing downstream can ever observe a partial init).
      this.automationService = pendingAutomationService
      this.automationServiceReady = true
      setAutomationServiceInstance(pendingAutomationService)
      this.logger.info('AutomationService initialized')
    } catch (e) {
      // Roll back the half-built instance. It was never published (no field, no singleton, routes see
      // undefined), so this only reaps whatever the partial init managed to start.
      try {
        pendingAutomationService?.shutdown()
      } catch {
        // best-effort rollback — the instance is unpublished either way
      }
      this.automationService = undefined
      this.automationServiceReady = false
      this.logger.error('AutomationService initialization failed; continuing in degraded mode', e as Error)
    }

    // T3-6: approval read-model projection. Subscribe the terminal projection trigger to the approval
    // completion bus (the create-hook path lives inside ApprovalProductService.createApproval), then
    // start the leader-gated §6b reconcile sweep that self-heals any best-effort lost write.
    try {
      const { getApprovalRecordProjectionService } = await import(
        './multitable/approval-record-projection-service'
      )
      const {
        startApprovalProjectionSweepScheduler,
        resolveApprovalProjectionSweepLeaderOptions,
        resolveApprovalProjectionSweepIntervalMs,
      } = await import('./services/ApprovalProjectionSweepScheduler')
      getApprovalRecordProjectionService().subscribe(eventBus)
      const projectionSweepLeaderOptions = await resolveApprovalProjectionSweepLeaderOptions()
      startApprovalProjectionSweepScheduler({
        leaderOptions: projectionSweepLeaderOptions,
        intervalMs: resolveApprovalProjectionSweepIntervalMs(),
      })
      this.logger.info('Approval record projection initialized')
    } catch (e) {
      this.logger.error('Approval record projection initialization failed; continuing in degraded mode', e as Error)
    }

    // Bind external data-source manager to DB and load persisted sources (A0)
    try {
      const { db: kyselyDbDataSources } = await import('./db/db')
      const { initializeDataSourceManager } = await import('./routes/data-sources')
      await initializeDataSourceManager(kyselyDbDataSources)
      this.logger.info('DataSourceManager persistence initialized')
    } catch (e) {
      this.logger.error('DataSourceManager initialization failed; continuing in degraded mode', e as Error)
    }

    try {
      await startDirectorySyncScheduler()
      this.logger.info('Directory sync scheduler initialized')
    } catch (e) {
      this.logger.error('Directory sync scheduler initialization failed; continuing in degraded mode', e as Error)
    }

    try {
      const leaderOptions = await resolveApprovalSlaSchedulerLeaderOptions()
      const breachNotifier = new ApprovalBreachNotifier({
        channels: createApprovalBreachChannelsFromEnv(),
      })
      startApprovalSlaScheduler({
        leaderOptions,
        runtime: { leaderStateGauge: promMetrics.approvalSlaSchedulerLeaderGauge },
        onBreach: async (ids) => {
          try {
            await breachNotifier.notifyBreaches(ids)
          } catch (notifyError) {
            this.logger.warn(
              `ApprovalBreachNotifier dispatch failed: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`,
            )
          }
        },
        // T1-1 node-level SLA: dispatch per-node overdue reminders to the node's active assignees.
        onNodeReminder: async ({ instanceId, assigneeIds }) => {
          try {
            await breachNotifier.notifyNodeReminder(instanceId, assigneeIds)
          } catch (notifyError) {
            this.logger.warn(
              `ApprovalBreachNotifier node-reminder dispatch failed: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`,
            )
          }
        },
        // T1-1 slice-2: apply due transfer/jump timeout effects (system actor, single-shot inside the
        // service transaction). Throws propagate to the scheduler's per-row catch → retried next tick.
        onNodeEffect: async ({ instanceId, effect }) =>
          new ApprovalProductService().applyNodeTimeoutEffect(instanceId, effect),
      })
      this.logger.info('Approval SLA scheduler initialized')
    } catch (e) {
      this.logger.error('Approval SLA scheduler initialization failed; continuing in degraded mode', e as Error)
    }

    // ④ C4 — attendance comp-time expiry scheduler. Opt-in (ATTENDANCE_SCHEDULER_ENABLED=true, default
    // OFF); returns null and no-ops when disabled. The expiry claim is idempotent + concurrency-safe on
    // its own, so the optional Redis leader lock only sheds load. ⑤/C5 source producers are SECONDARY jobs
    // on the same scheduler, each opt-in (default OFF → null → expiry only).
    try {
      const attendanceLeaderOptions = await resolveAttendanceSchedulerLeaderOptions()
      const unscheduledReminderJob = resolveUnscheduledReminderJob()
      const compTimeExpiryReminderJob = resolveCompTimeExpiryReminderJob()
      const attendanceNotificationDeliveryJob = resolveAttendanceNotificationDeliveryJob()
      const attendanceSchedulerJobs = [
        unscheduledReminderJob,
        compTimeExpiryReminderJob,
        attendanceNotificationDeliveryJob,
      ].filter((job): job is NonNullable<typeof job> => Boolean(job))
      const scheduler = startAttendanceScheduler({
        leaderOptions: attendanceLeaderOptions,
        intervalMs: resolveAttendanceSchedulerIntervalMs(),
        jobs: attendanceSchedulerJobs,
      })
      this.logger.info(scheduler ? 'Attendance scheduler initialized' : 'Attendance scheduler disabled (ATTENDANCE_SCHEDULER_ENABLED!=true)')
    } catch (e) {
      this.logger.error('Attendance scheduler initialization failed; continuing in degraded mode', e as Error)
    }

    // Webhook outbound pipeline. Two independent halves wired here:
    //   (1) the event bridge — subscribes the multitable record/comment topics on the
    //       module-singleton integration eventBus (the SAME bus the record-write path
    //       emits on; independent of core/EventBusService.initialize() above) and
    //       forwards them to WebhookService.deliverEvent. Webhooks are DB-row-driven,
    //       not env-gated, so this is wired unconditionally; the bridge keeps its own
    //       initialized idempotency guard, so a duplicate call is a no-op.
    //   (2) the retry tick — a periodic scan that re-attempts `pending` deliveries past
    //       their next_retry_at, mirroring the SLA scheduler's leader-elected interval.
    //       Enabled by default (opt out via WEBHOOK_RETRY_SCHEDULER_DISABLED=1).
    try {
      initWebhookEventBridge()
      this.logger.info('Webhook event bridge initialized')
    } catch (e) {
      this.logger.error('Webhook event bridge initialization failed; continuing in degraded mode', e as Error)
    }

    // Webhook retry scheduler — started BEFORE the durable dispatch loop ON PURPOSE (owner P2, head
    // 1d3854c7a): flag-ON it is a load-bearing durable runtime dependency (the durable webhook leg persists
    // a `pending` row and fire-and-forgets the send; crash recovery — incl. the first-attempt stray-grace
    // leg — IS this scheduler), and the activation sequence must validate EVERY dependency before the loop
    // starts, so a fail-closed abort can never leave a live loop handle ticking the pool. Flag-OFF the order
    // swap is behavior-neutral: the two blocks are independent (the scheduler is webhook_deliveries
    // row-driven and never reads the loop), only the log-line order changes.
    try {
      const webhookRetryLeaderOptions = await resolveWebhookRetrySchedulerLeaderOptions()
      const webhookRetryScheduler = startWebhookRetryScheduler({
        leaderOptions: webhookRetryLeaderOptions,
        intervalMs: resolveWebhookRetrySchedulerIntervalMs(),
      })
      this.logger.info(
        webhookRetryScheduler
          ? 'Webhook retry scheduler initialized'
          : 'Webhook retry scheduler disabled (WEBHOOK_RETRY_SCHEDULER_DISABLED=1)',
      )
      // Owner P1 (head 5afe30f26): with durable delivery ON the retry scheduler is LOAD-BEARING (see the
      // ordering note above). Disabled (env) ⇒ throw here; init failure ⇒ the catch below. Both abort
      // startup flag-ON; flag-OFF keeps the legacy degrade-and-continue.
      const { assertDurableRuntimeDependency } = await import('./multitable/automation-durable-activation')
      assertDurableRuntimeDependency('webhook retry scheduler (durable webhook crash recovery)', webhookRetryScheduler != null)
    } catch (e) {
      const { durableBootFailureDisposition } = await import('./multitable/automation-durable-activation')
      if (durableBootFailureDisposition() === 'fail-closed') {
        // Roll back anything this block managed to start — an aborted startup must leave no ticking DB timer.
        try {
          stopWebhookRetryScheduler()
        } catch {
          // best-effort rollback; the abort below is the authoritative outcome
        }
        this.logger.error('Webhook retry scheduler unavailable with AUTOMATION_DURABLE_DELIVERY_ENABLED=true — aborting startup (fail-closed: the durable webhook leg depends on it for crash recovery)', e as Error)
        throw e
      }
      this.logger.error('Webhook retry scheduler initialization failed; continuing in degraded mode', e as Error)
    }

    // P2 durable-delivery S5: start the transactional-outbox dispatch loop. Gated by
    // AUTOMATION_DURABLE_DELIVERY_ENABLED — bootDurableDelivery returns null when the flag is OFF, so this
    // block registers no loop, opens no poll, and reads no rows (byte-identical startup). When ON, it builds
    // the six REAL consumer adapters (delegating to the SAME service methods the legacy bus subscribers call —
    // handleApprovalCompletionEvent / ...Trigger / projection reconcile / handleEvent / webhook deliverEvent),
    // asserts manifest completeness before any claim, and drains meta_automation_outbox_consumer. The legacy
    // bus subscriptions above stay wired — with the flag ON they serve only UN-routed event types (routed
    // families' producers enqueue same-txn and SUPPRESS their legacy emit, the P1#2 REPLACE contract), and
    // with the flag OFF they are the delivery path exactly as before. stop() is registered in this.stop().
    //
    // ACTIVATION IS A ROLLBACK-ABLE SEQUENCE (owner P2, head 1d3854c7a): every durable dependency is
    // validated BEFORE the loop starts — the retry scheduler in the block above, AutomationService readiness
    // and manifest completeness below — and the loop start is the LAST fallible step, so a fail-closed abort
    // structurally cannot leave a live loop. The catch still stops+nulls any started handle (defense in
    // depth) and tears down the retry scheduler on abort.
    try {
      const { bootDurableDelivery, assertDurableRuntimeDependency } = await import('./multitable/automation-durable-activation')
      const { buildDurableConsumerHandlers } = await import('./multitable/automation-durable-consumer-handlers')
      const { getApprovalRecordProjectionService } = await import('./multitable/approval-record-projection-service')
      const { WebhookService } = await import('./multitable/webhook-service')
      const { db: kyselyDbDurable } = await import('./db/db')
      // Owner P1 (head 5afe30f26): an earlier degraded AutomationService init must not silently SKIP durable
      // boot — with the flag ON, skipping is the same outage as a boot crash (no dispatcher, outbox stranded)
      // but with no exception to catch. The assert throws flag-ON (→ the disposition catch below aborts
      // startup) and no-ops flag-OFF (the `if` skip below keeps the legacy degrade behavior).
      // Owner P1 (head 1d3854c7a): the assert consumes the explicit READINESS bit, not the object's mere
      // existence — publish-last (above) guarantees the bit is true only after constructor+init()+load ALL
      // succeeded, so a half-initialized service can no longer slip past `Boolean(this.automationService)`.
      assertDurableRuntimeDependency(
        'AutomationService (durable consumer handlers delegate; requires the FULL init chain: constructor + init() + loadAndRegisterAllScheduled())',
        this.automationServiceReady && Boolean(this.automationService),
      )
      if (this.automationServiceReady && this.automationService) {
        const handlers = buildDurableConsumerHandlers({
          automationService: this.automationService,
          projectionService: getApprovalRecordProjectionService(),
          webhookService: new WebhookService(kyselyDbDurable),
        })
        this.durableDeliveryLoop = bootDurableDelivery(poolManager.get(), handlers, {
          onUnknownConsumerKeys: (keys) => this.logger.warn(`Durable delivery: unknown consumer keys parked pending: ${keys.join(', ')}`),
          onTickError: (err) => this.logger.error('Durable delivery dispatch tick error', err instanceof Error ? err : new Error(String(err))),
          onHeartbeatError: (info) => this.logger.warn(`Durable delivery heartbeat renew DB error for ${info.consumerKey} (outbox ${info.outboxId}); row left for reclaim`),
          onClaimTimePoison: (info) => this.logger.warn(`Durable delivery dead-lettered ${info.consumerKey} (outbox ${info.outboxId}) after ${info.attempts} attempts`),
        }, {
          // Clock alignment (sink audit 2026-07-17): the OUTBOX consumer lease must outlive the SINK leases
          // (EVENT_DELIVERY_LEASE_MS / BRIDGE_COMPLETION_LEASE_MS, both 60s) — with the 30s default, a crash
          // redelivers while the dead worker's sink lease is still live, burning retries on 'busy'. 90s means
          // the first post-crash redelivery already finds the sink lease expired and reclaims. The busy→
          // retryable mapping in the sinks is the structural guard; this alignment just avoids wasted spins.
          leaseMs: 90_000,
        })
        if (this.durableDeliveryLoop) this.logger.info('Durable delivery dispatch loop started (AUTOMATION_DURABLE_DELIVERY_ENABLED)')
      }
    } catch (e) {
      // Owner closure item 4 — startup fail-closed. With the flag ON the producer families suppress their
      // legacy emits, so continuing without a dispatch loop is not "degraded": it silently strands every
      // outbox row (total delivery outage). The disposition helper (unit-tested) decides per flag.
      //
      // ROLLBACK FIRST (owner P2, head 1d3854c7a): if a loop handle was started before the throw, stop it
      // and null the field NOW — the prior shape left the S1 rejection with a live loop whose next tick hit
      // "Cannot use a pool after calling end on the pool" in the green Node20 CI log. With the reordered
      // sequence above nothing fallible remains after the loop starts, so this is defense in depth.
      if (this.durableDeliveryLoop) {
        const startedLoop = this.durableDeliveryLoop
        this.durableDeliveryLoop = null
        await startedLoop.stop().catch((stopErr: unknown) => {
          this.logger.warn(`Durable delivery dispatch loop rollback stop error: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`)
        })
      }
      const { durableBootFailureDisposition } = await import('./multitable/automation-durable-activation')
      if (durableBootFailureDisposition() === 'fail-closed') {
        // The retry scheduler (started in the block above) must not outlive the aborted startup either.
        try {
          stopWebhookRetryScheduler()
        } catch {
          // best-effort rollback; the abort below is the authoritative outcome
        }
        this.logger.error('Durable delivery boot FAILED with AUTOMATION_DURABLE_DELIVERY_ENABLED=true — aborting startup (fail-closed: legacy emits are suppressed, a loop-less process would strand all outbox rows)', e as Error)
        throw e
      }
      this.logger.error('Durable delivery dispatch loop initialization failed (flag OFF — nothing suppressed, legacy path delivers); continuing', e as Error)
    }

    // B3-07 approval attachment pipeline (#4195 §7/§9) — flag-gated boot: route mount + GC sweep +
    // purge drain + bucket reconciler. APPROVAL_ATTACHMENTS_ENABLED OFF ⇒ bootApprovalAttachmentRuntime
    // returns null: nothing mounts, nothing ticks, byte-identical startup (D5/G1). Flag ON ⇒ the boot
    // resolves storage per the ratified O3 decision (production requires the built-in S3-compatible
    // provider's complete bucket+region configuration; otherwise uploads/downloads fail closed 503;
    // dev/test probe a local-FS root) and a FAILED probe/boot ABORTS startup — the same doctrine as
    // durableBootFailureDisposition (flag ON means a storage-less boot is an outage, not a degrade).
    try {
      const { bootApprovalAttachmentRuntime } = await import('./services/approval-attachment-runtime')
      const attachmentRuntime = await bootApprovalAttachmentRuntime({ db: poolManager.get(), logger: this.logger })
      if (attachmentRuntime) {
        this.app.use(attachmentRuntime.router)
        if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
          this.stopApprovalAttachmentWorkers = attachmentRuntime.startWorkers()
        }
        this.logger.info('Approval attachment pipeline initialized (APPROVAL_ATTACHMENTS_ENABLED)')
      }
    } catch (e) {
      // Only reachable flag-ON (flag-OFF returns null before anything fallible) ⇒ always fail-closed.
      this.logger.error('Approval attachment runtime boot FAILED with APPROVAL_ATTACHMENTS_ENABLED=true — aborting startup (fail-closed: an unusable blob store must not boot a live upload surface)', e as Error)
      throw e
    }

    // AI usage ledger retention sweep (ladder #9): a periodic bounded DELETE of
    // multitable_ai_usage_ledger rows past the retention window (default 90d,
    // env-overridable, floored at 7d so it can never cross a quota window). The
    // M2 ledger inserts a row per attempt, so without this the table grows
    // unbounded under a rate-limit storm. Mirrors the webhook retry scheduler's
    // leader-elected interval; enabled by default (opt out via
    // MULTITABLE_AI_LEDGER_RETENTION_DISABLED=1).
    try {
      const ledgerRetentionLeaderOptions = await resolveLedgerRetentionSchedulerLeaderOptions()
      const ledgerRetentionScheduler = startLedgerRetentionScheduler({
        leaderOptions: ledgerRetentionLeaderOptions,
        intervalMs: resolveLedgerRetentionSchedulerIntervalMs(),
      })
      this.logger.info(
        ledgerRetentionScheduler
          ? 'AI usage ledger retention scheduler initialized'
          : 'AI usage ledger retention scheduler disabled (MULTITABLE_AI_LEDGER_RETENTION_DISABLED=1)',
      )
    } catch (e) {
      this.logger.error('AI usage ledger retention scheduler initialization failed; continuing in degraded mode', e as Error)
    }

    // DingTalk group-delivery retention sweep (R1, DT-HARDEN-08 follow-up): a
    // periodic bounded DELETE of dingtalk_group_deliveries rows past the
    // retention window (default 90d, env-overridable, floored at 7d). The
    // table is write-once — every group-robot send attempt (automation rule
    // firings AND manual test-sends) inserts a row with full message content
    // and raw response bodies, so without this it grows unbounded. Reuses the
    // generic LedgerRetentionScheduler (same pattern as the AI usage ledger
    // sweep above); enabled by default (opt out via
    // DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED=1).
    try {
      const dingtalkDeliveryRetentionLeaderOptions = await resolveDingTalkGroupDeliveryRetentionSchedulerLeaderOptions()
      const dingtalkDeliveryRetentionScheduler = startDingTalkGroupDeliveryRetentionScheduler({
        leaderOptions: dingtalkDeliveryRetentionLeaderOptions,
        intervalMs: resolveDingTalkGroupDeliveryRetentionSchedulerIntervalMs(),
      })
      this.logger.info(
        dingtalkDeliveryRetentionScheduler
          ? 'DingTalk group-delivery retention scheduler initialized'
          : 'DingTalk group-delivery retention scheduler disabled (DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED=1)',
      )
    } catch (e) {
      this.logger.error('DingTalk group-delivery retention scheduler initialization failed; continuing in degraded mode', e as Error)
    }

    // DingTalk approval-card + person delivery retention sweep (DT-HARDEN-08 follow-up): a
    // periodic sweep of dingtalk_person_deliveries (bounded batch DELETE, message content +
    // response bodies) and dingtalk_approval_card_deliveries (stale sent → expired only, never
    // deleted — see dingtalk-card-person-delivery-retention.ts for why). Reuses the generic
    // LedgerRetentionScheduler, same as the group-delivery sweep above. UNLIKE the group sweep,
    // this one is DISABLED BY DEFAULT: it stays a no-op until an operator sets a positive
    // DINGTALK_DELIVERY_RETENTION_DAYS (opt out any time with DINGTALK_DELIVERY_RETENTION_DISABLED=1).
    // The scheduler still starts unconditionally (a harmless no-op timer) so this boot path never
    // depends on whether that env var is set.
    try {
      const dingtalkCardPersonDeliveryRetentionLeaderOptions = await resolveDingTalkCardPersonDeliveryRetentionSchedulerLeaderOptions()
      const dingtalkCardPersonDeliveryRetentionScheduler = startDingTalkCardPersonDeliveryRetentionScheduler({
        leaderOptions: dingtalkCardPersonDeliveryRetentionLeaderOptions,
        intervalMs: resolveDingTalkCardPersonDeliveryRetentionSchedulerIntervalMs(),
      })
      this.logger.info(
        dingtalkCardPersonDeliveryRetentionScheduler
          ? 'DingTalk approval-card/person delivery retention scheduler initialized (no-op until DINGTALK_DELIVERY_RETENTION_DAYS is set)'
          : 'DingTalk approval-card/person delivery retention scheduler disabled (DINGTALK_DELIVERY_RETENTION_DISABLED=1)',
      )
    } catch (e) {
      this.logger.error('DingTalk approval-card/person delivery retention scheduler initialization failed; continuing in degraded mode', e as Error)
    }

    // B-4 BJ-5 follow-up: reconcile ORPHANED AI bulk-fill jobs at boot. A hard
    // restart drops the in-process worker + plan registry, so a job left
    // `queued`/`running` can never progress yet keeps blocking a fresh start for
    // its (actor, sheet, field) scope (the BJ-7 active-job index) until expires_at
    // GC. Flip the stale ones to `errored`. The UPDATE is idempotent and
    // age-guarded, so it is safe to run on every instance (no leader election).
    try {
      const bulkPool = poolManager.get()
      const reconciled = await reconcileOrphanedBulkJobs(bulkPool.query.bind(bulkPool) as AiUsageQueryFn)
      this.logger.info(`AI bulk-fill orphaned-job reconcile: ${reconciled} job(s) marked errored`)
    } catch (e) {
      this.logger.error('AI bulk-fill orphaned-job reconcile failed; continuing in degraded mode', e as Error)
    }

    // 加载插件并启动 HTTP 服务
    if (process.env.SKIP_PLUGINS === 'true') {
      this.logger.warn('Skipping plugin load (SKIP_PLUGINS=true)')
    } else {
      this.logger.info('Loading plugins...')
      try {
        await this.pluginLoader.loadPlugins()
        await this.refreshDisabledPluginsFromRegistry()
        await this.activateLoadedPlugins()
        this.logger.info('Plugins loaded successfully')
      } catch (e) {
        this.logger.error('Plugin loading failed; continuing startup without full plugin set', e as Error)
      }
    }

    // Initialize WebSocket Service
    try {
      const collabService = this.injector.get(ICollabService)
      collabService.setTokenVerifier(async (token: string) => {
        const user = await authService.verifyToken(token)
        return user?.id?.toString() ?? null
      })
      collabService.setSheetRoomAuthChecker(async ({ sheetId, userId }) => {
        try {
          const pool = poolManager.get()
          const { capabilities } = await resolveSheetCapabilitiesForUser(
            pool.query.bind(pool),
            sheetId,
            userId,
          )
          return capabilities.canRead
        } catch {
          return false
        }
      })
      collabService.setCommentRoomAuthChecker(async ({ spreadsheetId, rowId, userId }) => {
        try {
          const pool = poolManager.get()
          const query = pool.query.bind(pool)
          const { capabilities, isAdminRole } = await resolveSheetCapabilitiesForUser(
            query,
            spreadsheetId,
            userId,
          )
          if (!capabilities.canRead) return false
          if (isAdminRole) return true
          if (rowId) {
            return !(await isRecordReadDeniedForUser(query, spreadsheetId, rowId, userId))
          }
          // Sheet-wide comment rooms receive unfilterable full-comment broadcasts.
          // Under row-level deny, non-admin users must subscribe to row rooms only.
          return !(await loadRowLevelReadDenyEnabled(query, spreadsheetId))
        } catch {
          return false
        }
      })
      const commentService = this.injector.get(ICommentService)
      commentService.setCommentTargetReadChecker(async ({ spreadsheetId, rowId, userId }) => {
        try {
          const pool = poolManager.get()
          const query = pool.query.bind(pool)
          const { capabilities, isAdminRole } = await resolveSheetCapabilitiesForUser(
            query,
            spreadsheetId,
            userId,
          )
          if (!capabilities.canRead) return false
          if (isAdminRole) return true
          return !(await isRecordReadDeniedForUser(query, spreadsheetId, rowId, userId))
        } catch {
          return false
        }
      })
      collabService.initialize(this.httpServer)
    } catch (e) {
      this.logger.error('Failed to initialize WebSocket service', e as Error)
    }

    // Initialize Yjs collaborative editing service (behind ENABLE_YJS_COLLAB feature flag)
    const yjsEnabled = process.env.ENABLE_YJS_COLLAB === 'true'
    if (!yjsEnabled) {
      this.logger.info('Yjs collaborative editing disabled (ENABLE_YJS_COLLAB != true)')
    }
    if (yjsEnabled) try {
      const { YjsPersistenceAdapter } = await import('./collab/yjs-persistence-adapter')
      const { YjsSyncService } = await import('./collab/yjs-sync-service')
      const { YjsWebSocketAdapter } = await import('./collab/yjs-websocket-adapter')
      const { YjsRecordBridge } = await import('./collab/yjs-record-bridge')
      const { canReadEveryYjsFieldForUser } = await import('./collab/yjs-field-read-access')
      const { RecordWriteService } = await import('./multitable/record-write-service')
      const { loadSheetMemberUserIdSet, loadFieldPermissionScopeMap } = await import('./multitable/permission-service')
      const { createYjsInvalidationPostCommitHook } = await import('./multitable/post-commit-hooks')
      const { db: kyselyDbYjs } = await import('./db/db')
      const collabIO = this.injector.get(ICollabService).getIO()
      if (collabIO) {
        const yjsPersistence = new YjsPersistenceAdapter(kyselyDbYjs)
        // Seed fresh Y.Docs from meta_records so the first opener of an
        // existing cell sees its current value, not an empty textbox.
        // See yjs-sync-service.ts for the seeding rule (strings only).
        const yjsPoolRef = poolManager.get()
        const yjsRecordSeeder = async (recordId: string) => {
          try {
            const result = await yjsPoolRef.query(
              'SELECT data FROM meta_records WHERE id = $1',
              [recordId],
            )
            const row = (result.rows as Array<{ data: unknown } | undefined>)[0]
            if (!row) return null
            if (row.data && typeof row.data === 'object' && !Array.isArray(row.data)) {
              return row.data as Record<string, unknown>
            }
            return null
          } catch (err) {
            console.error(`[yjs] recordSeeder query failed for ${recordId}:`, err)
            return null
          }
        }
        const yjsSyncService = new YjsSyncService(yjsPersistence, yjsRecordSeeder)
        const yjsWsAdapter = new YjsWebSocketAdapter(yjsSyncService)

        // JWT token verifier: verify token, extract trusted userId
        yjsWsAdapter.setTokenVerifier(async (token: string) => {
          try {
            const user = await authService.verifyToken(token)
            return user?.id?.toString() ?? null
          } catch {
            return null
          }
        })

        // Auth gate: uses the same sheet + record-level capability resolution as REST
        const sheetCaps = await import('./multitable/sheet-capabilities')
        const { resolveSheetCapabilitiesForUser, canWriteRecord } = sheetCaps
        const { isRecordReadDeniedForUser } = await import('./multitable/permission-service')
        yjsWsAdapter.setAuthChecker(async (userId, recordId) => {
          try {
            const pool = poolManager.get()
            const recResult = await pool.query(
              'SELECT id, sheet_id, created_by FROM meta_records WHERE id = $1',
              [recordId],
            )
            if (recResult.rows.length === 0) return null
            const sheetId = String((recResult.rows[0] as any).sheet_id)
            const createdBy = typeof (recResult.rows[0] as any).created_by === 'string'
              ? (recResult.rows[0] as any).created_by : null

            const { capabilities, sheetScope, isAdminRole } = await resolveSheetCapabilitiesForUser(
              pool.query.bind(pool),
              sheetId,
              userId,
            )
            // T36-1 review P1: sheet-level canRead is not enough — the doc seeder loads the
            // record's FULL data, so a row-level-denied record (projection non-participant row,
            // or any row-deny-flagged sheet) must not be subscribable at all. DENY-WINS.
            if (!isAdminRole && capabilities.canRead
              && (await isRecordReadDeniedForUser(pool.query.bind(pool), sheetId, recordId, userId))) {
              return { canRead: false, canWrite: false }
            }
            const canReadAllFields = capabilities.canRead
              ? await canReadEveryYjsFieldForUser(pool.query.bind(pool), sheetId, userId, capabilities)
              : false
            const canWrite = canWriteRecord(capabilities, sheetScope, isAdminRole, userId, createdBy)
            return { canRead: capabilities.canRead, canWrite, canReadAllFields }
          } catch {
            return null
          }
        })

        // Bridge: Y.Text changes → RecordWriteService.patchRecords()
        const pool = poolManager.get()
        // W1-1 (design-lock 2026-07-05 §2 LOCK-F, F1): the actor-based recompute sibling lives in
        // univer-meta.ts (its two req-consumers — the taint resolver + relation-aggregation — are
        // chokepoint-guarded to that file), imported here just for this wiring.
        const { recalculateFormulaFieldsForActor } = await import('./routes/univer-meta')
        const recordWriteService = new RecordWriteService(pool, eventBus, {
          normalizeLinkIds: (v) => (Array.isArray(v) ? v.map(String) : []),
          normalizeAttachmentIds: (v) => (Array.isArray(v) ? v.map(String) : []),
          normalizeJson: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}),
          parseLinkFieldConfig: () => null,
          buildId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
          ensureRecordWriteAllowed: sheetCaps.ensureRecordWriteAllowed,
          filterRecordDataByFieldIds: (data, ids) => {
            if (!data || typeof data !== 'object') return {}
            return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([k]) => ids.has(k)))
          },
          extractLookupRollupData: () => ({}),
          mergeComputedRecords: (base, extra) => ((!base || base.length === 0) && extra.length === 0 ? undefined : [...(base ?? []), ...extra]),
          filterRecordFieldSummaryMap: (map) => map,
          serializeLinkSummaryMap: () => ({}),
          serializeAttachmentSummaryMap: () => ({}),
          // W1-1 (design-lock §2 LOCK-F, F4): lookup/rollup fan-out stays a DELIBERATE stub — they
          // are computed-on-read (no persistent stale value), so a collab edit only misses the
          // cross-record ECHO, never a stale materialized value. Named residual; a separate gated
          // slice if demand names it (GF9 pins this stays stubbed).
          applyLookupRollup: async () => {},
          computeDependentLookupRollupRecords: async () => [],
          // W1-1 (design-lock §2 LOCK-F, F1/F3): formula recalc is NO LONGER stubbed. The bridge has
          // no Express `req`, so it calls the actor-based sibling of the REST recompute — same
          // taint discipline, byte-for-byte (the SAME function body runs under a synthetic
          // writer-taint context keyed on the real flushing actor id instead of a request; no
          // system/full-access bypass).
          recalculateFormulaFields: (q, sid, f, ids, changed, hydrated, actorId) =>
            recalculateFormulaFieldsForActor(actorId ?? null, q, sid, f, ids, changed, hydrated),
          loadLinkValuesByRecord: async () => new Map(),
          buildLinkSummaries: async () => new Map(),
          buildAttachmentSummaries: async () => new Map(),
          ensureAttachmentIdsExist: async () => null,
          // Native person (人员): enforce the member boundary on the Yjs collab write path too —
          // a real resolver (pure query) so a collaboratively-edited person cell can't store a
          // non-member userId. (Unlike link validation, which is stubbed on this bridge path.)
          loadSheetMemberUserIds: (q, sid) => loadSheetMemberUserIdSet(q, sid),
        })

        const yjsBridge = new YjsRecordBridge(
          yjsSyncService,
          recordWriteService,
          async (recordId, patch, actorId, _allActorIds) => {
            // Build RecordPatchInput from recordId + patch fields + real actor
            try {
              const recResult = await pool.query(
                'SELECT sheet_id FROM meta_records WHERE id = $1',
                [recordId],
              )
              if (recResult.rows.length === 0) return null
              const sheetId = String((recResult.rows[0] as any).sheet_id)

              const fieldResult = await pool.query(
                'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
                [sheetId],
              )
              const fields = (fieldResult.rows as any[]).map((f: any) => {
                const prop = f.property && typeof f.property === 'object' ? f.property : {}
                return { id: String(f.id), name: String(f.name), type: f.type, property: prop, options: prop.options, order: Number(f.order ?? 0) }
              })

              // Build real field mutation guards from DB via the CANONICAL `isFieldAlwaysReadOnly` (C2/I-1
              // mirror-read-only hardening). The previous hand-rolled `lookup/rollup || prop.readOnly` MISSED the
              // mirror side of a twoWay link (`property.mirrorOf`) whenever the persisted property lacked
              // `readOnly:true` — the exact gap `isFieldAlwaysReadOnly` (permission-derivation.ts) closes — letting a
              // realtime grid edit write a `meta_links` row for a mirror field. Converge onto the single source of
              // truth, delivering this block's own "same logic as buildFieldMutationGuardMap" intent.
              const fieldById = new Map(
                fields.map((f: any) => {
                  const prop = f.property || {}
                  const isReadOnly = isFieldAlwaysReadOnly(f)
                  const isHidden = prop.hidden === true || prop.permissionHidden === true
                  const guard: any = { type: f.type, readOnly: isReadOnly, hidden: isHidden }
                  if ((f.type === 'select' || f.type === 'multiSelect') && Array.isArray(prop.options)) {
                    guard.options = prop.options.map((o: any) => typeof o === 'string' ? o : o?.value ?? '')
                  }
                  // Set the link guard ONLY for a WRITABLE link — never a read-only mirror (defense-in-depth: the
                  // link-write path is unreachable for a mirror even if the readOnly check were ever bypassed).
                  if (f.type === 'link' && prop.foreignSheetId && !isReadOnly) {
                    guard.link = { foreignSheetId: prop.foreignSheetId, limitSingleRecord: !!prop.limitSingleRecord }
                  }
                  return [f.id, guard] as const
                }),
              )

              const visibleFields = fields.filter((f: any) => {
                const g = fieldById.get(f.id)
                return g && !g.hidden
              })

              const changesByRecord = new Map([
                [recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))],
              ])

              // Resolve real user capabilities — same path as REST
              const { capabilities, sheetScope, isAdminRole, permissions: actorPerms } =
                await resolveSheetCapabilitiesForUser(pool.query.bind(pool), sheetId, actorId)

              // W1-3 (multitable-per-subject-field-write-gate-w13-designlock-20260705, LOCK-F1/F3/F4):
              // Layer-3 per-subject field-WRITE gate. `RecordWriteService.patchRecords` (below, via
              // `yjs-record-bridge.ts`'s executePatch) enforces only PROPERTY-level guards (fieldById
              // above); it does NOT enforce per-subject `field_permissions.read_only` — so a field marked
              // read-only for THIS actor specifically would otherwise be writable through the collab
              // channel even though the everyday grid `/patch` route blocks it. Derive `fieldPermissions`
              // via the SAME composite the grid gate uses (`deriveFieldPermissions` + a per-subject scope
              // read), reusing `visibleFields` already loaded above (only the scope-map read is new — one
              // extra indexed `field_permissions` read per debounced flush build, not per keystroke).
              const fieldScopeMap = await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, actorId)
              const fieldPermissions = deriveFieldPermissions(visibleFields as any, capabilities, { fieldScopeMap })
              const forbiddenWriteFieldIds = Object.keys(patch).filter((fid) => isFieldWriteForbidden(fieldPermissions[fid]))
              if (forbiddenWriteFieldIds.length > 0) {
                // Fail-closed + atomic (F4): THROW a coarse, values-free error rather than returning null.
                // `executePatch` maps a null input to `return false`, which lands in flushNow's
                // `.then(applied => …)` branch and increments NEITHER success nor failure counter — a
                // per-subject deny would be metric-invisible. Throwing routes to the `.catch` branch
                // instead, so the deny increments `flushFailureCount` and is coarsely logged, matching how
                // a genuine write failure is observed on this entry point (there is no HTTP response here).
                throw new FieldWritePermissionDeniedError()
              }

              return {
                sheetId,
                changesByRecord,
                actorId,
                fields: fields as any,
                visiblePropertyFields: visibleFields as any,
                visiblePropertyFieldIds: new Set(visibleFields.map((f: any) => f.id)),
                attachmentFields: visibleFields.filter((f: any) => f.type === 'attachment') as any,
                fieldById: fieldById as any,
                capabilities,
                sheetScope,
                access: { userId: actorId, permissions: actorPerms, isAdminRole },
                // Mark bridge-originated writes so RecordWriteService does NOT
                // fire the Yjs invalidation hook on them — those writes ARE the
                // Y.Doc's authoritative content; wiping it would tear out any
                // live editor and re-seed from stale data (the bridge write
                // hasn't finished appearing in meta_records.data at that point).
                source: 'yjs-bridge' as const,
              }
            } catch (err) {
              // W1-3 F4: a per-subject field-write denial must propagate as a rejection (see the throw
              // above), NOT be folded into this generic "context unavailable" catch — otherwise it would
              // become a null return here too and the deny would be metric-invisible. Every OTHER error
              // (DB unavailable, record deleted mid-build, etc.) keeps the existing coarse-log + null-return
              // behavior.
              if (err instanceof FieldWritePermissionDeniedError) throw err
              console.error(`[yjs-bridge] Failed to build write input for ${recordId}:`, err)
              return null
            }
          },
          { mergeWindowMs: 200, maxDelayMs: 500 },
          (socketId) => yjsWsAdapter.getSocketUserId(socketId),
        )

        yjsWsAdapter.setBridge(yjsBridge)
        yjsWsAdapter.register(collabIO)

        // REST → Yjs invalidator: every REST write to meta_records.data
        // wipes the corresponding Y.Doc state so the next getOrCreateDoc
        // re-seeds from the authoritative DB row. Must cancel bridge
        // pending flushes FIRST — without that a 200–500ms debounced
        // bridge write would re-materialize the stale Yjs-cached value
        // on top of the just-committed REST change.
        const yjsInvalidate = async (recordIds: string[]) => {
          if (recordIds.length === 0) return
          yjsBridge.cancelPending(recordIds)
          try {
            await yjsSyncService.invalidateDocs(recordIds)
          } finally {
            yjsWsAdapter.notifyInvalidated(recordIds)
          }
        }
        recordWriteService.setPostCommitHooks([
          createYjsInvalidationPostCommitHook(yjsInvalidate),
        ])
        const univerMetaModule = await import('./routes/univer-meta')
        univerMetaModule.setYjsInvalidatorForRoutes(yjsInvalidate)

        this.yjsSyncMetricsSource = yjsSyncService
        this.yjsBridgeMetricsSource = yjsBridge
        this.yjsSocketMetricsSource = yjsWsAdapter
        // Periodic cleanup: orphan states + compaction check every 10 minutes
        this.yjsCleanupTimer = setInterval(async () => {
          try {
            const orphanCount = await yjsPersistence.cleanupOrphanStates()
            if (orphanCount > 0) {
              this.logger.info(`[yjs-cleanup] Removed ${orphanCount} orphan Yjs state rows`)
            }
          } catch (err) {
            this.logger.error('[yjs-cleanup] Orphan cleanup failed', err as Error)
          }
        }, 10 * 60 * 1000) // 10 minutes
        this.yjsCleanupTimer.unref()

        this.logger.info('Yjs collaborative editing service initialized on /yjs namespace (bridge + auth + cleanup active)')
      } else {
        this.logger.warn('Yjs: CollabService IO not available, skipping')
      }
    } catch (e) {
      this.logger.error('Failed to initialize Yjs service', e as Error)
    }

    // Initialize Metrics Stream Service (real-time metrics over WebSocket)
    try {
      this.metricsStreamService = new MetricsStreamService()
      this.metricsStreamService.initialize(this.httpServer)
    } catch (e) {
      this.logger.error('Failed to initialize MetricsStreamService', e as Error)
    }

    // Initialize optional DingTalk interactive-card Stream worker (B-1 skeleton; default disabled).
    try {
      this.dingtalkInteractiveCardStreamWorker = new DingTalkInteractiveCardStreamWorker()
      await this.dingtalkInteractiveCardStreamWorker.initialize()
    } catch (e) {
      this.logger.error('Failed to initialize DingTalkInteractiveCardStreamWorker', e as Error)
    }

    this.installGlobalErrorHandler()

    this.logger.info('Starting HTTP server listen phase...')
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.logger.error(`Port ${this.port} is already in use. Stop the process using it or set PORT to another value.`)
        } else if (err.code === 'EACCES') {
          this.logger.error(`Permission denied binding to port ${this.port}. Try a higher port or check permissions.`)
        } else {
          this.logger.error('HTTP server error', err)
        }
        reject(err)
      }

      this.httpServer.once('error', onError)
      const onListening = () => {
        this.httpServer.off('error', onError)

        // If port=0, update port to actual assigned port
        const addr = this.httpServer.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
        }

        const displayHost = this.host ?? 'localhost'
        this.logger.info(`MetaSheet v2 core listening on http://${displayHost}:${this.port}`)
        this.logger.info(`Health:  http://${displayHost}:${this.port}/health`)
        this.logger.info(`Metrics: http://${displayHost}:${this.port}/metrics/prom`)
        this.logger.info(`Plugins: http://${displayHost}:${this.port}/api/plugins`)
        this.logger.info(`Events:  http://${displayHost}:${this.port}/api/events`)
        resolve()
      }

      // Preserve previous behavior: if no host specified, listen on all interfaces.
      if (this.host) {
        this.httpServer.listen(this.port, this.host, onListening)
      } else {
        this.httpServer.listen(this.port, onListening)
      }
    })

    // Background tasks (after server starts listening)
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      this.stopOperationAuditRetention = startOperationAuditRetention({ logger: this.logger })
      this.stopMultitableAttachmentCleanup = startMultitableAttachmentCleanup({ logger: this.logger })
      this.stopMetaRevisionRetention = startMetaRevisionRetention({ logger: this.logger })
      this.stopFilesOrphanBlobRetention = startFilesOrphanBlobRetention({ logger: this.logger })
      this.stopMultitableAttachmentBlobPurge = startMultitableAttachmentBlobPurge({ logger: this.logger })
    }

    // Register signal handlers only for real runtime, not test runners.
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      process.on('SIGTERM', () => this.stop('SIGTERM').then(() => process.exit(0)))
      process.on('SIGINT', () => this.stop('SIGINT').then(() => process.exit(0)))
    }
  }
}

// 启动 - 仅在直接运行时启动服务器，测试导入时不启动
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const server = new MetaSheetServer()
  server.start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start MetaSheet v2 core:', err)
    process.exit(1)
  })
}

// ============================================================
// View Provider System Exports
// ============================================================

// T3-2 WorkdayCalendarPort exports — the approval SLA business-calendar port + registry.
export {
  getWorkdayCalendarRegistry,
  registerWorkdayCalendarProvider,
  unregisterWorkdayCalendarProvider,
  computeWorkdayDeadline,
  WORKDAY_SEARCH_CAP_DAYS,
} from './core/workday-calendar-port'
export type {
  WorkdayCalendarPort,
  WorkdayCalendar,
  RecurringWindow,
  WorkdayDeadlineResult,
} from './core/workday-calendar-port'

// View Config Provider exports
export { getViewConfigRegistry, registerViewConfigProvider, unregisterViewConfigProvider } from './core/view-config-registry'
export type { ViewConfigProvider, ViewConfigProviderRegistry, DatabasePool, BaseViewConfig, GalleryViewConfig, CalendarViewConfig, KanbanViewConfig } from './types/view-config'

// View Data Provider exports
export { getViewDataRegistry, registerViewDataProvider, unregisterViewDataProvider } from './core/view-data-registry'
export { getDefaultViewDataProvider, DefaultViewDataProvider } from './core/default-view-data-provider'
export type { ViewDataProvider, ViewDataProviderRegistry, DataPool, ViewDataContext, ViewDataQueryOptions, ViewDataResult, FilterCondition, SortOptions, PaginationOptions } from './types/view-data'

// Convenience exports from views router
export { registerViewConfigProviderSync, registerViewDataProviderSync } from './routes/views'

// ============================================================
// Plugin System Exports (Sprint 7)
// ============================================================

// Plugin Loader exports
export { PluginLoader } from './core/plugin-loader'
export type { LoadOptions, LoadedPlugin, CascadeReloadOptions, CascadeReloadResult } from './core/plugin-loader'

// Plugin State Manager exports (Hot Swap)
export {
  PluginStateManager,
  getPluginStateManager,
  resetPluginStateManager
} from './core/plugin-state-manager'
export type {
  PluginState,
  StateSerializer,
  HotSwapHooks,
  StateSaveOptions,
  StateRestoreResult
} from './core/plugin-state-manager'

// ============================================================
// Audit System Exports (Sprint 7 Day 2)
// ============================================================

// AuditService exports
export { AuditService } from './audit/AuditService'
export type {
  AuditContext,
  AuditOptions,
  AuditLogFilters,
  UserActivitySummary,
  SecurityEventSummary,
  DataChange,
  AuditMessageEvent
} from './audit/AuditService'

// AuditLogSubscriber exports (JSON Lines file writer)
export {
  AuditLogSubscriber,
  createAuditLogSubscriber
} from './audit/AuditLogSubscriber'
export type {
  AuditLogSubscriberOptions,
  AuditLogStats
} from './audit/AuditLogSubscriber'

// Health Aggregation Exports (Sprint 7 Day 4)
export {
  HealthAggregatorService,
  getHealthAggregator,
  resetHealthAggregator
} from './services/HealthAggregatorService'
export type {
  HealthStatus,
  SubsystemHealth,
  DatabaseHealth,
  MessageBusHealth,
  PluginSystemHealth,
  RateLimitingHealth,
  SystemResourceHealth,
  AggregatedHealth,
  HealthAggregatorConfig
} from './services/HealthAggregatorService'

/**
 * D-2 side-door delete recoverability — TYPED SDK ERRORS on the package's public surface (OD-6; review
 * P3-2). A plugin author catching a refused delete must be able to `instanceof` it, not string-match on
 * `err.code`. Both are only reachable with `MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED='true'`:
 *   - CapExceeded      — the record's inbound-edge count is over MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS
 *                        (fail-closed: refused rather than run half-captured).
 *   - NonTransactional — the SDK's `deleteRecord` was wired outside a transaction (OD-7, fail-closed).
 */
export { MultitableRecordDeleteCapExceededError } from './multitable/record-errors'
export { MultitableSideDoorDeleteNonTransactionalError } from './multitable/side-door-delete-trash'
