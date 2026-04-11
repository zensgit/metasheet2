'use strict'

const appManifest = require('./app.manifest.json')
const installer = require('./lib/installer.cjs')
const { buildDefaultBlueprint } = require('./lib/blueprint.cjs')
const {
  getNotificationTopicSpecs,
  sendTopicNotification,
} = require('./lib/notification-adapter.cjs')
const {
  buildRefundApprovalCommand,
  getRefundApproval,
  submitRefundApproval,
  submitRefundApprovalDecision,
} = require('./lib/refund-approval.cjs')
const {
  registerAfterSalesWorkflowHandlers,
} = require('./lib/workflow-adapter.cjs')
const {
  resolveFieldPoliciesForUser,
  resolveFieldPolicyRoleSlugs,
} = require('./lib/field-policies.cjs')
const {
  buildAutomationUpdateRules,
  buildFieldPolicyUpdatePayload,
  loadRuntimeAdminState,
} = require('./lib/runtime-admin.cjs')
const {
  buildCreateTicketCommand,
  buildCustomerCommand,
  buildFollowUpCommand,
  buildInstalledAssetCommand,
  buildUpdateFollowUpCommand,
  buildUpdateCustomerCommand,
  buildUpdateInstalledAssetCommand,
  buildUpdateTicketCommand,
  buildRefundDecisionEventPayload,
  buildServiceRecordCommand,
  buildUpdateServiceRecordCommand,
  buildServiceRecordedEventPayload,
  buildRequestRefundCommand,
  buildTicketCreatedEventPayload,
  buildRefundRequestedEventPayload,
  buildTicketOverdueEventPayload,
  buildFollowUpDueEventPayload,
} = require('./lib/event-entry.cjs')
const {
  findObjectSheetId,
  resolvePhysicalFieldIds,
  toPhysicalRecord,
  fromPhysicalRecord,
} = require('./lib/multitable-helpers.cjs')

const AFTER_SALES_PLUGIN_ID = 'plugin-after-sales'
const SERVICE_TICKET_FIELDS = ['ticketNo', 'title', 'source', 'priority', 'status', 'slaDueAt', 'refundAmount', 'refundStatus']
const SERVICE_RECORD_FIELDS = ['ticketNo', 'visitType', 'scheduledAt', 'completedAt', 'technicianName', 'workSummary', 'result']
const INSTALLED_ASSET_FIELDS = ['assetCode', 'serialNo', 'model', 'location', 'installedAt', 'warrantyUntil', 'status']
const CUSTOMER_FIELDS = ['customerCode', 'name', 'phone', 'email', 'status']
const FOLLOW_UP_FIELDS = ['ticketNo', 'customerName', 'dueAt', 'followUpType', 'ownerName', 'status', 'summary']

async function toPhysicalTicketData(provisioning, projectId, logicalData) {
  return toPhysicalRecord(provisioning, projectId, 'serviceTicket', logicalData)
}

async function fromPhysicalTicketData(provisioning, projectId, physicalData) {
  return fromPhysicalRecord(provisioning, projectId, 'serviceTicket', SERVICE_TICKET_FIELDS, physicalData)
}

async function toPhysicalServiceRecordData(provisioning, projectId, logicalData) {
  return toPhysicalRecord(provisioning, projectId, 'serviceRecord', logicalData)
}

async function toPhysicalInstalledAssetData(provisioning, projectId, logicalData) {
  return toPhysicalRecord(provisioning, projectId, 'installedAsset', logicalData)
}

async function fromPhysicalServiceRecordData(provisioning, projectId, physicalData) {
  return fromPhysicalRecord(provisioning, projectId, 'serviceRecord', SERVICE_RECORD_FIELDS, physicalData)
}

async function fromPhysicalInstalledAssetData(provisioning, projectId, physicalData) {
  return fromPhysicalRecord(provisioning, projectId, 'installedAsset', INSTALLED_ASSET_FIELDS, physicalData)
}

async function fromPhysicalCustomerData(provisioning, projectId, physicalData) {
  return fromPhysicalRecord(provisioning, projectId, 'customer', CUSTOMER_FIELDS, physicalData)
}

async function fromPhysicalFollowUpData(provisioning, projectId, physicalData) {
  const logicalData = await fromPhysicalRecord(provisioning, projectId, 'followUp', FOLLOW_UP_FIELDS, physicalData)
  return {
    ...logicalData,
    ownerName: logicalData.ownerName ?? null,
    summary: logicalData.summary ?? null,
  }
}

async function toPhysicalFollowUpData(provisioning, projectId, logicalData) {
  return toPhysicalRecord(provisioning, projectId, 'followUp', logicalData)
}

async function toPhysicalCustomerData(provisioning, projectId, logicalData) {
  return toPhysicalRecord(provisioning, projectId, 'customer', logicalData)
}

let activeContext = null
let workflowSubscriptionIds = []
const TENANT_FALLBACK_WARNED = Symbol('after-sales-tenant-fallback-warned')

// --------------------------------------------------------------------------
// Local helpers
// --------------------------------------------------------------------------

/**
 * v1 tenantId extraction. Matches the existing convention used by
 * packages/core-backend/src/routes/plm-workbench.ts and workflow.ts.
 *
 * TODO(phase-1b): replace with AsyncLocalStorage tenantContext.getTenantId()
 * once the plugin-context injection is available for plugins.
 */
function getTenantId(req, logger) {
  const tenantId = req && req.user && req.user.tenantId != null
    ? String(req.user.tenantId).trim()
    : ''
  if (tenantId) return tenantId

  if (req && !req[TENANT_FALLBACK_WARNED]) {
    req[TENANT_FALLBACK_WARNED] = true
    logger && typeof logger.warn === 'function' && logger.warn(
      'After-sales request missing tenantId; falling back to default',
      {
        method: req.method || null,
        path: req.path || null,
        userId: getUserId(req),
      },
    )
  }
  return 'default'
}

function getUserId(req) {
  const u = req.user
  if (!u) return null
  return u.id || u.sub || u.userId || null
}

function normalizeClaimValues(input) {
  if (Array.isArray(input)) {
    return input
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
  }
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }
  return []
}

function hasInstallAdminAccess(req) {
  const user = req && req.user
  if (!user || typeof user !== 'object') return false

  const roles = new Set([
    ...normalizeClaimValues(user.role),
    ...normalizeClaimValues(user.roles),
  ])
  const permissions = new Set([
    ...normalizeClaimValues(user.permissions),
    ...normalizeClaimValues(user.perms),
  ])

  return (
    roles.has('admin') ||
    permissions.has('*:*') ||
    permissions.has('admin') ||
    permissions.has('admin:all') ||
    permissions.has('after_sales:admin')
  )
}

function hasAfterSalesWriteAccess(req) {
  const user = req && req.user
  if (!user || typeof user !== 'object') return false

  const roles = new Set([
    ...normalizeClaimValues(user.role),
    ...normalizeClaimValues(user.roles),
  ])
  const permissions = new Set([
    ...normalizeClaimValues(user.permissions),
    ...normalizeClaimValues(user.perms),
  ])

  return (
    roles.has('admin') ||
    permissions.has('*:*') ||
    permissions.has('admin') ||
    permissions.has('admin:all') ||
    permissions.has('after_sales:write') ||
    permissions.has('after_sales:admin')
  )
}

function hasAfterSalesReadAccess(req) {
  const user = req && req.user
  if (!user || typeof user !== 'object') return false

  const roles = new Set([
    ...normalizeClaimValues(user.role),
    ...normalizeClaimValues(user.roles),
  ])
  const permissions = new Set([
    ...normalizeClaimValues(user.permissions),
    ...normalizeClaimValues(user.perms),
  ])

  return (
    roles.has('admin') ||
    permissions.has('*:*') ||
    permissions.has('admin') ||
    permissions.has('admin:all') ||
    permissions.has('after_sales:read') ||
    permissions.has('after_sales:write') ||
    permissions.has('after_sales:admin')
  )
}

function resolvePluginId(context) {
  return context && context.metadata && typeof context.metadata.name === 'string' && context.metadata.name.trim()
    ? context.metadata.name.trim()
    : AFTER_SALES_PLUGIN_ID
}

function getAutomationRegistryService(context) {
  return context &&
    context.services &&
    context.services.automationRegistry &&
    typeof context.services.automationRegistry.listRules === 'function' &&
    typeof context.services.automationRegistry.upsertRules === 'function'
    ? context.services.automationRegistry
    : null
}

function getRbacProvisioningService(context) {
  return context &&
    context.services &&
    context.services.rbacProvisioning &&
    typeof context.services.rbacProvisioning.applyRoleMatrix === 'function'
    ? context.services.rbacProvisioning
    : null
}

function getDefaultBlueprint() {
  return buildDefaultBlueprint(appManifest)
}

/**
 * v1 whitelist of template ids. v2 will expand this as templates proliferate
 * and/or user-uploaded templates become allowed.
 */
const ALLOWED_TEMPLATE_IDS = new Set(['after-sales-default'])

/**
 * Map InstallerError.code to HTTP status codes per
 * platform-project-creation-flow-design-20260407.md §4.3.
 */
function installerErrorToHttpStatus(code) {
  switch (code) {
    case installer.ERROR_CODES.ALREADY_INSTALLED:
      return 409
    case installer.ERROR_CODES.NO_INSTALL_TO_REBUILD:
      return 404
    case installer.ERROR_CODES.VALIDATION_FAILED:
    case installer.ERROR_CODES.INVALID_TEMPLATE_ID:
      return 400
    case installer.ERROR_CODES.LEDGER_READ_FAILED:
    case installer.ERROR_CODES.CORE_OBJECT_FAILED:
    case installer.ERROR_CODES.LEDGER_WRITE_FAILED:
      return 500
    default:
      return 500
  }
}

function sendInstallerError(res, err) {
  const status = installerErrorToHttpStatus(err.code)
  const payload = {
    ok: false,
    error: { code: err.code, message: err.message },
  }
  if (err.meta && typeof err.meta === 'object') {
    payload.error.details = err.meta
  }
  res.status(status).json(payload)
}

function sendUnauthorized(res) {
  res.status(401).json({
    ok: false,
    error: { code: 'UNAUTHORIZED', message: 'User ID not found' },
  })
}

function sendForbidden(res) {
  res.status(403).json({
    ok: false,
    error: { code: 'FORBIDDEN', message: 'Admin access required' },
  })
}

function sendWriteForbidden(res) {
  res.status(403).json({
    ok: false,
    error: { code: 'FORBIDDEN', message: 'After-sales write access required' },
  })
}

function sendBadRequest(res, err) {
  res.status(400).json({
    ok: false,
    error: {
      code: err && err.code ? err.code : 'BAD_REQUEST',
      message: err && err.message ? err.message : 'Bad request',
      ...(err && err.details && typeof err.details === 'object' ? { details: err.details } : {}),
    },
  })
}

function isOperationalAfterSalesStatus(status) {
  return status === 'installed' || status === 'partial'
}

function getMultitableWriteApi(context) {
  const multitable = context && context.api && context.api.multitable
  const provisioning = multitable && multitable.provisioning
  const records = multitable && multitable.records
  if (
    !provisioning ||
    (typeof provisioning.findObjectSheet !== 'function' &&
      typeof provisioning.getObjectSheetId !== 'function') ||
    (typeof provisioning.resolveFieldIds !== 'function' &&
      typeof provisioning.getFieldId !== 'function') ||
    !records ||
    typeof records.createRecord !== 'function' ||
    typeof records.getRecord !== 'function' ||
    typeof records.patchRecord !== 'function'
  ) {
    return null
  }
  return { provisioning, records }
}

function getMultitableReadApi(context) {
  const multitable = context && context.api && context.api.multitable
  const provisioning = multitable && multitable.provisioning
  const records = multitable && multitable.records
  if (
    !provisioning ||
    (typeof provisioning.findObjectSheet !== 'function' &&
      typeof provisioning.getObjectSheetId !== 'function') ||
    (typeof provisioning.resolveFieldIds !== 'function' &&
      typeof provisioning.getFieldId !== 'function') ||
    !records ||
    typeof records.getRecord !== 'function'
  ) {
    return null
  }
  return { provisioning, records }
}

async function findTicketByTicketNo(multitableApi, projectId, ticketNo) {
  const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
  const recordsApi = multitableApi.records
  let records = []
  let foundByQuery = false

  if (typeof recordsApi.queryRecords === 'function') {
    const physicalFieldIds = await resolvePhysicalFieldIds(
      multitableApi.provisioning,
      projectId,
      'serviceTicket',
      ['ticketNo'],
    )
    records = await recordsApi.queryRecords({
      sheetId,
      filters: {
        [physicalFieldIds.ticketNo || 'ticketNo']: ticketNo,
      },
      limit: 1,
    })
    foundByQuery = Array.isArray(records) && records.length > 0
  }

  if (!foundByQuery && typeof recordsApi.listRecords === 'function') {
    records = await recordsApi.listRecords({ sheetId })
  } else {
    if (!foundByQuery) {
      const error = new Error('Multitable ticket reader is not available on plugin context')
      error.code = 'MULTITABLE_UNAVAILABLE'
      throw error
    }
  }

  for (const ticket of Array.isArray(records) ? records : []) {
    const logicalTicket = await fromPhysicalTicketData(
      multitableApi.provisioning,
      projectId,
      ticket.data,
    )
    if (logicalTicket.ticketNo === ticketNo) {
      return {
        id: ticket.id,
        version: ticket.version,
        data: logicalTicket,
      }
    }
  }

  return null
}

async function getServiceRecordById(multitableApi, projectId, serviceRecordId) {
  const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceRecord')
  const record = await multitableApi.records.getRecord({
    sheetId,
    recordId: serviceRecordId,
  })
  return {
    sheetId,
    record,
    logicalData: await fromPhysicalServiceRecordData(multitableApi.provisioning, projectId, record.data),
  }
}

async function getInstalledAssetById(multitableApi, projectId, installedAssetId) {
  const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'installedAsset')
  const record = await multitableApi.records.getRecord({
    sheetId,
    recordId: installedAssetId,
  })
  return {
    sheetId,
    record,
    logicalData: await fromPhysicalInstalledAssetData(multitableApi.provisioning, projectId, record.data),
  }
}

async function getCustomerById(multitableApi, projectId, customerId) {
  const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'customer')
  const record = await multitableApi.records.getRecord({
    sheetId,
    recordId: customerId,
  })
  return {
    sheetId,
    record,
    logicalData: await fromPhysicalCustomerData(multitableApi.provisioning, projectId, record.data),
  }
}

async function getFollowUpById(multitableApi, projectId, followUpId) {
  const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'followUp')
  const record = await multitableApi.records.getRecord({
    sheetId,
    recordId: followUpId,
  })
  return {
    sheetId,
    record,
    logicalData: await fromPhysicalFollowUpData(multitableApi.provisioning, projectId, record.data),
  }
}

async function getTicketRecordById(multitableApi, projectId, ticketId) {
  const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
  const record = await multitableApi.records.getRecord({
    sheetId,
    recordId: ticketId,
  })
  return {
    sheetId,
    record,
    logicalData: await fromPhysicalTicketData(multitableApi.provisioning, projectId, record.data),
  }
}

function resolveTenantIdFromProject(projectId) {
  if (typeof projectId !== 'string') return 'default'
  const [tenantId] = projectId.split(':')
  return tenantId || 'default'
}

async function handleRefundApprovalDecisionCallback(context, input) {
  const approval = input && typeof input.approval === 'object' ? input.approval : {}
  const decision = input && typeof input === 'object' ? input.decision : null
  const ticket = approval && typeof approval.subject === 'object' && approval.subject ? approval.subject : {}
  const projectId = typeof ticket.projectId === 'string' && ticket.projectId.trim()
    ? ticket.projectId.trim()
    : (typeof input?.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : '')
  const ticketId = typeof ticket.ticketId === 'string' && ticket.ticketId.trim()
    ? ticket.ticketId.trim()
    : (typeof input?.ticketId === 'string' && input.ticketId.trim() ? input.ticketId.trim() : '')

  if (!projectId || !ticketId) {
    throw new Error('projectId and ticketId are required to handle refund approval decisions')
  }

  const multitableApi = getMultitableWriteApi(context)
  if (!multitableApi) {
    throw new Error('Multitable record writer is not available on plugin context')
  }

  const refundStatus = decision === 'approved' ? 'approved' : 'rejected'
  const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
  const updatedRecord = await multitableApi.records.patchRecord({
    sheetId,
    recordId: ticketId,
    changes: await toPhysicalTicketData(multitableApi.provisioning, projectId, {
      refundStatus,
    }),
  })
  const logicalUpdated = await fromPhysicalTicketData(multitableApi.provisioning, projectId, updatedRecord.data)

  const payload = buildRefundDecisionEventPayload({
    decision: refundStatus,
    actorId: typeof input?.actorId === 'string' ? input.actorId : 'system',
    actorName: typeof input?.actorName === 'string' ? input.actorName : undefined,
    comment: typeof input?.comment === 'string' ? input.comment : undefined,
    ticket: {
      id: updatedRecord.id,
      ticketNo: logicalUpdated.ticketNo,
      title: logicalUpdated.title,
      refundAmount: logicalUpdated.refundAmount,
    },
    approval: {
      id: typeof approval.id === 'string' ? approval.id : undefined,
      bridge: 'after-sales-refund',
      ticketId,
      comment: typeof input?.comment === 'string' ? input.comment : undefined,
    },
  }, {
    tenantId: resolveTenantIdFromProject(projectId),
    projectId,
  })
  context.api.events.emit(
    refundStatus === 'approved' ? 'refund.settled' : 'refund.rejected',
    payload,
  )

  return {
    projectId,
    ticket: {
      id: updatedRecord.id,
      version: updatedRecord.version,
      data: logicalUpdated,
    },
    event: {
      accepted: true,
      event: refundStatus === 'approved' ? 'refund.settled' : 'refund.rejected',
    },
  }
}

function cleanupWorkflowSubscriptions() {
  if (
    activeContext &&
    activeContext.api &&
    activeContext.api.events &&
    typeof activeContext.api.events.off === 'function'
  ) {
    for (const subscriptionId of workflowSubscriptionIds) {
      if (subscriptionId) {
        activeContext.api.events.off(subscriptionId)
      }
    }
  }
  workflowSubscriptionIds = []
  activeContext = null
}

// --------------------------------------------------------------------------
// Plugin entry
// --------------------------------------------------------------------------

module.exports = {
  async activate(context) {
    cleanupWorkflowSubscriptions()
    activeContext = context
    const logger = context.logger || console

    // Health / manifest probes (unchanged from skeleton)
    context.api.http.addRoute('GET', '/api/after-sales/health', async (_req, res) => {
      res.json({
        ok: true,
        plugin: 'plugin-after-sales',
        appId: appManifest.id,
        ts: Date.now(),
      })
    })

    context.api.http.addRoute('GET', '/api/after-sales/app-manifest', async (_req, res) => {
      res.json({
        ok: true,
        data: appManifest,
      })
    })

    // ------------------------------------------------------------------
    // GET /api/after-sales/projects/current
    //
    // Returns a ProjectCurrentResponse (see #5 §5.2.1). Used by the frontend
    // AfterSalesView state machine on mount to decide which sub-view to
    // render: not-installed / installed / partial / failed.
    // ------------------------------------------------------------------
    context.api.http.addRoute(
      'GET',
      '/api/after-sales/projects/current',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          res.json({ ok: true, data: current })
        } catch (err) {
          if (err instanceof installer.InstallerError) {
            sendInstallerError(res, err)
            return
          }
          logger.error && logger.error('after-sales loadCurrent failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to load current state' },
          })
        }
      },
    )

    // ------------------------------------------------------------------
    // POST /api/after-sales/projects/install
    //
    // Triggers the installer orchestrator. Accepts ProjectCreateRequest
    // (see #4 §4.1). The `projectId` field is ignored in v1; the installer
    // always generates `${tenantId}:after-sales`.
    // ------------------------------------------------------------------
    context.api.http.addRoute(
      'POST',
      '/api/after-sales/projects/install',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasInstallAdminAccess(req)) {
            sendForbidden(res)
            return
          }

          const body = (req && req.body) || {}

          const templateId = typeof body.templateId === 'string' ? body.templateId : ''
          if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
            res.status(400).json({
              ok: false,
              error: {
                code: installer.ERROR_CODES.INVALID_TEMPLATE_ID,
                message: `unknown templateId: ${templateId || '(empty)'}`,
              },
            })
            return
          }

          const mode = body.mode === 'reinstall' ? 'reinstall' : 'enable'
          const displayName = typeof body.displayName === 'string' ? body.displayName : ''
          const config =
            body.config && typeof body.config === 'object' && !Array.isArray(body.config)
              ? body.config
              : {}

          const tenantId = getTenantId(req, context.logger)
          const blueprint = getDefaultBlueprint()

          const result = await installer.runInstall({
            context,
            tenantId,
            blueprint,
            mode,
            displayName,
            config,
          })

          res.json({
            ok: true,
            data: {
              projectId: result.projectId,
              appId: result.appId,
              routes: {
                home: '/p/plugin-after-sales/after-sales',
                apiBase: '/api/after-sales',
              },
              installResult: result,
            },
          })
        } catch (err) {
          if (err instanceof installer.InstallerError) {
            sendInstallerError(res, err)
            return
          }
          logger.error && logger.error('after-sales runInstall failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Install failed' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'GET',
      '/api/after-sales/field-policies',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesReadAccess(req)) {
            res.status(403).json({
              ok: false,
              error: { code: 'FORBIDDEN', message: 'After-sales read access required' },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before reading field policies',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const policies = await resolveFieldPoliciesForUser(context.api.database, {
            tenantId,
            pluginId: context.metadata && context.metadata.name ? context.metadata.name : 'plugin-after-sales',
            appId: appManifest.id,
            projectId,
            roleSlugs: resolveFieldPolicyRoleSlugs(req && req.user),
          })

          res.json({
            ok: true,
            data: policies,
          })
        } catch (err) {
          logger.error && logger.error('after-sales field policy lookup failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to load after-sales field policies' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'GET',
      '/api/after-sales/runtime-admin',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasInstallAdminAccess(req)) {
            sendForbidden(res)
            return
          }

          const automationRegistry = getAutomationRegistryService(context)
          if (!automationRegistry) {
            throw new Error('automationRegistry service unavailable on plugin context')
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before managing runtime admin state',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const data = await loadRuntimeAdminState({
            database: context.api.database,
            automationRegistry,
            blueprint: getDefaultBlueprint(),
            manifest: appManifest,
            tenantId,
            pluginId: resolvePluginId(context),
            appId: appManifest.id,
            projectId,
          })

          res.json({
            ok: true,
            data,
          })
        } catch (err) {
          logger.error && logger.error('after-sales runtime admin lookup failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to load after-sales runtime admin state' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'PUT',
      '/api/after-sales/runtime-admin/automations',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasInstallAdminAccess(req)) {
            sendForbidden(res)
            return
          }

          const automationRegistry = getAutomationRegistryService(context)
          if (!automationRegistry) {
            throw new Error('automationRegistry service unavailable on plugin context')
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before updating runtime automations',
              },
            })
            return
          }

          const blueprint = getDefaultBlueprint()
          const body = req && req.body && typeof req.body === 'object' ? req.body : {}
          const rules = buildAutomationUpdateRules(blueprint, appManifest, body.automations)
          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)

          await automationRegistry.upsertRules({
            pluginId: resolvePluginId(context),
            appId: appManifest.id,
            tenantId,
            projectId,
            templateId: blueprint.id,
            rules,
          })

          const data = await loadRuntimeAdminState({
            database: context.api.database,
            automationRegistry,
            blueprint,
            manifest: appManifest,
            tenantId,
            pluginId: resolvePluginId(context),
            appId: appManifest.id,
            projectId,
          })

          res.json({
            ok: true,
            data,
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          logger.error && logger.error('after-sales runtime automation update failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to update after-sales automations' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'PUT',
      '/api/after-sales/runtime-admin/field-policies',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasInstallAdminAccess(req)) {
            sendForbidden(res)
            return
          }

          const rbacProvisioning = getRbacProvisioningService(context)
          const automationRegistry = getAutomationRegistryService(context)
          if (!rbacProvisioning) {
            throw new Error('rbacProvisioning service unavailable on plugin context')
          }
          if (!automationRegistry) {
            throw new Error('automationRegistry service unavailable on plugin context')
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before updating field policies',
              },
            })
            return
          }

          const blueprint = getDefaultBlueprint()
          const body = req && req.body && typeof req.body === 'object' ? req.body : {}
          const roleMatrix = buildFieldPolicyUpdatePayload(blueprint, body.roles)
          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)

          await rbacProvisioning.applyRoleMatrix({
            pluginId: resolvePluginId(context),
            appId: appManifest.id,
            tenantId,
            projectId,
            matrix: roleMatrix,
          })

          const data = await loadRuntimeAdminState({
            database: context.api.database,
            automationRegistry,
            blueprint,
            manifest: appManifest,
            tenantId,
            pluginId: resolvePluginId(context),
            appId: appManifest.id,
            projectId,
          })

          res.json({
            ok: true,
            data,
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          logger.error && logger.error('after-sales runtime field policy update failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to update after-sales field policies' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'GET',
      '/api/after-sales/tickets',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesReadAccess(req)) {
            res.status(403).json({
              ok: false,
              error: { code: 'FORBIDDEN', message: 'After-sales read access required' },
            })
            return
          }

          const multitableApi = getMultitableReadApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record reader is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before listing tickets',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
          const status = typeof req?.query?.status === 'string' && req.query.status.trim()
            ? req.query.status.trim()
            : null
          const search = typeof req?.query?.search === 'string' && req.query.search.trim()
            ? req.query.search.trim()
            : null
          const limit = typeof req?.query?.limit === 'string' && req.query.limit.trim()
            ? Number(req.query.limit)
            : undefined
          const offset = typeof req?.query?.offset === 'string' && req.query.offset.trim()
            ? Number(req.query.offset)
            : undefined

          const recordsApi = multitableApi.records
          let tickets
          if (typeof recordsApi.queryRecords === 'function') {
            const physicalFieldIds = status
              ? await resolvePhysicalFieldIds(
                  multitableApi.provisioning,
                  projectId,
                  'serviceTicket',
                  ['status'],
                )
              : {}
            const filters = status
              ? {
                  [physicalFieldIds.status || 'status']: status,
                }
              : undefined
            tickets = await recordsApi.queryRecords({
              sheetId,
              filters,
              search,
              limit,
              offset,
            })
          } else if (typeof recordsApi.listRecords === 'function') {
            tickets = await recordsApi.listRecords({
              sheetId,
              limit,
              offset,
            })
          } else {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable list/query seam is not available on plugin context',
              },
            })
            return
          }

          const logicalTickets = Array.isArray(tickets)
            ? (
                await Promise.all(
                  tickets.map(async (ticket) => ({
                    id: ticket.id,
                    version: ticket.version,
                    data: await fromPhysicalTicketData(multitableApi.provisioning, projectId, ticket.data),
                  })),
                )
              ).filter((ticket) => {
                if (status && ticket.data.status !== status) return false
                if (!search) return true
                const haystack = JSON.stringify(ticket.data).toLowerCase()
                return haystack.includes(search.toLowerCase())
              })
            : []

          res.json({
            ok: true,
            data: {
              projectId,
              tickets: logicalTickets,
              count: logicalTickets.length,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales list tickets failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to list after-sales tickets' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/tickets',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before creating tickets',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const command = buildCreateTicketCommand((req && req.body) || {})
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
          const record = await multitableApi.records.createRecord({
            sheetId,
            data: await toPhysicalTicketData(multitableApi.provisioning, projectId, command.recordData),
          })
          const logicalRecordData = await fromPhysicalTicketData(multitableApi.provisioning, projectId, record.data)

          let event = { accepted: false, event: 'ticket.created' }
          try {
            const payload = buildTicketCreatedEventPayload({
              ticket: {
                id: record.id,
                ...command.eventTicket,
              },
            }, {
              tenantId,
              projectId,
              requesterId: userId,
            })
            context.api.events.emit('ticket.created', payload)
            event = { accepted: true, event: 'ticket.created' }
          } catch (err) {
            logger.error && logger.error('after-sales ticket.created emit after record create failed', err)
          }

          res.status(201).json({
            ok: true,
            data: {
              projectId,
              ticket: {
                id: record.id,
                version: record.version,
                data: logicalRecordData,
              },
              event,
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales create ticket failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to create after-sales ticket' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'PATCH',
      '/api/after-sales/tickets/:ticketId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const ticketId = typeof req?.params?.ticketId === 'string' ? req.params.ticketId.trim() : ''
          if (!ticketId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'ticketId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before updating tickets',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const { sheetId, record, logicalData } = await getTicketRecordById(multitableApi, projectId, ticketId)
          const command = buildUpdateTicketCommand((req && req.body) || {}, {
            id: record.id,
            ...logicalData,
          })
          const updatedRecord = await multitableApi.records.patchRecord({
            sheetId,
            recordId: ticketId,
            changes: await toPhysicalTicketData(multitableApi.provisioning, projectId, command.changes),
          })
          const logicalUpdated = await fromPhysicalTicketData(multitableApi.provisioning, projectId, updatedRecord.data)

          res.json({
            ok: true,
            data: {
              projectId,
              ticket: {
                id: updatedRecord.id,
                version: updatedRecord.version,
                data: logicalUpdated,
              },
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales update ticket failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to update after-sales ticket' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/after-sales/tickets/:ticketId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const ticketId = typeof req?.params?.ticketId === 'string' ? req.params.ticketId.trim() : ''
          if (!ticketId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'ticketId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi || typeof multitableApi.records.deleteRecord !== 'function') {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record delete seam is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before deleting tickets',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
          const deleted = await multitableApi.records.deleteRecord({
            sheetId,
            recordId: ticketId,
          })

          res.json({
            ok: true,
            data: {
              projectId,
              ticketId: deleted.id,
              version: deleted.version,
              deleted: true,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales delete ticket failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to delete after-sales ticket' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/installed-assets',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before creating installed assets',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const command = buildInstalledAssetCommand((req && req.body) || {})
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'installedAsset')
          const record = await multitableApi.records.createRecord({
            sheetId,
            data: await toPhysicalInstalledAssetData(multitableApi.provisioning, projectId, command.recordData),
          })
          const logicalRecordData = await fromPhysicalInstalledAssetData(
            multitableApi.provisioning,
            projectId,
            record.data,
          )

          res.status(201).json({
            ok: true,
            data: {
              projectId,
              installedAsset: {
                id: record.id,
                version: record.version,
                data: logicalRecordData,
              },
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales create installed asset failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to create after-sales installed asset' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'PATCH',
      '/api/after-sales/installed-assets/:installedAssetId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const installedAssetId =
            typeof req?.params?.installedAssetId === 'string' ? req.params.installedAssetId.trim() : ''
          if (!installedAssetId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'installedAssetId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before updating installed assets',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const { sheetId, record, logicalData } = await getInstalledAssetById(multitableApi, projectId, installedAssetId)
          const command = buildUpdateInstalledAssetCommand((req && req.body) || {}, {
            id: record.id,
            ...logicalData,
          })
          const updatedRecord = await multitableApi.records.patchRecord({
            sheetId,
            recordId: installedAssetId,
            changes: await toPhysicalInstalledAssetData(multitableApi.provisioning, projectId, command.changes),
          })
          const logicalUpdated = await fromPhysicalInstalledAssetData(
            multitableApi.provisioning,
            projectId,
            updatedRecord.data,
          )

          res.json({
            ok: true,
            data: {
              projectId,
              installedAsset: {
                id: updatedRecord.id,
                version: updatedRecord.version,
                data: logicalUpdated,
              },
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales update installed asset failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to update after-sales installed asset' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/after-sales/installed-assets/:installedAssetId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const installedAssetId =
            typeof req?.params?.installedAssetId === 'string' ? req.params.installedAssetId.trim() : ''
          if (!installedAssetId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'installedAssetId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi || typeof multitableApi.records.deleteRecord !== 'function') {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record delete seam is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before deleting installed assets',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'installedAsset')
          const deleted = await multitableApi.records.deleteRecord({
            sheetId,
            recordId: installedAssetId,
          })

          res.json({
            ok: true,
            data: {
              projectId,
              installedAssetId: deleted.id,
              version: deleted.version,
              deleted: true,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales delete installed asset failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to delete after-sales installed asset' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'GET',
      '/api/after-sales/installed-assets',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesReadAccess(req)) {
            res.status(403).json({
              ok: false,
              error: { code: 'FORBIDDEN', message: 'After-sales read access required' },
            })
            return
          }

          const multitableApi = getMultitableReadApi(context)
          if (!multitableApi || (typeof multitableApi.records.listRecords !== 'function' && typeof multitableApi.records.queryRecords !== 'function')) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record reader is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before listing installed assets',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'installedAsset')
          const status = typeof req?.query?.status === 'string' && req.query.status.trim()
            ? req.query.status.trim()
            : null
          const search = typeof req?.query?.search === 'string' && req.query.search.trim()
            ? req.query.search.trim()
            : null
          const limit = typeof req?.query?.limit === 'string' && req.query.limit.trim()
            ? Number(req.query.limit)
            : undefined
          const offset = typeof req?.query?.offset === 'string' && req.query.offset.trim()
            ? Number(req.query.offset)
            : undefined

          const recordsApi = multitableApi.records
          let installedAssets
          if (typeof recordsApi.queryRecords === 'function') {
            const physicalFieldIds = status
              ? await resolvePhysicalFieldIds(
                  multitableApi.provisioning,
                  projectId,
                  'installedAsset',
                  ['status'],
                )
              : {}
            const filters = status
              ? {
                  [physicalFieldIds.status || 'status']: status,
                }
              : undefined
            installedAssets = await recordsApi.queryRecords({
              sheetId,
              filters,
              search,
              limit,
              offset,
            })
          } else {
            installedAssets = await recordsApi.listRecords({
              sheetId,
              limit,
              offset,
            })
          }

          const logicalInstalledAssets = Array.isArray(installedAssets)
            ? (
                await Promise.all(
                  installedAssets.map(async (installedAsset) => ({
                    id: installedAsset.id,
                    version: installedAsset.version,
                    data: await fromPhysicalInstalledAssetData(
                      multitableApi.provisioning,
                      projectId,
                      installedAsset.data,
                    ),
                  })),
                )
              ).filter((record) => {
                if (status && record.data.status !== status) return false
                if (!search) return true
                const haystack = JSON.stringify(record.data).toLowerCase()
                return haystack.includes(search.toLowerCase())
              })
            : []

          res.json({
            ok: true,
            data: {
              projectId,
              installedAssets: logicalInstalledAssets,
              count: logicalInstalledAssets.length,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales list installed assets failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to list after-sales installed assets' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'GET',
      '/api/after-sales/service-records',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesReadAccess(req)) {
            res.status(403).json({
              ok: false,
              error: { code: 'FORBIDDEN', message: 'After-sales read access required' },
            })
            return
          }

          const multitableApi = getMultitableReadApi(context)
          if (!multitableApi || (typeof multitableApi.records.listRecords !== 'function' && typeof multitableApi.records.queryRecords !== 'function')) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record reader is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before listing service records',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceRecord')
          const ticketNo = typeof req?.query?.ticketNo === 'string' && req.query.ticketNo.trim()
            ? req.query.ticketNo.trim()
            : null
          const resultFilter = typeof req?.query?.result === 'string' && req.query.result.trim()
            ? req.query.result.trim()
            : null
          const search = typeof req?.query?.search === 'string' && req.query.search.trim()
            ? req.query.search.trim()
            : null
          const limit = typeof req?.query?.limit === 'string' && req.query.limit.trim()
            ? Number(req.query.limit)
            : undefined
          const offset = typeof req?.query?.offset === 'string' && req.query.offset.trim()
            ? Number(req.query.offset)
            : undefined

          const recordsApi = multitableApi.records
          let serviceRecords
          if (typeof recordsApi.queryRecords === 'function') {
            const fieldIds = []
            if (ticketNo) fieldIds.push('ticketNo')
            if (resultFilter) fieldIds.push('result')
            const physicalFieldIds = fieldIds.length
              ? await resolvePhysicalFieldIds(multitableApi.provisioning, projectId, 'serviceRecord', fieldIds)
              : {}
            const filters = {}
            if (ticketNo) {
              filters[physicalFieldIds.ticketNo || 'ticketNo'] = ticketNo
            }
            if (resultFilter) {
              filters[physicalFieldIds.result || 'result'] = resultFilter
            }
            serviceRecords = await recordsApi.queryRecords({
              sheetId,
              filters: Object.keys(filters).length ? filters : undefined,
              search,
              limit,
              offset,
            })
          } else {
            serviceRecords = await recordsApi.listRecords({
              sheetId,
              limit,
              offset,
            })
          }

          const logicalServiceRecords = Array.isArray(serviceRecords)
            ? (
                await Promise.all(
                  serviceRecords.map(async (serviceRecord) => ({
                    id: serviceRecord.id,
                    version: serviceRecord.version,
                    data: await fromPhysicalServiceRecordData(
                      multitableApi.provisioning,
                      projectId,
                      serviceRecord.data,
                    ),
                  })),
                )
              ).filter((record) => {
                if (ticketNo && record.data.ticketNo !== ticketNo) return false
                if (resultFilter && record.data.result !== resultFilter) return false
                if (!search) return true
                const haystack = JSON.stringify(record.data).toLowerCase()
                return haystack.includes(search.toLowerCase())
              })
            : []

          res.json({
            ok: true,
            data: {
              projectId,
              serviceRecords: logicalServiceRecords,
              count: logicalServiceRecords.length,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales list service records failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to list after-sales service records' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/customers',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before creating customers',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const command = buildCustomerCommand((req && req.body) || {})
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'customer')
          const record = await multitableApi.records.createRecord({
            sheetId,
            data: await toPhysicalCustomerData(multitableApi.provisioning, projectId, command.recordData),
          })
          const logicalRecordData = await fromPhysicalCustomerData(
            multitableApi.provisioning,
            projectId,
            record.data,
          )

          res.status(201).json({
            ok: true,
            data: {
              projectId,
              customer: {
                id: record.id,
                version: record.version,
                data: logicalRecordData,
              },
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales create customer failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to create after-sales customer' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'GET',
      '/api/after-sales/customers',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesReadAccess(req)) {
            res.status(403).json({
              ok: false,
              error: { code: 'FORBIDDEN', message: 'After-sales read access required' },
            })
            return
          }

          const multitableApi = getMultitableReadApi(context)
          if (!multitableApi || (typeof multitableApi.records.listRecords !== 'function' && typeof multitableApi.records.queryRecords !== 'function')) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record reader is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before listing customers',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'customer')
          const status = typeof req?.query?.status === 'string' && req.query.status.trim()
            ? req.query.status.trim()
            : null
          const search = typeof req?.query?.search === 'string' && req.query.search.trim()
            ? req.query.search.trim()
            : null
          const limit = typeof req?.query?.limit === 'string' && req.query.limit.trim()
            ? Number(req.query.limit)
            : undefined
          const offset = typeof req?.query?.offset === 'string' && req.query.offset.trim()
            ? Number(req.query.offset)
            : undefined

          const recordsApi = multitableApi.records
          let customers
          if (typeof recordsApi.queryRecords === 'function') {
            const physicalFieldIds = status
              ? await resolvePhysicalFieldIds(
                  multitableApi.provisioning,
                  projectId,
                  'customer',
                  ['status'],
                )
              : {}
            const filters = status
              ? {
                  [physicalFieldIds.status || 'status']: status,
                }
              : undefined
            customers = await recordsApi.queryRecords({
              sheetId,
              filters,
              search,
              limit,
              offset,
            })
          } else {
            customers = await recordsApi.listRecords({
              sheetId,
              limit,
              offset,
            })
          }

          const logicalCustomers = Array.isArray(customers)
            ? (
                await Promise.all(
                  customers.map(async (customer) => ({
                    id: customer.id,
                    version: customer.version,
                    data: await fromPhysicalCustomerData(
                      multitableApi.provisioning,
                      projectId,
                      customer.data,
                    ),
                  })),
                )
              ).filter((record) => {
                if (status && record.data.status !== status) return false
                if (!search) return true
                const haystack = JSON.stringify(record.data).toLowerCase()
                return haystack.includes(search.toLowerCase())
              })
            : []

          res.json({
            ok: true,
            data: {
              projectId,
              customers: logicalCustomers,
              count: logicalCustomers.length,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales list customers failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to list after-sales customers' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/follow-ups',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable write seam is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before creating follow-ups',
              },
            })
            return
          }

          const command = buildFollowUpCommand((req && req.body) || {})
          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'followUp')
          const record = await multitableApi.records.createRecord({
            sheetId,
            data: await toPhysicalFollowUpData(multitableApi.provisioning, projectId, command.recordData),
          })
          const logicalRecordData = await fromPhysicalFollowUpData(
            multitableApi.provisioning,
            projectId,
            record.data,
          )

          res.status(201).json({
            ok: true,
            data: {
              projectId,
              followUp: {
                id: record.id,
                version: record.version,
                data: logicalRecordData,
              },
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales create follow-up failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to create after-sales follow-up' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/after-sales/follow-ups/:followUpId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const followUpId =
            typeof req?.params?.followUpId === 'string' ? req.params.followUpId.trim() : ''
          if (!followUpId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'followUpId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi || typeof multitableApi.records.deleteRecord !== 'function') {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record delete seam is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before deleting follow-ups',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'followUp')
          const deleted = await multitableApi.records.deleteRecord({
            sheetId,
            recordId: followUpId,
          })

          res.json({
            ok: true,
            data: {
              projectId,
              followUpId: deleted.id,
              version: deleted.version,
              deleted: true,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales delete follow-up failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to delete after-sales follow-up' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'PATCH',
      '/api/after-sales/follow-ups/:followUpId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const followUpId =
            typeof req?.params?.followUpId === 'string' ? req.params.followUpId.trim() : ''
          if (!followUpId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'followUpId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before updating follow-ups',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const { sheetId, record, logicalData } = await getFollowUpById(multitableApi, projectId, followUpId)
          const command = buildUpdateFollowUpCommand((req && req.body) || {}, {
            id: record.id,
            ...logicalData,
          })
          const updatedRecord = await multitableApi.records.patchRecord({
            sheetId,
            recordId: followUpId,
            changes: await toPhysicalFollowUpData(multitableApi.provisioning, projectId, command.changes),
          })
          const logicalRecordData = await fromPhysicalFollowUpData(
            multitableApi.provisioning,
            projectId,
            updatedRecord.data,
          )

          res.json({
            ok: true,
            data: {
              projectId,
              followUp: {
                id: updatedRecord.id,
                version: updatedRecord.version,
                data: logicalRecordData,
              },
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales update follow-up failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to update after-sales follow-up' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'GET',
      '/api/after-sales/follow-ups',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesReadAccess(req)) {
            res.status(403).json({
              ok: false,
              error: { code: 'FORBIDDEN', message: 'After-sales read access required' },
            })
            return
          }

          const multitableApi = getMultitableReadApi(context)
          if (!multitableApi || (typeof multitableApi.records.listRecords !== 'function' && typeof multitableApi.records.queryRecords !== 'function')) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record reader is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before listing follow-ups',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'followUp')
          const status = typeof req?.query?.status === 'string' && req.query.status.trim()
            ? req.query.status.trim()
            : null
          const ticketNo = typeof req?.query?.ticketNo === 'string' && req.query.ticketNo.trim()
            ? req.query.ticketNo.trim()
            : null
          const search = typeof req?.query?.search === 'string' && req.query.search.trim()
            ? req.query.search.trim()
            : null
          const limit = typeof req?.query?.limit === 'string' && req.query.limit.trim()
            ? Number(req.query.limit)
            : undefined
          const offset = typeof req?.query?.offset === 'string' && req.query.offset.trim()
            ? Number(req.query.offset)
            : undefined

          const recordsApi = multitableApi.records
          let followUps
          if (typeof recordsApi.queryRecords === 'function') {
            const fieldIds = []
            if (status) fieldIds.push('status')
            if (ticketNo) fieldIds.push('ticketNo')
            const physicalFieldIds = fieldIds.length
              ? await resolvePhysicalFieldIds(multitableApi.provisioning, projectId, 'followUp', fieldIds)
              : {}
            const filters = {}
            if (status) {
              filters[physicalFieldIds.status || 'status'] = status
            }
            if (ticketNo) {
              filters[physicalFieldIds.ticketNo || 'ticketNo'] = ticketNo
            }
            followUps = await recordsApi.queryRecords({
              sheetId,
              filters: Object.keys(filters).length ? filters : undefined,
              search,
              limit,
              offset,
            })
          } else {
            followUps = await recordsApi.listRecords({
              sheetId,
              limit,
              offset,
            })
          }

          const logicalFollowUps = Array.isArray(followUps)
            ? (
                await Promise.all(
                  followUps.map(async (followUp) => ({
                    id: followUp.id,
                    version: followUp.version,
                    data: await fromPhysicalFollowUpData(
                      multitableApi.provisioning,
                      projectId,
                      followUp.data,
                    ),
                  })),
                )
              ).filter((record) => {
                if (status && record.data.status !== status) return false
                if (ticketNo && record.data.ticketNo !== ticketNo) return false
                if (!search) return true
                const haystack = JSON.stringify(record.data).toLowerCase()
                return haystack.includes(search.toLowerCase())
              })
            : []

          res.json({
            ok: true,
            data: {
              projectId,
              followUps: logicalFollowUps,
              count: logicalFollowUps.length,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales list follow-ups failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to list after-sales follow-ups' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/after-sales/customers/:customerId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const customerId =
            typeof req?.params?.customerId === 'string' ? req.params.customerId.trim() : ''
          if (!customerId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'customerId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi || typeof multitableApi.records.deleteRecord !== 'function') {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record delete seam is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before deleting customers',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'customer')
          const deleted = await multitableApi.records.deleteRecord({
            sheetId,
            recordId: customerId,
          })

          res.json({
            ok: true,
            data: {
              projectId,
              customerId: deleted.id,
              version: deleted.version,
              deleted: true,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales delete customer failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to delete after-sales customer' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'PATCH',
      '/api/after-sales/customers/:customerId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const customerId =
            typeof req?.params?.customerId === 'string' ? req.params.customerId.trim() : ''
          if (!customerId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'customerId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before updating customers',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const { sheetId, record, logicalData } = await getCustomerById(multitableApi, projectId, customerId)
          const command = buildUpdateCustomerCommand((req && req.body) || {}, {
            id: record.id,
            ...logicalData,
          })
          const updatedRecord = await multitableApi.records.patchRecord({
            sheetId,
            recordId: customerId,
            changes: await toPhysicalCustomerData(multitableApi.provisioning, projectId, command.changes),
          })
          const logicalRecordData = await fromPhysicalCustomerData(
            multitableApi.provisioning,
            projectId,
            updatedRecord.data,
          )

          res.json({
            ok: true,
            data: {
              projectId,
              customer: {
                id: updatedRecord.id,
                version: updatedRecord.version,
                data: logicalRecordData,
              },
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales update customer failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to update after-sales customer' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/service-records',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before creating service records',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const multitableReadApi = getMultitableReadApi(context)
          if (
            !multitableReadApi ||
            (typeof multitableReadApi.records.listRecords !== 'function' &&
              typeof multitableReadApi.records.queryRecords !== 'function')
          ) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable ticket reader is not available on plugin context',
              },
            })
            return
          }

          const command = buildServiceRecordCommand((req && req.body) || {})
          const ticket = await findTicketByTicketNo(multitableReadApi, projectId, command.recordData.ticketNo)
          if (!ticket) {
            res.status(404).json({
              ok: false,
              error: {
                code: 'NOT_FOUND',
                message: `After-sales ticket ${command.recordData.ticketNo} not found`,
              },
            })
            return
          }

          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceRecord')
          const record = await multitableApi.records.createRecord({
            sheetId,
            data: await toPhysicalServiceRecordData(multitableApi.provisioning, projectId, command.recordData),
          })
          const logicalRecordData = await fromPhysicalServiceRecordData(
            multitableApi.provisioning,
            projectId,
            record.data,
          )

          let event = { accepted: false, event: 'service.recorded' }
          try {
            const payload = buildServiceRecordedEventPayload({
              serviceRecord: {
                id: record.id,
                ...command.eventServiceRecord,
              },
            }, {
              tenantId,
              projectId,
              requesterId: userId,
            })
            context.api.events.emit('service.recorded', payload)
            event = { accepted: true, event: 'service.recorded' }
          } catch (err) {
            logger.error && logger.error('after-sales service.recorded emit after record create failed', err)
          }

          res.status(201).json({
            ok: true,
            data: {
              projectId,
              serviceRecord: {
                id: record.id,
                version: record.version,
                data: logicalRecordData,
              },
              event,
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales create service record failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to create after-sales service record' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'PATCH',
      '/api/after-sales/service-records/:serviceRecordId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const serviceRecordId =
            typeof req?.params?.serviceRecordId === 'string' ? req.params.serviceRecordId.trim() : ''
          if (!serviceRecordId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'serviceRecordId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before updating service records',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const { sheetId, record, logicalData } = await getServiceRecordById(multitableApi, projectId, serviceRecordId)
          const command = buildUpdateServiceRecordCommand((req && req.body) || {}, {
            id: record.id,
            ...logicalData,
          })
          const updatedRecord = await multitableApi.records.patchRecord({
            sheetId,
            recordId: serviceRecordId,
            changes: await toPhysicalServiceRecordData(multitableApi.provisioning, projectId, command.changes),
          })
          const logicalRecordData = await fromPhysicalServiceRecordData(
            multitableApi.provisioning,
            projectId,
            updatedRecord.data,
          )

          res.json({
            ok: true,
            data: {
              projectId,
              serviceRecord: {
                id: updatedRecord.id,
                version: updatedRecord.version,
                data: logicalRecordData,
              },
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales update service record failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to update after-sales service record' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'DELETE',
      '/api/after-sales/service-records/:serviceRecordId',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const serviceRecordId =
            typeof req?.params?.serviceRecordId === 'string' ? req.params.serviceRecordId.trim() : ''
          if (!serviceRecordId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'serviceRecordId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi || typeof multitableApi.records.deleteRecord !== 'function') {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record delete seam is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || !isOperationalAfterSalesStatus(current.status)) {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before deleting service records',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceRecord')
          const deleted = await multitableApi.records.deleteRecord({
            sheetId,
            recordId: serviceRecordId,
          })

          res.json({
            ok: true,
            data: {
              projectId,
              serviceRecordId: deleted.id,
              version: deleted.version,
              deleted: true,
            },
          })
        } catch (err) {
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales delete service record failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to delete after-sales service record' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/tickets/:ticketId/refund-request',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const ticketId = typeof req?.params?.ticketId === 'string' ? req.params.ticketId.trim() : ''
          if (!ticketId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'ticketId is required' },
            })
            return
          }

          const multitableApi = getMultitableWriteApi(context)
          if (!multitableApi) {
            res.status(503).json({
              ok: false,
              error: {
                code: 'MULTITABLE_UNAVAILABLE',
                message: 'Multitable record writer is not available on plugin context',
              },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || current.status === 'not-installed') {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before requesting refunds',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
          const existingRecord = await multitableApi.records.getRecord({
            sheetId,
            recordId: ticketId,
          })
          const logicalExisting = await fromPhysicalTicketData(multitableApi.provisioning, projectId, existingRecord.data)
          const command = buildRequestRefundCommand((req && req.body) || {}, {
            id: existingRecord.id,
            ticketNo: logicalExisting.ticketNo,
            title: logicalExisting.title,
          })
          const updatedRecord = await multitableApi.records.patchRecord({
            sheetId,
            recordId: ticketId,
            changes: await toPhysicalTicketData(multitableApi.provisioning, projectId, command.changes),
          })
          const logicalUpdated = await fromPhysicalTicketData(multitableApi.provisioning, projectId, updatedRecord.data)

          let event = { accepted: false, event: 'ticket.refundRequested' }
          try {
            const payload = buildRefundRequestedEventPayload({
              ticket: command.eventTicket,
            }, {
              tenantId,
              projectId,
              requesterId: userId,
            })
            context.api.events.emit('ticket.refundRequested', payload)
            event = { accepted: true, event: 'ticket.refundRequested' }
          } catch (err) {
            logger.error && logger.error('after-sales ticket.refundRequested emit after record patch failed', err)
          }

          res.status(202).json({
            ok: true,
            data: {
              projectId,
              ticket: {
                id: updatedRecord.id,
                version: updatedRecord.version,
                data: logicalUpdated,
              },
              event,
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          if (err && err.code === 'VALIDATION_ERROR') {
            res.status(400).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          if (err && err.code === 'NOT_FOUND') {
            res.status(404).json({
              ok: false,
              error: { code: err.code, message: err.message },
            })
            return
          }
          logger.error && logger.error('after-sales refund request failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to request ticket refund' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'GET',
      '/api/after-sales/tickets/:ticketId/refund-approval',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesReadAccess(req)) {
            res.status(403).json({
              ok: false,
              error: { code: 'FORBIDDEN', message: 'After-sales read access required' },
            })
            return
          }

          const ticketId = typeof req?.params?.ticketId === 'string' ? req.params.ticketId.trim() : ''
          if (!ticketId) {
            res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'ticketId is required' },
            })
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const current = await installer.loadCurrent(context, tenantId, appManifest.id)
          if (!current || current.status === 'not-installed') {
            res.status(409).json({
              ok: false,
              error: {
                code: 'AFTER_SALES_NOT_INSTALLED',
                message: 'After-sales must be installed before querying refund approvals',
              },
            })
            return
          }

          const projectId = current.projectId || installer.getProjectId(tenantId, appManifest.id)
          const approval = await getRefundApproval(context, {
            projectId,
            ticketId,
          })

          res.json({
            ok: true,
            data: {
              projectId,
              approval: approval || null,
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_APPROVAL_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          logger.error && logger.error('after-sales refund approval status failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to load refund approval status' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/events/ticket-created',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const payload = buildTicketCreatedEventPayload((req && req.body) || {}, {
            tenantId,
            projectId: installer.getProjectId(tenantId, appManifest.id),
            requesterId: userId,
          })

          context.api.events.emit('ticket.created', payload)
          res.status(202).json({
            ok: true,
            data: {
              accepted: true,
              event: 'ticket.created',
              projectId: payload.projectId,
              ticketId: payload.ticket.id,
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          logger.error && logger.error('after-sales ticket.created emit failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to emit ticket.created' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/events/ticket-refund-requested',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const payload = buildRefundRequestedEventPayload((req && req.body) || {}, {
            tenantId,
            projectId: installer.getProjectId(tenantId, appManifest.id),
            requesterId: userId,
          })

          context.api.events.emit('ticket.refundRequested', payload)
          res.status(202).json({
            ok: true,
            data: {
              accepted: true,
              event: 'ticket.refundRequested',
              projectId: payload.projectId,
              ticketId: payload.ticket.id,
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          logger.error && logger.error('after-sales ticket.refundRequested emit failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to emit ticket.refundRequested' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/events/ticket-overdue',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const payload = buildTicketOverdueEventPayload((req && req.body) || {}, {
            tenantId,
            projectId: installer.getProjectId(tenantId, appManifest.id),
            requesterId: userId,
          })

          context.api.events.emit('ticket.overdue', payload)
          res.status(202).json({
            ok: true,
            data: {
              accepted: true,
              event: 'ticket.overdue',
              projectId: payload.projectId,
              ticketId: payload.ticket.id,
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          logger.error && logger.error('after-sales ticket.overdue emit failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to emit ticket.overdue' },
          })
        }
      },
    )

    context.api.http.addRoute(
      'POST',
      '/api/after-sales/events/followup-due',
      async (req, res) => {
        try {
          const userId = getUserId(req)
          if (!userId) {
            sendUnauthorized(res)
            return
          }
          if (!hasAfterSalesWriteAccess(req)) {
            sendWriteForbidden(res)
            return
          }

          const tenantId = getTenantId(req, context.logger)
          const payload = buildFollowUpDueEventPayload((req && req.body) || {}, {
            tenantId,
            projectId: installer.getProjectId(tenantId, appManifest.id),
            requesterId: userId,
          })

          context.api.events.emit('followup.due', payload)
          res.status(202).json({
            ok: true,
            data: {
              accepted: true,
              event: 'followup.due',
              projectId: payload.projectId,
              ticketId: payload.ticket.id,
              followUpId: payload.followUp.id,
            },
          })
        } catch (err) {
          if (err && err.code === 'AFTER_SALES_EVENT_VALIDATION_FAILED') {
            sendBadRequest(res, err)
            return
          }
          logger.error && logger.error('after-sales followup.due emit failed', err)
          res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to emit followup.due' },
          })
        }
      },
    )

    // Communication / events (unchanged from skeleton)
    context.communication.register('after-sales', {
      async getManifest() {
        return appManifest
      },
      async getNotificationTopics() {
        return getNotificationTopicSpecs()
      },
      buildRefundApprovalCommand(args) {
        return buildRefundApprovalCommand(args)
      },
      async getRefundApproval(args) {
        return getRefundApproval(context, args)
      },
      async submitRefundApproval(args) {
        return submitRefundApproval(context, args)
      },
      async submitRefundApprovalDecision(args) {
        return submitRefundApprovalDecision(context, args)
      },
      async sendNotificationTopic(args) {
        return sendTopicNotification(context, args)
      },
      async handleRefundApprovalDecisionCallback(args) {
        return handleRefundApprovalDecisionCallback(context, args)
      },
      emitTicketCreated(args) {
        const tenantId = (args && typeof args === 'object' && typeof args.tenantId === 'string' && args.tenantId.trim())
          ? args.tenantId.trim()
          : 'default'
        const payload = buildTicketCreatedEventPayload(args || {}, {
          tenantId,
          projectId: installer.getProjectId(tenantId, appManifest.id),
          requesterId: typeof args?.requesterId === 'string' ? args.requesterId : 'system',
        })
        context.api.events.emit('ticket.created', payload)
        return { accepted: true, event: 'ticket.created', payload }
      },
      emitTicketRefundRequested(args) {
        const tenantId = (args && typeof args === 'object' && typeof args.tenantId === 'string' && args.tenantId.trim())
          ? args.tenantId.trim()
          : 'default'
        const payload = buildRefundRequestedEventPayload(args || {}, {
          tenantId,
          projectId: installer.getProjectId(tenantId, appManifest.id),
          requesterId: typeof args?.requesterId === 'string' ? args.requesterId : 'system',
        })
        context.api.events.emit('ticket.refundRequested', payload)
        return { accepted: true, event: 'ticket.refundRequested', payload }
      },
      emitTicketOverdue(args) {
        const tenantId = (args && typeof args === 'object' && typeof args.tenantId === 'string' && args.tenantId.trim())
          ? args.tenantId.trim()
          : 'default'
        const payload = buildTicketOverdueEventPayload(args || {}, {
          tenantId,
          projectId: installer.getProjectId(tenantId, appManifest.id),
          requesterId: typeof args?.requesterId === 'string' ? args.requesterId : 'system',
        })
        context.api.events.emit('ticket.overdue', payload)
        return { accepted: true, event: 'ticket.overdue', payload }
      },
      emitFollowUpDue(args) {
        const tenantId = (args && typeof args === 'object' && typeof args.tenantId === 'string' && args.tenantId.trim())
          ? args.tenantId.trim()
          : 'default'
        const payload = buildFollowUpDueEventPayload(args || {}, {
          tenantId,
          projectId: installer.getProjectId(tenantId, appManifest.id),
          requesterId: typeof args?.requesterId === 'string' ? args.requesterId : 'system',
        })
        context.api.events.emit('followup.due', payload)
        return { accepted: true, event: 'followup.due', payload }
      },
      async createTicket(args) {
        const tenantId = (args && typeof args === 'object' && typeof args.tenantId === 'string' && args.tenantId.trim())
          ? args.tenantId.trim()
          : 'default'
        const projectId = installer.getProjectId(tenantId, appManifest.id)
        const multitableApi = getMultitableWriteApi(context)
        if (!multitableApi) {
          throw new Error('Multitable record writer is not available on plugin context')
        }
        const command = buildCreateTicketCommand(args || {})
        const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
        const record = await multitableApi.records.createRecord({
          sheetId,
          data: await toPhysicalTicketData(multitableApi.provisioning, projectId, command.recordData),
        })
        const logicalRecordData = await fromPhysicalTicketData(multitableApi.provisioning, projectId, record.data)
        const payload = buildTicketCreatedEventPayload({
          ticket: {
            id: record.id,
            ...command.eventTicket,
          },
        }, {
          tenantId,
          projectId,
          requesterId: typeof args?.requesterId === 'string' ? args.requesterId : 'system',
        })
        context.api.events.emit('ticket.created', payload)
        return {
          projectId,
          ticket: {
            id: record.id,
            version: record.version,
            data: logicalRecordData,
          },
          event: {
            accepted: true,
            event: 'ticket.created',
          },
        }
      },
      async updateTicket(args) {
        const tenantId = (args && typeof args === 'object' && typeof args.tenantId === 'string' && args.tenantId.trim())
          ? args.tenantId.trim()
          : 'default'
        const projectId = installer.getProjectId(tenantId, appManifest.id)
        const ticketId = typeof args?.ticketId === 'string' ? args.ticketId.trim() : ''
        if (!ticketId) {
          throw new Error('ticketId is required')
        }
        const multitableApi = getMultitableWriteApi(context)
        if (!multitableApi) {
          throw new Error('Multitable record writer is not available on plugin context')
        }
        const { sheetId, record, logicalData } = await getTicketRecordById(multitableApi, projectId, ticketId)
        const command = buildUpdateTicketCommand(args || {}, {
          id: record.id,
          ...logicalData,
        })
        const updatedRecord = await multitableApi.records.patchRecord({
          sheetId,
          recordId: ticketId,
          changes: await toPhysicalTicketData(multitableApi.provisioning, projectId, command.changes),
        })
        return {
          projectId,
          ticket: {
            id: updatedRecord.id,
            version: updatedRecord.version,
            data: await fromPhysicalTicketData(multitableApi.provisioning, projectId, updatedRecord.data),
          },
        }
      },
      async requestTicketRefund(args) {
        const tenantId = (args && typeof args === 'object' && typeof args.tenantId === 'string' && args.tenantId.trim())
          ? args.tenantId.trim()
          : 'default'
        const projectId = installer.getProjectId(tenantId, appManifest.id)
        const ticketId = typeof args?.ticketId === 'string' ? args.ticketId.trim() : ''
        if (!ticketId) {
          throw new Error('ticketId is required')
        }
        const multitableApi = getMultitableWriteApi(context)
        if (!multitableApi) {
          throw new Error('Multitable record writer is not available on plugin context')
        }
        const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
        const existingRecord = await multitableApi.records.getRecord({
          sheetId,
          recordId: ticketId,
        })
        const logicalExisting = await fromPhysicalTicketData(multitableApi.provisioning, projectId, existingRecord.data)
        const command = buildRequestRefundCommand(args || {}, {
          id: existingRecord.id,
          ticketNo: logicalExisting.ticketNo,
          title: logicalExisting.title,
        })
        const updatedRecord = await multitableApi.records.patchRecord({
          sheetId,
          recordId: ticketId,
          changes: await toPhysicalTicketData(multitableApi.provisioning, projectId, command.changes),
        })
        const logicalUpdated = await fromPhysicalTicketData(multitableApi.provisioning, projectId, updatedRecord.data)
        const payload = buildRefundRequestedEventPayload({
          ticket: command.eventTicket,
        }, {
          tenantId,
          projectId,
          requesterId: typeof args?.requesterId === 'string' ? args.requesterId : 'system',
        })
        context.api.events.emit('ticket.refundRequested', payload)
        return {
          projectId,
          ticket: {
            id: updatedRecord.id,
            version: updatedRecord.version,
            data: logicalUpdated,
          },
          event: {
            accepted: true,
            event: 'ticket.refundRequested',
          },
        }
      },
      async listTickets(args) {
        const tenantId = (args && typeof args === 'object' && typeof args.tenantId === 'string' && args.tenantId.trim())
          ? args.tenantId.trim()
          : 'default'
        const projectId = installer.getProjectId(tenantId, appManifest.id)
        const multitableApi = getMultitableReadApi(context)
        if (!multitableApi) {
          throw new Error('Multitable record reader is not available on plugin context')
        }
        const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
        let records
        if (typeof multitableApi.records.queryRecords === 'function') {
          const statusFieldIds = typeof args?.status === 'string' && args.status.trim()
            ? await resolvePhysicalFieldIds(
                multitableApi.provisioning,
                projectId,
                'serviceTicket',
                ['status'],
              )
            : {}
          const filters = typeof args?.status === 'string' && args.status.trim()
            ? {
                [statusFieldIds.status || 'status']: args.status.trim(),
              }
            : undefined
          records = await multitableApi.records.queryRecords({
            sheetId,
            filters,
            search: typeof args?.search === 'string' ? args.search : undefined,
            limit: args?.limit,
            offset: args?.offset,
          })
        } else if (typeof multitableApi.records.listRecords === 'function') {
          records = await multitableApi.records.listRecords({
            sheetId,
            limit: args?.limit,
            offset: args?.offset,
          })
        } else {
          throw new Error('Multitable list/query seam is not available on plugin context')
        }

        return {
          projectId,
          tickets: Array.isArray(records)
            ? await Promise.all(
                records.map(async (record) => ({
                  id: record.id,
                  version: record.version,
                  data: await fromPhysicalTicketData(multitableApi.provisioning, projectId, record.data),
                })),
              )
            : [],
        }
      },
      async deleteTicket(args) {
        const tenantId = (args && typeof args === 'object' && typeof args.tenantId === 'string' && args.tenantId.trim())
          ? args.tenantId.trim()
          : 'default'
        const projectId = installer.getProjectId(tenantId, appManifest.id)
        const ticketId = typeof args?.ticketId === 'string' ? args.ticketId.trim() : ''
        if (!ticketId) {
          throw new Error('ticketId is required')
        }
        const multitableApi = getMultitableWriteApi(context)
        if (!multitableApi || typeof multitableApi.records.deleteRecord !== 'function') {
          throw new Error('Multitable record delete seam is not available on plugin context')
        }
        const sheetId = await findObjectSheetId(multitableApi.provisioning, projectId, 'serviceTicket')
        const deleted = await multitableApi.records.deleteRecord({
          sheetId,
          recordId: ticketId,
        })
        return {
          projectId,
          ticketId: deleted.id,
          version: deleted.version,
          deleted: true,
        }
      },
    })

    const workflowRuntime = registerAfterSalesWorkflowHandlers(context, {
      appId: appManifest.id,
    })
    workflowSubscriptionIds = Array.isArray(workflowRuntime.subscriptions)
      ? workflowRuntime.subscriptions
      : []

    context.api.events.emit('after-sales.plugin.activated', {
      plugin: 'plugin-after-sales',
      appId: appManifest.id,
    })

    logger.info && logger.info('After-sales plugin activated')
  },

  async deactivate() {
    cleanupWorkflowSubscriptions()
  },
}
