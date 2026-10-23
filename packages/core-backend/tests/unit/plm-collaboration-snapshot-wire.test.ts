import { describe, expect, it } from 'vitest'
import {
  ECO_COLLABORATION_ECO_FIELDS,
  ECO_COLLABORATION_LOCAL_FIELDS,
  ECO_COLLABORATION_SOURCE_FIELDS,
  ecoCollaborationBusinessHash,
  ecoCollaborationBusinessMaterial,
  ecoCollaborationRowKey,
  parseEcoCollaborationSource,
  parseEcoCollaborationSourceInput,
  type EcoCollaborationAnchor,
  type EcoCollaborationSource,
} from '../../src/multitable/plm-collaboration-snapshot-wire'

const SECRET = 'w23-description-secret'
const UPDATED = '2026-10-23T01:02:03.000000Z'
const SNAPSHOT_A = '2026-10-23T02:03:04.000000Z'
const SNAPSHOT_B = '2026-10-23T05:06:07.000000Z'

function anchor(overrides: Partial<EcoCollaborationAnchor> = {}): EcoCollaborationAnchor {
  return {
    tenantId: 'tenant-w23',
    orgId: 'org-w23',
    itemId: 'item-root',
    ecoId: 'eco-scoped',
    currentVersionId: null,
    ...overrides,
  }
}

function envelope(options?: {
  snapshotAt?: string
  version?: string | null
  eco?: Record<string, unknown>
  source?: Record<string, unknown>
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    projection_contract: 'eco_collaboration_source.v1',
    feature_key: 'collaboration_source_read',
    entitled: true,
    source: {
      tenant_id: 'tenant-w23',
      org_id: 'org-w23',
      item_id: 'item-root',
      current_version_id: options?.version ?? null,
      ...options?.source,
    },
    snapshot_at: options?.snapshotAt ?? SNAPSHOT_A,
    eco: {
      id: 'eco-scoped',
      name: 'Scoped ECO',
      eco_type: 'bom',
      product_id: 'item-root',
      source_version_id: null,
      target_version_id: null,
      stage_id: null,
      state: null,
      kanban_state: null,
      priority: null,
      updated_at: null,
      ...options?.eco,
    },
    ...options?.extra,
  }
}

function parse(value: unknown, expected = anchor()): EcoCollaborationSource {
  return parseEcoCollaborationSource(value, expected)
}

describe('ECO collaboration source wire', () => {
  it('accepts the exact whitelist, nullable model fields, and retains snapshot_at', () => {
    const snapshot = parse(envelope())
    expect(Object.keys(snapshot).sort()).toEqual([
      'eco', 'entitled', 'feature_key', 'projection_contract', 'snapshot_at', 'source',
    ])
    expect(Object.keys(snapshot.source).sort()).toEqual([...ECO_COLLABORATION_SOURCE_FIELDS].sort())
    expect(Object.keys(snapshot.eco).sort()).toEqual([...ECO_COLLABORATION_ECO_FIELDS].sort())
    expect(snapshot.entitled).toBe(true)
    expect(snapshot.snapshot_at).toBe(SNAPSHOT_A)
    expect(snapshot.source.current_version_id).toBeNull()
    expect(snapshot.eco).toMatchObject({
      id: 'eco-scoped',
      name: 'Scoped ECO',
      eco_type: 'bom',
      product_id: 'item-root',
      source_version_id: null,
      target_version_id: null,
      stage_id: null,
      state: null,
      kanban_state: null,
      priority: null,
      updated_at: null,
    })
    const filled = parse(envelope({
      version: 'ver-root',
      eco: {
        state: 'draft',
        kanban_state: 'normal',
        priority: 'high',
        updated_at: UPDATED,
      },
    }), anchor({ currentVersionId: 'ver-root' }))
    expect(filled.source.current_version_id).toBe('ver-root')
    expect(filled.eco.updated_at).toBe(UPDATED)
    expect(filled.eco.state).toBe('draft')
  })

  it('rejects non-null columns, overlong model fields, extra keys, and secrets', () => {
    expect(() => parse(envelope({ eco: { name: null } }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_REJECTED', message: 'ECO_SOURCE_REJECTED',
    }))
    expect(() => parse(envelope({ eco: { eco_type: null } }))).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
    expect(() => parse(envelope({ eco: { name: 'n'.repeat(101) } }))).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
    expect(() => parse(envelope({ eco: { eco_type: 't'.repeat(21) } }))).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
    expect(() => parse(envelope({ eco: { state: 's'.repeat(21) } }))).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
    expect(() => parse(envelope({ eco: { kanban_state: 'k'.repeat(21) } }))).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
    expect(() => parse(envelope({ eco: { priority: 'p'.repeat(11) } }))).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
    expect(() => parse(envelope({ eco: { updated_at: '2026-10-23T01:02:03Z' } }))).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
    expect(() => parse(envelope({ eco: { name: 'n'.repeat(100), eco_type: 'bom' } }))).not.toThrow()
    const leaked = () => parse(envelope({ eco: { description: SECRET, created_by_id: 9001 } }))
    expect(leaked).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED', message: 'ECO_SOURCE_REJECTED' }))
    try {
      leaked()
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(SECRET)
    }
    expect(() => parse(envelope({ extra: { generated_at: SNAPSHOT_B } }))).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
    expect(() => parse(envelope({ extra: { feature_key: 'bom_multitable' } }))).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
    const readiness = {
      projection_contract: 'readiness.v1',
      feature_key: 'collaboration_source_read',
      entitled: true,
      resources: [],
      summary: { ok: true },
    }
    expect(() => parse(readiness)).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
  })

  it('refuses an unlicensed null envelope and does not return a snapshot', () => {
    const unlicensed = {
      projection_contract: 'eco_collaboration_source.v1',
      feature_key: 'collaboration_source_read',
      entitled: false,
      source: null,
      snapshot_at: null,
      eco: null,
    }
    expect(() => parse(unlicensed)).toThrow(expect.objectContaining({
      status: 403, code: 'ECO_SOURCE_UNLICENSED', message: 'ECO_SOURCE_UNLICENSED',
    }))
    const extra = { ...unlicensed, description: SECRET, password: 'native-password' }
    try {
      parse(extra)
      throw new Error('unlicensed extra was accepted')
    } catch (error) {
      expect(error).toMatchObject({ code: 'ECO_SOURCE_UNLICENSED' })
      expect(JSON.stringify(error)).not.toContain(SECRET)
      expect(JSON.stringify(error)).not.toContain('native-password')
    }
    expect(() => parse({ ...unlicensed, source: { tenant_id: 'tenant-w23' } })).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_UNLICENSED',
    }))
  })

  it('checks the fixed scope, item, nullable version, and product anchor', () => {
    expect(() => parse(envelope({ eco: { product_id: null } }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_ANCHOR_MISMATCH',
    }))
    expect(() => parse(envelope({ eco: { product_id: 'item-other' } }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_ANCHOR_MISMATCH',
    }))
    expect(() => parse(envelope(), anchor({ tenantId: 'tenant-other' }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_ANCHOR_MISMATCH',
    }))
    expect(() => parse(envelope(), anchor({ orgId: 'org-other' }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_ANCHOR_MISMATCH',
    }))
    expect(() => parse(envelope(), anchor({ itemId: 'item-other' }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_ANCHOR_MISMATCH',
    }))
    expect(() => parse(envelope(), anchor({ ecoId: 'eco-other' }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_ANCHOR_MISMATCH',
    }))
    expect(() => parse(envelope(), anchor({ currentVersionId: 'ver-root' }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_ANCHOR_MISMATCH',
    }))
    expect(() => parse(envelope({ version: 'ver-root' }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_ANCHOR_MISMATCH',
    }))
    expect(parse(envelope({ version: 'ver-root' }), anchor({ currentVersionId: 'ver-root' })).source.current_version_id).toBe('ver-root')
    const missingVersion = envelope()
    delete (missingVersion.source as { current_version_id?: unknown }).current_version_id
    expect(() => parse(missingVersion)).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_REJECTED' }))
  })

  it('requires the nullable version on input and keeps the typed row key collision-free', () => {
    expect(parseEcoCollaborationSourceInput({
      itemId: 'item-root', ecoId: 'eco-scoped', currentVersionId: null,
    })).toEqual({ itemId: 'item-root', ecoId: 'eco-scoped', currentVersionId: null })
    expect(() => parseEcoCollaborationSourceInput({ itemId: 'item-root', ecoId: 'eco-scoped' })).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_INPUT_INVALID',
    }))
    expect(() => parseEcoCollaborationSourceInput({
      itemId: 'item-root', ecoId: 'eco-scoped', currentVersionId: undefined,
    })).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_INPUT_INVALID' }))
    expect(() => parseEcoCollaborationSourceInput({
      itemId: 'item-root', ecoId: 'eco-scoped', currentVersionId: null, dataSourceId: 'meta-1',
    })).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_INPUT_INVALID' }))
    for (const itemId of ['', ' item-root', 'x'.repeat(129), 15]) {
      expect(() => parseEcoCollaborationSourceInput({
        itemId, ecoId: 'eco-scoped', currentVersionId: null,
      })).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_INPUT_INVALID' }))
    }
    expect(() => parseEcoCollaborationSourceInput({
      itemId: 'item-root', ecoId: 'eco-scoped', currentVersionId: '',
    })).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_INPUT_INVALID' }))

    const left = ecoCollaborationRowKey({ dataSourceId: 'a|b', tenantId: 'c', orgId: 'd', ecoId: 'e' })
    const right = ecoCollaborationRowKey({ dataSourceId: 'a', tenantId: 'b|c', orgId: 'd', ecoId: 'e' })
    expect(left.join('|')).toBe(right.join('|'))
    expect(JSON.stringify(left)).not.toBe(JSON.stringify(right))
    expect(left).toEqual(['a|b', 'c', 'd', 'e'])
    const again = ecoCollaborationRowKey({ dataSourceId: 'source-b', tenantId: 'tenant-w23', orgId: 'org-w23', ecoId: 'eco-scoped' })
    expect(JSON.stringify(again)).toBe(JSON.stringify(['source-b', 'tenant-w23', 'org-w23', 'eco-scoped']))
    expect(JSON.stringify(ecoCollaborationRowKey({
      dataSourceId: 'source-a', tenantId: 'tenant-w23', orgId: 'org-w23', ecoId: 'eco-scoped',
    }))).not.toBe(JSON.stringify(again))
  })

  it('excludes snapshot clock from the row business hash and includes updated_at, version, and whitelist', () => {
    const first = parse(envelope({ snapshotAt: SNAPSHOT_A, eco: { updated_at: UPDATED, name: 'Scoped ECO' } }))
    const clockOnly = parse(envelope({ snapshotAt: SNAPSHOT_B, eco: { updated_at: UPDATED, name: 'Scoped ECO' } }))
    expect(first.snapshot_at).not.toBe(clockOnly.snapshot_at)
    const dataSourceId = 'source-b'
    expect(ecoCollaborationBusinessHash(dataSourceId, first)).toBe(ecoCollaborationBusinessHash(dataSourceId, clockOnly))
    const material = ecoCollaborationBusinessMaterial(dataSourceId, first)
    expect(material.row_key).toEqual(['source-b', 'tenant-w23', 'org-w23', 'eco-scoped'])
    expect(material).not.toHaveProperty('snapshot_at')
    expect(material).not.toHaveProperty('generated_at')
    expect(material).not.toHaveProperty('rows')
    expect(JSON.stringify(material)).not.toContain(SNAPSHOT_A)
    expect(material.eco.updated_at).toBe(UPDATED)
    expect(material.current_version_id).toBeNull()
    const renamed = parse(envelope({ snapshotAt: SNAPSHOT_A, eco: { updated_at: UPDATED, name: 'Renamed ECO' } }))
    const touched = parse(envelope({
      snapshotAt: SNAPSHOT_A,
      eco: { updated_at: '2026-10-23T09:09:09.000000Z', name: 'Scoped ECO' },
    }))
    const versioned = parse(envelope({
      snapshotAt: SNAPSHOT_A,
      version: 'ver-root',
      eco: { updated_at: UPDATED, name: 'Scoped ECO' },
    }), anchor({ currentVersionId: 'ver-root' }))
    const otherSource = ecoCollaborationBusinessHash('source-a', first)
    expect(ecoCollaborationBusinessHash(dataSourceId, renamed)).not.toBe(ecoCollaborationBusinessHash(dataSourceId, first))
    expect(ecoCollaborationBusinessHash(dataSourceId, touched)).not.toBe(ecoCollaborationBusinessHash(dataSourceId, first))
    expect(ecoCollaborationBusinessHash(dataSourceId, versioned)).not.toBe(ecoCollaborationBusinessHash(dataSourceId, first))
    expect(otherSource).not.toBe(ecoCollaborationBusinessHash(dataSourceId, first))
    expect(ecoCollaborationBusinessHash(dataSourceId, first)).toBe(ecoCollaborationBusinessHash(dataSourceId, first))
  })

  it('counts Native code points for emoji ids and ECO names', () => {
    const emoji = '😀'
    for (const count of [65, 128]) {
      const id = emoji.repeat(count)
      expect([...id].length).toBe(count)
      expect(id.length).toBe(count * 2)
      const parsed = parseEcoCollaborationSourceInput({
        itemId: id,
        ecoId: id,
        currentVersionId: id,
      })
      expect(parsed).toEqual({ itemId: id, ecoId: id, currentVersionId: id })
      const snapshot = parse(envelope({
        version: id,
        source: { item_id: id },
        eco: { id, product_id: id, name: emoji.repeat(51) },
      }), anchor({ itemId: id, ecoId: id, currentVersionId: id }))
      expect(snapshot.eco.id).toBe(id)
      expect(snapshot.eco.name).toBe(emoji.repeat(51))
      expect(snapshot.source.item_id).toBe(id)
      expect(snapshot.source.current_version_id).toBe(id)
    }
    const overId = emoji.repeat(129)
    expect(() => parseEcoCollaborationSourceInput({
      itemId: overId,
      ecoId: 'eco-scoped',
      currentVersionId: null,
    })).toThrow(expect.objectContaining({ code: 'ECO_SOURCE_INPUT_INVALID' }))
    expect(() => parse(envelope({ eco: { id: overId } }), anchor({ ecoId: overId }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_REJECTED',
    }))
    const name51 = emoji.repeat(51)
    const name100 = emoji.repeat(100)
    const accepted51 = parse(envelope({ eco: { name: name51 } }))
    const accepted100 = parse(envelope({ eco: { name: name100 } }))
    expect(accepted51.eco.name).toBe(name51)
    expect(accepted100.eco.name).toBe(name100)
    expect(() => parse(envelope({ eco: { name: emoji.repeat(101) } }))).toThrow(expect.objectContaining({
      code: 'ECO_SOURCE_REJECTED',
    }))
    const decomposed = 'e\u0301'
    const composed = '\u00e9'
    const decomposedSnapshot = parse(envelope({ eco: { name: decomposed } }))
    const composedSnapshot = parse(envelope({ eco: { name: composed } }))
    expect(decomposedSnapshot.eco.name).toBe(decomposed)
    expect(composedSnapshot.eco.name).toBe(composed)
    expect(ecoCollaborationBusinessHash('source-b', decomposedSnapshot)).not.toBe(
      ecoCollaborationBusinessHash('source-b', composedSnapshot),
    )
  })

  it('accepts Native year 0001 timestamps and keeps Gregorian day checks', () => {
    for (const stamp of [
      '0001-01-01T00:00:00.000000Z',
      '0099-12-31T23:59:59.000000Z',
      '0100-01-01T00:00:00.000000Z',
      '2000-02-29T12:00:00.000000Z',
    ]) {
      expect(parse(envelope({ eco: { updated_at: stamp } })).eco.updated_at).toBe(stamp)
    }
    expect(parse(envelope({ snapshotAt: '0001-01-01T00:00:00.000000Z' })).snapshot_at).toBe(
      '0001-01-01T00:00:00.000000Z',
    )
    for (const stamp of [
      '0000-01-01T00:00:00.000000Z',
      '1900-02-29T00:00:00.000000Z',
      '2000-02-30T00:00:00.000000Z',
      '2023-02-29T00:00:00.000000Z',
    ]) {
      expect(() => parse(envelope({ eco: { updated_at: stamp } }))).toThrow(expect.objectContaining({
        code: 'ECO_SOURCE_REJECTED',
      }))
    }
    const year1 = parse(envelope({ eco: { updated_at: '0001-01-01T00:00:00.000000Z' } }))
    const year100 = parse(envelope({ eco: { updated_at: '0100-01-01T00:00:00.000000Z' } }))
    expect(ecoCollaborationBusinessHash('source-b', year1)).not.toBe(
      ecoCollaborationBusinessHash('source-b', year100),
    )
  })

  it('exports only the three future local collaboration fields', () => {
    expect(ECO_COLLABORATION_LOCAL_FIELDS).toEqual([
      { key: 'collaboration_owner', type: 'person' },
      { key: 'followup_due_at', type: 'dateTime' },
      { key: 'review_note', type: 'longText' },
    ])
    expect(JSON.stringify(ECO_COLLABORATION_LOCAL_FIELDS)).not.toContain('readiness')
  })
})
