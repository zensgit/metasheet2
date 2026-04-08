'use strict'

const REFUND_APPROVAL_BRIDGE_ID = 'after-sales-refund'

function createAdapterError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details && typeof details === 'object') {
    error.details = details
  }
  return error
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createAdapterError(
      'AFTER_SALES_APPROVAL_VALIDATION_FAILED',
      `${field} is required`,
      { field },
    )
  }
  return value.trim()
}

function requiredNumber(value, field) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) {
    throw createAdapterError(
      'AFTER_SALES_APPROVAL_VALIDATION_FAILED',
      `${field} must be a finite number`,
      { field },
    )
  }
  return number
}

function buildRefundApprovalCommand(input) {
  const projectId = requiredString(input?.projectId, 'projectId')
  const ticketId = requiredString(input?.ticketId, 'ticketId')
  const ticketNo = requiredString(input?.ticketNo, 'ticketNo')
  const title = requiredString(input?.title, 'title')
  const requesterId = requiredString(input?.requesterId, 'requesterId')
  const refundAmount = requiredNumber(input?.refundAmount, 'refundAmount')

  return {
    bridge: REFUND_APPROVAL_BRIDGE_ID,
    sourceSystem: 'after-sales',
    topic: 'ticket.refundRequested',
    title: `Refund approval for ${ticketNo}`,
    businessKey: `after-sales:${projectId}:ticket:${ticketId}:refund`,
    requester: {
      id: requesterId,
      name: typeof input?.requesterName === 'string' ? input.requesterName.trim() || undefined : undefined,
    },
    subject: {
      projectId,
      ticketId,
      ticketNo,
      title,
      refundAmount,
      currency: typeof input?.currency === 'string' && input.currency.trim() ? input.currency.trim() : 'CNY',
    },
    policy: {
      sourceOfTruth: 'after-sales',
      rejectCommentRequired: true,
    },
    metadata: {
      projectId,
      ticketId,
      ticketNo,
      refundAmount,
      reason: typeof input?.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined,
      requestedAt: typeof input?.requestedAt === 'string' && input.requestedAt.trim()
        ? input.requestedAt.trim()
        : new Date().toISOString(),
    },
  }
}

async function submitRefundApproval(context, input) {
  const command = buildRefundApprovalCommand(input)
  const communication = context?.communication
  if (!communication || typeof communication.call !== 'function') {
    throw createAdapterError(
      'AFTER_SALES_APPROVAL_BRIDGE_UNAVAILABLE',
      'After-sales approval bridge submit seam is not available on plugin context',
      { bridge: REFUND_APPROVAL_BRIDGE_ID },
    )
  }

  return communication.call(
    'after-sales-approval-bridge',
    'submitRefundApproval',
    command,
  )
}

async function getRefundApproval(context, input) {
  const projectId = requiredString(input?.projectId, 'projectId')
  const communication = context?.communication
  if (!communication || typeof communication.call !== 'function') {
    throw createAdapterError(
      'AFTER_SALES_APPROVAL_BRIDGE_UNAVAILABLE',
      'After-sales approval bridge query seam is not available on plugin context',
      { bridge: REFUND_APPROVAL_BRIDGE_ID },
    )
  }

  return communication.call(
    'after-sales-approval-bridge',
    'getRefundApproval',
    {
      projectId,
      ticketId: typeof input?.ticketId === 'string' && input.ticketId.trim() ? input.ticketId.trim() : undefined,
      businessKey: typeof input?.businessKey === 'string' && input.businessKey.trim() ? input.businessKey.trim() : undefined,
    },
  )
}

async function submitRefundApprovalDecision(context, input) {
  const communication = context?.communication
  if (!communication || typeof communication.call !== 'function') {
    throw createAdapterError(
      'AFTER_SALES_APPROVAL_BRIDGE_UNAVAILABLE',
      'After-sales approval bridge decision seam is not available on plugin context',
      { bridge: REFUND_APPROVAL_BRIDGE_ID },
    )
  }

  return communication.call(
    'after-sales-approval-bridge',
    'submitRefundApprovalDecision',
    {
      ticketId: typeof input?.ticketId === 'string' && input.ticketId.trim() ? input.ticketId.trim() : undefined,
      businessKey: typeof input?.businessKey === 'string' && input.businessKey.trim() ? input.businessKey.trim() : undefined,
      action: requiredString(input?.action, 'action'),
      actorId: requiredString(input?.actorId, 'actorId'),
      actorName: typeof input?.actorName === 'string' && input.actorName.trim() ? input.actorName.trim() : undefined,
      comment: typeof input?.comment === 'string' && input.comment.trim() ? input.comment.trim() : undefined,
    },
  )
}

module.exports = {
  REFUND_APPROVAL_BRIDGE_ID,
  buildRefundApprovalCommand,
  getRefundApproval,
  submitRefundApproval,
  submitRefundApprovalDecision,
}
