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
 * This module supplies the MODE, a pure classifier, and the typed refusal error.
 *
 * DEFAULT `'refuse'` (Codex round 2 — S3's ratified direction). An EXISTING object is
 * never silently destructively reconciled: when any incoming field differs from the stored
 * row in name/type/property/order, `ensureFields` THROWS
 * `MultitableEnsureFieldsRefusedError` naming the diff KINDS (never the values), and the
 * whole `ensureObject` call fails closed. A field id that does not yet exist is still a
 * plain create, so ADDITIVE template evolution through `ensureObject` keeps working and a
 * FIRST install is completely unaffected. Repair of an already-provisioned object goes
 * through `ensureMissingObjectFields` (ON CONFLICT DO NOTHING, constructively add-only).
 *
 * The other modes are explicit opt-ins, honored only as exact literals:
 *   - `'overwrite'` — the pre-P0-S behavior, byte-identical SQL with NO pre-read. The one
 *     escape hatch for an operator who has decided the blueprint wins.
 *   - `'observe'` — still overwrites, but emits a structured warning first (audit-first,
 *     per the same discipline as the assertSheetScope migration).
 *   - `'preserve'` — switches the conflict to add-only (existing rows untouched, no throw).
 *
 * Anything else (unset / empty / typo / wrong case) resolves to `'refuse'` — a typo in the
 * escape hatch must not silently re-arm the destructive path. Full three-way-diff /
 * named-migration reconciliation is still a follow-up (needs the upgrade-ledger work).
 */

export const ENSURE_FIELDS_OVERWRITE_MODE_ENV = 'MULTITABLE_ENSURE_FIELDS_OVERWRITE_MODE'

export type EnsureFieldsOverwriteMode = 'refuse' | 'overwrite' | 'observe' | 'preserve'

type Env = Readonly<Record<string, string | undefined>>

/**
 * Fail-CLOSED resolution: default `'refuse'`. Only the exact lowercase literals
 * `'overwrite'` / `'observe'` / `'preserve'` opt out; anything else (unset/empty/typo/
 * wrong case) => `'refuse'`.
 */
export function resolveEnsureFieldsOverwriteMode(env: Env = process.env): EnsureFieldsOverwriteMode {
  const raw = env[ENSURE_FIELDS_OVERWRITE_MODE_ENV]
  if (raw === 'overwrite') return 'overwrite'
  if (raw === 'observe') return 'observe'
  if (raw === 'preserve') return 'preserve'
  return 'refuse'
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
  return diffFieldOverwriteKinds(existing, incoming).length === 0 ? 'unchanged' : 'would_overwrite'
}

/** The mutable, schema-affecting columns a reconcile could clobber. */
export type FieldDiffKind = 'name' | 'type' | 'property' | 'order'

/** Stable order so the refusal message is deterministic across runs. */
const FIELD_DIFF_KIND_ORDER: readonly FieldDiffKind[] = ['name', 'type', 'property', 'order']

/**
 * Which columns would change if `incoming` were written over `existing`. Returns the KINDS
 * only — never the stored or incoming values — so the result is safe to put in a log line
 * or an error message. Empty array === nothing would change. `existing == null` (a plain
 * create) is likewise empty: a create is not a destructive overwrite.
 */
export function diffFieldOverwriteKinds(
  existing: ExistingFieldShape | null | undefined,
  incoming: IncomingFieldShape,
): FieldDiffKind[] {
  if (!existing) return []
  const changed: Record<FieldDiffKind, boolean> = {
    name: existing.name !== incoming.name,
    type: existing.type !== incoming.type,
    property: stableJson(existing.property) !== stableJson(incoming.property),
    order: existing.order !== incoming.order,
  }
  return FIELD_DIFF_KIND_ORDER.filter((kind) => changed[kind])
}

/**
 * Typed refusal raised by `ensureFields` (and therefore by `ensureObject`) when the default
 * `'refuse'` mode meets an existing field the incoming descriptor would mutate.
 *
 * VALUES-FREE by construction: it carries the synthetic `fieldId` / `sheetId` (stable hashes
 * derived from projectId+objectId+logical id — the same identifiers the pre-existing S3 warn
 * already logs) and the diff KINDS. No field name, no type value, no property payload, no
 * cell data ever reaches the message.
 */
export class MultitableEnsureFieldsRefusedError extends Error {
  readonly code = 'MULTITABLE_ENSURE_FIELDS_REFUSED' as const
  readonly fieldId: string
  readonly sheetId: string
  readonly diffKinds: FieldDiffKind[]

  constructor(args: { fieldId: string; sheetId: string; diffKinds: FieldDiffKind[] }) {
    super(
      `ensureFields refused a destructive reconcile: field ${args.fieldId} on sheet ${args.sheetId} ` +
        `already exists and differs in [${args.diffKinds.join(', ')}]. ` +
        `Existing objects are never silently overwritten — use ensureMissingObjectFields for ` +
        `additive repair, or set ${ENSURE_FIELDS_OVERWRITE_MODE_ENV}=overwrite to opt in.`,
    )
    this.name = 'MultitableEnsureFieldsRefusedError'
    this.fieldId = args.fieldId
    this.sheetId = args.sheetId
    this.diffKinds = args.diffKinds
    Object.setPrototypeOf(this, MultitableEnsureFieldsRefusedError.prototype)
  }
}
