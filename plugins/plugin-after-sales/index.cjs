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
  buildCreateTicketCommand,
  buildRefundDecisionEventPayload,
  buildRequestRefundCommand,
  buildTicketCreatedEventPayload,
  buildRefundRequestedEventPayload,
  buildTicketOverdueEventPayload,
  buildFollowUpDueEventPayload,
} = require('./lib/event-entry.cjs')
const {
  toPhysicalRecord,
  fromPhysicalRecord,
} = require('./lib/multitable-helpers.cjs')

const SERVICE_TICKET_FIELDS = ['ticketNo', 'title', 'source', 'priority', 'status', 'slaDueAt', 'refundAmount', 'refundStatus']

function toPhysicalTicketData(provisioning, projectId, logicalData) {
  return toPhysicalRecord(provisioning, projectId, 'serviceTicket', logicalData)
}

function fromPhysicalTicketData(provisioning, projectId, physicalData) {
  return fromPhysicalRecord(provisioning, projectId, 'serviceTicket', SERVICE_TICKET_FIELDS, physicalData)
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

function getMultitableWriteApi(context) {
  const multitable = context && context.api && context.api.multitable
  const provisioning = multitable && multitable.provisioning
  const records = multitable && multitable.records
  if (
    !provisioning ||
    typeof provisioning.getObjectSheetId !== 'function' ||
    typeof provisioning.getFieldId !== 'function' ||
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
    typeof provisioning.getObjectSheetId !== 'function' ||
    typeof provisioning.getFieldId !== 'function' ||
    !records ||
    typeof records.getRecord !== 'function'
  ) {
    return null
  }
  return { provisioning, records }
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
  const sheetId = multitableApi.provisioning.getObjectSheetId(projectId, 'serviceTicket')
  const updatedRecord = await multitableApi.records.patchRecord({
    sheetId,
    recordId: ticketId,
    changes: toPhysicalTicketData(multitableApi.provisioning, projectId, {
      refundStatus,
    }),
  })
  const logicalUpdated = fromPhysicalTicketData(multitableApi.provisioning, projectId, updatedRecord.data)

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
          const blueprint = buildDefaultBlueprint(appManifest)

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
          if (!current || current.status === 'not-installed') {
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
          const sheetId = multitableApi.provisioning.getObjectSheetId(projectId, 'serviceTicket')
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
            const filters = status
              ? {
                  [multitableApi.provisioning.getFieldId(projectId, 'serviceTicket', 'status')]: status,
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
            ? tickets
                .map((ticket) => ({
                  id: ticket.id,
                  version: ticket.version,
                  data: fromPhysicalTicketData(multitableApi.provisioning, projectId, ticket.data),
                }))
                .filter((ticket) => {
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
          if (!current || current.status === 'not-installed') {
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
          const sheetId = multitableApi.provisioning.getObjectSheetId(projectId, 'serviceTicket')
          const record = await multitableApi.records.createRecord({
            sheetId,
            data: toPhysicalTicketData(multitableApi.provisioning, projectId, command.recordData),
          })
          const logicalRecordData = fromPhysicalTicketData(multitableApi.provisioning, projectId, record.data)

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
          if (!current || current.status === 'not-installed') {
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
          const sheetId = multitableApi.provisioning.getObjectSheetId(projectId, 'serviceTicket')
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
          const sheetId = multitableApi.provisioning.getObjectSheetId(projectId, 'serviceTicket')
          const existingRecord = await multitableApi.records.getRecord({
            sheetId,
            recordId: ticketId,
          })
          const logicalExisting = fromPhysicalTicketData(multitableApi.provisioning, projectId, existingRecord.data)
          const command = buildRequestRefundCommand((req && req.body) || {}, {
            id: existingRecord.id,
            ticketNo: logicalExisting.ticketNo,
            title: logicalExisting.title,
          })
          const updatedRecord = await multitableApi.records.patchRecord({
            sheetId,
            recordId: ticketId,
            changes: toPhysicalTicketData(multitableApi.provisioning, projectId, command.changes),
          })
          const logicalUpdated = fromPhysicalTicketData(multitableApi.provisioning, projectId, updatedRecord.data)

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
        const sheetId = multitableApi.provisioning.getObjectSheetId(projectId, 'serviceTicket')
        const record = await multitableApi.records.createRecord({
          sheetId,
          data: toPhysicalTicketData(multitableApi.provisioning, projectId, command.recordData),
        })
        const logicalRecordData = fromPhysicalTicketData(multitableApi.provisioning, projectId, record.data)
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
        const sheetId = multitableApi.provisioning.getObjectSheetId(projectId, 'serviceTicket')
        const existingRecord = await multitableApi.records.getRecord({
          sheetId,
          recordId: ticketId,
        })
        const logicalExisting = fromPhysicalTicketData(multitableApi.provisioning, projectId, existingRecord.data)
        const command = buildRequestRefundCommand(args || {}, {
          id: existingRecord.id,
          ticketNo: logicalExisting.ticketNo,
          title: logicalExisting.title,
        })
        const updatedRecord = await multitableApi.records.patchRecord({
          sheetId,
          recordId: ticketId,
          changes: toPhysicalTicketData(multitableApi.provisioning, projectId, command.changes),
        })
        const logicalUpdated = fromPhysicalTicketData(multitableApi.provisioning, projectId, updatedRecord.data)
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
        const sheetId = multitableApi.provisioning.getObjectSheetId(projectId, 'serviceTicket')
        let records
        if (typeof multitableApi.records.queryRecords === 'function') {
          const filters = typeof args?.status === 'string' && args.status.trim()
            ? {
                [multitableApi.provisioning.getFieldId(projectId, 'serviceTicket', 'status')]: args.status.trim(),
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
            ? records.map((record) => ({
                id: record.id,
                version: record.version,
                data: fromPhysicalTicketData(multitableApi.provisioning, projectId, record.data),
              }))
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
        const sheetId = multitableApi.provisioning.getObjectSheetId(projectId, 'serviceTicket')
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
