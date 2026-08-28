import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import * as cryptoRegistryMigration from '../../src/db/migrations/zzzz20260826124000_create_recovery_archive_crypto_registry'
import {
  RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  RECOVERY_ARCHIVE_AEAD_KEY_BYTES,
  RECOVERY_ARCHIVE_AEAD_NONCE_BYTES,
  RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN,
  toRecoveryArchiveNonceHex,
} from '../../src/multitable/recovery-archive-crypto'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import {
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropOutcome,
  type OwnedPoolTerminationHandler,
} from '../helpers/scratch-database'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D2h crypto-registry real-DB allowlist step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_crypto_registry_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 12)
const REGISTRY_TABLE = 'meta_recovery_archive_nonce_reservations'
const REGISTRY_INDEX = 'uq_meta_recovery_archive_nonce_reservation_generation_section'
const REGISTRY_FUNCTIONS = [
  'meta_recovery_archive_nonce_reservation_guard_row',
  'meta_recovery_archive_nonce_reservation_guard_truncate',
  'meta_recovery_archive_reserve_nonce',
] as const
const REGISTRY_TRIGGERS = [
  'trg_meta_recovery_archive_nonce_reservation_guard_row',
  'trg_meta_recovery_archive_nonce_reservation_guard_truncate',
] as const

type DatabaseError = Error & { code?: string; detail?: string; where?: string; hint?: string }

/**
 * Every D2h registry proof runs on its OWN ephemeral database.
 *
 * The registry is deliberately immutable (no UPDATE, no DELETE, no TRUNCATE), so a shared database
 * cannot be cleaned between runs, and `down()` refuses while rows exist. An ephemeral database
 * makes both the lifecycle and the drift arms deterministic instead of dependent on what the
 * shared CI database happens to already contain.
 */
type Scratch = {
  pool: Pool
  db: Kysely<unknown>
  name: string
  terminationHandler: OwnedPoolTerminationHandler
}

let adminPool: Pool
const scratches: Scratch[] = []

function databaseUrlFor(databaseName: string): string {
  const url = new URL(String(process.env.DATABASE_URL))
  url.pathname = `/${databaseName}`
  return url.toString()
}

async function createScratch(label: string): Promise<Scratch> {
  const name = `tm_d2h_${RUN}_${label}`
  await adminPool.query(`CREATE DATABASE "${name}"`)
  const pool = new Pool({ connectionString: databaseUrlFor(name), max: 4 })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const scratch = {
    pool,
    db,
    name,
    terminationHandler: attachOwnedPoolTerminationHandler(pool),
  }
  scratches.push(scratch)
  return scratch
}

async function dropScratch(scratch: Scratch): Promise<void> {
  try {
    await scratch.db.destroy().catch(() => {})
    const outcome = await dropScratchDatabase(adminPool, scratch.name)
    console.log(formatScratchDropOutcome('recovery-archive-crypto-registry', outcome))
  } finally {
    scratch.terminationHandler.detach()
  }
}

async function errorOf(promise: Promise<unknown>): Promise<DatabaseError> {
  try {
    await promise
  } catch (error) {
    return error as DatabaseError
  }
  throw new Error('expected_database_rejection')
}

function renderError(error: DatabaseError): string {
  return [error.message, error.detail, error.where, error.hint].filter(Boolean).join(' ')
}

function expectValuesFree(error: DatabaseError, forbiddenValues: readonly string[]): void {
  const rendered = renderError(error)
  for (const value of forbiddenValues) expect(rendered).not.toContain(value)
}

/**
 * Contract-conforming DEK identity: a domain-separated PRF over the ACTUAL UNWRAPPED DEK, exactly
 * as D-F requires. Two different DEKs therefore give two different registry identities.
 */
function fingerprintOfDek(dek: Buffer): string {
  return createHmac('sha256', dek).update(RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN).digest('hex')
}

function freshFingerprint(): string {
  return fingerprintOfDek(randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES))
}

function freshNonceHex(): string {
  return toRecoveryArchiveNonceHex(randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES))
}

type ReservationInput = {
  dekFingerprint: string
  nonceHex: string
  generationId: string
  sectionName: string
  aeadAlgorithm: string
  formatVersion: number
}

function reservationInput(overrides: Partial<ReservationInput> = {}): ReservationInput {
  return {
    dekFingerprint: freshFingerprint(),
    nonceHex: freshNonceHex(),
    generationId: randomUUID(),
    sectionName: 'records',
    aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
    formatVersion: 1,
    ...overrides,
  }
}

function reserve(scratch: Scratch, input: ReservationInput): Promise<unknown> {
  return scratch.pool.query(
    'SELECT meta_recovery_archive_reserve_nonce($1, $2, $3::uuid, $4, $5, $6::integer)',
    [
      input.dekFingerprint,
      input.nonceHex,
      input.generationId,
      input.sectionName,
      input.aeadAlgorithm,
      input.formatVersion,
    ],
  )
}

function bareInsert(scratch: Scratch, input: ReservationInput): Promise<unknown> {
  return scratch.pool.query(
    `INSERT INTO ${REGISTRY_TABLE} (
       dek_fingerprint, nonce, generation_id, section_name, aead_algorithm, format_version
     ) VALUES ($1, $2, $3::uuid, $4, $5, $6::integer)`,
    [
      input.dekFingerprint,
      input.nonceHex,
      input.generationId,
      input.sectionName,
      input.aeadAlgorithm,
      input.formatVersion,
    ],
  )
}

/**
 * Harness-only escape hatch. Ordinary DELETE is refused by the immutability trigger, so clearing
 * the registry requires disabling that trigger as the table owner. Using it here is itself part of
 * the evidence: nothing short of a schema-owner trigger disable can empty this table.
 */
async function forceClearRegistry(scratch: Scratch): Promise<void> {
  await scratch.pool.query(`ALTER TABLE ${REGISTRY_TABLE} DISABLE TRIGGER USER`)
  await scratch.pool.query(`DELETE FROM ${REGISTRY_TABLE}`)
  await scratch.pool.query(`ALTER TABLE ${REGISTRY_TABLE} ENABLE TRIGGER USER`)
}

async function registrySurface(scratch: Scratch): Promise<{
  tables: string[]
  indexes: string[]
  functions: string[]
  triggers: string[]
}> {
  const [tables, indexes, functions, triggers] = await Promise.all([
    scratch.pool.query(
      `SELECT relname AS name FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relkind = 'r' AND relname = $1`,
      [REGISTRY_TABLE],
    ),
    scratch.pool.query(
      `SELECT indexname AS name FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = $1`,
      [REGISTRY_INDEX],
    ),
    scratch.pool.query(
      `SELECT proname AS name FROM pg_proc procedure_row
         JOIN pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
        WHERE namespace.nspname = 'public' AND proname = ANY($1::text[]) ORDER BY proname`,
      [REGISTRY_FUNCTIONS],
    ),
    scratch.pool.query(
      `SELECT tgname AS name FROM pg_trigger trigger_row
         JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND NOT trigger_row.tgisinternal
          AND tgname = ANY($1::text[]) ORDER BY tgname`,
      [REGISTRY_TRIGGERS],
    ),
  ])
  return {
    tables: tables.rows.map((row) => String(row.name)),
    indexes: indexes.rows.map((row) => String(row.name)),
    functions: functions.rows.map((row) => String(row.name)),
    triggers: triggers.rows.map((row) => String(row.name)),
  }
}

/**
 * Structural fingerprint of the owned objects, including collation. A replayed `up()` must
 * reproduce it byte for byte, and dropping `COLLATE "C"` changes it.
 */
async function registryFingerprint(scratch: Scratch): Promise<string> {
  const result = await scratch.pool.query(
    `SELECT kind, object_name, member_name, definition FROM (
       SELECT 'column'::text AS kind,
              table_name::text AS object_name,
              column_name::text AS member_name,
              concat_ws('|', data_type, udt_name, is_nullable,
                        coalesce(column_default, ''), coalesce(collation_name, ''))::text
                AS definition
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
       UNION ALL
       SELECT 'constraint'::text, relation.relname::text, constraint_row.conname::text,
              pg_get_constraintdef(constraint_row.oid, true)::text
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = $1
       UNION ALL
       SELECT 'index'::text, tablename::text, indexname::text, indexdef::text
         FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1
       UNION ALL
       SELECT 'trigger'::text, relation.relname::text, trigger_row.tgname::text,
              pg_get_triggerdef(trigger_row.oid, true)::text
         FROM pg_trigger trigger_row
         JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND NOT trigger_row.tgisinternal
          AND relation.relname = $1
       UNION ALL
       SELECT 'function'::text, procedure_row.proname::text,
              pg_get_function_identity_arguments(procedure_row.oid)::text,
              concat_ws('|', coalesce(array_to_string(procedure_row.proconfig, ','), ''),
                        pg_get_functiondef(procedure_row.oid))::text
         FROM pg_proc procedure_row
         JOIN pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
        WHERE namespace.nspname = 'public' AND procedure_row.proname = ANY($2::text[])
     ) catalog ORDER BY kind, object_name, member_name, definition`,
    [REGISTRY_TABLE, REGISTRY_FUNCTIONS],
  )
  return createHash('sha256').update(JSON.stringify(result.rows)).digest('hex')
}

describeIfRealDbStep('Phase D2h recovery-archive crypto registry (real DB)', () => {
  let main: Scratch

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    main = await createScratch('main')
    await cryptoRegistryMigration.up(main.db)
  }, 120000)

  afterAll(async () => {
    for (const scratch of scratches) await dropScratch(scratch)
    await adminPool?.end().catch(() => {})
  }, 120000)

  describe('installed surface', () => {
    test('creates exactly the owned table, index, functions, and triggers', async () => {
      const surface = await registrySurface(main)
      expect(surface.tables).toEqual([REGISTRY_TABLE])
      expect(surface.indexes).toEqual([REGISTRY_INDEX])
      expect(surface.functions).toEqual([...REGISTRY_FUNCTIONS].sort())
      expect(surface.triggers).toEqual([...REGISTRY_TRIGGERS].sort())
    })

    test('the generation+section uniqueness constraint owns its index', async () => {
      const result = await main.pool.query(
        `SELECT constraint_row.conname AS name,
                pg_get_constraintdef(constraint_row.oid, true) AS definition
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid = constraint_row.conrelid
          WHERE relation.relname = $1 AND constraint_row.contype = 'u'`,
        [REGISTRY_TABLE],
      )
      expect(result.rows).toEqual([
        {
          name: 'uq_meta_recovery_archive_nonce_reservation_generation_section',
          definition: 'UNIQUE (generation_id, section_name)',
        },
      ])
    })

    test('the primary key is the exact (dek_fingerprint, nonce) pair', async () => {
      const result = await main.pool.query(
        `SELECT pg_get_constraintdef(constraint_row.oid, true) AS definition
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid = constraint_row.conrelid
          WHERE relation.relname = $1 AND constraint_row.contype = 'p'`,
        [REGISTRY_TABLE],
      )
      expect(result.rows).toHaveLength(1)
      expect(String(result.rows[0].definition)).toBe('PRIMARY KEY (dek_fingerprint, nonce)')
    })

    test('identity columns are byte-exact C collation, so one nonce has one spelling', async () => {
      const result = await main.pool.query(
        `SELECT column_name, collation_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
            AND column_name IN ('dek_fingerprint', 'nonce')
          ORDER BY column_name`,
        [REGISTRY_TABLE],
      )
      expect(result.rows).toEqual([
        { column_name: 'dek_fingerprint', collation_name: 'C' },
        { column_name: 'nonce', collation_name: 'C' },
      ])
    })

    test('NO CASCADE: the registry has zero foreign keys, in or out', async () => {
      const outbound = await main.pool.query(
        `SELECT constraint_row.conname FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid = constraint_row.conrelid
          WHERE relation.relname = $1 AND constraint_row.contype = 'f'`,
        [REGISTRY_TABLE],
      )
      const inbound = await main.pool.query(
        `SELECT constraint_row.conname FROM pg_constraint constraint_row
           JOIN pg_class referenced ON referenced.oid = constraint_row.confrelid
          WHERE referenced.relname = $1 AND constraint_row.contype = 'f'`,
        [REGISTRY_TABLE],
      )
      expect(outbound.rows).toEqual([])
      expect(inbound.rows).toEqual([])
    })

    test('a reservation is admitted for a generation that has no catalog row at all', async () => {
      // Behavioural companion to the zero-FK check: admission never consults a parent, so no
      // generation, staging-object, or archive-object deletion can take this reservation with it.
      const input = reservationInput()
      await expect(reserve(main, input)).resolves.toBeTruthy()
      const stored = await main.pool.query(
        `SELECT generation_id, section_name FROM ${REGISTRY_TABLE}
          WHERE dek_fingerprint = $1 AND nonce = $2`,
        [input.dekFingerprint, input.nonceHex],
      )
      expect(stored.rows).toEqual([
        { generation_id: input.generationId, section_name: 'records' },
      ])
    })
  })

  describe('uniqueness semantics', () => {
    test('the same nonce under the SAME fingerprint refuses, values free', async () => {
      const first = reservationInput()
      await reserve(main, first)

      const error = await errorOf(
        reserve(main, {
          ...first,
          generationId: randomUUID(),
          sectionName: 'links',
        }),
      )
      expect(error.message).toBe('recovery_archive_nonce_reservation_conflict')
      expectValuesFree(error, [first.dekFingerprint, first.nonceHex, first.generationId])

      // Exactly one row survives: the refused attempt wrote nothing.
      const stored = await main.pool.query(
        `SELECT count(*)::int AS count FROM ${REGISTRY_TABLE}
          WHERE dek_fingerprint = $1 AND nonce = $2`,
        [first.dekFingerprint, first.nonceHex],
      )
      expect(stored.rows[0].count).toBe(1)
    })

    test('the same nonce under a DEMONSTRABLY DIFFERENT fingerprint is admitted', async () => {
      const dekA = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES)
      const dekB = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES)
      const fingerprintA = fingerprintOfDek(dekA)
      const fingerprintB = fingerprintOfDek(dekB)
      expect(fingerprintA).not.toBe(fingerprintB)

      const nonceHex = freshNonceHex()
      await expect(
        reserve(main, reservationInput({ dekFingerprint: fingerprintA, nonceHex })),
      ).resolves.toBeTruthy()
      await expect(
        reserve(main, reservationInput({ dekFingerprint: fingerprintB, nonceHex })),
      ).resolves.toBeTruthy()

      const stored = await main.pool.query(
        `SELECT count(*)::int AS count FROM ${REGISTRY_TABLE} WHERE nonce = $1`,
        [nonceHex],
      )
      expect(stored.rows[0].count).toBe(2)
    })

    test('a bare duplicate INSERT is still refused (the PK is the race backstop)', async () => {
      const input = reservationInput()
      await reserve(main, input)
      const error = await errorOf(bareInsert(main, { ...input, sectionName: 'schema' }))
      expect(error.code).toBe('23505')
    })

    test('a non-canonical spelling of one nonce is refused, never stored as a second row', async () => {
      const input = reservationInput()
      await reserve(main, input)

      for (const spelling of [
        input.nonceHex.toUpperCase(),
        `${input.nonceHex}00`,
        input.nonceHex.slice(0, -1),
        ` ${input.nonceHex}`,
      ]) {
        const error = await errorOf(
          reserve(main, { ...input, nonceHex: spelling, generationId: randomUUID() }),
        )
        expect(error.message).toBe('recovery_archive_nonce_reservation_shape_invalid')
        expectValuesFree(error, [input.dekFingerprint, input.nonceHex, spelling])
      }

      const stored = await main.pool.query(
        `SELECT count(*)::int AS count FROM ${REGISTRY_TABLE} WHERE dek_fingerprint = $1`,
        [input.dekFingerprint],
      )
      expect(stored.rows[0].count).toBe(1)
    })

    test('a non-canonical fingerprint spelling is refused', async () => {
      for (const spelling of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)} `]) {
        const error = await errorOf(reserve(main, reservationInput({ dekFingerprint: spelling })))
        expect(error.message).toBe('recovery_archive_nonce_reservation_shape_invalid')
        expectValuesFree(error, [spelling])
      }
    })

    test('one generation reserves each section exactly once, values free', async () => {
      const first = reservationInput({ sectionName: 'records' })
      await reserve(main, first)

      // A retry that minted a FRESH nonce would otherwise be admitted: the (fingerprint, nonce)
      // pair is genuinely new, so only the generation+section arbiter can refuse it.
      const retry = reservationInput({
        generationId: first.generationId,
        sectionName: 'records',
        dekFingerprint: freshFingerprint(),
        nonceHex: freshNonceHex(),
      })
      const error = await errorOf(reserve(main, retry))
      expect(error.message).toBe('recovery_archive_nonce_reservation_conflict')
      expectValuesFree(error, [
        first.generationId,
        first.dekFingerprint,
        first.nonceHex,
        retry.dekFingerprint,
        retry.nonceHex,
        'records',
      ])

      const stored = await main.pool.query(
        `SELECT count(*)::int AS count FROM ${REGISTRY_TABLE} WHERE generation_id = $1::uuid`,
        [first.generationId],
      )
      expect(stored.rows[0].count).toBe(1)
    })

    test('the SAME generation may reserve a DIFFERENT section', async () => {
      const generationId = randomUUID()
      for (const sectionName of RECOVERY_ARCHIVE_V1_SECTION_NAMES) {
        await expect(
          reserve(main, reservationInput({ generationId, sectionName })),
        ).resolves.toBeTruthy()
      }
      const stored = await main.pool.query(
        `SELECT count(*)::int AS count FROM ${REGISTRY_TABLE} WHERE generation_id = $1::uuid`,
        [generationId],
      )
      // A complete format-v1 snapshot is exactly ten reservations under one generation.
      expect(stored.rows[0].count).toBe(RECOVERY_ARCHIVE_V1_SECTION_NAMES.length)
    })

    test('the BARE conflict clause absorbs BOTH arbiters, not just the primary key', async () => {
      // The distinguishing case for a bare `ON CONFLICT DO NOTHING`: a targeted
      // `ON CONFLICT (dek_fingerprint, nonce)` clause absorbs only the primary key, so this
      // generation+section duplicate would escape as a raw 23505 whose DETAIL prints the
      // generation and the section name.
      const seed = reservationInput({ sectionName: 'links' })
      await reserve(main, seed)
      const collision = reservationInput({
        generationId: seed.generationId,
        sectionName: 'links',
        dekFingerprint: freshFingerprint(),
        nonceHex: freshNonceHex(),
      })

      const error = await errorOf(reserve(main, collision))
      expect(error.code).not.toBe('23505')
      expect(error.message).toBe('recovery_archive_nonce_reservation_conflict')
      expect(renderError(error)).not.toMatch(/Key \(/)
      expectValuesFree(error, [seed.generationId, 'links'])

      // A bare duplicate INSERT on the same arbiter still refuses; it is simply not values free,
      // which is exactly why the primitive exists.
      const bare = await errorOf(bareInsert(main, collision))
      expect(bare.code).toBe('23505')
    })

    test('the DB closed sets match the TypeScript contract exactly', async () => {
      for (const sectionName of RECOVERY_ARCHIVE_V1_SECTION_NAMES) {
        await expect(
          reserve(main, reservationInput({ sectionName, generationId: randomUUID() })),
        ).resolves.toBeTruthy()
      }
      for (const [overrides, label] of [
        [{ sectionName: 'not_a_section' }, 'section'],
        [{ aeadAlgorithm: 'aes-256-cbc' }, 'algorithm'],
        [{ aeadAlgorithm: 'chacha20-poly1305' }, 'algorithm'],
        [{ formatVersion: 2 }, 'format_version'],
      ] as const) {
        const error = await errorOf(reserve(main, reservationInput(overrides)))
        expect(error.message, label).toBe('recovery_archive_nonce_reservation_shape_invalid')
      }
    })
  })

  describe('immutability', () => {
    test('UPDATE, DELETE, and TRUNCATE all refuse, values free', async () => {
      const input = reservationInput()
      await reserve(main, input)

      const update = await errorOf(
        main.pool.query(
          `UPDATE ${REGISTRY_TABLE} SET section_name = 'links'
            WHERE dek_fingerprint = $1 AND nonce = $2`,
          [input.dekFingerprint, input.nonceHex],
        ),
      )
      expect(update.message).toBe('recovery_archive_nonce_reservation_immutable')
      expectValuesFree(update, [input.dekFingerprint, input.nonceHex])

      const remove = await errorOf(
        main.pool.query(
          `DELETE FROM ${REGISTRY_TABLE} WHERE dek_fingerprint = $1 AND nonce = $2`,
          [input.dekFingerprint, input.nonceHex],
        ),
      )
      expect(remove.message).toBe('recovery_archive_nonce_reservation_immutable')

      const truncate = await errorOf(main.pool.query(`TRUNCATE TABLE ${REGISTRY_TABLE}`))
      expect(truncate.message).toBe('recovery_archive_nonce_reservation_immutable')

      const stored = await main.pool.query(
        `SELECT section_name FROM ${REGISTRY_TABLE}
          WHERE dek_fingerprint = $1 AND nonce = $2`,
        [input.dekFingerprint, input.nonceHex],
      )
      expect(stored.rows).toEqual([{ section_name: 'records' }])
    })
  })

  describe('migration lifecycle', () => {
    test('up() refuses a second install rather than partially reinstalling', async () => {
      await expect(cryptoRegistryMigration.up(main.db)).rejects.toThrow(
        /recovery_archive_crypto_registry_object_conflict/,
      )
      // The refusal is inert: the installed surface is untouched.
      const surface = await registrySurface(main)
      expect(surface.tables).toEqual([REGISTRY_TABLE])
    })

    test('down() refuses while reservations exist and changes nothing', async () => {
      const before = await main.pool.query(`SELECT count(*)::int AS count FROM ${REGISTRY_TABLE}`)
      expect(before.rows[0].count).toBeGreaterThan(0)

      await expect(cryptoRegistryMigration.down(main.db)).rejects.toThrow(
        /recovery_archive_crypto_registry_nonempty/,
      )

      const after = await main.pool.query(`SELECT count(*)::int AS count FROM ${REGISTRY_TABLE}`)
      expect(after.rows[0].count).toBe(before.rows[0].count)
      const surface = await registrySurface(main)
      expect(surface.tables).toEqual([REGISTRY_TABLE])
      expect(surface.functions).toEqual([...REGISTRY_FUNCTIONS].sort())
    })

    test('up -> down -> up replays to a byte-identical structural fingerprint', async () => {
      const lifecycle = await createScratch('lifecycle')
      await cryptoRegistryMigration.up(lifecycle.db)
      const firstFingerprint = await registryFingerprint(lifecycle)

      await cryptoRegistryMigration.down(lifecycle.db)
      const afterDown = await registrySurface(lifecycle)
      expect(afterDown.tables).toEqual([])
      expect(afterDown.indexes).toEqual([])
      expect(afterDown.functions).toEqual([])
      expect(afterDown.triggers).toEqual([])

      await cryptoRegistryMigration.up(lifecycle.db)
      expect(await registryFingerprint(lifecycle)).toBe(firstFingerprint)

      // The replayed registry is functional, not just structurally identical.
      const input = reservationInput()
      await expect(reserve(lifecycle, input)).resolves.toBeTruthy()
      const conflict = await errorOf(reserve(lifecycle, input))
      expect(conflict.message).toBe('recovery_archive_nonce_reservation_conflict')

      await forceClearRegistry(lifecycle)
      await expect(cryptoRegistryMigration.down(lifecycle.db)).resolves.toBeUndefined()
    })
  })

  describe('fail-loud drift detection', () => {
    test('a type-incompatible preexisting archive catalog refuses before anything is created', async () => {
      const drift = await createScratch('drift')
      await drift.pool.query('CREATE TABLE public.meta_recovery_archives (generation_id text)')

      await expect(cryptoRegistryMigration.up(drift.db)).rejects.toThrow(
        /recovery_archive_crypto_registry_source_schema_mismatch/,
      )
      expect((await registrySurface(drift)).tables).toEqual([])

      // Positive control: the SAME migration installs once the catalog binding is compatible, so
      // the refusal above is the type check firing and not the migration being broken.
      await drift.pool.query('DROP TABLE public.meta_recovery_archives')
      await drift.pool.query('CREATE TABLE public.meta_recovery_archives (generation_id uuid)')
      await expect(cryptoRegistryMigration.up(drift.db)).resolves.toBeUndefined()
      expect((await registrySurface(drift)).tables).toEqual([REGISTRY_TABLE])
    })

    test('an absent archive catalog is not drift: the registry installs standalone', async () => {
      const standalone = await createScratch('standalone')
      const catalogAbsent = await standalone.pool.query(
        `SELECT to_regclass('public.meta_recovery_archives') IS NULL AS absent`,
      )
      expect(catalogAbsent.rows[0].absent).toBe(true)

      await expect(cryptoRegistryMigration.up(standalone.db)).resolves.toBeUndefined()
      await expect(reserve(standalone, reservationInput())).resolves.toBeTruthy()
    })

    test('a same-name squatter object refuses the install', async () => {
      const squatter = await createScratch('squatter')
      await squatter.pool.query(`CREATE TABLE public.${REGISTRY_TABLE} (unrelated text)`)

      await expect(cryptoRegistryMigration.up(squatter.db)).rejects.toThrow(
        /recovery_archive_crypto_registry_object_conflict/,
      )
      const columns = await squatter.pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [REGISTRY_TABLE],
      )
      expect(columns.rows).toEqual([{ column_name: 'unrelated' }])
    })
  })
})
