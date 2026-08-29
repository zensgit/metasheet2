import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import type { RecoveryArchiveManifest } from '../../src/multitable/recovery-archive-manifest'
import type { RecoveryArchiveOpenedSnapshot } from '../../src/multitable/recovery-archive-reader'
import {
  RecoveryArchiveReconstructorError,
  reconstructRecoveryArchiveCompleteSectionsInternal,
} from '../../src/multitable/recovery-archive-reconstructor'

const runRealDb =
  Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D4 real-DB allowlist step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_reconstruction_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d4_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const BASE = `${PREFIX}_base`
const SHEET = `${PREFIX}_sheet`
const FIELD = `${PREFIX}_field`
const CHECKPOINT_A = `${PREFIX}_ckpt_a`
const CHECKPOINT_B = `${PREFIX}_ckpt_b`
const ACTOR = `${PREFIX}_actor`
const ANCHOR_SEQ = '9007199254740993'
const FLOOR_SEQ = '10'
const PRE_FLOOR_SEQ = '5'
const HOT_SEQ = ANCHOR_SEQ
const NOTE = FIELD

const R_FLOOR = `${PREFIX}_rec_floor`
const R_PRUNED = `${PREFIX}_rec_pruned`
const R_HOT = `${PREFIX}_rec_hot`
const R_GEN = `${PREFIX}_rec_gen`
const R_MARKER = `${PREFIX}_rec_marker`

let pool: Pool
const q = (text: string, values?: unknown[]) => pool.query(text, values)

function recordRow(input: {
  record_id: string
  exists: boolean
  version: number | null
  data: Record<string, unknown> | null
}) {
  return {
    entity_key: `record/${input.record_id}`,
    payload: {
      record_id: input.record_id,
      exists: input.exists,
      version: input.version,
      data: input.data,
    },
  }
}

function openedArchive(records: ReturnType<typeof recordRow>[], checkpointId = CHECKPOINT_A): RecoveryArchiveOpenedSnapshot {
  const sections = Object.create(null) as RecoveryArchiveOpenedSnapshot['sections']
  const writable = sections as Record<string, unknown>
  for (const name of RECOVERY_ARCHIVE_V1_SECTION_NAMES) writable[name] = []
  writable.records = records
  const manifest = {
    format_version: 1,
    archive_generation_id: randomUUID(),
    workspace_id: WORKSPACE,
    base_id: BASE,
    sheet_id: SHEET,
    anchor_operation_id: randomUUID(),
    anchor_seq: ANCHOR_SEQ,
    checkpoint_id: checkpointId,
    created_at: '2026-08-28T00:00:00.000Z',
    expires_at: null,
    source_vector_hash: 'b'.repeat(64),
    sections: RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name) => ({
      name,
      row_count: name === 'records' ? String(records.length) : '0',
      plaintext_sha256: 'a'.repeat(64),
      aead_algorithm: 'aes-256-gcm',
      key_id: 'key',
      wrapped_dek_id: 'wrap',
      dek_fingerprint: 'c'.repeat(64),
      nonce: '11'.repeat(12),
    })),
    root_hash: 'd'.repeat(64),
    manifest_mac: '00aa',
  } as RecoveryArchiveManifest
  return { manifest, sections }
}

async function insertRevision(
  recordId: string,
  version: number,
  action: 'create' | 'update' | 'delete',
  snap: Record<string, unknown> | null,
  seq: string,
): Promise<void> {
  await q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[]::text[],'{}'::jsonb,$5::jsonb,$6::bigint)`,
    [SHEET, recordId, version, action, snap === null ? null : JSON.stringify(snap), seq],
  )
}

async function wipeHistory(): Promise<void> {
  await q('DELETE FROM meta_record_version_markers WHERE sheet_id = $1', [SHEET]).catch(() => {})
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
  await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SHEET]).catch(() => {})
  await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SHEET]).catch(() => {})
}

describeIfRealDbStep('Phase D4 recovery-archive reconstruction (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name, workspace_id) VALUES ($1,$2,$3)', [BASE, `${PREFIX} Base`, WORKSPACE])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, `${PREFIX} Sheet`])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FIELD, SHEET, 'Note', 'string', '{}', 1],
    )
  })

  afterEach(async () => {
    await wipeHistory()
  })

  afterAll(async () => {
    await wipeHistory()
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
    await pool.end()
  })

  test('the exact real-DB allowlist marker and database are active', () => {
    expect(process.env.METASHEET_REAL_DB_TEST_STEP).toBe('1')
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('pre-floor revision cannot shadow checkpoint/archive; pruned hot record is archive-filled; bigint stays exact', async () => {
    expect(Number(ANCHOR_SEQ) === Number('9007199254740992')).toBe(true)

    await q(
      `INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
       VALUES ($1,$2,'active',$3::bigint)`,
      [CHECKPOINT_A, SHEET, FLOOR_SEQ],
    )
    await insertRevision(R_FLOOR, 1, 'create', { [NOTE]: 'stale-pre-floor' }, PRE_FLOOR_SEQ)
    await q(
      `INSERT INTO meta_history_baselines (checkpoint_id, sheet_id, record_id, data, version, is_trashed)
       VALUES ($1,$2,$3,$4::jsonb,7,false)`,
      [CHECKPOINT_A, SHEET, R_FLOOR, JSON.stringify({ [NOTE]: 'checkpoint-trusted' })],
    )
    await insertRevision(R_HOT, 1, 'create', { [NOTE]: 'lo' }, '9007199254740992')
    await insertRevision(R_HOT, 2, 'update', { [NOTE]: 'hi' }, HOT_SEQ)
    await insertRevision(R_GEN, 1, 'create', { [NOTE]: 'g1' }, '11')
    await insertRevision(R_GEN, 1, 'delete', { [NOTE]: 'g1' }, '12')
    await insertRevision(R_GEN, 1, 'create', { [NOTE]: 'g2' }, '13')
    await q(
      `INSERT INTO meta_history_baselines (checkpoint_id, sheet_id, record_id, data, version, is_trashed)
       VALUES ($1,$2,$3,$4::jsonb,7,false)`,
      [CHECKPOINT_A, SHEET, R_MARKER, JSON.stringify({ [NOTE]: 'marker-baseline' })],
    )
    await q(
      `INSERT INTO meta_record_version_markers (id, sheet_id, record_id, version, kind, seq)
       VALUES (gen_random_uuid(),$1,$2,8,'unlock',20::bigint)`,
      [SHEET, R_MARKER],
    )

    const archive = openedArchive([
      recordRow({
        record_id: R_FLOOR,
        exists: true,
        version: 7,
        data: { [NOTE]: 'checkpoint-trusted' },
      }),
      recordRow({
        record_id: R_PRUNED,
        exists: true,
        version: 1,
        data: { [NOTE]: 'archive-fill' },
      }),
      recordRow({
        record_id: R_HOT,
        exists: true,
        version: 2,
        data: { [NOTE]: 'hi' },
      }),
      recordRow({
        record_id: R_GEN,
        exists: true,
        version: 1,
        data: { [NOTE]: 'g2' },
      }),
      recordRow({
        record_id: R_MARKER,
        exists: true,
        version: 8,
        data: { [NOTE]: 'marker-baseline' },
      }),
    ])

    const result = await reconstructRecoveryArchiveCompleteSectionsInternal({
      query: (text, values) => q(text, values),
      openedArchive: archive,
    })

    expect(result.records.get(R_FLOOR)).toEqual({
      recordId: R_FLOOR,
      exists: true,
      data: { [NOTE]: 'checkpoint-trusted' },
      version: 7,
    })
    expect(result.records.get(R_FLOOR)?.data).not.toEqual({ [NOTE]: 'stale-pre-floor' })
    expect(result.records.get(R_PRUNED)).toEqual({
      recordId: R_PRUNED,
      exists: true,
      data: { [NOTE]: 'archive-fill' },
      version: 1,
    })
    expect(result.records.get(R_HOT)).toEqual({
      recordId: R_HOT,
      exists: true,
      data: { [NOTE]: 'hi' },
      version: 2,
    })
    expect(result.records.get(R_HOT)?.data).not.toEqual({ [NOTE]: 'lo' })
    expect(result.records.get(R_GEN)).toEqual({
      recordId: R_GEN,
      exists: true,
      data: { [NOTE]: 'g2' },
      version: 1,
    })
    expect(result.records.get(R_MARKER)).toEqual({
      recordId: R_MARKER,
      exists: true,
      data: { [NOTE]: 'marker-baseline' },
      version: 8,
    })
    expect(archive.manifest.anchor_seq).toBe(ANCHOR_SEQ)
  })

  test('reselected checkpoint mismatch fails closed', async () => {
    await q(
      `INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
       VALUES ($1,$2,'superseded',$3::bigint), ($4,$5,'active',$6::bigint)`,
      [CHECKPOINT_A, SHEET, FLOOR_SEQ, CHECKPOINT_B, SHEET, '20'],
    )
    try {
      await reconstructRecoveryArchiveCompleteSectionsInternal({
        query: (text, values) => q(text, values),
        openedArchive: openedArchive([], CHECKPOINT_A),
      })
      throw new Error('expected-refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryArchiveReconstructorError)
      expect(error).toMatchObject({
        code: 'RECOVERY_ARCHIVE_RECONSTRUCTOR_CHECKPOINT_MISMATCH',
        message: 'RECOVERY_ARCHIVE_RECONSTRUCTOR_CHECKPOINT_MISMATCH',
      })
    }
  })
})
