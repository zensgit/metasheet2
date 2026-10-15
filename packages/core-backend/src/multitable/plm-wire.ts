import { z } from 'zod'

// PostgreSQL text/jsonb cannot store NUL or unpaired UTF-16 surrogates. Never normalize source text.
export function isPlmText(value: string): boolean {
  return !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  )
}
export const plmId = z
  .string()
  .refine((v) => v.length > 0 && Array.from(v).length <= 128 && isPlmText(v))
export const plmSourceSchema = z
  .object({
    connection_id: plmId,
    tenant_id: plmId,
    org_id: plmId,
    part_id: plmId,
  })
  .strict()
export function canonicalPlmEvent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPlmEvent).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalPlmEvent((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}
