'use strict'

const installer = require('./installer.cjs')
const { DEFAULT_TEMPLATE_CONFIG } = require('./blueprint.cjs')
const { sendTopicNotification } = require('./notification-adapter.cjs')
const { submitRefundApproval } = require('./refund-approval.cjs')

const DEFAULT_APP_ID = 'after-sales'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeTemplateConfig(rawConfig) {
  return {
    ...DEFAULT_TEMPLATE_CONFIG,
    ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}),
  }
}

function computeSlaDueAt(priority, config = DEFAULT_TEMPLATE_CONFIG, now = new Date()) {
  const normalized = normalizeTemplateConfig(config)
  const baseTime = now instanceof Date ? now.getTime() : new Date(now).getTime()
  const hours = priority === 'urgent' ? normalized.urgentSlaHours : normalized.defaultSlaHours
  return new Date(baseTime + hours * 60 * 60 * 1000).toISOString()
}

function normalizeRecipientCandidate(value, fallbackType = 'user') {
  if (!value) return null
  if (typeof value === 'string' && value.trim()) {
    return { id: value.trim(), type: fallbackType }
  }
  if (typeof value === 'object' && typeof value.id === 'string' && value.id.trim()) {
    return {
      id: value.id.trim(),
      type: typeof value.type === 'string' && value.type.trim() ? value.type.trim() : fallbackType,
      metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : undefined,
    }
  }
  return null
}

function normalizeCandidateList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((candidate) => normalizeRecipientCandidate(candidate))
    .filter(Boolean)
}

function serializeRecipientValue(recipient) {
  return recipient && typeof recipient.id === 'string' ? recipient.id : null
}

function getNamespacedObject(payload, key) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const value = payload[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

function getScalarString(payload, field) {
  return typeof payload?.[field] === 'string' && payload[field].trim() ? payload[field].trim() : ''
}

function resolveTenantId(payload) {
  return (
    getScalarString(payload, 'tenantId') ||
    getScalarString(getNamespacedObject(payload, 'ticket'), 'tenantId') ||
    getScalarString(getNamespacedObject(payload, 'approval'), 'tenantId') ||
    'default'
  )
}

function resolveRequestedAssignee(ticket) {
  const existing = normalizeRecipientCandidate(ticket.assignedTo)
  if (existing) {
    return {
      assignedTo: existing,
      assignedSupervisor: normalizeRecipientCandidate(ticket.assignedSupervisor),
    }
  }

  const candidates = normalizeCandidateList(ticket.assigneeCandidates || ticket.technicianCandidates)
  if (candidates.length === 0) {
    return {
      assignedTo: null,
      assignedSupervisor: normalizeRecipientCandidate(ticket.assignedSupervisor),
    }
  }

  const selected = candidates[0]
  const candidateSource = Array.isArray(ticket.assigneeCandidates)
    ? ticket.assigneeCandidates[0]
    : Array.isArray(ticket.technicianCandidates)
      ? ticket.technicianCandidates[0]
      : null

  const supervisor = normalizeRecipientCandidate(candidateSource && candidateSource.supervisor)
    || normalizeRecipientCandidate(ticket.assignedSupervisor)

  return {
    assignedTo: selected,
    assignedSupervisor: supervisor,
  }
}

async function resolveRoleRecipients(context, roleSlugs) {
  const slugs = Array.from(new Set((roleSlugs || []).filter((role) => typeof role === 'string' && role.trim()).map((role) => role.trim())))
  if (slugs.length === 0) return {}

  try {
    const rows = await context.api.database.query(
      `SELECT role_id, user_id, email
       FROM (
         SELECT ur.role_id AS role_id, u.id AS user_id, u.email AS email
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
         WHERE ur.role_id = ANY($1::text[])
           AND COALESCE(u.is_active, TRUE) = TRUE
         UNION
         SELECT u.role AS role_id, u.id AS user_id, u.email AS email
         FROM users u
         WHERE u.role = ANY($1::text[])
           AND COALESCE(u.is_active, TRUE) = TRUE
       ) resolved
       ORDER BY role_id ASC, user_id ASC`,
      [slugs],
    )

    const recipientsByRole = {}
    for (const role of slugs) {
      recipientsByRole[role] = []
    }

    for (const row of rows || []) {
      const roleId = typeof row.role_id === 'string' ? row.role_id : ''
      const userId = typeof row.user_id === 'string' ? row.user_id : ''
      const email = typeof row.email === 'string' ? row.email : ''
      if (!roleId || !userId || !recipientsByRole[roleId]) continue
      recipientsByRole[roleId].push({ id: userId, type: 'user' })
      if (email) {
        recipientsByRole[roleId].push({ id: email, type: 'email' })
      }
    }

    return recipientsByRole
  } catch (error) {
    context.logger?.warn?.('after-sales role recipient lookup failed', error)
    return {}
  }
}

async function resolveRuntimeInstallContext(context, payload, options = {}) {
  const appId = options.appId || DEFAULT_APP_ID
  const tenantId = resolveTenantId(payload)

  try {
    const current = await (options.loadCurrent || installer.loadCurrent)(context, tenantId, appId)
    const config = normalizeTemplateConfig(current && current.status !== 'not-installed' ? current.config : null)
    const projectId =
      getScalarString(payload, 'projectId') ||
      (current && current.status !== 'not-installed' ? current.projectId : '') ||
      installer.getProjectId(tenantId, appId)

    return {
      tenantId,
      projectId,
      config,
      current,
    }
  } catch (error) {
    context.logger?.warn?.('after-sales workflow adapter falling back to default config', error)
    return {
      tenantId,
      projectId: installer.getProjectId(tenantId, appId),
      config: normalizeTemplateConfig(null),
      current: null,
    }
  }
}

function buildApprovalPendingPayload(payload, submitResult, runtimeContext) {
  const ticket = getNamespacedObject(payload, 'ticket')
  const approval = submitResult && submitResult.approval ? submitResult.approval : null
  return {
    tenantId: runtimeContext.tenantId,
    projectId: runtimeContext.projectId,
    title: approval?.title || `Refund approval for ${ticket.ticketNo || ticket.id || 'ticket'}`,
    ticketNo: typeof ticket.ticketNo === 'string' ? ticket.ticketNo : '',
    ticket: {
      id: ticket.id,
      refundAmount: ticket.refundAmount,
      requestedBy: ticket.requestedBy,
    },
    approval: {
      id: submitResult?.approvalId,
      bridge: 'after-sales-refund',
      ticketId: ticket.id,
    },
  }
}

function createWorkflowRuntime(context, options = {}) {
  const sendNotification = options.sendTopicNotification || sendTopicNotification
  const submitApproval = options.submitRefundApproval || submitRefundApproval
  const emitEvent = options.emitEvent || ((eventName, eventPayload) => context.api.events.emit(eventName, eventPayload))

  return {
    async onTicketCreated(payload = {}) {
      const runtimeContext = await resolveRuntimeInstallContext(context, payload, options)
      const ticket = getNamespacedObject(payload, 'ticket')
      const selection = resolveRequestedAssignee(ticket)
      const assignedToValue = serializeRecipientValue(selection.assignedTo)
      const assignedSupervisorValue = serializeRecipientValue(selection.assignedSupervisor)
      const nextPayload = {
        ...payload,
        tenantId: runtimeContext.tenantId,
        projectId: runtimeContext.projectId,
        title: typeof payload.title === 'string' ? payload.title : ticket.title,
        ticketNo: typeof payload.ticketNo === 'string' ? payload.ticketNo : ticket.ticketNo,
        assignedTo: assignedToValue,
        assignedSupervisor: assignedSupervisorValue,
        ticket: {
          ...ticket,
          assignedTo: assignedToValue,
          assignedSupervisor: assignedSupervisorValue,
          slaDueAt: computeSlaDueAt(ticket.priority, runtimeContext.config, options.now ? options.now() : new Date()),
        },
      }
      nextPayload.slaDueAt = nextPayload.ticket.slaDueAt

      if (!assignedToValue) {
        context.logger?.warn?.('after-sales ticket-triage skipped: no assignee resolved', {
          ticketId: ticket.id,
          tenantId: runtimeContext.tenantId,
        })
        return {
          workflowId: 'ticket-triage',
          skipped: true,
          reason: 'no-assignee-resolved',
          payload: nextPayload,
        }
      }

      emitEvent('ticket.assigned', nextPayload)
      return {
        workflowId: 'ticket-triage',
        emittedEvent: 'ticket.assigned',
        payload: nextPayload,
      }
    },

    async onTicketAssigned(payload = {}) {
      const roleRecipients = await resolveRoleRecipients(context, ['supervisor'])
      return sendNotification(context, {
        topic: 'after-sales.ticket.assigned',
        payload,
        roleRecipients,
      })
    },

    async onTicketRefundRequested(payload = {}) {
      const runtimeContext = await resolveRuntimeInstallContext(context, payload, options)
      if (!runtimeContext.config.enableRefundApproval) {
        return {
          workflowId: 'refund-approval',
          skipped: true,
          reason: 'refund-approval-disabled',
        }
      }

      const ticket = getNamespacedObject(payload, 'ticket')
      const approvalResult = await submitApproval(context, {
        projectId: runtimeContext.projectId,
        ticketId: ticket.id,
        ticketNo: ticket.ticketNo,
        title: ticket.title || payload.title || 'Refund approval',
        requesterId: ticket.requestedBy,
        requesterName: ticket.requestedByName,
        refundAmount: ticket.refundAmount,
        currency: ticket.currency,
        reason: ticket.reason,
        requestedAt: ticket.requestedAt,
      })

      if (approvalResult && approvalResult.approvalId) {
        emitEvent('approval.pending', buildApprovalPendingPayload(payload, approvalResult, runtimeContext))
      }

      return {
        workflowId: 'refund-approval',
        approvalResult,
      }
    },

    async onApprovalPending(payload = {}) {
      const roleRecipients = await resolveRoleRecipients(context, ['finance', 'supervisor'])
      return sendNotification(context, {
        topic: 'after-sales.approval.pending',
        payload,
        roleRecipients,
      })
    },

    async onTicketOverdue(payload = {}) {
      const roleRecipients = await resolveRoleRecipients(context, ['supervisor'])
      return sendNotification(context, {
        topic: 'after-sales.ticket.overdue',
        payload: {
          ...payload,
          assignedTo: payload.assignedTo ?? getNamespacedObject(payload, 'ticket').assignedTo,
          assignedSupervisor: payload.assignedSupervisor ?? getNamespacedObject(payload, 'ticket').assignedSupervisor,
          overdueWebhook: payload.overdueWebhook ?? getNamespacedObject(payload, 'ticket').overdueWebhook,
        },
        roleRecipients,
      })
    },

    async onFollowUpDue(payload = {}) {
      return sendNotification(context, {
        topic: 'after-sales.followup.due',
        payload: {
          ...payload,
          followUpOwner: payload.followUpOwner ?? getNamespacedObject(payload, 'followUp').owner,
        },
        roleRecipients: {},
      })
    },
  }
}

function registerAfterSalesWorkflowHandlers(context, options = {}) {
  const runtime = createWorkflowRuntime(context, options)
  const subscriptions = []
  const events = context && context.api && context.api.events
  if (!events || typeof events.on !== 'function') {
    return { subscriptions, runtime }
  }

  subscriptions.push(events.on('ticket.created', runtime.onTicketCreated))
  subscriptions.push(events.on('ticket.assigned', runtime.onTicketAssigned))
  subscriptions.push(events.on('ticket.overdue', runtime.onTicketOverdue))
  subscriptions.push(events.on('ticket.refundRequested', runtime.onTicketRefundRequested))
  subscriptions.push(events.on('approval.pending', runtime.onApprovalPending))
  subscriptions.push(events.on('followup.due', runtime.onFollowUpDue))

  return {
    subscriptions: subscriptions.filter(Boolean),
    runtime,
  }
}

module.exports = {
  DEFAULT_TEMPLATE_CONFIG,
  computeSlaDueAt,
  createWorkflowRuntime,
  registerAfterSalesWorkflowHandlers,
}
