import type { PlmItemMetadata } from '../../services/PlmService'
import type { ProductRecord, PlmProductMetadataRow } from './plmPanelModels'

function readProductFieldValue(product: ProductRecord | null, fieldName: string): unknown {
  if (!product || !fieldName.trim()) return undefined
  const topLevelValue = product[fieldName]
  if (topLevelValue !== undefined && topLevelValue !== null && topLevelValue !== '') {
    return topLevelValue
  }

  const properties = product.properties
  if (!properties || typeof properties !== 'object') return undefined
  const propertyValue = properties[fieldName]
  if (propertyValue !== undefined && propertyValue !== null && propertyValue !== '') {
    return propertyValue
  }
  return undefined
}

export function formatProductMetadataValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function buildProductMetadataRows(
  product: ProductRecord | null,
  metadata: PlmItemMetadata | null,
): PlmProductMetadataRow[] {
  if (!metadata?.properties?.length) return []

  return metadata.properties
    .filter((field) => typeof field.name === 'string' && field.name.trim().length > 0)
    .map((field) => ({
      name: field.name,
      label: typeof field.label === 'string' && field.label.trim().length > 0 ? field.label : field.name,
      type: typeof field.type === 'string' && field.type.trim().length > 0 ? field.type : '-',
      required: field.required === true,
      length: typeof field.length === 'number' ? String(field.length) : '-',
      defaultValue: formatProductMetadataValue(field.default),
      currentValue: formatProductMetadataValue(readProductFieldValue(product, field.name)),
    }))
}
