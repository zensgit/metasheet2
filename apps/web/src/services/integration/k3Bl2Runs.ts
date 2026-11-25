import { apiFetch } from '../../utils/api'

const BL2_ERROR_CODES = [
  'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_CONFIGURED',
  'K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID',
  'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED',
  'K3_WISE_BOM_LIST_BY_MATERIAL_FAILED',
  'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH',
  'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND',
  'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS',
  'K3_WISE_BOM_LIST_BY_MATERIAL_FIELD_MISSING',
] as const
type K3Bl2ReadErrorCode = typeof BL2_ERROR_CODES[number] | 'K3_BL2_READ_FAILED'

function safeCode(value: unknown): K3Bl2ReadErrorCode {
  return typeof value === 'string' && (BL2_ERROR_CODES as readonly string[]).includes(value)
    ? value as K3Bl2ReadErrorCode : 'K3_BL2_READ_FAILED'
}

export class K3Bl2ReadError extends Error {
  readonly code: K3Bl2ReadErrorCode

  constructor(code: unknown = 'K3_BL2_READ_FAILED') {
    const coarse = safeCode(code)
    super(coarse)
    this.name = 'K3Bl2ReadError'
    this.code = coarse
  }
}

export function normalizeK3Bl2Key(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim()
  return /^[0-9]{1,20}$/.test(key) ? key : null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(): never { throw new K3Bl2ReadError() }

function normalizeResult(payload: unknown): { value: string | number } {
  if (!record(payload) || payload.ok !== true || !record(payload.data)) invalid()
  const result = payload.data
  const evidence = result.evidence
  if (!record(evidence) || evidence.object !== 'material-bom-list'
    || evidence.mode !== 'resolver_lookup') invalid()
  // Never inspect or return the data plane after a failed resolution, even if one was supplied.
  if (evidence.ok === false) throw new K3Bl2ReadError(evidence.errorCode)
  if (evidence.ok !== true || evidence.resolved !== true || evidence.containerLocated !== true
    || evidence.rule !== 'exactly_one' || evidence.candidateCount !== 1 || evidence.matchedCount !== 1
    || !record(evidence.containers) || !record(evidence.containers.primary)
    || evidence.containers.primary.type !== 'array' || evidence.containers.primary.arrayLength !== 1
    || ['ambiguous', 'capReached', 'timeoutReached'].some((key) => key in evidence && evidence[key] !== false)
    || ['boundedSmoke', 'boundedSmokeExecuted'].some((key) => key in evidence && typeof evidence[key] !== 'boolean')
    || 'errorCode' in evidence || 'errorType' in evidence) invalid()
  // Resolver evidence currently has boundedSmoke:false and no boundedSmokeExecuted. Neither flag
  // establishes uniqueness; the exact resolver counts above do. Do not impose B4 preview evidence.
  const data = result.data
  if (!record(data) || !record(data.resolver) || data.resolver.target !== 'bom_number') invalid()
  const value = data.resolver.value
  if (typeof value === 'string') {
    if (!value.trim() || value.length > 4096) invalid()
  } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  // This is a UI display restriction, not a claim that the backend resolver enforces scalar output.
  return { value }
}

export async function readK3Bl2Bom(
  id: string,
  key: string,
  workspaceId?: string | null,
): Promise<{ value: string | number }> {
  const normalizedKey = normalizeK3Bl2Key(key)
  if (normalizedKey === null) throw new K3Bl2ReadError('K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID')
  if (typeof id !== 'string' || !id.trim()) invalid()
  try {
    const query = workspaceId ? `?${new URLSearchParams({ workspaceId })}` : ''
    const response = await apiFetch(`/api/integration/read-source-configs/${encodeURIComponent(id)}/read${query}`, {
      method: 'POST', omitHeaders: ['x-tenant-id'], suppressUnauthorizedRedirect: true,
      body: JSON.stringify({ inputs: { key: normalizedKey } }),
    })
    if (!response.ok) invalid()
    return normalizeResult(await response.json())
  } catch (error) {
    if (error instanceof K3Bl2ReadError) throw error
    throw new K3Bl2ReadError()
  }
}
