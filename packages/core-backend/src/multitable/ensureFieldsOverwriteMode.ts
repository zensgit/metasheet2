/**
 * P0-S S3 — `ensureObject`/`ensureFields` destructive-reconcile guard (mode config).
 *
 * Security context (rebaselined @ c5a4a94f7, 2026-08-20):
 *   `ensureObject` (the installer's real entry — `plugin-after-sales/lib/installer.cjs`
 *   calls `provisioning.ensureObject`) drives `ensureFields`, whose per-field UPSERT is
 *   `ON CONFLICT (id) DO UPDATE SET name/type/property/"order" = EXCLUDED.*`. So a
 *   REINSTALL of the same blueprint silently OVERWRITES a tenant's field renames,
 *   type/property tweaks and re-ordering — an active data-loss path, not a theoretical one.
 *
 * This module only supplies the MODE and a pure classifier. The default mode is
 * `'overwrite'` = today's exact behavior (no pre-read, unchanged SQL) so the hot path is
 * byte-identical unless an operator opts in. `'observe'` keeps overwriting but emits a
 * structured warning + metric when an existing field WOULD change (audit-first, per the
 * same discipline as the assertSheetScope migration). `'preserve'` switches the conflict
 * to add-only (existing rows untouched). Full three-way-diff / named-migration enforcement
 * is a follow-up (needs the upgrade-ledger work), deliberately not attempted here.
 */

export const ENSURE_FIELDS_OVERWRITE_MODE_ENV = 'MULTITABLE_ENSURE_FIELDS_OVERWRITE_MODE'

export type EnsureFieldsOverwriteMode = 'overwrite' | 'observe' | 'preserve'

type Env = Readonly<Record<string, string | undefined>>

/**
 * Fail-safe resolution: default `'overwrite'` (today's behavior). Only the exact strings
 * `'observe'` / `'preserve'` change behavior; anything else (unset/empty/typo) => overwrite.
 */
export function resolveEnsureFieldsOverwriteMode(env: Env = process.env): EnsureFieldsOverwriteMode {
  const raw = env[ENSURE_FIELDS_OVERWRITE_MODE_ENV]
  if (raw === 'observe') return 'observe'
  if (raw === 'preserve') return 'preserve'
  return 'overwrite'
}

export interface ExistingFieldShape {
  name: string
  type: string
  property: unknown
  order: number
}
export interface IncomingFieldShape {
  name: string
  type: string
  property: unknown
  order: number
}

export type FieldOverwriteVerdict = 'create' | 'unchanged' | 'would_overwrite'

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`
}

/**
 * Pure classifier: does writing `incoming` over `existing` change anything a tenant may
 * have customized? `existing === null` means the field id does not yet exist (a plain
 * create — never a destructive overwrite).
 */
export function classifyFieldOverwrite(
  existing: ExistingFieldShape | null | undefined,
  incoming: IncomingFieldShape,
): FieldOverwriteVerdict {
  if (!existing) return 'create'
  const same =
    existing.name === incoming.name &&
    existing.type === incoming.type &&
    existing.order === incoming.order &&
    stableJson(existing.property) === stableJson(incoming.property)
  return same ? 'unchanged' : 'would_overwrite'
}
