'use strict'

const CHANNEL_TO_RECIPIENT_TYPE = Object.freeze({
  feishu: 'user',
  email: 'email',
  webhook: 'webhook',
})

const {
  normalizeRecipientList,
} = require('./recipient-utils.cjs')

const TOPIC_SPECS = Object.freeze([
  {
    topic: 'after-sales.ticket.assigned',
    event: 'ticket.assigned',
    channels: ['feishu', 'email'],
    defaultRecipients: ['{{assignedTo}}', '{{assignedSupervisor}}', 'role:supervisor'],
    subject: 'After-sales ticket assigned',
  },
  {
    topic: 'after-sales.ticket.overdue',
    event: 'ticket.overdue',
    channels: ['feishu', 'email', 'webhook'],
    defaultRecipients: ['{{assignedTo}}', '{{assignedSupervisor}}', 'role:supervisor', '{{overdueWebhook}}'],
    subject: 'After-sales ticket overdue',
  },
  {
    topic: 'after-sales.approval.pending',
    event: 'approval.pending',
    channels: ['feishu', 'email'],
    defaultRecipients: ['role:finance', 'role:supervisor'],
    subject: 'After-sales approval pending',
  },
  {
    topic: 'after-sales.followup.due',
    event: 'followup.due',
    channels: ['feishu', 'email'],
    defaultRecipients: ['{{followUpOwner}}'],
    subject: 'After-sales follow-up due',
  },
])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createAdapterError(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details && typeof details === 'object') {
    error.details = details
  }
  return error
}

function getNotificationTopicSpecs() {
  return clone(TOPIC_SPECS)
}

function getNotificationTopicSpec(topic) {
  return TOPIC_SPECS.find((spec) => spec.topic === topic) || null
}

function readPayloadValue(payload, keyPath) {
  if (!payload || typeof payload !== 'object' || !keyPath) return undefined
  if (!keyPath.includes('.')) {
    return payload[keyPath]
  }
  const parts = keyPath.split('.')
  if (parts.length !== 2) return undefined
  const head = payload[parts[0]]
  if (!head || typeof head !== 'object' || Array.isArray(head)) return undefined
  return head[parts[1]]
}

function recipientMatchesChannel(recipient, channel) {
  return recipient.type === CHANNEL_TO_RECIPIENT_TYPE[channel]
}

function dedupeRecipients(recipients) {
  const seen = new Set()
  return recipients.filter((recipient) => {
    const key = `${recipient.type}:${recipient.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function resolveDefaultRecipients(input) {
  const {
    channel,
    defaultRecipients = [],
    payload = {},
    roleRecipients = {},
  } = input || {}

  const recipients = []

  for (const entry of defaultRecipients) {
    if (typeof entry !== 'string') continue

    if (entry.startsWith('role:')) {
      const roleSlug = entry.slice('role:'.length)
      const roleValues = roleRecipients[roleSlug] || []
      recipients.push(...normalizeRecipientList(roleValues))
      continue
    }

    const match = entry.match(/^\{\{([a-zA-Z0-9_.-]+)\}\}$/)
    if (!match) {
      recipients.push(...normalizeRecipientList(entry))
      continue
    }

    const payloadValue = readPayloadValue(payload, match[1])
    recipients.push(...normalizeRecipientList(payloadValue))
  }

  return dedupeRecipients(recipients.filter((recipient) => recipientMatchesChannel(recipient, channel)))
}

function buildNotificationContent(spec, payload) {
  if (typeof payload?.content === 'string' && payload.content.trim()) {
    return payload.content.trim()
  }
  const title = typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : spec.event
  const ticketNo = typeof payload?.ticketNo === 'string' && payload.ticketNo.trim() ? payload.ticketNo.trim() : null
  return ticketNo ? `${title} (${ticketNo})` : title
}

function buildNotificationsForTopic(input) {
  const { topic, payload = {}, roleRecipients = {} } = input || {}
  const spec = getNotificationTopicSpec(topic)
  if (!spec) {
    throw createAdapterError('AFTER_SALES_TOPIC_NOT_FOUND', `Unknown after-sales notification topic: ${topic}`)
  }

  const subject = typeof payload?.subject === 'string' && payload.subject.trim()
    ? payload.subject.trim()
    : spec.subject

  return spec.channels
    .map((channel) => {
      const recipients = resolveDefaultRecipients({
        channel,
        defaultRecipients: spec.defaultRecipients,
        payload,
        roleRecipients,
      })

      if (recipients.length === 0) {
        return null
      }

      return {
        topic: spec.topic,
        event: spec.event,
        channel,
        notification: {
          type: spec.event,
          channel,
          channels: [channel],
          subject,
          content: buildNotificationContent(spec, payload),
          recipients,
          data: payload,
          metadata: {
            topic: spec.topic,
            event: spec.event,
          },
        },
      }
    })
    .filter(Boolean)
}

async function sendTopicNotification(context, input) {
  const notificationService = context?.services?.notification
  if (!notificationService || typeof notificationService.send !== 'function') {
    throw createAdapterError(
      'AFTER_SALES_NOTIFICATION_SERVICE_UNAVAILABLE',
      'After-sales notification service is not available on plugin context',
    )
  }

  const requests = buildNotificationsForTopic(input)
  const results = []
  for (const request of requests) {
    const result = await notificationService.send(request.notification)
    results.push({
      topic: request.topic,
      event: request.event,
      channel: request.channel,
      result,
    })
  }
  return results
}

module.exports = {
  CHANNEL_TO_RECIPIENT_TYPE,
  getNotificationTopicSpecs,
  getNotificationTopicSpec,
  buildNotificationsForTopic,
  sendTopicNotification,
}
