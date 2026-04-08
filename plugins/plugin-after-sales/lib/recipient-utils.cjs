'use strict'

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

function normalizeRecipientList(value, fallbackType = 'user') {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeRecipientList(item, fallbackType))
  }
  const recipient = normalizeRecipientCandidate(value, fallbackType)
  return recipient ? [recipient] : []
}

function serializeRecipientValue(recipient) {
  return recipient && typeof recipient.id === 'string' ? recipient.id : null
}

module.exports = {
  normalizeRecipientCandidate,
  normalizeRecipientList,
  serializeRecipientValue,
}
