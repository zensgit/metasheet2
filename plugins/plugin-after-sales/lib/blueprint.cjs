'use strict'

const { getNotificationTopicSpecs } = require('./notification-adapter.cjs')

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
    ],
    automations: [],
    roles: [],
    notifications: getNotificationTopicSpecs(),
    configDefaults: {},
  }
}

module.exports = {
  buildDefaultBlueprint,
}
