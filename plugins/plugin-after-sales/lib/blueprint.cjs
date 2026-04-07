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
