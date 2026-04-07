'use strict'

function enrichObjectDescriptor(objectDescriptor) {
  if (!objectDescriptor || typeof objectDescriptor !== 'object') {
    return objectDescriptor
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
        id: 'installedAsset-grid',
        objectId: 'installedAsset',
        name: 'Installed Assets',
        type: 'grid',
        config: {},
      },
    ],
    automations: [],
    roles: [],
    notifications: [],
    configDefaults: {},
  }
}

module.exports = {
  buildDefaultBlueprint,
}
