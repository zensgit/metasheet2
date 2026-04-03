export type ProductMode = 'platform' | 'attendance' | 'plm-workbench'

function parseBooleanEnv(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return undefined
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return undefined
}

export function normalizeProductMode(value: unknown): ProductMode {
  if (value === 'attendance' || value === 'attendance-focused') return 'attendance'
  if (value === 'plm-workbench' || value === 'plmWorkbench' || value === 'plm-focused') return 'plm-workbench'
  return 'platform'
}

export function isPlmEnabled(
  productModeValue: unknown = process.env.PRODUCT_MODE,
  enablePlmValue: unknown = process.env.ENABLE_PLM,
): boolean {
  const productMode = normalizeProductMode(productModeValue)
  if (productMode === 'attendance') return false
  return parseBooleanEnv(enablePlmValue) ?? true
}

export function resolveEffectiveProductMode(
  productModeValue: unknown = process.env.PRODUCT_MODE,
  enablePlmValue: unknown = process.env.ENABLE_PLM,
): ProductMode {
  const productMode = normalizeProductMode(productModeValue)
  if (productMode === 'plm-workbench' && !isPlmEnabled(productMode, enablePlmValue)) {
    return 'platform'
  }
  return productMode
}
