import { describe, expect, it } from 'vitest'
import { ECO_COLLABORATION_LOCAL_FIELDS } from '../../src/multitable/plm-collaboration-snapshot-wire'
import {
  READINESS_COLLABORATION_COVERAGE_STATUS,
  READINESS_COLLABORATION_FEATURE_KEY,
  READINESS_COLLABORATION_LOCAL_FIELDS,
  READINESS_COLLABORATION_PROJECTION_CONTRACT,
  READINESS_COLLABORATION_RESOURCE_CAPS,
  READINESS_COLLABORATION_SOURCE_FIELDS,
  READINESS_COLLABORATION_SOURCE_FIELD_TYPE,
  ReadinessCollaborationSourceError,
  parseReadinessCollaborationSource,
  parseReadinessCollaborationSourceInput,
  readinessCollaborationBusinessHash,
  readinessCollaborationBusinessMaterial,
  readinessCollaborationRowKey,
  readinessCollaborationSourceCells,
  type ReadinessCollaborationAnchor,
  type ReadinessCollaborationResource,
  type ReadinessCollaborationSource,
} from '../../src/multitable/plm-collaboration-readiness-wire'

const dataSourceId = 'ds-readiness-1'
const tenant = 'tenant-1'
const org = 'org-1'
const itemId = 'item-1'
const rulesetId = 'ruleset-1'
const versionId = 'ver-1'
const snapshotAt = '2026-10-24T01:02:03.000000Z'
const generatedAt = '2026-10-24T01:02:04.000000Z'
const laterClock = '2026-10-24T05:06:07.000123Z'

function anchor(patch: Partial<ReadinessCollaborationAnchor> = {}): ReadinessCollaborationAnchor {
  return {
    tenantId: tenant,
    orgId: org,
    itemId,
    rulesetId,
    currentVersionId: versionId,
    ...patch,
  }
}

function issue(code: string, ruleId = code) {
  return { code, rule_id: ruleId }
}

function resource(
  kind: ReadinessCollaborationResource['kind'],
  resourceType: ReadinessCollaborationResource['resource_type'],
  resource_id: string,
  patch: Partial<Pick<ReadinessCollaborationResource, 'name' | 'state' | 'errors' | 'warnings'>> = {},
): ReadinessCollaborationResource {
  return {
    kind,
    name: patch.name === undefined ? null : patch.name,
    state: patch.state === undefined ? null : patch.state,
    resource_type: resourceType,
    resource_id,
    errors: patch.errors ?? [],
    warnings: patch.warnings ?? [],
  }
}

function summaryFor(resources: ReadinessCollaborationResource[]) {
  return {
    resources: resources.length,
    ok_resources: resources.filter((entry) => entry.errors.length === 0).length,
    error_count: resources.reduce((total, entry) => total + entry.errors.length, 0),
    warning_count: resources.reduce((total, entry) => total + entry.warnings.length, 0),
  }
}

function envelope(options: {
  resources: ReadinessCollaborationResource[]
  summary?: ReturnType<typeof summaryFor>
  currentVersionId?: string | null
  snapshotAt?: string
  generatedAt?: string
  itemId?: string
  rulesetId?: string
  tenantId?: string
  orgId?: string
  coverage?: string
  extra?: Record<string, unknown>
  readinessExtra?: Record<string, unknown>
}) {
  const item = options.itemId ?? itemId
  const ruleset = options.rulesetId ?? rulesetId
  return {
    projection_contract: READINESS_COLLABORATION_PROJECTION_CONTRACT,
    feature_key: READINESS_COLLABORATION_FEATURE_KEY,
    entitled: true,
    source: {
      tenant_id: options.tenantId ?? tenant,
      org_id: options.orgId ?? org,
      item_id: item,
      current_version_id: options.currentVersionId === undefined ? versionId : options.currentVersionId,
    },
    snapshot_at: options.snapshotAt ?? snapshotAt,
    readiness: {
      item_id: item,
      ruleset_id: ruleset,
      generated_at: options.generatedAt ?? generatedAt,
      coverage_status: options.coverage ?? READINESS_COLLABORATION_COVERAGE_STATUS,
      summary: options.summary ?? summaryFor(options.resources),
      resources: options.resources,
      ...options.readinessExtra,
    },
    ...options.extra,
  }
}

function parse(value: unknown, expected = anchor()): ReadinessCollaborationSource {
  return parseReadinessCollaborationSource(value, expected)
}

function failure(value: unknown, expected = anchor()): ReadinessCollaborationSourceError {
  try {
    parse(value, expected)
  } catch (error) {
    expect(error).toBeInstanceOf(ReadinessCollaborationSourceError)
    return error as ReadinessCollaborationSourceError
  }
  throw new Error('expected the readiness wire to reject')
}

describe('readiness collaboration strict wire', () => {
  it('parses a native envelope with nulls, a warning-only resource, and the matching item', () => {
    const longName = 'n'.repeat(300)
    const longRule = 'r'.repeat(300)
    const resources = [
      resource('mbom_release', 'mbom', 'mbom-1', {
        errors: [issue('mbom.exists')],
        warnings: [issue('mbom.note', longRule)],
      }),
      resource('routing_release', 'routing', 'routing-1', {
        name: longName,
        state: 'draft',
        warnings: [issue('routing.note'), issue('routing.note')],
      }),
      resource('item_release', 'item', itemId),
    ]
    const parsed = parse(envelope({ resources, currentVersionId: null }), anchor({ currentVersionId: null }))
    expect(parsed.entitled).toBe(true)
    expect(parsed.source.current_version_id).toBeNull()
    expect(parsed.readiness.resources).toEqual(resources)
    expect(parsed.readiness.resources[0]?.name).toBeNull()
    expect(parsed.readiness.resources[0]?.state).toBeNull()
    expect(parsed.readiness.summary).toEqual({
      resources: 3,
      ok_resources: 2,
      error_count: 1,
      warning_count: 3,
    })
    expect(parsed.readiness.coverage_status).toBe('bounded_not_proven_complete')
    expect(parsed.readiness.resources[2]?.resource_id).toBe(itemId)
  })

  it('accepts an empty resource list and the 20/20/20 plus one item boundary', () => {
    const empty = parse(envelope({ resources: [], currentVersionId: null }), anchor({ currentVersionId: null }))
    expect(empty.readiness.summary).toEqual({
      resources: 0,
      ok_resources: 0,
      error_count: 0,
      warning_count: 0,
    })
    expect(empty.readiness.coverage_status).toBe('bounded_not_proven_complete')
    const resources = [
      ...Array.from({ length: 20 }, (_, index) => resource('mbom_release', 'mbom', `mbom-${index}`)),
      ...Array.from({ length: 20 }, (_, index) => resource('routing_release', 'routing', `routing-${index}`, {
        name: `Route ${index}`,
        state: 'draft',
      })),
      ...Array.from({ length: 20 }, (_, index) => resource('baseline_release', 'baseline', `baseline-${index}`)),
      resource('item_release', 'item', itemId, { name: 'ITEM-1', state: null }),
    ]
    const parsed = parse(envelope({ resources }))
    expect(parsed.readiness.resources).toHaveLength(61)
    expect(parsed.readiness.summary.resources).toBe(61)
    expect(parsed.readiness.summary.ok_resources).toBe(61)
    expect(parsed.readiness.resources.map((entry) => entry.resource_id)).toEqual(resources.map((entry) => entry.resource_id))
  })

  it('accepts a 128-code-point id that is longer than 128 UTF-16 units and is not a UUID', () => {
    const astral = '\u{1F4A1}'.repeat(128)
    expect(astral).toHaveLength(256)
    const parsed = parse(
      envelope({ resources: [], itemId: astral, rulesetId: 'not-a-uuid' }),
      anchor({ itemId: astral, rulesetId: 'not-a-uuid' }),
    )
    expect(parsed.source.item_id).toBe(astral)
    expect(parseReadinessCollaborationSourceInput({
      itemId: astral,
      rulesetId: 'not-a-uuid',
      currentVersionId: null,
    })).toEqual({ itemId: astral, rulesetId: 'not-a-uuid', currentVersionId: null })
  })

  it('uses the Python 3.11 strip set on request ids and keeps BOM and internal NEL', () => {
    const pythonStrip = [
      9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760,
      8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
      8232, 8233, 8239, 8287, 12288,
    ]
    expect(pythonStrip).toHaveLength(29)
    for (const code of pythonStrip) {
      const mark = String.fromCodePoint(code)
      expect(() => parseReadinessCollaborationSourceInput({
        itemId: `${mark}item-1`,
        rulesetId,
        currentVersionId: versionId,
      })).toThrow(expect.objectContaining({ status: 422, code: 'READINESS_SOURCE_INPUT_INVALID' }))
      expect(() => parseReadinessCollaborationSourceInput({
        itemId,
        rulesetId: `ruleset-1${mark}`,
        currentVersionId: versionId,
      })).toThrow(expect.objectContaining({ status: 422, code: 'READINESS_SOURCE_INPUT_INVALID' }))
    }
    for (const prefix of ['\u0085', '\u001c']) {
      expect(failure(
        envelope({ resources: [], itemId: `${prefix}item-1` }),
        anchor({ itemId: `${prefix}item-1` }),
      )).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    }
    const bomItem = '\uFEFFitem-1'
    expect(parseReadinessCollaborationSourceInput({
      itemId: bomItem,
      rulesetId: 'not-a-uuid',
      currentVersionId: '\uFEFFver-1',
    })).toEqual({ itemId: bomItem, rulesetId: 'not-a-uuid', currentVersionId: '\uFEFFver-1' })
    const parsedBom = parse(
      envelope({ resources: [], itemId: bomItem, rulesetId: 'not-a-uuid' }),
      anchor({ itemId: bomItem, rulesetId: 'not-a-uuid' }),
    )
    expect(parsedBom.source.item_id).toBe(bomItem)
    expect(parsedBom.readiness.item_id).toBe(bomItem)
    const internalNel = 'item\u0085one'
    const parsedNel = parse(
      envelope({ resources: [], itemId: internalNel }),
      anchor({ itemId: internalNel }),
    )
    expect(parsedNel.source.item_id).toBe(internalNel)
    expect(parsedNel.readiness.item_id).toBe(internalNel)
    expect(readinessCollaborationSourceCells(parsedNel).item_id).toBe(internalNel)
    const astral = '\u{1F4A1}'.repeat(128)
    expect(astral).toHaveLength(256)
    expect(parseReadinessCollaborationSourceInput({
      itemId: astral,
      rulesetId,
      currentVersionId: null,
    }).itemId).toBe(astral)
  })

  it('rejects scope, item, version, and ruleset failures', () => {
    expect(failure(envelope({ resources: [], tenantId: 'a'.repeat(65) }), anchor({ tenantId: 'a'.repeat(65) }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [], tenantId: 'tenant\n1' }), anchor({ tenantId: 'tenant\n1' }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [], orgId: `org\r1` }), anchor({ orgId: 'org\r1' }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    const tooLong = 'a'.repeat(129)
    expect(failure(envelope({ resources: [], itemId: tooLong }), anchor({ itemId: tooLong }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [], itemId: ' item-1' }), anchor({ itemId: ' item-1' }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [], itemId: 'item\u00001' }), anchor({ itemId: 'item\u00001' }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [], currentVersionId: '' }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [], currentVersionId: tooLong }), anchor({ currentVersionId: tooLong }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [], rulesetId: ' other' }), anchor({ rulesetId: ' other' }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [] }), anchor({ tenantId: 'other-tenant' }))).toMatchObject({
      status: 409,
      code: 'READINESS_SOURCE_ANCHOR_MISMATCH',
    })
    expect(failure(envelope({ resources: [] }), anchor({ itemId: 'item-2' }))).toMatchObject({
      status: 409,
      code: 'READINESS_SOURCE_ANCHOR_MISMATCH',
    })
    expect(failure(envelope({ resources: [] }), anchor({ currentVersionId: null }))).toMatchObject({
      status: 409,
      code: 'READINESS_SOURCE_ANCHOR_MISMATCH',
    })
    expect(failure(envelope({ resources: [] }), anchor({ rulesetId: 'ruleset-2' }))).toMatchObject({
      status: 409,
      code: 'READINESS_SOURCE_ANCHOR_MISMATCH',
    })
    expect(() => parseReadinessCollaborationSourceInput({
      itemId,
      rulesetId,
      currentVersionId: versionId,
      ecoId: 'eco-1',
    })).toThrow(expect.objectContaining({ status: 422, code: 'READINESS_SOURCE_INPUT_INVALID' }))
    expect(() => parseReadinessCollaborationSourceInput({ itemId, currentVersionId: null })).toThrow(
      expect.objectContaining({ status: 422, code: 'READINESS_SOURCE_INPUT_INVALID' }),
    )
  })

  it('rejects extras, nested issue fields, malformed counts, caps, duplicates, and entitled false', () => {
    const mbom = resource('mbom_release', 'mbom', 'mbom-1', { errors: [issue('mbom.exists'), issue('mbom.exists')] })
    expect(failure(envelope({ resources: [mbom], extra: { properties: { publish: true } } }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({
      resources: [{ ...mbom, esign: true } as ReadinessCollaborationResource],
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [{ ...mbom, errors: [{ code: 'mbom.exists', rule_id: 'mbom.exists', details: { any: 1 } }] } as never],
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [mbom],
      summary: { resources: 1, ok_resources: 0, error_count: 1, warning_count: 0 },
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [resource('routing_release', 'routing', 'routing-1', { warnings: [issue('routing.note')] })],
      summary: { resources: 1, ok_resources: 0, error_count: 0, warning_count: 1 },
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [],
      summary: { resources: '0', ok_resources: 0, error_count: 0, warning_count: 0 } as never,
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [],
      summary: { resources: 1.5, ok_resources: 0, error_count: 0, warning_count: 0 } as never,
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [],
      summary: { resources: -1, ok_resources: 0, error_count: 0, warning_count: 0 },
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    const overCap = Array.from({ length: 21 }, (_, index) => resource('mbom_release', 'mbom', `mbom-${index}`))
    expect(failure(envelope({ resources: overCap }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [
        resource('item_release', 'item', itemId),
        resource('item_release', 'item', itemId),
      ],
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [
        resource('baseline_release', 'baseline', 'baseline-1'),
        resource('baseline_release', 'baseline', 'baseline-1'),
      ],
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [resource('mbom_release', 'routing', 'mbom-1')],
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure(envelope({
      resources: [],
      coverage: 'all_ready',
    }))).toMatchObject({ status: 502, code: 'READINESS_SOURCE_REJECTED' })
    expect(failure({
      projection_contract: READINESS_COLLABORATION_PROJECTION_CONTRACT,
      feature_key: READINESS_COLLABORATION_FEATURE_KEY,
      entitled: false,
      source: null,
      snapshot_at: null,
      readiness: null,
    })).toMatchObject({ status: 403, code: 'READINESS_SOURCE_UNLICENSED' })
    expect(failure(envelope({ resources: [], generatedAt: '2026-10-24T01:02:03Z' }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [], snapshotAt: '0000-01-01T00:00:00.000000Z' }))).toMatchObject({
      status: 502,
      code: 'READINESS_SOURCE_REJECTED',
    })
    expect(failure(envelope({ resources: [resource('item_release', 'item', 'item-foreign')] }))).toMatchObject({
      status: 409,
      code: 'READINESS_SOURCE_ANCHOR_MISMATCH',
    })
  })

  it('keeps one business hash across clock changes and changes it for source meaning', () => {
    const resources = [
      resource('mbom_release', 'mbom', 'mbom-1', {
        state: 'draft',
        errors: [issue('mbom.exists'), issue('mbom.structure')],
      }),
      resource('routing_release', 'routing', 'routing-1', { warnings: [issue('routing.note')] }),
    ]
    const first = parse(envelope({ resources }))
    const second = parse(envelope({ resources, snapshotAt: laterClock, generatedAt: laterClock }))
    const firstHash = readinessCollaborationBusinessHash(dataSourceId, first)
    const secondHash = readinessCollaborationBusinessHash(dataSourceId, second)
    expect(firstHash).toBe(secondHash)
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/)
    const material = readinessCollaborationBusinessMaterial(dataSourceId, first)
    expect(material).not.toHaveProperty('snapshot_at')
    expect(material).not.toHaveProperty('generated_at')
    expect(material.row_key).toEqual([dataSourceId, tenant, org, itemId, rulesetId])
    expect(material.item_id).toBe(itemId)
    expect(material.current_version_id).toBe(versionId)
    const swappedResources = [resources[1], resources[0]]
    expect(readinessCollaborationBusinessHash(dataSourceId, parse(envelope({ resources: swappedResources })))).not.toBe(firstHash)
    const swappedIssues = [
      resource('mbom_release', 'mbom', 'mbom-1', {
        state: 'draft',
        errors: [issue('mbom.structure'), issue('mbom.exists')],
      }),
      resources[1],
    ]
    expect(readinessCollaborationBusinessHash(dataSourceId, parse(envelope({ resources: swappedIssues })))).not.toBe(firstHash)
    const changedState = [
      resource('mbom_release', 'mbom', 'mbom-1', {
        state: 'released',
        errors: [issue('mbom.exists'), issue('mbom.structure')],
      }),
      resources[1],
    ]
    expect(readinessCollaborationBusinessHash(dataSourceId, parse(envelope({ resources: changedState })))).not.toBe(firstHash)
    const changedRule = [
      resources[0],
      resource('routing_release', 'routing', 'routing-1', { warnings: [issue('routing.other')] }),
    ]
    expect(readinessCollaborationBusinessHash(dataSourceId, parse(envelope({ resources: changedRule })))).not.toBe(firstHash)
    const changedVersion = parse(envelope({ resources, currentVersionId: 'ver-2' }), anchor({ currentVersionId: 'ver-2' }))
    expect(readinessCollaborationBusinessHash(dataSourceId, changedVersion)).not.toBe(firstHash)
    const changedTuple = parse(envelope({ resources, tenantId: 'tenant-2' }), anchor({ tenantId: 'tenant-2' }))
    expect(readinessCollaborationBusinessHash(dataSourceId, changedTuple)).not.toBe(firstHash)
  })

  it('projects nine canonical string cells and a five-part row key', () => {
    const resources = [
      resource('mbom_release', 'mbom', 'mbom-1', {
        errors: [issue('mbom.exists')],
        warnings: [issue('mbom.note')],
      }),
    ]
    const parsed = parse(envelope({ resources }))
    const cells = readinessCollaborationSourceCells(parsed)
    expect(Object.keys(cells)).toEqual([...READINESS_COLLABORATION_SOURCE_FIELDS])
    expect(Object.values(cells).every((value) => typeof value === 'string')).toBe(true)
    expect(cells.item_id).toBe(itemId)
    expect(cells.ruleset_id).toBe(rulesetId)
    expect(cells.generated_at).toBe(generatedAt)
    expect(cells.coverage_status).toBe('bounded_not_proven_complete')
    expect(cells.resources_count).toBe('1')
    expect(cells.ok_resources).toBe('0')
    expect(cells.error_count).toBe('1')
    expect(cells.warning_count).toBe('1')
    expect(cells.resources).toBe(
      '[{"errors":[{"code":"mbom.exists","rule_id":"mbom.exists"}],"kind":"mbom_release","name":null,"resource_id":"mbom-1","resource_type":"mbom","state":null,"warnings":[{"code":"mbom.note","rule_id":"mbom.note"}]}]',
    )
    expect(JSON.parse(cells.resources)).toEqual(resources)
    const later = parse(envelope({ resources, snapshotAt: laterClock, generatedAt: laterClock }))
    const laterCells = readinessCollaborationSourceCells(later)
    expect(laterCells.generated_at).toBe(laterClock)
    expect(laterCells.resources).toBe(cells.resources)
    expect(laterCells.resources_count).toBe(cells.resources_count)
    expect(readinessCollaborationRowKey({
      dataSourceId,
      tenantId: tenant,
      orgId: org,
      itemId,
      rulesetId,
    })).toEqual([dataSourceId, tenant, org, itemId, rulesetId])
    expect(() => readinessCollaborationRowKey({
      dataSourceId: 'a'.repeat(129),
      tenantId: tenant,
      orgId: org,
      itemId,
      rulesetId,
    })).toThrow(expect.objectContaining({ status: 422, code: 'READINESS_SOURCE_INPUT_INVALID' }))
    expect(READINESS_COLLABORATION_SOURCE_FIELD_TYPE).toBe('string')
    expect(READINESS_COLLABORATION_LOCAL_FIELDS).toEqual([
      { key: 'collaboration_owner', type: 'person' },
      { key: 'followup_due_at', type: 'dateTime' },
      { key: 'review_note', type: 'longText' },
    ])
    expect(READINESS_COLLABORATION_LOCAL_FIELDS).toEqual([...ECO_COLLABORATION_LOCAL_FIELDS])
    expect(READINESS_COLLABORATION_RESOURCE_CAPS).toEqual([
      { kind: 'mbom_release', resource_type: 'mbom', cap: 20 },
      { kind: 'routing_release', resource_type: 'routing', cap: 20 },
      { kind: 'baseline_release', resource_type: 'baseline', cap: 20 },
      { kind: 'item_release', resource_type: 'item', cap: 1 },
    ])
  })
})
