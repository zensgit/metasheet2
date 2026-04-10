'use strict'

const { getNotificationTopicSpecs } = require('./notification-adapter.cjs')

const DEFAULT_TEMPLATE_CONFIG = Object.freeze({
  enableWarranty: true,
  enableRefundApproval: true,
  enableVisitScheduling: true,
  enableFollowUp: true,
  defaultSlaHours: 24,
  urgentSlaHours: 4,
  followUpAfterDays: 7,
})

const DEFAULT_AUTOMATIONS = Object.freeze([
  {
    id: 'ticket-triage',
    trigger: { event: 'ticket.created' },
    conditions: [],
    actions: [
      // This string is intentionally kept literal here. The workflow runtime
      // is the only place that resolves the computeSlaDueAt(priority) helper.
      { type: 'assign', assigneeRule: 'by-area-or-round-robin' },
      { type: 'updateField', field: 'slaDueAt', value: '{{computeSlaDueAt(priority)}}' },
      { type: 'sendNotification', topic: 'after-sales.ticket.assigned' },
    ],
    enabled: true,
  },
  {
    id: 'sla-watcher',
    trigger: {
      event: 'ticket.overdue',
      filter: [{ field: 'status', operator: 'in', value: ['new', 'assigned', 'inProgress'] }],
    },
    conditions: [],
    actions: [
      { type: 'updateField', field: 'priority', value: 'urgent' },
      { type: 'sendNotification', topic: 'after-sales.ticket.overdue' },
    ],
    enabled: true,
  },
  {
    id: 'refund-approval',
    trigger: { event: 'ticket.refundRequested' },
    conditions: [],
    actions: [
      { type: 'submitApproval', bridge: 'after-sales-refund' },
      { type: 'sendNotification', topic: 'after-sales.approval.pending' },
    ],
    enabled: true,
  },
  {
    id: 'service-record-notify',
    trigger: { event: 'service.recorded' },
    conditions: [],
    actions: [
      { type: 'sendNotification', topic: 'after-sales.service.recorded' },
    ],
    enabled: true,
  },
])

const DEFAULT_ROLES = Object.freeze([
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

const DEFAULT_FIELD_POLICIES = Object.freeze([
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

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function enrichObjectDescriptor(objectDescriptor) {
  if (!objectDescriptor || typeof objectDescriptor !== 'object') {
    return objectDescriptor
  }

  if (objectDescriptor.id === 'serviceTicket') {
    return {
      ...objectDescriptor,
      provisioning: {
        multitable: true,
      },
      fields: [
        {
          id: 'ticketNo',
          name: 'Ticket No',
          type: 'string',
          required: true,
        },
        {
          id: 'title',
          name: 'Title',
          type: 'string',
          required: true,
        },
        {
          id: 'source',
          name: 'Source',
          type: 'select',
          required: true,
          options: ['phone', 'email', 'web', 'wechat'],
        },
        {
          id: 'priority',
          name: 'Priority',
          type: 'select',
          required: true,
          options: ['low', 'normal', 'high', 'urgent'],
        },
        {
          id: 'status',
          name: 'Status',
          type: 'select',
          required: true,
          options: ['new', 'assigned', 'inProgress', 'done', 'closed'],
        },
        {
          id: 'slaDueAt',
          name: 'SLA Due At',
          type: 'date',
          required: false,
        },
        {
          id: 'refundAmount',
          name: 'Refund Amount',
          type: 'number',
          required: false,
        },
        {
          id: 'refundStatus',
          name: 'Refund Status',
          type: 'select',
          required: false,
          options: ['pending', 'approved', 'rejected'],
        },
      ],
    }
  }

  if (objectDescriptor.id === 'customer') {
    return {
      ...objectDescriptor,
      fields: [
        {
          id: 'customerCode',
          name: 'Customer Code',
          type: 'string',
          required: true,
        },
        {
          id: 'name',
          name: 'Name',
          type: 'string',
          required: true,
        },
        {
          id: 'phone',
          name: 'Phone',
          type: 'string',
          required: false,
        },
        {
          id: 'email',
          name: 'Email',
          type: 'string',
          required: false,
        },
        {
          id: 'status',
          name: 'Status',
          type: 'select',
          required: true,
          options: ['active', 'inactive'],
        },
      ],
    }
  }

  if (objectDescriptor.id === 'serviceRecord') {
    return {
      ...objectDescriptor,
      fields: [
        {
          id: 'ticketNo',
          name: 'Ticket No',
          type: 'string',
          required: true,
        },
        {
          id: 'visitType',
          name: 'Visit Type',
          type: 'select',
          required: true,
          options: ['onsite', 'remote', 'pickup'],
        },
        {
          id: 'scheduledAt',
          name: 'Scheduled At',
          type: 'date',
          required: true,
        },
        {
          id: 'completedAt',
          name: 'Completed At',
          type: 'date',
          required: false,
        },
        {
          id: 'technicianName',
          name: 'Technician Name',
          type: 'string',
          required: false,
        },
        {
          id: 'workSummary',
          name: 'Work Summary',
          type: 'string',
          required: false,
        },
        {
          id: 'result',
          name: 'Result',
          type: 'select',
          required: false,
          options: ['resolved', 'partial', 'escalated'],
        },
      ],
    }
  }

  if (objectDescriptor.id === 'partItem') {
    return {
      ...objectDescriptor,
      fields: [
        {
          id: 'partNo',
          name: 'Part No',
          type: 'string',
          required: true,
        },
        {
          id: 'name',
          name: 'Name',
          type: 'string',
          required: true,
        },
        {
          id: 'category',
          name: 'Category',
          type: 'select',
          required: true,
          options: ['spare', 'consumable'],
        },
        {
          id: 'stockQty',
          name: 'Stock Qty',
          type: 'number',
          required: false,
        },
        {
          id: 'status',
          name: 'Status',
          type: 'select',
          required: true,
          options: ['available', 'reserved', 'consumed'],
        },
      ],
    }
  }

  if (objectDescriptor.id === 'followUp') {
    return {
      ...objectDescriptor,
      fields: [
        {
          id: 'ticketNo',
          name: 'Ticket No',
          type: 'string',
          required: true,
        },
        {
          id: 'customerName',
          name: 'Customer Name',
          type: 'string',
          required: true,
        },
        {
          id: 'dueAt',
          name: 'Due At',
          type: 'date',
          required: true,
        },
        {
          id: 'followUpType',
          name: 'Follow Up Type',
          type: 'select',
          required: true,
          options: ['phone', 'message', 'onsite'],
        },
        {
          id: 'ownerName',
          name: 'Owner Name',
          type: 'string',
          required: false,
        },
        {
          id: 'status',
          name: 'Status',
          type: 'select',
          required: true,
          options: ['pending', 'done', 'skipped'],
        },
        {
          id: 'summary',
          name: 'Summary',
          type: 'string',
          required: false,
        },
      ],
    }
  }

  if (objectDescriptor.id !== 'installedAsset') {
    return { ...objectDescriptor }
  }

  return {
    ...objectDescriptor,
    fields: [
      {
        id: 'assetCode',
        name: 'Asset Code',
        type: 'string',
        required: true,
      },
      {
        id: 'serialNo',
        name: 'Serial No',
        type: 'string',
        required: false,
      },
      {
        id: 'model',
        name: 'Model',
        type: 'string',
        required: false,
      },
      {
        id: 'location',
        name: 'Location',
        type: 'string',
        required: false,
      },
      {
        id: 'installedAt',
        name: 'Installed At',
        type: 'date',
        required: false,
      },
      {
        id: 'warrantyUntil',
        name: 'Warranty Until',
        type: 'date',
        required: false,
      },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        required: true,
        options: ['active', 'expired', 'decommissioned'],
      },
    ],
  }
}

function buildDefaultBlueprint(manifest) {
  return {
    id: 'after-sales-default',
    version: manifest.version || '0.1.0',
    displayName: manifest.displayName || 'After Sales Default Template',
    appId: manifest.id,
    objects: Array.isArray(manifest.objects)
      ? manifest.objects.map((objectDescriptor) => enrichObjectDescriptor(objectDescriptor))
      : [],
    views: [
      {
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
      },
      {
        id: 'installedAsset-grid',
        objectId: 'installedAsset',
        name: 'Installed Assets',
        type: 'grid',
        config: {},
      },
      {
        id: 'customer-grid',
        objectId: 'customer',
        name: 'Customers',
        type: 'grid',
        config: {},
      },
      {
        id: 'serviceRecord-calendar',
        objectId: 'serviceRecord',
        name: 'Service Schedule',
        type: 'calendar',
        config: {
          dateFieldId: 'scheduledAt',
        },
      },
      {
        id: 'partItem-grid',
        objectId: 'partItem',
        name: 'Parts',
        type: 'grid',
        config: {},
      },
      {
        id: 'followUp-grid',
        objectId: 'followUp',
        name: 'Follow Ups',
        type: 'grid',
        config: {},
      },
    ],
    automations: clone(DEFAULT_AUTOMATIONS),
    roles: clone(DEFAULT_ROLES),
    fieldPolicies: clone(DEFAULT_FIELD_POLICIES),
    notifications: getNotificationTopicSpecs(),
    configDefaults: clone(DEFAULT_TEMPLATE_CONFIG),
  }
}

module.exports = {
  DEFAULT_AUTOMATIONS,
  DEFAULT_FIELD_POLICIES,
  DEFAULT_ROLES,
  DEFAULT_TEMPLATE_CONFIG,
  buildDefaultBlueprint,
}
