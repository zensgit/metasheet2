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
      expect.objectContaining({
        id: 'refundStatus',
        type: 'select',
        required: false,
        options: ['pending', 'approved', 'rejected'],
      }),
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

  it('adds the customer multitable projection and default grid view', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const objects = Array.isArray(result.objects) ? result.objects as Array<Record<string, unknown>> : []
    const customer = objects.find((objectDescriptor) => objectDescriptor.id === 'customer')

    expect(customer).toMatchObject({
      id: 'customer',
      name: 'Customer',
      backing: 'multitable',
    })
    expect(customer?.fields).toEqual([
      expect.objectContaining({ id: 'customerCode', type: 'string', required: true }),
      expect.objectContaining({ id: 'name', type: 'string', required: true }),
      expect.objectContaining({ id: 'phone', type: 'string', required: false }),
      expect.objectContaining({ id: 'email', type: 'string', required: false }),
      expect.objectContaining({
        id: 'status',
        type: 'select',
        required: true,
        options: ['active', 'inactive'],
      }),
    ])
    expect(result.views).toContainEqual({
      id: 'customer-grid',
      objectId: 'customer',
      name: 'Customers',
      type: 'grid',
      config: {},
    })
  })

  it('adds the serviceRecord multitable projection and schedule calendar view', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const objects = Array.isArray(result.objects) ? result.objects as Array<Record<string, unknown>> : []
    const serviceRecord = objects.find((objectDescriptor) => objectDescriptor.id === 'serviceRecord')

    expect(serviceRecord).toMatchObject({
      id: 'serviceRecord',
      name: 'Service Record',
      backing: 'multitable',
    })
    expect(serviceRecord?.fields).toEqual([
      expect.objectContaining({ id: 'ticketNo', type: 'string', required: true }),
      expect.objectContaining({
        id: 'visitType',
        type: 'select',
        required: true,
        options: ['onsite', 'remote', 'pickup'],
      }),
      expect.objectContaining({ id: 'scheduledAt', type: 'date', required: true }),
      expect.objectContaining({ id: 'completedAt', type: 'date', required: false }),
      expect.objectContaining({ id: 'technicianName', type: 'string', required: false }),
      expect.objectContaining({ id: 'workSummary', type: 'string', required: false }),
      expect.objectContaining({
        id: 'result',
        type: 'select',
        required: false,
        options: ['resolved', 'partial', 'escalated'],
      }),
    ])
    expect(result.views).toContainEqual({
      id: 'serviceRecord-calendar',
      objectId: 'serviceRecord',
      name: 'Service Schedule',
      type: 'calendar',
      config: {
        dateFieldId: 'scheduledAt',
      },
    })
  })

  it('adds the partItem multitable projection and default grid view', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const objects = Array.isArray(result.objects) ? result.objects as Array<Record<string, unknown>> : []
    const partItem = objects.find((objectDescriptor) => objectDescriptor.id === 'partItem')

    expect(partItem).toMatchObject({
      id: 'partItem',
      name: 'Part Item',
      backing: 'multitable',
    })
    expect(partItem?.fields).toEqual([
      expect.objectContaining({ id: 'partNo', type: 'string', required: true }),
      expect.objectContaining({ id: 'name', type: 'string', required: true }),
      expect.objectContaining({
        id: 'category',
        type: 'select',
        required: true,
        options: ['spare', 'consumable'],
      }),
      expect.objectContaining({ id: 'stockQty', type: 'number', required: false }),
      expect.objectContaining({
        id: 'status',
        type: 'select',
        required: true,
        options: ['available', 'reserved', 'consumed'],
      }),
    ])
    expect(result.views).toContainEqual({
      id: 'partItem-grid',
      objectId: 'partItem',
      name: 'Parts',
      type: 'grid',
      config: {},
    })
  })

  it('adds the followUp multitable projection and default list view', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const objects = Array.isArray(result.objects) ? result.objects as Array<Record<string, unknown>> : []
    const followUp = objects.find((objectDescriptor) => objectDescriptor.id === 'followUp')

    expect(followUp).toMatchObject({
      id: 'followUp',
      name: 'Follow Up',
      backing: 'multitable',
    })
    expect(followUp?.fields).toEqual([
      expect.objectContaining({ id: 'ticketNo', type: 'string', required: true }),
      expect.objectContaining({ id: 'customerName', type: 'string', required: true }),
      expect.objectContaining({ id: 'dueAt', type: 'date', required: true }),
      expect.objectContaining({
        id: 'followUpType',
        type: 'select',
        required: true,
        options: ['phone', 'message', 'onsite'],
      }),
      expect.objectContaining({ id: 'ownerName', type: 'string', required: false }),
      expect.objectContaining({
        id: 'status',
        type: 'select',
        required: true,
        options: ['pending', 'done', 'skipped'],
      }),
      expect.objectContaining({ id: 'summary', type: 'string', required: false }),
    ])
    expect(result.views).toContainEqual({
      id: 'followUp-grid',
      objectId: 'followUp',
      name: 'Follow Ups',
      type: 'grid',
      config: {},
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
        topic: 'after-sales.service.recorded',
        event: 'service.recorded',
        channels: ['feishu', 'email'],
      }),
      expect.objectContaining({
        topic: 'after-sales.followup.due',
        event: 'followup.due',
        channels: ['feishu', 'email'],
      }),
    ])
  })

  it('declares the v1 automation catalog and template config defaults', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)

    expect(result.automations).toEqual([
      expect.objectContaining({
        id: 'ticket-triage',
        trigger: { event: 'ticket.created' },
        enabled: true,
      }),
      expect.objectContaining({
        id: 'sla-watcher',
        trigger: expect.objectContaining({ event: 'ticket.overdue' }),
        enabled: true,
      }),
      expect.objectContaining({
        id: 'refund-approval',
        trigger: { event: 'ticket.refundRequested' },
        enabled: true,
      }),
      expect.objectContaining({
        id: 'service-record-notify',
        trigger: { event: 'service.recorded' },
        enabled: true,
      }),
    ])
    expect(result.configDefaults).toEqual({
      enableWarranty: true,
      enableRefundApproval: true,
      enableVisitScheduling: true,
      enableFollowUp: true,
      defaultSlaHours: 24,
      urgentSlaHours: 4,
      followUpAfterDays: 7,
    })
  })

  it('declares the v1 role matrix and refundAmount field policies', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)

    expect(result.roles).toEqual([
      {
        slug: 'customer_service',
        label: '客服',
        permissions: ['after_sales:read', 'after_sales:write'],
      },
      {
        slug: 'technician',
        label: '技师',
        permissions: ['after_sales:read', 'after_sales:write'],
      },
      {
        slug: 'supervisor',
        label: '主管',
        permissions: ['after_sales:read', 'after_sales:write', 'after_sales:approve'],
      },
      {
        slug: 'finance',
        label: '财务',
        permissions: ['after_sales:read', 'after_sales:approve'],
      },
      {
        slug: 'admin',
        label: '管理员',
        permissions: ['after_sales:read', 'after_sales:write', 'after_sales:approve', 'after_sales:admin'],
      },
      {
        slug: 'viewer',
        label: '只读',
        permissions: ['after_sales:read'],
      },
    ])
    expect(result.fieldPolicies).toEqual([
      {
        objectId: 'serviceTicket',
        field: 'refundAmount',
        roleSlug: 'finance',
        visibility: 'visible',
        editability: 'editable',
      },
      {
        objectId: 'serviceTicket',
        field: 'refundAmount',
        roleSlug: 'admin',
        visibility: 'visible',
        editability: 'editable',
      },
      {
        objectId: 'serviceTicket',
        field: 'refundAmount',
        roleSlug: 'supervisor',
        visibility: 'visible',
        editability: 'readonly',
      },
      {
        objectId: 'serviceTicket',
        field: 'refundAmount',
        roleSlug: 'customer_service',
        visibility: 'hidden',
        editability: 'readonly',
      },
      {
        objectId: 'serviceTicket',
        field: 'refundAmount',
        roleSlug: 'technician',
        visibility: 'hidden',
        editability: 'readonly',
      },
      {
        objectId: 'serviceTicket',
        field: 'refundAmount',
        roleSlug: 'viewer',
        visibility: 'hidden',
        editability: 'readonly',
      },
    ])
  })
})
