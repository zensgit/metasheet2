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
 *      interactions plus the release-readiness governance interaction plus
 *      the BOM-analysis / ECO-approval Wave 3 interactions plus the approval
 *      list/detail / BOM-substitute Wave 4 interactions plus the CAD
 *      review/workspace Wave 5 interactions plus the PLM-COLLAB Discussion
 *      Phase 3 slice-1 (READ-ONLY) interactions that PLMAdapter currently
 *      calls are present, in the documented order.
 *      including `aml/metadata`, now that PLMAdapter calls the dedicated
 *      metadata route for item-type schema discovery.
 *   3. PLMAdapter actually calls every adapter-owned endpoint declared in the
 *      pact. V1.2's embed-token mint is the one parent-host-mediated exception:
 *      Yuantus calls it before posting the token into the MetaSheet iframe.
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
    matchingRules?: {
      body?: Record<string, unknown>
    }
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
const PLM_ADAPTER_PACT_PATHS = [
  { method: 'POST', path: '/api/v1/auth/login' },
  { method: 'GET', path: '/api/v1/health' },
  { method: 'GET', path: '/api/v1/search/' },
  { method: 'POST', path: '/api/v1/aml/apply' },
  { method: 'GET', path: '/api/v1/bom/01H000000000000000000000P1/tree' },
  { method: 'GET', path: '/api/v1/bom/compare' },
  { method: 'GET', path: '/api/v1/file/item/01H000000000000000000000P1' },
  { method: 'GET', path: '/api/v1/file/01H000000000000000000000F1' },
  { method: 'POST', path: '/api/v1/aml/query' },
  { method: 'GET', path: '/api/v1/aml/metadata/Part' },
  { method: 'GET', path: '/api/v1/release-readiness/items/01H000000000000000000000P1' },
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
  { method: 'GET', path: '/api/v1/cad/files/01H000000000000000000000F2/properties' },
  { method: 'PATCH', path: '/api/v1/cad/files/01H000000000000000000000F3/properties' },
  { method: 'GET', path: '/api/v1/cad/files/01H000000000000000000000F4/view-state' },
  { method: 'PATCH', path: '/api/v1/cad/files/01H000000000000000000000F5/view-state' },
  { method: 'GET', path: '/api/v1/cad/files/01H000000000000000000000F6/review' },
  { method: 'POST', path: '/api/v1/cad/files/01H000000000000000000000F7/review' },
  { method: 'GET', path: '/api/v1/cad/files/01H000000000000000000000F8/history' },
  { method: 'GET', path: '/api/v1/cad/files/01H000000000000000000000F9/diff' },
  { method: 'GET', path: '/api/v1/cad/files/01H000000000000000000000F11/mesh-stats' },
  // PLM-COLLAB V1.1: the two modern Path-A surfaces (advisory manifest + governed BOM context).
  { method: 'GET', path: '/api/v1/integrations/capabilities' },
  { method: 'GET', path: '/api/v1/bom/multitable/01H000000000000000000000P1/context' },
  // PLM-COLLAB P3 (方案1) governed BOM multitable write-back: re-added in its AMENDED form now that
  // the Yuantus provider (#905) honors a GOVERNED, Idempotency-Key-gated write-back (entitlement
  // plm.bom_multitable_writeback). PLMAdapter.ts owns the callsite.
  { method: 'PATCH', path: '/api/v1/bom/multitable/01H000000000000000000000W1/lines/01H000000000000000000000W3' },
  // ECO Phase 3 (Yuantus provider #973): the locked-BOM revision-intent seam the Phase-0
  // discriminated 409 (eco_required) points at. POST with NO body and NO Idempotency-Key —
  // idempotency is the provider's attach-before-create (at most one open intent per part).
  // It MUST sit at the END of the adapter-owned list — immediately before the V1.2 parent-host
  // embed-token — so the concatenated PACT_PATHS order matches the pact JSON placement.
  { method: 'POST', path: '/api/v1/bom/multitable/01H000000000000000000000L1/eco-intent' },
  // PLM-COLLAB Discussion Phase 3 slice-1 (READ-ONLY, design-lock taskbook
  // plm-collab-discussion-phase3-metasheet-consumer-taskbook-20260709.md): the provider routes
  // already exist on Yuantus main (Discussion Core R1 + Phase-2 + Phase-6) — this slice adds NO
  // new provider route, only the consumer read callsites. Bearer-JWT + target-inherited
  // permission only, NOT entitlement-gated. Per the taskbook's §3.4 template, these three sit at
  // the END of the adapter-owned list: a representative thread-list success, a thread-detail
  // success, and the no-leak 404 for a missing/unreadable target.
  { method: 'GET', path: '/api/v1/discussions' },
  { method: 'GET', path: '/api/v1/discussions/01H000000000000000000000T2' },
  { method: 'GET', path: '/api/v1/discussions' },
  // PLM-COLLAB Discussion Phase 3 slice-2 (WRITE, Gate-2 REWORKED contract): the
  // discussion-session credential exchange plus a representative write success/forbidden pair.
  // Only interactions backed by a provider PRE-REGISTERED state (named verbatim in the
  // taskbook) are pact-frozen here -- the contract-first principle above forbids inventing a
  // state name the provider does not actually expose. The adapter itself implements all 6
  // write routes (see `endpointsToFind` below, which checks source presence, not pact
  // interactions); the other 5 write routes share this same exchange + entitlement shape and
  // are exercised at the unit-test layer (plm-adapter-yuantus.test.ts) instead of here.
  { method: 'POST', path: '/api/v1/auth/embed/discussion-session' },
  { method: 'POST', path: '/api/v1/discussions/01H000000000000000000000T2/comments' },
  { method: 'POST', path: '/api/v1/discussions/01H000000000000000000000T2/comments' },
] as const

const PARENT_HOST_PACT_PATHS = [
  // PLM-COLLAB V1.2: the Yuantus parent host mints the token that powers the MetaSheet embed.
  // This is intentionally not a PLMAdapter call; it is still part of the broker artifact because
  // the MetaSheet embed runtime depends on this token envelope.
  { method: 'POST', path: '/api/v1/bom/multitable/01H000000000000000000000P1/embed-token' },
] as const

const ERROR_CONTRACT_PACT_PATHS = [
  // ECO Phase 0 (Yuantus taskbook plm-collab-eco-phase0-contract-taskbook-20260704.md, provider
  // #969): the pact's FIRST error interactions — the write-back's two discriminated 409s,
  // machine-distinguishable by detail.code ALONE (lifecycle_locked vs idempotency_conflict).
  // They live on DEDICATED provider fixtures (W4/W6 locked parent, W7/W9 burned replay key) so the
  // W1/W3 success-only pin above stays intact. Same PLMAdapter endpoint template as the 200
  // write-back — no new consumer callsite.
  { method: 'PATCH', path: '/api/v1/bom/multitable/01H000000000000000000000W4/lines/01H000000000000000000000W6' },
  { method: 'PATCH', path: '/api/v1/bom/multitable/01H000000000000000000000W7/lines/01H000000000000000000000W9' },
  // ECO Phase 3: the intent seam's own discriminated 409 namespace, pinned via its most
  // consumer-branched code — not_locked (the CTA resets to the direct-edit path on it). The
  // sibling code eco_intent_rejected shares the same envelope and stays consumer-tested only
  // (its recovery is a generic retry; pinning one code freezes the namespace shape).
  { method: 'POST', path: '/api/v1/bom/multitable/01H000000000000000000000L2/eco-intent' },
] as const

const PACT_PATHS = [
  ...PLM_ADAPTER_PACT_PATHS,
  ...PARENT_HOST_PACT_PATHS,
  ...ERROR_CONTRACT_PACT_PATHS,
] as const

function loadPact(): PactDocument {
  const raw = readFileSync(PACT_PATH, 'utf8')
  return JSON.parse(raw) as PactDocument
}

function loadAdapter(): string {
  return readFileSync(ADAPTER_PATH, 'utf8')
}

describe('Pact: Metasheet2 consumer -> YuantusPLM provider (Wave 1 + Wave 2 document semantics + release readiness + Wave 3 BOM/approval + Wave 4 approval list/detail/substitutes + Wave 5 CAD)', () => {
  it('pact JSON exists, parses as Pact v3, and names the right consumer/provider', () => {
    const pact = loadPact()
    expect(pact.consumer.name).toBe('Metasheet2')
    expect(pact.provider.name).toBe('YuantusPLM')
    expect(pact.metadata.pactSpecification.version).toBe('3.0.0')
  })

  it('contains exactly the adapter-owned plus V1.2 parent-host-mediated interactions, in documented order', () => {
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

  it('every adapter-owned protected endpoint is also called by the live PLMAdapter source', () => {
    const adapterSrc = loadAdapter()
    // Every PLMAdapter-owned endpoint declared in the pact should appear verbatim in
    // PLMAdapter.ts (as path segments or helper callsites), so the pact cannot silently
    // drift away from the live consumer implementation. V1.2's embed-token mint is the
    // one documented exception: the Yuantus parent host calls it before posting the token
    // into the MetaSheet iframe.
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
      '/api/v1/aml/metadata/${encodeURIComponent(itemType)}',
      '/api/v1/release-readiness/items/${itemId}',
      '/api/v1/eco',
      '/api/v1/eco/${approvalId}',
      '/api/v1/eco/${approvalId}/approvals',
      '/api/v1/eco/${approvalId}/approve',
      '/api/v1/eco/${approvalId}/reject',
      '/api/v1/bom/${bomLineId}/substitutes',
      '/api/v1/bom/${bomLineId}/substitutes/${substituteId}',
      '/api/v1/cad/files/${fileId}/properties',
      '/api/v1/cad/files/${fileId}/view-state',
      '/api/v1/cad/files/${fileId}/review',
      '/api/v1/cad/files/${fileId}/history',
      '/api/v1/cad/files/${fileId}/diff',
      '/api/v1/cad/files/${fileId}/mesh-stats',
      'fetchYuantusFileMetadata',
      '/api/v1/integrations/capabilities',
      '/api/v1/bom/multitable/${partId}/context',
      '/api/v1/bom/multitable/${partId}/lines/${bomLineId}',
      '/api/v1/bom/multitable/${partId}/eco-intent',
      // PLM-COLLAB Discussion Phase 3 slice-1 (READ-ONLY)
      '/api/v1/discussions',
      '/api/v1/discussions/${threadId}',
      // PLM-COLLAB Discussion Phase 3 slice-2 (WRITE): the exchange path + the write route
      // templates. '/api/v1/discussions' (createDiscussionThread's POST target) is already
      // covered by the read-slice entry above -- these are the remaining 6 write path
      // templates (5 distinct templates: edit/delete share one) + the exchange path = 7.
      '/api/v1/auth/embed/discussion-session',
      '/api/v1/discussions/${threadId}/comments',
      '/api/v1/discussions/${threadId}/comments/${commentId}',
      '/api/v1/discussions/${threadId}/resolve',
      '/api/v1/discussions/${threadId}/reopen',
    ]
    for (const ep of endpointsToFind) {
      expect(
        adapterSrc.includes(ep),
        `PLMAdapter.ts no longer references ${ep}; pact has drifted from the consumer.`,
      ).toBe(true)
    }
  })

  // #4020 (PLM-COLLAB C1 follow-up): the provider now computes a unified per-feature
  // `available` field -- `available = supported && (packaging === 'base' || entitled)`
  // (Yuantus provider #1156). Pins the formula for bom_multitable (paid, licensed under this
  // fixture's tenant-1 provider state), discussion_core (base packaging -- available stays
  // true even though entitled is false, since a base deployment ships no license row -- the
  // exact bug #4020 fixes), and metasheet_review (paid packaging, unlicensed under this same
  // fixture -- entitled false AND available false). entitled/available are EXACT-matched (the
  // formula's own discriminators); everything else on these entries stays match-by-type.
  it('#4020: the capabilities interaction pins the provider-computed available formula', () => {
    const pact = loadPact()
    const interaction = pact.interactions.find(
      i => i.request.path === '/api/v1/integrations/capabilities',
    )
    expect(interaction).toBeDefined()
    const body = interaction!.response.body as {
      features: Record<string, { supported: boolean; entitled: boolean; available?: boolean }>
    }

    expect(body.features.bom_multitable.supported).toBe(true)
    expect(body.features.bom_multitable.entitled).toBe(true)
    expect(body.features.bom_multitable.available).toBe(true)

    // base-packaged: unlicensed (entitled false) but STILL available -- the bug #4020 fixes
    expect(body.features.discussion_core.supported).toBe(true)
    expect(body.features.discussion_core.entitled).toBe(false)
    expect(body.features.discussion_core.available).toBe(true)

    // paid-packaged, unlicensed under this fixture: available follows entitled (both false)
    expect(body.features.metasheet_review.supported).toBe(true)
    expect(body.features.metasheet_review.entitled).toBe(false)
    expect(body.features.metasheet_review.available).toBe(false)

    // entitled/available are the formula's discriminators -- must be EXACT-matched, never
    // loosened to a type matcher (a type matcher would erase the pinned true/false split)
    const rules = interaction!.response.matchingRules?.body ?? {}
    for (const key of ['bom_multitable', 'discussion_core', 'metasheet_review']) {
      expect(rules).not.toHaveProperty(`$.features.${key}.entitled`)
      expect(rules).not.toHaveProperty(`$.features.${key}.available`)
    }
  })

  it('documents the V1.2 parent-host-mediated embed-token mint contract', () => {
    const pact = loadPact()
    const interaction = pact.interactions.find(
      i => i.request.path === '/api/v1/bom/multitable/01H000000000000000000000P1/embed-token',
    )
    expect(interaction).toBeDefined()
    expect(interaction!.request.method).toBe('POST')
    expect(interaction!.request.body).toEqual({ origin: 'https://metasheet.example' })
    const body = interaction!.response.body as Record<string, unknown>
    expect(body.feature_key).toBe('bom_multitable')
    expect(body.entitled).toBe(true)
    expect(body.token_type).toBe('embed')
    expect(body.aud).toBe('metasheet2.embed')
    expect(body.embed_origin).toBe('https://metasheet.example')
    const rules = interaction!.response.matchingRules?.body ?? {}
    expect(rules).toHaveProperty('$.embed_token')
    expect(rules).toHaveProperty('$.jti')
    expect(rules).toHaveProperty('$.expires_in')
  })

  // PLM-COLLAB P3 (方案1) governed BOM multitable write-back contract: RE-ADDED in its AMENDED form
  // now that the Yuantus provider (#905) honors the governed, Idempotency-Key-gated write-back. The
  // W1/W3 ids and request/response shape mirror the Yuantus provider fixture exactly, so the broker
  // provider-verify gate stays green. PLMAdapter.updateBomMultitableLine is the live consumer callsite.
  it('governed BOM multitable write-back interaction locks the amended PATCH contract (Idempotency-Key + entitlement state, success-only)', () => {
    const pact = loadPact()
    const path = '/api/v1/bom/multitable/01H000000000000000000000W1/lines/01H000000000000000000000W3'
    const matches = pact.interactions.filter(i => i.request.path === path)
    // success-only: exactly ONE interaction for this line-addressed write-back path
    expect(matches).toHaveLength(1)
    const writeback = matches[0]

    expect(writeback.request.method).toBe('PATCH')

    // the governed provider state is present AND names the write entitlement it gates on
    expect(writeback.providerStates).toBeDefined()
    expect(writeback.providerStates!.length).toBeGreaterThan(0)
    expect(writeback.providerStates![0].name).toContain('plm.bom_multitable_writeback')

    // the request carries a per-edit Idempotency-Key header (the governed-write seam)
    expect(writeback.request.headers).toBeDefined()
    expect(writeback.request.headers).toHaveProperty('Idempotency-Key')

    // request body is restricted to EXACTLY the four editable business cells
    expect(Object.keys(writeback.request.body as Record<string, unknown>).sort()).toEqual([
      'find_num',
      'quantity',
      'refdes',
      'uom',
    ])

    // response is the minimal success envelope — no eco_id / source_version / applied leakage
    expect(writeback.response.status).toBe(200)
    expect(writeback.response.body).toEqual({
      ok: true,
      bom_line_id: '01H000000000000000000000W3',
    })
  })

  // ECO Phase 3 (Yuantus provider #973): the locked-BOM revision-intent seam.
  it('ECO Phase 3: the eco-intent contract is body-less, key-less, entitlement-stated, minimal-enveloped', () => {
    const pact = loadPact()
    const success = pact.interactions.find(
      i => i.request.method === 'POST' && i.request.path === '/api/v1/bom/multitable/01H000000000000000000000L1/eco-intent',
    )
    expect(success).toBeDefined()

    // provider state names the intent entitlement + the locked precondition
    expect(success!.providerStates![0].name).toContain('plm.bom_eco_revision')
    expect(success!.providerStates![0].name).toContain('lifecycle-locked')

    // NO body, NO Idempotency-Key (provider attach-before-create owns idempotency), NO Content-Type
    expect(success!.request.body).toBeUndefined()
    const headers = (success!.request.headers ?? {}) as Record<string, string>
    expect(Object.keys(headers)).not.toContain('Idempotency-Key')
    expect(Object.keys(headers)).not.toContain('Content-Type')

    // minimal success envelope: the three consumer-branched keys only (source/target_version_id
    // stay provider-additive, deliberately unpinned)
    expect(success!.response.status).toBe(200)
    expect(Object.keys(success!.response.body as Record<string, unknown>).sort()).toEqual([
      'attached', 'eco_id', 'state',
    ])

    // the intent seam's own 409 namespace: not_locked pinned as a dedicated error fixture,
    // discriminated by detail.code alone (exact value, message type-matched)
    const notLocked = pact.interactions.find(
      i => i.request.method === 'POST' && i.request.path === '/api/v1/bom/multitable/01H000000000000000000000L2/eco-intent',
    )
    expect(notLocked).toBeDefined()
    expect(notLocked!.response.status).toBe(409)
    const detail = (notLocked!.response.body as { detail: Record<string, unknown> }).detail
    expect(detail.code).toBe('not_locked')
  })

  // PLM-COLLAB Discussion Phase 3 slice-1 (READ-ONLY): the provider routes already exist on
  // Yuantus main (Discussion Core R1 + Phase-2 + Phase-6); this slice adds no new provider
  // route, only the consumer read callsites (getDiscussions / getDiscussionThread). Bearer-JWT
  // + target-inherited permission only -- NOT entitlement-gated (no capability/SKU check).
  it('Discussion Phase 3 slice-1: thread-list success, thread-detail success, and the no-leak 404 are locked', () => {
    const pact = loadPact()
    const discussionInteractions = pact.interactions.filter(
      i => i.request.path === '/api/v1/discussions' || i.request.path === '/api/v1/discussions/01H000000000000000000000T2',
    )
    // exactly the three read interactions this slice adds (list success, detail success, 404)
    expect(discussionInteractions).toHaveLength(3)

    const listSuccess = pact.interactions.find(
      i => i.request.path === '/api/v1/discussions' && i.response.status === 200,
    )
    const detailSuccess = pact.interactions.find(
      i => i.request.path === '/api/v1/discussions/01H000000000000000000000T2',
    )
    const listNotFound = pact.interactions.find(
      i => i.request.path === '/api/v1/discussions' && i.response.status === 404,
    )

    expect(listSuccess).toBeDefined()
    expect(detailSuccess).toBeDefined()
    expect(listNotFound).toBeDefined()

    // thread-list request shape: target_type/target_id are required query params.
    // include_resolved/include_children are OMITTED here (not just "false") because the
    // adapter's guard is truthy-only (`if (options?.includeResolved) ...`), matching the
    // provider's own false defaults -- the pact must describe what the adapter actually sends.
    expect(listSuccess!.request.method).toBe('GET')
    expect(listSuccess!.request.query).toEqual({
      target_type: ['item'],
      target_id: ['01H000000000000000000000T1'],
      limit: ['20'],
    })
    expect(listSuccess!.providerStates![0].name).toContain('01H000000000000000000000T1')
    // envelope is {threads, next_cursor} -- NOT a bare array (unlike the ECO list endpoint)
    const listBody = listSuccess!.response.body as { threads: unknown[]; next_cursor: unknown }
    expect(Array.isArray(listBody.threads)).toBe(true)
    expect(listBody.threads[0]).toMatchObject({
      id: '01H000000000000000000000T2',
      target_type: 'item',
      target_id: '01H000000000000000000000T1',
      status: 'open',
    })
    expect(listBody).toHaveProperty('next_cursor')

    // thread-detail request shape + comment envelope
    expect(detailSuccess!.request.method).toBe('GET')
    expect(detailSuccess!.request.query).toEqual({ include_history: ['true'] })
    const detailBody = detailSuccess!.response.body as Record<string, unknown> & { comments: unknown[] }
    expect(detailBody.id).toBe('01H000000000000000000000T2')
    expect(Array.isArray(detailBody.comments)).toBe(true)
    expect(detailBody.comments[0]).toMatchObject({
      id: expect.any(String),
      author_user_id: expect.any(Number),
      body: expect.any(String),
    })
    // Phase-6 include_history merge, present because include_history=true was requested
    expect(Array.isArray(detailBody.history)).toBe(true)

    // the no-leak 404: a missing/unreadable target is indistinguishable, no existence leak
    expect(listNotFound!.request.query).toEqual({
      target_type: ['item'],
      target_id: ['01H000000000000000000000T9'],
      limit: ['20'],
    })
    expect(listNotFound!.response.status).toBe(404)
    expect(listNotFound!.response.body).toEqual({ detail: 'discussion target not found' })

    // every discussion interaction is bearer-JWT authenticated (no entitlement/capability header)
    for (const interaction of discussionInteractions) {
      const headers = (interaction.request.headers ?? {}) as Record<string, string>
      expect(headers.Authorization).toBeDefined()
    }
  })

  // PLM-COLLAB Discussion Phase 3 slice-2 (WRITE, Gate-2 REWORKED contract): the
  // discussion-session credential exchange (pre-auth, NO Authorization header) plus a
  // representative write success/forbidden pair on the same comments route -- mirrors the
  // read-slice's own shape (one distinct exchange path, one write path exercised twice).
  it('Discussion Phase 3 slice-2: the session exchange and a write success/forbidden pair are locked', () => {
    const pact = loadPact()
    const exchange = pact.interactions.find(
      i => i.request.path === '/api/v1/auth/embed/discussion-session',
    )
    const writeInteractions = pact.interactions.filter(
      i => i.request.path === '/api/v1/discussions/01H000000000000000000000T2/comments',
    )
    expect(exchange).toBeDefined()
    expect(writeInteractions).toHaveLength(2)

    // exchange: pre-auth, NO Authorization header, body is {embed_token}
    expect(exchange!.request.method).toBe('POST')
    expect(exchange!.request.headers?.Authorization).toBeUndefined()
    expect(exchange!.request.body).toEqual({ embed_token: expect.any(String) })
    expect(exchange!.response.status).toBe(200)
    const credential = exchange!.response.body as Record<string, unknown>
    expect(credential).toMatchObject({
      access_token: expect.any(String),
      token_type: expect.any(String),
      expires_in: expect.any(Number),
      aud: 'discussion',
    })
    expect(exchange!.providerStates![0].name).toBe(
      'a valid embed token exchanges for a discussion-session credential',
    )

    // write success: Bearer-authorized with the exchanged credential, response is a thread detail
    const writeSuccess = writeInteractions.find(i => i.response.status === 200)
    expect(writeSuccess).toBeDefined()
    expect(writeSuccess!.request.method).toBe('POST')
    const successHeaders = (writeSuccess!.request.headers ?? {}) as Record<string, string>
    expect(successHeaders.Authorization).toBeDefined()
    const successRules = (writeSuccess!.request as unknown as { matchingRules?: { header?: Record<string, unknown> } })
      .matchingRules
    expect(successRules?.header).toHaveProperty('$.Authorization')
    expect((writeSuccess!.response.body as Record<string, unknown>).comments).toBeDefined()
    expect(writeSuccess!.providerStates![0].name).toBe(
      'the discussion-session credential authorizes a comment write (can_comment true)',
    )

    // forbidden write: same route, same credential shape, provider denies (can_comment false)
    const writeForbidden = writeInteractions.find(i => i.response.status === 403)
    expect(writeForbidden).toBeDefined()
    expect(writeForbidden!.providerStates![0].name).toBe(
      'the discussion-session credential is forbidden from writing (can_comment false)',
    )
    expect(writeForbidden!.response.body).toEqual({ detail: expect.any(String) })
  })

  // ECO Phase 0: the discriminated-409 error contract (Yuantus provider #968 taskbook + #969 impl).
  // detail.code is the ONLY discriminator; eco_required is a boolean FIELD (not a third code);
  // message keeps the legacy human-readable strings; unknown code ⇒ treat as generic 409.
  it('ECO Phase 0: the two write-back 409s are machine-distinguishable by detail.code alone', () => {
    const pact = loadPact()

    const locked = pact.interactions.find(
      i =>
        i.request.path ===
        '/api/v1/bom/multitable/01H000000000000000000000W4/lines/01H000000000000000000000W6',
    )
    expect(locked).toBeDefined()
    expect(locked!.request.method).toBe('PATCH')
    expect(locked!.response.status).toBe(409)
    const lockedDetail = (locked!.response.body as { detail: Record<string, unknown> }).detail
    expect(lockedDetail.code).toBe('lifecycle_locked')
    expect(lockedDetail.eco_required).toBe(true)
    expect(typeof lockedDetail.message).toBe('string')
    expect(typeof lockedDetail.state).toBe('string')
    // exact payload key-set: no eco_id / entitlement / ECO-existence leakage on the error path
    expect(Object.keys(lockedDetail).sort()).toEqual(['code', 'eco_required', 'message', 'state'])
    expect(locked!.providerStates![0].name).toContain('lifecycle-locked')

    const conflict = pact.interactions.find(
      i =>
        i.request.path ===
        '/api/v1/bom/multitable/01H000000000000000000000W7/lines/01H000000000000000000000W9',
    )
    expect(conflict).toBeDefined()
    expect(conflict!.request.method).toBe('PATCH')
    expect(conflict!.response.status).toBe(409)
    const conflictDetail = (conflict!.response.body as { detail: Record<string, unknown> }).detail
    expect(conflictDetail.code).toBe('idempotency_conflict')
    expect(Object.keys(conflictDetail).sort()).toEqual(['code', 'message'])
    // the Idempotency-Key is EXACT-match (the provider state pre-seeds the replay row on it)
    expect(conflict!.request.headers).toHaveProperty(
      'Idempotency-Key',
      'pact-writeback-conflict-0001',
    )
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

  it('aml/metadata interaction locks the schema-discovery envelope used by getItemMetadata', () => {
    const pact = loadPact()
    const metadata = pact.interactions.find(
      i => i.request.path === '/api/v1/aml/metadata/Part',
    )

    expect(metadata).toBeDefined()
    expect(metadata!.request.method).toBe('GET')
    expect(metadata!.response.body).toEqual({
      id: 'Part',
      label: 'Part',
      is_relationship: false,
      properties: expect.any(Array),
    })
  })

  it('release-readiness interaction locks the governance drilldown envelope used by federation', () => {
    const pact = loadPact()
    const readiness = pact.interactions.find(
      i => i.request.path === '/api/v1/release-readiness/items/01H000000000000000000000P1',
    )

    expect(readiness).toBeDefined()
    expect(readiness!.request.query).toEqual({
      ruleset_id: ['gate-a'],
      mbom_limit: ['10'],
      routing_limit: ['12'],
      baseline_limit: ['8'],
    })
    expect(readiness!.response.body).toMatchObject({
      item_id: '01H000000000000000000000P1',
      ruleset_id: 'gate-a',
      summary: {
        ok: expect.any(Boolean),
        resources: expect.any(Number),
        error_count: expect.any(Number),
      },
      resources: expect.any(Array),
    })
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

  it('CAD interactions lock properties, view state, review, history, diff, and mesh stats for the native workspace', () => {
    const pact = loadPact()
    const propertiesGet = pact.interactions.find(
      i => i.request.path === '/api/v1/cad/files/01H000000000000000000000F2/properties'
        && i.request.method === 'GET',
    )
    const propertiesPatch = pact.interactions.find(
      i => i.request.path === '/api/v1/cad/files/01H000000000000000000000F3/properties'
        && i.request.method === 'PATCH',
    )
    const viewStateGet = pact.interactions.find(
      i => i.request.path === '/api/v1/cad/files/01H000000000000000000000F4/view-state'
        && i.request.method === 'GET',
    )
    const viewStatePatch = pact.interactions.find(
      i => i.request.path === '/api/v1/cad/files/01H000000000000000000000F5/view-state'
        && i.request.method === 'PATCH',
    )
    const reviewGet = pact.interactions.find(
      i => i.request.path === '/api/v1/cad/files/01H000000000000000000000F6/review'
        && i.request.method === 'GET',
    )
    const reviewPost = pact.interactions.find(
      i => i.request.path === '/api/v1/cad/files/01H000000000000000000000F7/review'
        && i.request.method === 'POST',
    )
    const historyGet = pact.interactions.find(
      i => i.request.path === '/api/v1/cad/files/01H000000000000000000000F8/history',
    )
    const diffGet = pact.interactions.find(
      i => i.request.path === '/api/v1/cad/files/01H000000000000000000000F9/diff',
    )
    const meshStatsGet = pact.interactions.find(
      i => i.request.path === '/api/v1/cad/files/01H000000000000000000000F11/mesh-stats',
    )

    expect(propertiesGet).toBeDefined()
    expect(propertiesPatch).toBeDefined()
    expect(viewStateGet).toBeDefined()
    expect(viewStatePatch).toBeDefined()
    expect(reviewGet).toBeDefined()
    expect(reviewPost).toBeDefined()
    expect(historyGet).toBeDefined()
    expect(diffGet).toBeDefined()
    expect(meshStatsGet).toBeDefined()

    expect(propertiesGet!.response.body).toMatchObject({
      file_id: '01H000000000000000000000F2',
      properties: {
        material: 'AL-6061',
        finish: 'anodized',
      },
      source: 'imported',
      cad_document_schema_version: 3,
    })
    expect(propertiesPatch!.request.body).toEqual({
      properties: {
        material: 'AL-7075',
        finish: 'hard-anodized',
      },
      source: 'manual',
    })
    expect(viewStateGet!.response.body).toMatchObject({
      file_id: '01H000000000000000000000F4',
      hidden_entity_ids: [12, 19],
      notes: [
        {
          entity_id: 12,
          note: 'check hole position',
          color: '#FFB020',
        },
      ],
      source: 'client',
      cad_document_schema_version: 3,
    })
    expect(viewStatePatch!.request.body).toEqual({
      hidden_entity_ids: [12, 19],
      notes: [
        {
          entity_id: 19,
          note: 'hide fastener',
          color: '#4C9AFF',
        },
      ],
      source: 'client',
      refresh_preview: false,
    })
    expect(reviewGet!.response.body).toMatchObject({
      file_id: '01H000000000000000000000F6',
      state: 'pending',
      note: 'Awaiting review',
      reviewed_by_id: 1,
    })
    expect(reviewPost!.request.body).toEqual({
      state: 'approved',
      note: 'Looks good',
    })
    expect((historyGet!.response.body as Record<string, unknown>).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'cad_properties_update' }),
        expect.objectContaining({ action: 'cad_review_update' }),
      ]),
    )
    expect(diffGet!.request.query).toEqual({
      other_file_id: ['01H000000000000000000000F10'],
    })
    expect(diffGet!.response.body).toMatchObject({
      file_id: '01H000000000000000000000F9',
      other_file_id: '01H000000000000000000000F10',
      properties: {
        added: { finish: 'anodized' },
        removed: { coating: 'none' },
        changed: {
          weight_kg: { from: 1.1, to: 1.2 },
        },
      },
      cad_document_schema_version: {
        from: 1,
        to: 2,
      },
    })
    expect(meshStatsGet!.response.body).toMatchObject({
      file_id: '01H000000000000000000000F11',
      stats: expect.objectContaining({
        available: true,
        entity_count: 2,
        triangle_count: 102400,
      }),
    })
  })
})
