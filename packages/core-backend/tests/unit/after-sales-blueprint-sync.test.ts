import { describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const manifest = require('../../../../plugins/plugin-after-sales/app.manifest.json') as Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const blueprint = require('../../../../plugins/plugin-after-sales/lib/blueprint.cjs') as {
  buildDefaultBlueprint: (manifestInput: Record<string, unknown>) => Record<string, unknown>
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notificationAdapter = require('../../../../plugins/plugin-after-sales/lib/notification-adapter.cjs') as {
  getNotificationTopicSpecs: () => Array<Record<string, unknown>>
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const workflowAdapter = require('../../../../plugins/plugin-after-sales/lib/workflow-adapter.cjs') as {
  registerAfterSalesWorkflowHandlers: (
    context: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => { subscriptions: string[] }
}

function createEventContext() {
  return {
    api: {
      events: {
        on: vi.fn((eventName: string) => `sub:${eventName}`),
      },
    },
  }
}

describe('after-sales blueprint runtime sync', () => {
  it('keeps blueprint notification specs in sync with the runtime notification catalog', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    expect(result.notifications).toEqual(notificationAdapter.getNotificationTopicSpecs())
  })

  it('only references runtime-supported notification topics, bridges, and helper expressions', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const automations = Array.isArray(result.automations)
      ? result.automations as Array<Record<string, unknown>>
      : []
    const topicCatalog = new Set(
      notificationAdapter.getNotificationTopicSpecs().map((spec) => String(spec.topic)),
    )

    for (const rule of automations) {
      const actions = Array.isArray(rule.actions) ? rule.actions as Array<Record<string, unknown>> : []

      for (const action of actions) {
        if (action.type === 'sendNotification') {
          expect(topicCatalog.has(String(action.topic))).toBe(true)
        }

        if (action.type === 'submitApproval') {
          expect(action.bridge).toBe('after-sales-refund')
        }

        if (action.type === 'updateField' && action.field === 'slaDueAt') {
          expect(action.value).toBe('{{computeSlaDueAt(priority)}}')
        }
      }
    }
  })

  it('registers workflow listeners for every automation trigger and notification event', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const automations = Array.isArray(result.automations)
      ? result.automations as Array<Record<string, unknown>>
      : []
    const topicSpecs = notificationAdapter.getNotificationTopicSpecs()
    const expectedEvents = Array.from(new Set([
      ...automations.map((rule) => String((rule.trigger as Record<string, unknown>)?.event || '')).filter(Boolean),
      ...topicSpecs.map((spec) => String(spec.event)).filter(Boolean),
    ])).sort()

    const context = createEventContext()
    const runtime = workflowAdapter.registerAfterSalesWorkflowHandlers(context)
    const registeredEvents = context.api.events.on.mock.calls.map(([eventName]: [string]) => eventName).sort()

    expect(registeredEvents).toEqual(expectedEvents)
    expect([...runtime.subscriptions].sort()).toEqual(expectedEvents.map((eventName) => `sub:${eventName}`))
  })
})
