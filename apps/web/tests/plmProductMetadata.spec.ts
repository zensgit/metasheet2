import { describe, expect, it } from 'vitest'
import { buildProductMetadataRows, formatProductMetadataValue } from '../src/views/plm/plmProductMetadata'

describe('plmProductMetadata helpers', () => {
  it('builds metadata rows from top-level fields and properties fallback', () => {
    const rows = buildProductMetadataRows(
      {
        item_number: 'TOP-001',
        properties: {
          description: 'Property description',
          cost: 123.45,
        },
      },
      {
        id: 'Part',
        label: 'Part',
        is_relationship: false,
        properties: [
          { name: 'item_number', label: '料号', type: 'string', required: true, length: 64, default: null },
          { name: 'description', label: '描述', type: 'string', required: false, length: 256, default: null },
          { name: 'cost', label: '成本', type: 'float', required: false, length: 18, default: 0 },
        ],
      },
    )

    expect(rows).toEqual([
      {
        name: 'item_number',
        label: '料号',
        type: 'string',
        required: true,
        length: '64',
        defaultValue: '-',
        currentValue: 'TOP-001',
      },
      {
        name: 'description',
        label: '描述',
        type: 'string',
        required: false,
        length: '256',
        defaultValue: '-',
        currentValue: 'Property description',
      },
      {
        name: 'cost',
        label: '成本',
        type: 'float',
        required: false,
        length: '18',
        defaultValue: '0',
        currentValue: '123.45',
      },
    ])
  })

  it('formats empty and structured values for UI display', () => {
    expect(formatProductMetadataValue(undefined)).toBe('-')
    expect(formatProductMetadataValue(null)).toBe('-')
    expect(formatProductMetadataValue('')).toBe('-')
    expect(formatProductMetadataValue(false)).toBe('false')
    expect(formatProductMetadataValue({ owner: 'qa' })).toContain('"owner": "qa"')
  })
})
