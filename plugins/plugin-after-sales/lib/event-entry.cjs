'use strict'

function createEventEntryError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details && typeof details === 'object') {
    error.details = details
  }
  return error
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createEventEntryError('AFTER_SALES_EVENT_VALIDATION_FAILED', `${field} is required`, { field })
  }
  return value.trim()
}

function requiredNumber(value, field) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw createEventEntryError('AFTER_SALES_EVENT_VALIDATION_FAILED', `${field} must be a finite number`, { field })
  }
  return parsed
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeEnumValue(value, field, allowed, fallback) {
  const normalized = optionalString(value) || fallback
  if (!allowed.includes(normalized)) {
    throw createEventEntryError(
      'AFTER_SALES_EVENT_VALIDATION_FAILED',
      `${field} must be one of: ${allowed.join(', ')}`,
      { field, allowed },
    )
  }
  return normalized
}

function optionalRecipient(value) {
  if (!value) return undefined
  if (typeof value === 'string' && value.trim()) {
    return { id: value.trim(), type: 'user' }
  }
  if (typeof value === 'object' && typeof value.id === 'string' && value.id.trim()) {
    return {
      id: value.id.trim(),
      type: typeof value.type === 'string' && value.type.trim() ? value.type.trim() : 'user',
      supervisor: value.supervisor,
    }
  }
  return undefined
}

function optionalRecipientList(value) {
  if (!Array.isArray(value)) return undefined
  const list = value.map((item) => optionalRecipient(item)).filter(Boolean)
  return list.length > 0 ? list : undefined
}

function buildTicketCreatedEventPayload(input, meta) {
  const ticket = input && typeof input.ticket === 'object' && !Array.isArray(input.ticket) ? input.ticket : {}
  return {
    tenantId: requiredString(meta.tenantId, 'tenantId'),
    projectId: requiredString(meta.projectId, 'projectId'),
    ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
    title: requiredString(ticket.title ?? input.title, 'ticket.title'),
    ticket: {
      id: requiredString(ticket.id, 'ticket.id'),
      ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
      title: requiredString(ticket.title ?? input.title, 'ticket.title'),
      priority: requiredString(ticket.priority, 'ticket.priority'),
      source: optionalString(ticket.source),
      customerId: optionalString(ticket.customerId),
      assignedTo: optionalRecipient(ticket.assignedTo),
      assignedSupervisor: optionalRecipient(ticket.assignedSupervisor),
      assigneeCandidates: optionalRecipientList(ticket.assigneeCandidates),
      technicianCandidates: optionalRecipientList(ticket.technicianCandidates),
    },
  }
}

function buildRefundRequestedEventPayload(input, meta) {
  const ticket = input && typeof input.ticket === 'object' && !Array.isArray(input.ticket) ? input.ticket : {}
  const requesterId = optionalString(ticket.requestedBy) || requiredString(meta.requesterId, 'requesterId')

  return {
    tenantId: requiredString(meta.tenantId, 'tenantId'),
    projectId: requiredString(meta.projectId, 'projectId'),
    ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
    title: requiredString(ticket.title ?? input.title, 'ticket.title'),
    ticket: {
      id: requiredString(ticket.id, 'ticket.id'),
      ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
      title: requiredString(ticket.title ?? input.title, 'ticket.title'),
      refundAmount: requiredNumber(ticket.refundAmount, 'ticket.refundAmount'),
      requestedBy: requesterId,
      requestedByName: optionalString(ticket.requestedByName),
      reason: optionalString(ticket.reason),
      currency: optionalString(ticket.currency),
      requestedAt: optionalString(ticket.requestedAt),
    },
  }
}

function buildCreateTicketCommand(input) {
  const ticket = input && typeof input.ticket === 'object' && !Array.isArray(input.ticket) ? input.ticket : input || {}
  const source = normalizeEnumValue(
    ticket.source,
    'ticket.source',
    ['phone', 'email', 'web', 'wechat'],
    'web',
  )
  const priority = normalizeEnumValue(
    ticket.priority,
    'ticket.priority',
    ['low', 'normal', 'high', 'urgent'],
    'normal',
  )
  const status = normalizeEnumValue(
    ticket.status,
    'ticket.status',
    ['new', 'assigned', 'inProgress', 'done', 'closed'],
    'new',
  )
  const refundAmount =
    ticket.refundAmount == null || ticket.refundAmount === ''
      ? undefined
      : requiredNumber(ticket.refundAmount, 'ticket.refundAmount')

  const eventTicket = {
    ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
    title: requiredString(ticket.title ?? input.title, 'ticket.title'),
    source,
    priority,
    status,
    assignedTo: optionalRecipient(ticket.assignedTo),
    assignedSupervisor: optionalRecipient(ticket.assignedSupervisor),
    assigneeCandidates: optionalRecipientList(ticket.assigneeCandidates),
    technicianCandidates: optionalRecipientList(ticket.technicianCandidates),
  }

  return {
    recordData: {
      ticketNo: eventTicket.ticketNo,
      title: eventTicket.title,
      source,
      priority,
      status,
      ...(typeof refundAmount === 'number' ? { refundAmount } : {}),
    },
    eventTicket,
  }
}

function buildTicketOverdueEventPayload(input, meta) {
  const ticket = input && typeof input.ticket === 'object' && !Array.isArray(input.ticket) ? input.ticket : {}
  const assignedTo = optionalRecipient(ticket.assignedTo)
  const assignedSupervisor = optionalRecipient(ticket.assignedSupervisor)
  const overdueWebhook = optionalRecipient(ticket.overdueWebhook ?? input.overdueWebhook)

  return {
    tenantId: requiredString(meta.tenantId, 'tenantId'),
    projectId: requiredString(meta.projectId, 'projectId'),
    ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
    title: requiredString(ticket.title ?? input.title, 'ticket.title'),
    assignedTo,
    assignedSupervisor,
    overdueWebhook,
    ticket: {
      id: requiredString(ticket.id, 'ticket.id'),
      ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
      title: requiredString(ticket.title ?? input.title, 'ticket.title'),
      priority: optionalString(ticket.priority),
      assignedTo,
      assignedSupervisor,
      overdueWebhook,
      slaDueAt: optionalString(ticket.slaDueAt),
      overdueAt: optionalString(ticket.overdueAt),
    },
  }
}

function buildFollowUpDueEventPayload(input, meta) {
  const followUp = input && typeof input.followUp === 'object' && !Array.isArray(input.followUp) ? input.followUp : {}
  const ticket = input && typeof input.ticket === 'object' && !Array.isArray(input.ticket) ? input.ticket : {}
  const followUpOwner = optionalRecipient(followUp.owner ?? input.followUpOwner)

  if (!followUpOwner) {
    throw createEventEntryError('AFTER_SALES_EVENT_VALIDATION_FAILED', 'followUpOwner is required', {
      field: 'followUpOwner',
    })
  }

  return {
    tenantId: requiredString(meta.tenantId, 'tenantId'),
    projectId: requiredString(meta.projectId, 'projectId'),
    ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
    title: requiredString(ticket.title ?? input.title, 'ticket.title'),
    followUpOwner,
    ticket: {
      id: requiredString(ticket.id, 'ticket.id'),
      ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
      title: requiredString(ticket.title ?? input.title, 'ticket.title'),
    },
    followUp: {
      id: requiredString(followUp.id ?? input.followUpId, 'followUp.id'),
      owner: followUpOwner,
      dueAt: optionalString(followUp.dueAt ?? input.dueAt),
      followUpType: optionalString(followUp.followUpType ?? input.followUpType),
    },
  }
}

module.exports = {
  buildCreateTicketCommand,
  buildTicketCreatedEventPayload,
  buildRefundRequestedEventPayload,
  buildTicketOverdueEventPayload,
  buildFollowUpDueEventPayload,
  createEventEntryError,
}
