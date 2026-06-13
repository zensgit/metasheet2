/**
 * ②a wall — §2a.4-b dangling / cross-base link ops sweep (real DB).
 *
 * A read-only ops sweep (`scripts/ops/multitable-dangling-link-sweep.mjs`, mirrors the
 * `check-yjs-retention-health.mjs` psql model) enumerates two governance hazards that the write-path
 * wall cannot retroactively fix on already-stored rows:
 *
 *   (i)  cross-base link FIELDS — a `meta_fields` row of type 'link' whose foreignSheetId's sheet
 *        `base_id` differs (null-aware, IS DISTINCT FROM) from the link field's own sheet `base_id`.
 *        Covers the parseLinkFieldConfig aliases (foreignDatasheetId / foreignSheetId / datasheetId)
 *        in the SAME precedence as the wall.
 *   (ii) dangling meta_links — `meta_links.foreign_record_id` with no matching `meta_records` row
 *        (foreign_record_id has NO FK, so a deleted foreign record leaves a dangling edge).
 *
 * VALUES-FREE (ids/counts only, no cell data) and READ-ONLY (no writes). This test seeds a small fixture
 * via the pool, runs the actual script via execFile (real psql path), and asserts the enumerated ids/
 * counts. Real DB (describeIfDatabase).
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(HERE, '../../../../scripts/ops/multitable-dangling-link-sweep.mjs')

const TS = Date.now()
const BASE_A = `base_sweep_a_${TS}`
const BASE_B = `base_sweep_b_${TS}`
const SHEET_A = `sheet_sweep_a_${TS}` // BASE_A
const SHEET_B = `sheet_sweep_b_${TS}` // BASE_B

const FLD_CROSS = `fld_sweep_cross_${TS}` // link A→B (cross-base)
const FLD_CROSS_ALIAS = `fld_sweep_cross_alias_${TS}` // link A→B via datasheetId alias (cross-base)
const FLD_SAME = `fld_sweep_same_${TS}` // link A→A (same-base, must NOT be flagged)
const FLD_NONLINK = `fld_sweep_nonlink_${TS}` // string field with a stashed foreignSheetId (must NOT be flagged)
const FLD_LINK_FOR_DANGLE = `fld_sweep_dangle_${TS}` // a same-base link, owns a dangling meta_link

const REC_A = `rec_sweep_a_${TS}`
const REC_GOOD = `rec_sweep_good_${TS}`
const LINK_DANGLE = `link_sweep_dangle_${TS}`
const LINK_GOOD = `link_sweep_good_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

describeIfDatabase('②a wall — dangling / cross-base link sweep (§2a.4-b, real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'Sweep Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'Sweep Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Sweep A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_B, BASE_B, 'Sweep B'])

    // (i) cross-base link fields (must be flagged): A→B under foreignSheetId and under the datasheetId alias.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_CROSS, SHEET_A, 'Cross Link', 'link', JSON.stringify({ foreignSheetId: SHEET_B }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_CROSS_ALIAS, SHEET_A, 'Cross Link Alias', 'link', JSON.stringify({ datasheetId: SHEET_B }), 2])
    // same-base link + non-link with a stashed target (must NOT be flagged).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_SAME, SHEET_A, 'Same Link', 'link', JSON.stringify({ foreignSheetId: SHEET_A }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NONLINK, SHEET_A, 'Stashed String', 'string', JSON.stringify({ foreignSheetId: SHEET_B }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK_FOR_DANGLE, SHEET_A, 'Dangle Owner', 'link', JSON.stringify({ foreignSheetId: SHEET_A }), 5])

    // (ii) dangling meta_link: a link row whose foreign_record_id points at a non-existent record. We
    // also seed a GOOD link (foreign record exists) to prove the sweep does not over-flag.
    await q('INSERT INTO meta_records (id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [REC_A, SHEET_A, '{}'])
    await q('INSERT INTO meta_records (id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [REC_GOOD, SHEET_A, '{}'])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
      [LINK_DANGLE, FLD_LINK_FOR_DANGLE, REC_A, `missing_rec_${TS}`])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
      [LINK_GOOD, FLD_LINK_FOR_DANGLE, REC_A, REC_GOOD])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE id = ANY($1::text[])', [[LINK_DANGLE, LINK_GOOD]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE id = ANY($1::text[])', [[REC_A, REC_GOOD]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  function runSweep(): {
    crossBaseLinkFields: Array<{ fieldId: string; sourceSheetId: string; sourceBaseId: string | null; foreignSheetId: string; foreignBaseId: string | null }>
    danglingLinks: Array<{ linkId: string; fieldId: string; recordId: string; foreignRecordId: string }>
    counts: { crossBaseLinkFields: number; danglingLinks: number }
  } {
    // The sweep exits 2 when hazards are found (its CLI contract) and 0 when clean. execFileSync throws
    // on a non-zero exit, so read stdout off the thrown error too; only a real failure (no stdout) rethrows.
    let out: string
    try {
      out = execFileSync('node', [SCRIPT, '--json-only'], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      })
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout
      if (typeof stdout !== 'string' || stdout.trim().length === 0) throw err
      out = stdout
    }
    return JSON.parse(out)
  }

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('sweep enumerates the seeded cross-base link fields (incl. alias), not same-base / non-link', () => {
    const payload = runSweep()
    const crossIds = payload.crossBaseLinkFields.map((r) => r.fieldId)
    expect(crossIds).toContain(FLD_CROSS)
    expect(crossIds).toContain(FLD_CROSS_ALIAS)
    // same-base link, non-link stash, and the dangle-owner (same-base) must NOT be flagged cross-base.
    expect(crossIds).not.toContain(FLD_SAME)
    expect(crossIds).not.toContain(FLD_NONLINK)
    expect(crossIds).not.toContain(FLD_LINK_FOR_DANGLE)
    // the flagged rows carry the base ids (values-free metadata) for triage.
    const cross = payload.crossBaseLinkFields.find((r) => r.fieldId === FLD_CROSS)
    expect(cross?.sourceBaseId).toBe(BASE_A)
    expect(cross?.foreignBaseId).toBe(BASE_B)
  })

  test('sweep enumerates the seeded dangling meta_link, not the good one', () => {
    const payload = runSweep()
    const danglingIds = payload.danglingLinks.map((r) => r.linkId)
    expect(danglingIds).toContain(LINK_DANGLE)
    expect(danglingIds).not.toContain(LINK_GOOD)
  })
})
