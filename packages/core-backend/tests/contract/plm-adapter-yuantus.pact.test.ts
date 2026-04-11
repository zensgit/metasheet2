/**
 * Wave 1 Pact contract sanity test for the Metasheet -> Yuantus PLM federation.
 *
 * This test currently performs a STATIC sanity check against a hand-authored
 * Pact v3 artifact at `pacts/metasheet2-yuantus-plm.json`. It does not yet
 * regenerate the artifact from real consumer interactions because that would
 * require adding `@pact-foundation/pact` as a dependency, which has not been
 * approved as of 2026-04-07.
 *
 * What this test guarantees today:
 *
 *   1. The pact JSON exists and parses as Pact v3.
 *   2. The 6 Wave 1 P0 interactions plus the document-semantics Wave 2
 *      interactions plus the BOM-analysis / ECO-approval Wave 3 interactions
 *      plus the approval list/detail / BOM-substitute Wave 4 interactions that
 *      PLMAdapter currently calls are present, in the documented order.
 *      (codex's plan also lists `aml/metadata`, but PLMAdapter does not yet
 *      call it; deferred until there is a real consumer call site.)
 *   3. The PLMAdapter actually calls every endpoint declared in the pact, so
 *      the contract cannot drift away from the live consumer code without
 *      this test failing.
 *
 * What this test does NOT yet do:
 *
 *   - Spin up a Pact mock server and replay PLMAdapter against it. That is the
 *     "real" consumer pact behaviour and will land once `@pact-foundation/pact`
 *     is approved as a devDependency. When that happens, this file should be
 *     replaced (or extended) so the JSON is generated from `Pact.write()`
 *     rather than committed by hand.
 *
 * The provider verification side already exists at:
 *   /Users/huazhou/Downloads/Github/Yuantus/src/yuantus/api/tests/test_pact_provider_yuantus_plm.py
 *
 * See also:
 *   - docs/PACT_FIRST_INTEGRATION_PLAN_20260407.md
 *   - docs/PLM_STANDALONE_METASHEET_BOUNDARY_STRATEGY_20260407.md
 *   - docs/METASHEET_REPO_SOURCE_OF_TRUTH_INVESTIGATION_20260407.md
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PACT_PATH = resolve(__dirname, 'pacts', 'metasheet2-yuantus-plm.json')
const ADAPTER_PATH = resolve(
  __dirname,
  '..',
  '..',
  'src',
  'data-adapters',
  'PLMAdapter.ts',
)

interface PactInteraction {
  description: string
  providerStates?: Array<{ name: string }>
  request: {
    method: string
    path: string
    body?: unknown
    headers?: Record<string, string>
    query?: Record<string, string[]>
  }
  response: {
    status: number
    body?: unknown
  }
}

interface PactDocument {
  consumer: { name: string }
  provider: { name: string }
  interactions: PactInteraction[]
  metadata: { pactSpecification: { version: string } }
}

// Wave 1 P0 = endpoints PLMAdapter.ts CURRENTLY calls. Anything that is only
// "planned" or "anticipated" must NOT live in this list — the contract-first
// principle requires that pact freezes what is actually used, never aspiration.
//
// Notable omission from codex's PACT_FIRST plan: GET /api/v1/aml/metadata/{type}
// is listed as Wave 1 P0 in docs/PACT_FIRST_INTEGRATION_PLAN_20260407.md, but
// PLMAdapter.ts does not currently invoke it. It is parked for Wave 1.5 / Wave
// 2 and will be added to this list as soon as the adapter starts calling it.
const PACT_PATHS = [
  { method: 'POST', path: '/api/v1/auth/login' },
  { method: 'GET', path: '/api/v1/health' },
  { method: 'GET', path: '/api/v1/search/' },
  { method: 'POST', path: '/api/v1/aml/apply' },
  { method: 'GET', path: '/api/v1/bom/01H000000000000000000000P1/tree' },
  { method: 'GET', path: '/api/v1/bom/compare' },
  { method: 'GET', path: '/api/v1/file/item/01H000000000000000000000P1' },
  { method: 'GET', path: '/api/v1/file/01H000000000000000000000F1' },
  { method: 'POST', path: '/api/v1/aml/query' },
  { method: 'GET', path: '/api/v1/bom/01H000000000000000000000P2/where-used' },
  { method: 'GET', path: '/api/v1/bom/compare/schema' },
  { method: 'GET', path: '/api/v1/eco/01H000000000000000000000E1/approvals' },
  { method: 'POST', path: '/api/v1/eco/01H000000000000000000000E2/approve' },
  { method: 'POST', path: '/api/v1/eco/01H000000000000000000000E3/reject' },
  { method: 'GET', path: '/api/v1/eco' },
  { method: 'GET', path: '/api/v1/eco/01H000000000000000000000E2' },
  { method: 'GET', path: '/api/v1/bom/01H000000000000000000000R1/substitutes' },
  { method: 'POST', path: '/api/v1/bom/01H000000000000000000000R3/substitutes' },
  { method: 'DELETE', path: '/api/v1/bom/01H000000000000000000000R4/substitutes/01H000000000000000000000R6' },
] as const

function loadPact(): PactDocument {
  const raw = readFileSync(PACT_PATH, 'utf8')
  return JSON.parse(raw) as PactDocument
}

function loadAdapter(): string {
  return readFileSync(ADAPTER_PATH, 'utf8')
}

describe('Pact: Metasheet2 consumer -> YuantusPLM provider (Wave 1 + Wave 2 document semantics + Wave 3 BOM/approval + Wave 4 approval list/detail/substitutes)', () => {
  it('pact JSON exists, parses as Pact v3, and names the right consumer/provider', () => {
    const pact = loadPact()
    expect(pact.consumer.name).toBe('Metasheet2')
    expect(pact.provider.name).toBe('YuantusPLM')
    expect(pact.metadata.pactSpecification.version).toBe('3.0.0')
  })

  it('contains exactly the currently used interactions PLMAdapter calls, in documented order', () => {
    const pact = loadPact()
    expect(pact.interactions).toHaveLength(PACT_PATHS.length)
    pact.interactions.forEach((interaction, index) => {
      const expected = PACT_PATHS[index]
      expect(interaction.request.method).toBe(expected.method)
      expect(interaction.request.path).toBe(expected.path)
    })
  })

  it('every interaction declares at least one provider state', () => {
    const pact = loadPact()
    for (const interaction of pact.interactions) {
      expect(interaction.providerStates).toBeDefined()
      expect(interaction.providerStates!.length).toBeGreaterThan(0)
      expect(interaction.providerStates![0].name).toBeTruthy()
    }
  })

  it('every protected endpoint is also called by the live PLMAdapter source', () => {
    const adapterSrc = loadAdapter()
    // Every endpoint declared in the pact should appear verbatim in
    // PLMAdapter.ts (as path segments or helper callsites), so the pact
    // cannot silently drift away from the live consumer implementation.
    const endpointsToFind = [
      '/api/v1/auth/login',
      '/api/v1/health',
      '/api/v1/search/',
      '/api/v1/aml/apply',
      '/api/v1/bom/${productId}/tree',
      '/api/v1/bom/compare',
      '/api/v1/bom/${itemId}/where-used',
      '/api/v1/bom/compare/schema',
      '/api/v1/file/item/',
      '/api/v1/aml/query',
      '/api/v1/eco',
      '/api/v1/eco/${approvalId}',
      '/api/v1/eco/${approvalId}/approvals',
      '/api/v1/eco/${approvalId}/approve',
      '/api/v1/eco/${approvalId}/reject',
      '/api/v1/bom/${bomLineId}/substitutes',
      '/api/v1/bom/${bomLineId}/substitutes/${substituteId}',
      'fetchYuantusFileMetadata',
    ]
    for (const ep of endpointsToFind) {
      expect(
        adapterSrc.includes(ep),
        `PLMAdapter.ts no longer references ${ep}; pact has drifted from the consumer.`,
      ).toBe(true)
    }
  })

  it('aml/apply request body documents the RPC envelope shape used by PLMAdapter', () => {
    const pact = loadPact()
    const applyInteraction = pact.interactions.find(
      i => i.request.path === '/api/v1/aml/apply',
    )
    expect(applyInteraction).toBeDefined()
    const body = applyInteraction!.request.body as Record<string, string>
    expect(body).toHaveProperty('type')
    expect(body).toHaveProperty('action')
    expect(body).toHaveProperty('id')
    expect(body.action).toBe('get')
  })

  it('aml/apply response declares the count + items envelope returned by GetOperation', () => {
    const pact = loadPact()
    const applyInteraction = pact.interactions.find(
      i => i.request.path === '/api/v1/aml/apply',
    )
    expect(applyInteraction).toBeDefined()
    const body = applyInteraction!.response.body as Record<string, unknown>
    expect(body).toHaveProperty('count')
    expect(body).toHaveProperty('items')
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('document semantics interactions lock attachment listing, file metadata enrichment, and AML related-doc expansion', () => {
    const pact = loadPact()
    const attachmentList = pact.interactions.find(
      i => i.request.path === '/api/v1/file/item/01H000000000000000000000P1',
    )
    const fileMetadata = pact.interactions.find(
      i => i.request.path === '/api/v1/file/01H000000000000000000000F1',
    )
    const amlQuery = pact.interactions.find(
      i => i.request.path === '/api/v1/aml/query',
    )

    expect(attachmentList).toBeDefined()
    expect(fileMetadata).toBeDefined()
    expect(amlQuery).toBeDefined()
  })

  it('aml/query request body documents the expand Document Part envelope used by getProductDocuments', () => {
    const pact = loadPact()
    const amlQuery = pact.interactions.find(
      i => i.request.path === '/api/v1/aml/query',
    )
    expect(amlQuery).toBeDefined()
    const body = amlQuery!.request.body as Record<string, unknown>
    expect(body.type).toBe('Part')
    expect(body.where).toEqual({ id: '01H000000000000000000000P1' })
    expect(body.expand).toEqual(['Document Part'])
    expect(body.page_size).toBe(1)
  })

  it('where-used and compare-schema interactions lock the BOM analysis surfaces consumed on mainline', () => {
    const pact = loadPact()
    const whereUsed = pact.interactions.find(
      i => i.request.path === '/api/v1/bom/01H000000000000000000000P2/where-used',
    )
    const compareSchema = pact.interactions.find(
      i => i.request.path === '/api/v1/bom/compare/schema',
    )

    expect(whereUsed).toBeDefined()
    expect(compareSchema).toBeDefined()
    expect(whereUsed!.request.query).toEqual({
      recursive: ['true'],
      max_levels: ['4'],
    })
    expect(compareSchema!.response.body).toMatchObject({
      line_fields: expect.any(Array),
      compare_modes: expect.any(Array),
      line_key_options: expect.any(Array),
    })
  })

  it('approval-history and approval-action interactions lock the ECO approval envelope used by federation', () => {
    const pact = loadPact()
    const history = pact.interactions.find(
      i => i.request.path === '/api/v1/eco/01H000000000000000000000E1/approvals',
    )
    const approve = pact.interactions.find(
      i => i.request.path === '/api/v1/eco/01H000000000000000000000E2/approve',
    )
    const reject = pact.interactions.find(
      i => i.request.path === '/api/v1/eco/01H000000000000000000000E3/reject',
    )

    expect(history).toBeDefined()
    expect(approve).toBeDefined()
    expect(reject).toBeDefined()
    expect(history!.response.body).toEqual([
      expect.objectContaining({
        eco_id: '01H000000000000000000000E1',
        status: expect.any(String),
      }),
    ])
    expect(approve!.request.body).toEqual({
      version: 7,
      comment: 'Ship it',
    })
    expect(reject!.request.body).toEqual({
      version: 8,
      comment: 'Missing test evidence',
    })
  })

  it('approval list/detail and BOM substitute interactions lock the extra mainline surfaces used by bridge + federation', () => {
    const pact = loadPact()
    const approvalsList = pact.interactions.find(
      i => i.request.path === '/api/v1/eco',
    )
    const approvalDetail = pact.interactions.find(
      i => i.request.path === '/api/v1/eco/01H000000000000000000000E2',
    )
    const substitutesList = pact.interactions.find(
      i => i.request.path === '/api/v1/bom/01H000000000000000000000R1/substitutes'
        && i.request.method === 'GET',
    )
    const substitutesAdd = pact.interactions.find(
      i => i.request.path === '/api/v1/bom/01H000000000000000000000R3/substitutes'
        && i.request.method === 'POST',
    )
    const substitutesRemove = pact.interactions.find(
      i => i.request.path === '/api/v1/bom/01H000000000000000000000R4/substitutes/01H000000000000000000000R6',
    )

    expect(approvalsList).toBeDefined()
    expect(approvalDetail).toBeDefined()
    expect(substitutesList).toBeDefined()
    expect(substitutesAdd).toBeDefined()
    expect(substitutesRemove).toBeDefined()

    expect(approvalsList!.request.query).toEqual({
      product_id: ['01H000000000000000000000P1'],
      created_by_id: ['1'],
      limit: ['25'],
      offset: ['0'],
    })
    expect((approvalsList!.response.body as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: '01H000000000000000000000E1',
      eco_type: 'bom',
      product_id: '01H000000000000000000000P1',
    })
    expect(approvalDetail!.response.body).toMatchObject({
      id: '01H000000000000000000000E2',
      name: 'Approve ECO',
    })
    expect(substitutesList!.response.body).toMatchObject({
      bom_line_id: '01H000000000000000000000R1',
      count: 1,
      substitutes: [expect.objectContaining({ id: '01H000000000000000000000R5' })],
    })
    expect(substitutesAdd!.request.body).toEqual({
      substitute_item_id: '01H000000000000000000000P3',
      properties: {
        rank: 1,
        note: 'new alternate',
      },
    })
    expect(substitutesRemove!.response.body).toEqual({
      ok: true,
      substitute_id: '01H000000000000000000000R6',
    })
  })
})
