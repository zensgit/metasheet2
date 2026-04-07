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
    expect(result.views).toEqual([
      {
        id: 'installedAsset-grid',
        objectId: 'installedAsset',
        name: 'Installed Assets',
        type: 'grid',
        config: {},
      },
    ])
  })

  it('keeps non-installedAsset objects unchanged', () => {
    const result = blueprint.buildDefaultBlueprint(manifest)
    const objects = Array.isArray(result.objects) ? result.objects as Array<Record<string, unknown>> : []
    const serviceTicket = objects.find((objectDescriptor) => objectDescriptor.id === 'serviceTicket')
    const warrantyPolicy = objects.find((objectDescriptor) => objectDescriptor.id === 'warrantyPolicy')

    expect(serviceTicket).toEqual({
      id: 'serviceTicket',
      name: 'Service Ticket',
      backing: 'hybrid',
    })
    expect(warrantyPolicy).toEqual({
      id: 'warrantyPolicy',
      name: 'Warranty Policy',
      backing: 'service',
    })
  })
})
