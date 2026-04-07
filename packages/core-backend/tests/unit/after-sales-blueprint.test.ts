import { describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const manifest = require('../../../../plugins/plugin-after-sales/app.manifest.json') as Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const blueprint = require('../../../../plugins/plugin-after-sales/lib/blueprint.cjs') as {
  buildDefaultBlueprint: (manifestInput: Record<string, unknown>) => Record<string, unknown>
}

describe('plugin-after-sales default blueprint', () => {
  it('enriches installedAsset with the maintained installed asset field set', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const objects = Array.isArray(result.objects) ? result.objects as Array<Record<string, unknown>> : []
    const installedAsset = objects.find((objectDescriptor) => objectDescriptor.id === 'installedAsset')

    expect(installedAsset).toBeDefined()
    expect(installedAsset).toMatchObject({
      id: 'installedAsset',
      name: 'Installed Asset',
      backing: 'multitable',
    })
    expect(installedAsset?.fields).toEqual([
      expect.objectContaining({ id: 'assetCode', type: 'string', required: true }),
      expect.objectContaining({ id: 'serialNo', type: 'string' }),
      expect.objectContaining({ id: 'model', type: 'string' }),
      expect.objectContaining({ id: 'location', type: 'string' }),
      expect.objectContaining({ id: 'installedAt', type: 'date' }),
      expect.objectContaining({ id: 'warrantyUntil', type: 'date' }),
      expect.objectContaining({
        id: 'status',
        type: 'select',
        required: true,
        options: ['active', 'expired', 'decommissioned'],
      }),
    ])
    expect(result.views).toContainEqual({
      id: 'installedAsset-grid',
      objectId: 'installedAsset',
      name: 'Installed Assets',
      type: 'grid',
      config: {},
    })
  })

  it('adds the serviceTicket multitable projection and default board view', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const objects = Array.isArray(result.objects) ? result.objects as Array<Record<string, unknown>> : []
    const serviceTicket = objects.find((objectDescriptor) => objectDescriptor.id === 'serviceTicket')

    expect(serviceTicket).toMatchObject({
      id: 'serviceTicket',
      name: 'Service Ticket',
      backing: 'hybrid',
      provisioning: {
        multitable: true,
      },
    })
    expect(serviceTicket?.fields).toEqual([
      expect.objectContaining({ id: 'ticketNo', type: 'string', required: true }),
      expect.objectContaining({ id: 'title', type: 'string', required: true }),
      expect.objectContaining({
        id: 'source',
        type: 'select',
        required: true,
        options: ['phone', 'email', 'web', 'wechat'],
      }),
      expect.objectContaining({
        id: 'priority',
        type: 'select',
        required: true,
        options: ['low', 'normal', 'high', 'urgent'],
      }),
      expect.objectContaining({
        id: 'status',
        type: 'select',
        required: true,
        options: ['new', 'assigned', 'inProgress', 'done', 'closed'],
      }),
      expect.objectContaining({ id: 'slaDueAt', type: 'date', required: false }),
      expect.objectContaining({ id: 'refundAmount', type: 'number', required: false }),
    ])
    expect(result.views).toContainEqual({
      id: 'ticket-board',
      objectId: 'serviceTicket',
      name: 'Ticket Board',
      type: 'kanban',
      config: {
        groupFieldId: 'status',
        cardFieldIds: ['ticketNo', 'title', 'priority', 'slaDueAt'],
      },
      groupInfo: {
        fieldId: 'status',
      },
    })
  })

  it('keeps service-only objects unchanged', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const objects = Array.isArray(result.objects) ? result.objects as Array<Record<string, unknown>> : []
    const warrantyPolicy = objects.find((objectDescriptor) => objectDescriptor.id === 'warrantyPolicy')

    expect(warrantyPolicy).toEqual({
      id: 'warrantyPolicy',
      name: 'Warranty Policy',
      backing: 'service',
    })
  })

  it('declares the v1 notification topic catalog', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const notifications = Array.isArray(result.notifications)
      ? result.notifications as Array<Record<string, unknown>>
      : []

    expect(notifications).toEqual([
      expect.objectContaining({
        topic: 'after-sales.ticket.assigned',
        event: 'ticket.assigned',
        channels: ['feishu', 'email'],
      }),
      expect.objectContaining({
        topic: 'after-sales.ticket.overdue',
        event: 'ticket.overdue',
        channels: ['feishu', 'email', 'webhook'],
      }),
      expect.objectContaining({
        topic: 'after-sales.approval.pending',
        event: 'approval.pending',
        channels: ['feishu', 'email'],
      }),
      expect.objectContaining({
        topic: 'after-sales.followup.due',
        event: 'followup.due',
        channels: ['feishu', 'email'],
      }),
    ])
  })
})
