import type { Kysely, Transaction } from 'kysely'
import { sql } from 'kysely'
import { checkColumnExists, checkTableExists } from './_patterns'

/**
 * F3 files-storage-integrity design-lock (2026-07-10), G3 + G5 (+ owner guards D/G): `storage_key`
 * column + fail-closed, ATOMIC backfill.
 *
 * G3 makes the `files` DB row authoritative for the id → physical-object mapping so a download/info
 * request never depends on the storage provider's in-memory disk-scan index (which drifts on restart:
 * upload emits a uuid id but a restart rebuilds the index under `md5(relpath)` — F3-2). `storage_key`
 * is the deterministic relative key (`<uuid>/<safe-basename>` for files written after F3) that
 * `LocalStorageProvider.downloadByKey` joins onto `basePath` to locate the object directly.
 *
 * G5 backfill (owner acceptance B — "旧证据不 404"): existing rows predate this column, so their
 * physical object is located via the `url` they already carry (`url = ${baseUrl}/${filePath}`, and that
 * `filePath` is exactly the relative key the old code wrote to and this migration recovers). The strip is
 * CONSERVATIVE — only rows whose `url` begins with the configured baseUrl prefix get a value; anything
 * else stays NULL so the files.ts runtime fallback (re-derives from `url` using the live provider baseUrl)
 * is the last-resort authority rather than a possibly-wrong backfilled value shadowing it. baseUrl is read
 * from the SAME `STORAGE_BASE_URL || <default>` files.ts's getStorageService uses.
 *
 * Owner guard G — ATOMICITY (unconditional, independent of the collision policy): the whole up() runs in
 * ONE transaction. The Kysely Migrator already wraps each migration's up() in a transaction for Postgres
 * (supportsTransactionalDdl === true), so we detect that (`db.isTransaction`) and DON'T double-nest; when
 * up() is invoked directly outside the Migrator (tests), we open the transaction ourselves. Either way
 * ANY unhandled failure — a DDL error, a DB error, a backfill exception, the abort throw below — rolls the
 * ADD COLUMN + backfill + UNIQUE index ALL back together. There is no half-migrated "column added, rows
 * partly backfilled, constraint missing" state (that would trade a data-integrity bug for a schema one).
 *
 * Owner guard D — COLLISION policy (single decision point, `COLLISION_POLICY`): the old code's same-name
 * overwrite (F3-1) means two active rows can derive the SAME physical key, and its missing containment
 * means a url can carry a `..` traversal segment. Either is a corrupted/ambiguous state we must NEVER
 * silently backfill (two rows sharing one blob = last-write-wins confidentiality leak; a traversal key
 * reads outside the root). Both `abort` and `poison` are fail-closed; they differ only in whether the
 * migration completes:
 *   - 'abort' (DEFAULT, per owner guard G): any unsafe row → throw with a conflict report → the whole
 *     transaction rolls back (nothing lands). A DB with legacy collisions/traversal fails closed and an
 *     operator must reconcile the listed rows before re-running (see PR body ops runbook). A clean DB
 *     (CI / fresh install / most prod) has no unsafe rows and applies fully.
 *   - 'poison': quarantine each unsafe row to a DISTINCT, non-resolvable `!f3-collision:<id>` key
 *     (fail-closed at read: no shared blob, no last-write-wins) and complete the migration — poison rows
 *     are a well-defined terminal state, so this still leaves NO half-migration.
 * Flipping the policy is this ONE constant + swapping the corresponding test assertions; nothing else in
 * the codebase branches on it.
 *
 * The partial UNIQUE index (`WHERE deleted_at IS NULL`) makes "no two SERVABLE rows share a physical key"
 * a database invariant going forward (tombstoned rows are never served, so they are exempt).
 *
 * Runs AFTER `zzzz20260710130000_add_files_deleted_at.ts`. Idempotent: guarded by checkTableExists/
 * checkColumnExists + `CREATE UNIQUE INDEX IF NOT EXISTS`; the backfill only touches `storage_key IS NULL`
 * rows, so re-runs and any DB where `files` has not been created yet are no-ops in both directions.
 */

const DEFAULT_STORAGE_BASE_URL = 'http://localhost:8900/files'
const STORAGE_KEY_UNIQUE_INDEX = 'idx_files_storage_key_active'

/**
 * Single decision point for how a legacy collision / unresolvable-url row is handled. Default 'poison'
 * (owner's ratified default). Flip to 'abort' HERE (and swap the matching test assertions) to fail closed
 * and roll the whole migration back instead of completing with quarantined rows. Nothing else in the
 * codebase reads this.
 */
const COLLISION_POLICY: 'abort' | 'poison' = 'poison'

/**
 * MUST equal `FILES_POISON_KEY_PREFIX` in `../../services/filesStorageKey.ts` — the download/info read
 * path rejects exactly this prefix BEFORE any url-fallback/provider call (owner guard D/G rule 2). A unit
 * test (`filesStorageKey.test.ts`) asserts the two literals are identical so they can never drift. Kept a
 * local literal (not an import) so this migration stays a self-contained historical snapshot.
 */
export const QUARANTINE_PREFIX = '!f3-collision:'

type UnsafeReason = 'collision' | 'unparseable-url' | 'traversal-url'

function resolveStorageBaseUrlPrefix(): string {
  return (process.env.STORAGE_BASE_URL || DEFAULT_STORAGE_BASE_URL).replace(/\/+$/, '')
}

type DerivedKeyRow = { id: string; derived_key: string }
type CollisionRow = { derived_key: string; ids: string[]; n: number | string }

async function applyBackfill(trx: Kysely<unknown>): Promise<void> {
  const prefix = resolveStorageBaseUrlPrefix()
  const prefixWithSep = `${prefix}/`
  const prefixLen = prefix.length

  const hasStorageKey = await checkColumnExists(trx, 'files', 'storage_key')
  if (!hasStorageKey) {
    await trx.schema
      .alterTable('files')
      .addColumn('storage_key', 'text', (col) => col.defaultTo(null))
      .execute()
  }

  // Rows this migration would backfill: active (servable), url starts with the configured baseUrl prefix,
  // no storage_key yet. `substr`/`left` (not LIKE) so a baseUrl with a LIKE wildcard can never mis-match.
  const eligible = sql`
    files
    WHERE deleted_at IS NULL
      AND url IS NOT NULL
      AND storage_key IS NULL
      AND left(url, ${prefixLen + 1}) = ${prefixWithSep}
  `

  // Unresolvable / traversal: derived key is empty (unparseable-url) or has a `..` PATH SEGMENT
  // (traversal-url — precise segment match, not a substring, so a legit filename like `a..b.txt` is not a
  // false positive). `derived_key` is returned so the reason can be classified for the audit list.
  const unresolvable = await sql<DerivedKeyRow>`
    SELECT id, substr(url, ${prefixLen + 2}) AS derived_key
    FROM ${eligible}
      AND (
        substr(url, ${prefixLen + 2}) = ''
        OR substr(url, ${prefixLen + 2}) = '..'
        OR substr(url, ${prefixLen + 2}) LIKE '../%'
        OR substr(url, ${prefixLen + 2}) LIKE '%/..'
        OR substr(url, ${prefixLen + 2}) LIKE '%/../%'
      )
  `.execute(trx)

  // Collision: two+ eligible rows derive the same physical key (same-name overwrite). GROUP BY the
  // ordinal (1 = derived_key) rather than repeating `substr(url, $N)` — kysely emits each `${...}` as a
  // distinct positional parameter, so a repeated `substr(url, ${...})` would be two different params and
  // Postgres would reject the GROUP BY as not matching the SELECT expression.
  const collisions = await sql<CollisionRow>`
    SELECT substr(url, ${prefixLen + 2}) AS derived_key,
           array_agg(id ORDER BY id) AS ids,
           count(*) AS n
    FROM ${eligible}
    GROUP BY 1
    HAVING count(*) > 1
  `.execute(trx)

  // Owner guard D/G rule 4 — auditable `{id, reason}` conflict list. reason ∈ unparseable-url (empty
  // derived key) / traversal-url (`..` segment) / collision (shared derived key). collision wins if a row
  // is both (the more actionable reason for an operator).
  const unsafe = new Map<string, UnsafeReason>()
  for (const r of unresolvable.rows) {
    unsafe.set(r.id, r.derived_key === '' ? 'unparseable-url' : 'traversal-url')
  }
  // Rule 1 — the WHOLE collision group is quarantined (every id in the group), NEVER keep-one-winner.
  for (const c of collisions.rows) {
    for (const id of c.ids || []) {
      unsafe.set(id, 'collision')
    }
  }

  if (unsafe.size > 0) {
    // ops-facing server log (migration console): one `{"id","reason"}` line per row so an operator can
    // reconcile (fix url / re-upload / tombstone). NOT an API/audit surface. urls/derived keys are kept
    // OUT of this list (they can carry user-ish filenames); the url stays on the row itself (rule 3) for
    // manual repair.
    for (const [id, reason] of unsafe) {
      // eslint-disable-next-line no-console
      console.error(`[F3 migration] storage_key quarantine: {"id":"${id}","reason":"${reason}"}`)
    }

    if (COLLISION_POLICY === 'abort') {
      // Fail-closed + atomic: the throw rolls the whole transaction back (nothing lands). Kept as the
      // flippable alternative to poison (one constant + swap tests) — NOT the ratified default.
      throw new Error(
        `F3 storage_key backfill aborted: ${unsafe.size} unsafe files row(s) — migration rolled back, nothing applied. Reconcile before re-deploying.`,
      )
    }

    // poison (owner's ratified default): quarantine each unsafe row to a DISTINCT, non-resolvable
    // `!f3-collision:<id>` key (rule 1: whole group, no winner). Only `storage_key` is written — `url` is
    // left intact (rule 3: audit + manual repair). Non-empty, so the runtime fallback never re-derives it;
    // the read path rejects the prefix before any fallback/provider call (rule 2). This is a migration
    // SUCCESS, not an abort — poison is a well-defined terminal state, so no half-migration exists.
    await sql`
      UPDATE files
      SET storage_key = ${QUARANTINE_PREFIX} || id
      WHERE id = ANY(${Array.from(unsafe.keys())}::text[])
        AND deleted_at IS NULL
        AND storage_key IS NULL
    `.execute(trx)
  }

  // Backfill the remaining safe eligible rows (poisoned rows are already non-null and skipped here).
  await sql`
    UPDATE files
    SET storage_key = substr(url, ${prefixLen + 2})
    WHERE deleted_at IS NULL
      AND url IS NOT NULL
      AND storage_key IS NULL
      AND left(url, ${prefixLen + 1}) = ${prefixWithSep}
  `.execute(trx)

  // "No two servable rows share a physical key" becomes a DB invariant.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(STORAGE_KEY_UNIQUE_INDEX)}
    ON files (storage_key)
    WHERE deleted_at IS NULL AND storage_key IS NOT NULL
  `.execute(trx)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const filesExists = await checkTableExists(db, 'files')
  if (!filesExists) return

  // Owner guard G: single transaction around the entire up(). The Kysely Migrator already wraps up() in a
  // transaction for Postgres, so avoid double-nesting when we're already inside one; wrap explicitly only
  // when called directly (tests / a non-transactional runner).
  if (db.isTransaction) {
    await applyBackfill(db)
  } else {
    await db.transaction().execute((trx: Transaction<unknown>) => applyBackfill(trx))
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const filesExists = await checkTableExists(db, 'files')
  if (!filesExists) return

  await sql`DROP INDEX IF EXISTS ${sql.raw(STORAGE_KEY_UNIQUE_INDEX)}`.execute(db)

  const hasStorageKey = await checkColumnExists(db, 'files', 'storage_key')
  if (hasStorageKey) {
    await db.schema.alterTable('files').dropColumn('storage_key').execute()
  }
}
