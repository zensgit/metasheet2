import type {
  FormDetailColumnIdentity,
  FormFieldIdentity,
} from './approvalFormCommands'
import type { AuthorableFieldType } from './templateAuthoring'

/**
 * F1 opaque identity allocator — RATIFIED FB-D5 `OPAQUE_COLLISION_RESISTANT`
 * (approval-form-builder-parity-delta-design-20260811.md §2/§10).
 *
 * This module is the SOLE identity authority for Designer 2.0 fields, detail
 * columns, and their local selection ids. Contract:
 *
 * - Identities are opaque random tokens. They are NEVER derived from current
 *   list length, maximum visible suffix, array index, timestamps, or any other
 *   draft state — by construction: no allocator entry point accepts a draft.
 * - Every call produces a FRESH candidate (new random bytes per token), so the
 *   adapter's collision retry can never re-submit a rejected candidate.
 * - Cross-version non-reuse is provided by opacity/entropy, not by a server
 *   reservation API or an identity-history parameter: `addFormField` /
 *   `addFormDetailColumn` validate each candidate against the complete current
 *   draft, and `approvalFormAuthoringAdapter` retries a collision before any
 *   mutation.
 * - The random source is an injected seam (`IdentityRandomSource`) so tests can
 *   be deterministic and can force collisions; production uses Web Crypto.
 *
 * The legacy `createEmptyFieldDraft(index)` / `createEmptyDetailColumnDraft(index)`
 * helpers remain the flag-OFF inline-editor fallback and are NOT re-routed here
 * (delta §5 F1 protected baseline). This module must never import them.
 */

/** Random-byte seam. Production: Web Crypto. Tests: injected deterministic source. */
export interface IdentityRandomSource {
  /** Return `length` uniformly random bytes. Each call must be independent. */
  nextBytes(length: number): Uint8Array
}

/** Bytes of entropy per identity token (16 hex chars = 64 bits per token). */
export const OPAQUE_IDENTITY_TOKEN_BYTES = 8

/** Allocates opaque identities; see module doc for the FB-D5 contract. */
export interface OpaqueFormIdentityAllocator {
  /**
   * Fresh opaque field identity. Includes a first detail-column identity
   * exactly when `fieldType === 'detail'` (column ids are persisted too and
   * share the same collision domain).
   */
  nextFieldIdentity(fieldType: AuthorableFieldType): FormFieldIdentity
  /** Fresh opaque identity for one additional detail column. */
  nextDetailColumnIdentity(): FormDetailColumnIdentity
}

/** Web Crypto random source with a non-crypto fallback for exotic test hosts. */
export function defaultIdentityRandomSource(): IdentityRandomSource {
  return {
    nextBytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length)
      const cryptoApi = (globalThis as { crypto?: Crypto }).crypto
      if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
        cryptoApi.getRandomValues(bytes)
        return bytes
      }
      for (let index = 0; index < length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256)
      }
      return bytes
    },
  }
}

function hexToken(source: IdentityRandomSource): string {
  const bytes = source.nextBytes(OPAQUE_IDENTITY_TOKEN_BYTES)
  let token = ''
  for (let index = 0; index < bytes.length; index += 1) {
    token += bytes[index]!.toString(16).padStart(2, '0')
  }
  return token
}

/**
 * Create the opaque allocator. Prefixes (`fld_`/`fldloc_`/`dcol_`/`dcolloc_`)
 * are namespacing only — the random token is the identity; prefixes carry no
 * ordering or count information. Distinct prefixes also keep opaque ids out of
 * the legacy `field_N` / `col_N` / `field_<ts>_*` / `detailcol_<ts>_*` shapes,
 * so the two allocation lineages cannot alias each other.
 */
export function createOpaqueFormIdentityAllocator(
  source: IdentityRandomSource = defaultIdentityRandomSource(),
): OpaqueFormIdentityAllocator {
  return {
    nextFieldIdentity(fieldType: AuthorableFieldType): FormFieldIdentity {
      return {
        persistentId: `fld_${hexToken(source)}`,
        localId: `fldloc_${hexToken(source)}`,
        ...(fieldType === 'detail'
          ? {
              detailColumn: {
                persistentId: `dcol_${hexToken(source)}`,
                localId: `dcolloc_${hexToken(source)}`,
              },
            }
          : {}),
      }
    },
    nextDetailColumnIdentity(): FormDetailColumnIdentity {
      return {
        persistentId: `dcol_${hexToken(source)}`,
        localId: `dcolloc_${hexToken(source)}`,
      }
    },
  }
}
