'use strict'

/**
 * 列映射副驾 (schema-mapping copilot) ROUTES — driven through the REAL route registration
 * (registerIntegrationRoutes) against a MOCKED boundary (no real provider). Pins:
 *
 *   - integration:admin gate on both propose + confirm (a read-tier user is 403);
 *   - THE PRIVACY PIN at the route level: the request handed to the boundary carries
 *     dataClass:'business' and feature:'schema-mapping-copilot' (weaken → red);
 *   - NO AUTO-APPLY: a propose response NEVER carries a preset (`authoritativePreset` is null, no
 *     top-level preset), even when the AI is available — the ONLY path to a preset is confirm;
 *   - FAIL-OPEN: an absent boundary degrades propose to manual mapping, never a 5xx;
 *   - THE CONFIRMED PRESET IS THE AUTHORITATIVE ARTIFACT: confirm assembles the human-confirmed
 *     semantics into a DETERMINISTIC vendor preset validated by validateVendorPreset, marks AI-vs-human
 *     provenance, server-stamps confirmedBy, and REFUSES (422) a confirmation that would smuggle a
 *     concrete per-customer slot past the deterministic gate.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { registerIntegrationRoutes } = require(path.join(__dirname, '..', 'lib', 'http-routes.cjs'))

const TENANT_ID = 'tenant_1'
const ADMIN_USER = { id: 'user_admin', email: 'admin@example.test', tenantId: TENANT_ID, permissions: ['integration:admin'] }
const READ_USER = { id: 'user_read', tenantId: TENANT_ID, permissions: ['integration:read'] }

function noopStore(methods) {
  const store = {}
  for (const method of methods) store[method] = async () => ({})
  return store
}

function stubServices(overrides = {}) {
  return {
    externalSystemRegistry: {
      async upsertExternalSystem() { return {} },
      async getExternalSystem() { return {} },
      async deleteExternalSystem() { return {} },
      async listExternalSystems() { return [] },
    },
    adapterRegistry: { createAdapter() { return {} }, listAdapterKinds() { return [] } },
    pipelineRegistry: {
      async upsertPipeline() { return {} },
      async getPipeline() { return {} },
      async listPipelines() { return [] },
      async listPipelineRuns() { return [] },
    },
    pipelineRunner: { async runPipeline() { return {} } },
    deadLetterStore: { async listDeadLetters() { return [] } },
    stagingInstaller: { async installStaging() { return {} }, listStagingDescriptors() { return [] } },
    templateRegistry: {
      async upsertTemplate() { return {} },
      async getTemplate() { return {} },
      async listTemplates() { return [] },
      async deleteTemplate() { return {} },
      async instantiateTemplate() { return {} },
    },
    readSourceConfigStore: noopStore(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: noopStore(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: noopStore(['saveVersion', 'approve', 'retire', 'getForApply']),
    ...overrides,
  }
}

function createHarness(overrides = {}) {
  const routes = new Map()
  const context = {
    config: {},
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${String(method).toUpperCase()} ${routePath}`, handler)
        },
      },
    },
  }
  registerIntegrationRoutes({
    context,
    services: stubServices(overrides),
    logger: { warn() {}, error() {}, info() {} },
  })
  return { routes }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function invoke(routes, method, routePath, req = {}) {
  const handler = routes.get(`${String(method).toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} must be registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  assert.notEqual(res.body, undefined, 'route produced a JSON body')
  return res
}

const PROPOSE = '/api/integration/stock-preparation/schema-mapping-copilot/propose'
const CONFIRM = '/api/integration/stock-preparation/schema-mapping-copilot/confirm'

// A DN_PDM family catalog signal — the real preset dir (dn-pdm-family.preset.json) is what the route
// loads server-side; these table names clear its signature floor.
function proposeBody() {
  return {
    tenantId: TENANT_ID,
    signals: {
      tableNames: [
        'DN_PDM_PartLibraryInfo',
        'DN_PDM_BomHeadInfo',
        'DN_PDM_BomDetailsInfo',
        'DN_PDM_PathInfo',
        'DN_PM_BomExAttrInfo',
        'DN_PM_PartExAttrInfo',
      ],
      columns: [{ id: '7', name: 'Bom_ExAttr7', sample: ['12', '3', '40'] }],
      dictionaryRows: [{ columnName: 'Bom_ExAttr7', label: '数量', type: 'numeric', enabled: true }],
    },
  }
}

function availableBoundary(capture) {
  return {
    async suggest(request) {
      if (capture) capture.request = request
      return {
        available: true,
        suggestion: JSON.stringify([
          { id: '7', meaning: '数量 (quantity)', semantic: 'bom-line-quantity', reasoning: 'per [[col:7]] dict labels it 数量', confidence: 'high' },
        ]),
        provenance: { aiGenerated: true, advisory: true, providerTier: 'local', provider: 'openai', model: 'qwen' },
        citations: [{ id: 'col:7', label: 'Bom_ExAttr7', referenced: true }],
        usage: null,
      }
    },
  }
}

test('propose is integration:admin gated — a read-tier user is 403', async () => {
  const { routes } = createHarness({ governedAi: availableBoundary() })
  const res = await invoke(routes, 'POST', PROPOSE, { user: READ_USER, body: proposeBody() })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'FORBIDDEN')
})

test('PRIVACY PIN + NO AUTO-APPLY: propose tags the boundary business, and never returns a preset', async () => {
  const capture = {}
  const { routes } = createHarness({ governedAi: availableBoundary(capture) })
  const res = await invoke(routes, 'POST', PROPOSE, { user: ADMIN_USER, body: proposeBody() })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  // The boundary was asked with the privacy pin + feature tag.
  assert.equal(capture.request.dataClass, 'business')
  assert.equal(capture.request.feature, 'schema-mapping-copilot')
  // The grounding carried the opaque column so the AI can reason over it.
  assert.ok(Array.isArray(capture.request.grounding) && capture.request.grounding.length >= 1)
  // AI available, proposal parsed and cross-checked against the deterministic discovery.
  assert.equal(res.body.data.aiAvailable, true)
  const proposal = res.body.data.proposals.find((p) => p.id === '7')
  assert.equal(proposal.aiSemantic, 'bom-line-quantity')
  assert.equal(proposal.deterministic.labelHint, 'quantity')
  assert.equal(proposal.agreesWithDiscovery, true)
  // NO AUTO-APPLY: a propose response never carries an authoritative preset.
  assert.equal(res.body.data.authoritativePreset, null)
  assert.equal(res.body.data.preset, undefined)
})

test('FAIL-OPEN: an absent boundary degrades propose to manual mapping (never a 5xx)', async () => {
  const { routes } = createHarness({ governedAi: null })
  const res = await invoke(routes, 'POST', PROPOSE, { user: ADMIN_USER, body: proposeBody() })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.aiAvailable, false)
  assert.equal(res.body.data.reason, 'boundary_absent')
  assert.equal(res.body.data.manualFallback, true)
  // The deterministic hint (dictionary label → quantity) is still surfaced for manual mapping.
  const proposal = res.body.data.proposals.find((p) => p.id === '7')
  assert.equal(proposal.deterministic.labelHint, 'quantity')
  assert.equal(res.body.data.authoritativePreset, null)
})

test('propose rejects empty signals with a 400 (values-free contract error)', async () => {
  const { routes } = createHarness({ governedAi: availableBoundary() })
  const res = await invoke(routes, 'POST', PROPOSE, { user: ADMIN_USER, body: { signals: { columns: [] } } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'SCHEMA_MAPPING_COPILOT_SIGNALS_INVALID')
})

test('CONFIRM writes the authoritative deterministic preset + AI-vs-human provenance', async () => {
  const { routes } = createHarness({ governedAi: availableBoundary() })
  const res = await invoke(routes, 'POST', CONFIRM, {
    user: ADMIN_USER,
    body: {
      presetId: 'dn-pdm-family',
      confirmedSemantics: [
        {
          semantic: 'bom-line-quantity',
          locus: 'dictionary-assigned-column',
          columnFamily: 'bomDetailExAttr',
          dictionary: 'bom-detail-exattr-labels',
          dictionaryTypeHint: 'numeric',
          labelHint: 'quantity',
          source: 'ai-suggested',
        },
        { semantic: 'project-number', locus: 'native-column', role: 'pathExAttr', roleColumn: 'FileCode', source: 'human-set' },
      ],
    },
  })
  assert.equal(res.statusCode, 201)
  assert.equal(res.body.ok, true)
  // The authoritative artifact is a valid vendor preset.
  assert.equal(res.body.data.preset.presetSchema, 'metasheet.source-vendor-preset')
  assert.equal(res.body.data.preset.presetId, 'dn-pdm-family')
  assert.equal(res.body.data.preset.semanticExpectations.length, 2)
  // Provenance: which fields the AI suggested vs the human set, and a SERVER-STAMPED confirmer.
  assert.equal(res.body.data.provenance.confirmedBy, 'user_admin')
  assert.equal(res.body.data.provenance.aiSuggested, 1)
  assert.equal(res.body.data.provenance.humanSet, 1)
  assert.ok(res.body.data.provenance.fields.some((f) => f.semantic === 'bom-line-quantity' && f.source === 'ai-suggested'))
  // The preset itself never carries the AI-vs-human provenance (that is not preset data).
  assert.equal(JSON.stringify(res.body.data.preset).includes('ai-suggested'), false)
})

test('CONFIRM refuses a request-supplied confirmedBy (server-stamped only)', async () => {
  const { routes } = createHarness({ governedAi: availableBoundary() })
  const res = await invoke(routes, 'POST', CONFIRM, {
    user: ADMIN_USER,
    body: { presetId: 'dn-pdm-family', confirmedBy: 'forged', confirmedSemantics: [{ semantic: 'x', locus: 'native-column', role: 'part', roleColumn: 'OBJ_ID', source: 'human-set' }] },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'SCHEMA_MAPPING_COPILOT_FORBIDDEN_FIELD')
})

test('CONFIRM is deterministically validated — a smuggled concrete slot is REFUSED (422), no preset written', async () => {
  const { routes } = createHarness({ governedAi: availableBoundary() })
  const res = await invoke(routes, 'POST', CONFIRM, {
    user: ADMIN_USER,
    body: {
      presetId: 'dn-pdm-family',
      confirmedSemantics: [
        {
          semantic: 'bom-line-quantity',
          locus: 'dictionary-assigned-column',
          columnFamily: 'bomDetailExAttr',
          dictionary: 'bom-detail-exattr-labels',
          dictionaryTypeHint: 'numeric',
          labelHint: 'quantity',
          // A per-customer concrete slot smuggled in a note — the deterministic gate must refuse it.
          note: 'confirmed this maps to Bom_ExAttr7 at this customer',
          source: 'ai-suggested',
        },
      ],
    },
  })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.error.code, 'SCHEMA_MAPPING_COPILOT_CONFIRM_PRESET_INVALID')
  assert.equal(res.body.data && res.body.data.preset, undefined)
})

test('CONFIRM 422 for an unknown vendor family presetId', async () => {
  const { routes } = createHarness({ governedAi: availableBoundary() })
  const res = await invoke(routes, 'POST', CONFIRM, {
    user: ADMIN_USER,
    body: { presetId: 'not-a-real-family', confirmedSemantics: [{ semantic: 'x', locus: 'native-column', role: 'part', roleColumn: 'OBJ_ID', source: 'human-set' }] },
  })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.error.code, 'SCHEMA_MAPPING_COPILOT_PRESET_UNKNOWN')
})
