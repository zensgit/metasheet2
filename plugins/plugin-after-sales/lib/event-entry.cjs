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

function isMissingInputValue(value) {
  return value == null || (typeof value === 'string' && value.trim() === '')
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
  const refundAmount = isMissingInputValue(ticket.refundAmount)
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

function buildInstalledAssetCommand(input) {
  const installedAsset =
    input && typeof input.installedAsset === 'object' && !Array.isArray(input.installedAsset)
      ? input.installedAsset
      : input || {}

  const assetCode = requiredString(installedAsset.assetCode ?? input.assetCode, 'installedAsset.assetCode')
  const status = normalizeEnumValue(
    installedAsset.status,
    'installedAsset.status',
    ['active', 'expired', 'decommissioned'],
    'active',
  )
  const serialNo = optionalString(installedAsset.serialNo ?? input.serialNo)
  const model = optionalString(installedAsset.model ?? input.model)
  const location = optionalString(installedAsset.location ?? input.location)
  const installedAt = optionalString(installedAsset.installedAt ?? input.installedAt)
  const warrantyUntil = optionalString(installedAsset.warrantyUntil ?? input.warrantyUntil)

  return {
    recordData: {
      assetCode,
      status,
      ...(serialNo ? { serialNo } : {}),
      ...(model ? { model } : {}),
      ...(location ? { location } : {}),
      ...(installedAt ? { installedAt } : {}),
      ...(warrantyUntil ? { warrantyUntil } : {}),
    },
  }
}

function buildCustomerCommand(input) {
  const customer =
    input && typeof input.customer === 'object' && !Array.isArray(input.customer)
      ? input.customer
      : input || {}

  const customerCode = requiredString(customer.customerCode ?? input.customerCode, 'customer.customerCode')
  const name = requiredString(customer.name ?? input.name, 'customer.name')
  const status = normalizeEnumValue(
    customer.status,
    'customer.status',
    ['active', 'inactive'],
    'active',
  )
  const phone = optionalString(customer.phone ?? input.phone)
  const email = optionalString(customer.email ?? input.email)

  return {
    recordData: {
      customerCode,
      name,
      status,
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
    },
  }
}

function buildUpdateCustomerCommand(input, existingCustomer) {
  const command = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const customerInput =
    command.customer && typeof command.customer === 'object' && !Array.isArray(command.customer)
      ? command.customer
      : command
  const currentCustomer =
    existingCustomer && typeof existingCustomer === 'object' ? existingCustomer : {}

  const changes = {}
  const hasCustomerCode = hasOwnField(customerInput, 'customerCode') || hasOwnField(command, 'customerCode')
  const hasName = hasOwnField(customerInput, 'name') || hasOwnField(command, 'name')
  const hasStatus = hasOwnField(customerInput, 'status') || hasOwnField(command, 'status')
  const hasPhone = hasOwnField(customerInput, 'phone') || hasOwnField(command, 'phone')
  const hasEmail = hasOwnField(customerInput, 'email') || hasOwnField(command, 'email')

  if (hasCustomerCode) {
    changes.customerCode = requiredString(
      customerInput.customerCode ?? command.customerCode,
      'customer.customerCode',
    )
  }
  if (hasName) {
    changes.name = requiredString(
      customerInput.name ?? command.name,
      'customer.name',
    )
  }
  if (hasStatus) {
    changes.status = normalizeEnumValue(
      customerInput.status ?? command.status,
      'customer.status',
      ['active', 'inactive'],
      optionalString(currentCustomer.status) || 'active',
    )
  }
  if (hasPhone) {
    changes.phone = optionalString(customerInput.phone ?? command.phone) || null
  }
  if (hasEmail) {
    changes.email = optionalString(customerInput.email ?? command.email) || null
  }

  return {
    changes,
  }
}

function buildUpdateInstalledAssetCommand(input, existingInstalledAsset) {
  const command = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const installedAsset =
    command.installedAsset && typeof command.installedAsset === 'object' && !Array.isArray(command.installedAsset)
      ? command.installedAsset
      : command
  const currentInstalledAsset =
    existingInstalledAsset && typeof existingInstalledAsset === 'object' ? existingInstalledAsset : {}

  const assetCode = requiredString(
    installedAsset.assetCode ?? currentInstalledAsset.assetCode,
    'installedAsset.assetCode',
  )
  const status = normalizeEnumValue(
    installedAsset.status ?? currentInstalledAsset.status,
    'installedAsset.status',
    ['active', 'expired', 'decommissioned'],
    optionalString(currentInstalledAsset.status) || 'active',
  )
  const serialNo = optionalString(installedAsset.serialNo ?? currentInstalledAsset.serialNo)
  const model = optionalString(installedAsset.model ?? currentInstalledAsset.model)
  const location = optionalString(installedAsset.location ?? currentInstalledAsset.location)
  const installedAt = optionalString(installedAsset.installedAt ?? currentInstalledAsset.installedAt)
  const warrantyUntil = optionalString(installedAsset.warrantyUntil ?? currentInstalledAsset.warrantyUntil)

  return {
    changes: {
      assetCode,
      status,
      serialNo: serialNo || null,
      model: model || null,
      location: location || null,
      installedAt: installedAt || null,
      warrantyUntil: warrantyUntil || null,
    },
  }
}

function normalizeTicketStatus(value) {
  if (optionalString(value) === 'open') {
    return 'new'
  }
  return value
}

function buildUpdateTicketCommand(input, existingTicket) {
  const command = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const ticketInput =
    command.ticket && typeof command.ticket === 'object' && !Array.isArray(command.ticket)
      ? command.ticket
      : command
  const currentTicket = existingTicket && typeof existingTicket === 'object' ? existingTicket : {}
  const source = normalizeEnumValue(
    ticketInput.source ?? currentTicket.source,
    'ticket.source',
    ['phone', 'email', 'web', 'wechat'],
    optionalString(currentTicket.source) || 'web',
  )
  const priority = normalizeEnumValue(
    ticketInput.priority ?? currentTicket.priority,
    'ticket.priority',
    ['low', 'normal', 'high', 'urgent'],
    optionalString(currentTicket.priority) || 'normal',
  )
  const status = normalizeEnumValue(
    normalizeTicketStatus(ticketInput.status ?? currentTicket.status),
    'ticket.status',
    ['new', 'assigned', 'inProgress', 'done', 'closed'],
    normalizeTicketStatus(optionalString(currentTicket.status)) || 'new',
  )
  const title = requiredString(ticketInput.title ?? currentTicket.title, 'ticket.title')

  return {
    changes: {
      title,
      source,
      priority,
      status,
    },
  }
}

function buildRequestRefundCommand(input, existingTicket) {
  const ticket = existingTicket && typeof existingTicket === 'object' ? existingTicket : {}
  const command = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const refundAmount = requiredNumber(command.refundAmount, 'refundAmount')

  return {
    changes: {
      refundAmount,
      refundStatus: 'pending',
    },
    eventTicket: {
      id: requiredString(ticket.id, 'ticket.id'),
      ticketNo: requiredString(ticket.ticketNo, 'ticket.ticketNo'),
      title: requiredString(ticket.title, 'ticket.title'),
      refundAmount,
      refundStatus: 'pending',
      requestedBy: optionalString(command.requestedBy),
      requestedByName: optionalString(command.requestedByName ?? command.requesterName),
      reason: optionalString(command.reason),
      currency: optionalString(command.currency),
      requestedAt: optionalString(command.requestedAt),
    },
  }
}

function buildRefundDecisionEventPayload(input, meta) {
  const ticket = input && typeof input.ticket === 'object' && !Array.isArray(input.ticket) ? input.ticket : {}
  const approval = input && typeof input.approval === 'object' && !Array.isArray(input.approval) ? input.approval : {}
  const decision = requiredString(input?.decision, 'decision')
  if (decision !== 'approved' && decision !== 'rejected') {
    throw createEventEntryError(
      'AFTER_SALES_EVENT_VALIDATION_FAILED',
      'decision must be approved or rejected',
      { field: 'decision', allowed: ['approved', 'rejected'] },
    )
  }

  return {
    tenantId: requiredString(meta.tenantId, 'tenantId'),
    projectId: requiredString(meta.projectId, 'projectId'),
    decision,
    ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
    title: requiredString(ticket.title ?? input.title, 'ticket.title'),
    ticket: {
      id: requiredString(ticket.id, 'ticket.id'),
      ticketNo: requiredString(ticket.ticketNo ?? input.ticketNo, 'ticket.ticketNo'),
      title: requiredString(ticket.title ?? input.title, 'ticket.title'),
      refundAmount: requiredNumber(ticket.refundAmount, 'ticket.refundAmount'),
      refundStatus: decision,
    },
    approval: {
      id: requiredString(approval.id ?? input.approvalId, 'approval.id'),
      bridge: optionalString(approval.bridge ?? input.bridge) || 'after-sales-refund',
      ticketId: requiredString(approval.ticketId ?? ticket.id, 'approval.ticketId'),
      comment: optionalString(approval.comment ?? input.comment),
    },
    actor: {
      id: requiredString(input?.actorId, 'actorId'),
      name: optionalString(input?.actorName),
    },
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

function buildServiceRecordCommand(input) {
  const serviceRecord =
    input && typeof input.serviceRecord === 'object' && !Array.isArray(input.serviceRecord)
      ? input.serviceRecord
      : input || {}

  const ticketNo = requiredString(serviceRecord.ticketNo ?? input.ticketNo, 'serviceRecord.ticketNo')
  const visitType = normalizeEnumValue(
    serviceRecord.visitType,
    'serviceRecord.visitType',
    ['onsite', 'remote', 'pickup'],
    'onsite',
  )
  const scheduledAt = requiredString(
    serviceRecord.scheduledAt ?? input.scheduledAt,
    'serviceRecord.scheduledAt',
  )
  const completedAt = optionalString(serviceRecord.completedAt ?? input.completedAt)
  const technicianName = optionalString(serviceRecord.technicianName ?? input.technicianName)
  const workSummary = optionalString(serviceRecord.workSummary ?? input.workSummary)
  const result = isMissingInputValue(serviceRecord.result ?? input.result)
    ? undefined
    : normalizeEnumValue(
        serviceRecord.result ?? input.result,
        'serviceRecord.result',
        ['resolved', 'partial', 'escalated'],
        'resolved',
      )

  const recordData = {
    ticketNo,
    visitType,
    scheduledAt,
    ...(completedAt ? { completedAt } : {}),
    ...(technicianName ? { technicianName } : {}),
    ...(workSummary ? { workSummary } : {}),
    ...(typeof result === 'string' ? { result } : {}),
  }

  return {
    recordData,
    eventServiceRecord: {
      ticketNo,
      visitType,
      scheduledAt,
      ...(completedAt ? { completedAt } : {}),
      ...(technicianName ? { technicianName } : {}),
      ...(workSummary ? { workSummary } : {}),
      ...(typeof result === 'string' ? { result } : {}),
    },
  }
}

function hasOwnField(obj, field) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, field)
}

function buildUpdateServiceRecordCommand(input, existingServiceRecord) {
  const command = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const serviceRecordInput =
    command.serviceRecord && typeof command.serviceRecord === 'object' && !Array.isArray(command.serviceRecord)
      ? command.serviceRecord
      : command
  const currentRecord =
    existingServiceRecord && typeof existingServiceRecord === 'object' ? existingServiceRecord : {}
  const visitType = normalizeEnumValue(
    serviceRecordInput.visitType ?? currentRecord.visitType,
    'serviceRecord.visitType',
    ['onsite', 'remote', 'pickup'],
    optionalString(currentRecord.visitType) || 'onsite',
  )
  const scheduledAt = requiredString(
    serviceRecordInput.scheduledAt ?? currentRecord.scheduledAt,
    'serviceRecord.scheduledAt',
  )

  const completedAtInput = serviceRecordInput.completedAt ?? command.completedAt
  const technicianNameInput = serviceRecordInput.technicianName ?? command.technicianName
  const workSummaryInput = serviceRecordInput.workSummary ?? command.workSummary
  const resultInput = serviceRecordInput.result ?? command.result

  const completedAt = hasOwnField(serviceRecordInput, 'completedAt') || hasOwnField(command, 'completedAt')
    ? optionalString(completedAtInput) || null
    : optionalString(currentRecord.completedAt) || null
  const technicianName = hasOwnField(serviceRecordInput, 'technicianName') || hasOwnField(command, 'technicianName')
    ? optionalString(technicianNameInput) || null
    : optionalString(currentRecord.technicianName) || null
  const workSummary = hasOwnField(serviceRecordInput, 'workSummary') || hasOwnField(command, 'workSummary')
    ? optionalString(workSummaryInput) || null
    : optionalString(currentRecord.workSummary) || null

  let result = optionalString(currentRecord.result) || null
  if (hasOwnField(serviceRecordInput, 'result') || hasOwnField(command, 'result')) {
    result = isMissingInputValue(resultInput)
      ? null
      : normalizeEnumValue(
          resultInput,
          'serviceRecord.result',
          ['resolved', 'partial', 'escalated'],
          'resolved',
        )
  }

  return {
    changes: {
      visitType,
      scheduledAt,
      completedAt,
      technicianName,
      workSummary,
      result,
    },
  }
}

function buildServiceRecordedEventPayload(input, meta) {
  const serviceRecord =
    input && typeof input.serviceRecord === 'object' && !Array.isArray(input.serviceRecord)
      ? input.serviceRecord
      : input || {}

  return {
    tenantId: requiredString(meta.tenantId, 'tenantId'),
    projectId: requiredString(meta.projectId, 'projectId'),
    ticketNo: requiredString(serviceRecord.ticketNo ?? input.ticketNo, 'serviceRecord.ticketNo'),
    serviceRecord: {
      id: requiredString(serviceRecord.id, 'serviceRecord.id'),
      ticketNo: requiredString(serviceRecord.ticketNo ?? input.ticketNo, 'serviceRecord.ticketNo'),
      visitType: requiredString(serviceRecord.visitType, 'serviceRecord.visitType'),
      scheduledAt: requiredString(
        serviceRecord.scheduledAt ?? input.scheduledAt,
        'serviceRecord.scheduledAt',
      ),
      completedAt: optionalString(serviceRecord.completedAt ?? input.completedAt),
      technicianName: optionalString(serviceRecord.technicianName ?? input.technicianName),
      workSummary: optionalString(serviceRecord.workSummary ?? input.workSummary),
      result: optionalString(serviceRecord.result ?? input.result),
    },
  }
}

module.exports = {
  buildCreateTicketCommand,
  buildCustomerCommand,
  buildUpdateCustomerCommand,
  buildInstalledAssetCommand,
  buildUpdateInstalledAssetCommand,
  buildUpdateTicketCommand,
  buildRequestRefundCommand,
  buildRefundDecisionEventPayload,
  buildTicketCreatedEventPayload,
  buildRefundRequestedEventPayload,
  buildTicketOverdueEventPayload,
  buildFollowUpDueEventPayload,
  buildServiceRecordCommand,
  buildUpdateServiceRecordCommand,
  buildServiceRecordedEventPayload,
  createEventEntryError,
}
