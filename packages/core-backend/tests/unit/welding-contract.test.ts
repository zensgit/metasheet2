import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve('../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('welding finite integration registration', () => {
  it('keeps the API-policy exemption limited to exact GET csv/xlsx template route selection', () => {
    const source = read('packages/core-backend/src/routes/welding.ts')
    expect(source).toContain(String.raw`const template = /^\/api\/welding\/resources\/import\/templates\/(csv|xlsx)$/.exec(req.path)`)
    expect(source).toContain("if (template && req.method === 'GET')")
    expect(source).toContain('if (!apiPathHasPrefix(req.path, RESOURCE_IMPORT_PREFIX)) return null')
  })
  it('registers preflight before global authentication and finite router after it', () => {
    const source = read('packages/core-backend/src/index.ts')
    const preflight = source.indexOf('this.app.use(weldingPreflight)')
    const gate = source.indexOf('if (isApiPath(req.path)) return jwtAuthMiddleware(req, res, next)')
    const router = source.indexOf('this.app.use(weldingRouter())')
    expect(preflight).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(preflight)
    const rawBody = source.indexOf('this.app.use(weldingPlanRawBody)')
    expect(rawBody).toBeGreaterThan(preflight)
    expect(rawBody).toBeLessThan(source.indexOf("this.app.use(express.json({ limit: '10mb' }))"))
    expect(source.indexOf("this.app.use(express.json({ limit: '10mb' }))")).toBeGreaterThan(preflight)
    expect(source.indexOf('this.app.use(express.urlencoded({ extended: true }))')).toBeGreaterThan(preflight)
    expect(router).toBeGreaterThan(gate)
    expect(source.indexOf('this.app.use(weldingCadPreflight)')).toBeLessThan(gate)
    expect(source.indexOf('this.app.use(weldingCadRawBody)')).toBeLessThan(source.indexOf("this.app.use(express.json({ limit: '10mb' }))"))
    expect(source.indexOf('this.app.use(weldingCadHostRouter())')).toBeGreaterThan(gate)
  })
  it('registers the exact default-off flag with its actual source and semantics', async () => {
    const { GLOBAL_HISTORY_FLAG_MANIFEST, isActivated } = await import('../../../../scripts/ops/global-history-flag-manifest.mjs')
    const flag = GLOBAL_HISTORY_FLAG_MANIFEST.find((entry: { key: string }) => entry.key === 'WELDING_READ_ENABLED')
    expect(flag).toMatchObject({ type: 'boolean', activationValue: 'true', dependsOn: [], conflictsWith: [] })
    expect(flag.source).toContain('integrations/welding/provider.ts#weldingEnabled')
    const source = read('packages/core-backend/src/integrations/welding/provider.ts')
    expect(source).toContain("process.env.WELDING_READ_ENABLED === 'true'")
    expect(isActivated(flag, 'true')).toBe(true)
    for (const raw of [undefined, '', '1', 'TRUE', ' true ', 'false']) expect(isActivated(flag, raw)).toBe(false)
    const write = GLOBAL_HISTORY_FLAG_MANIFEST.find((entry: { key: string }) => entry.key === 'WELDING_WRITE_ENABLED')
    expect(write).toMatchObject({ type: 'boolean', activationValue: 'true', dependsOn: ['WELDING_READ_ENABLED'], conflictsWith: [] })
    expect(write.source).toContain('integrations/welding/provider.ts#weldingWriteAvailable')
    expect(source).toContain("process.env.WELDING_WRITE_ENABLED !== 'true'")
    expect(isActivated(write, 'true')).toBe(true)
    for (const raw of [undefined, '', '1', 'TRUE', ' true ', 'false']) expect(isActivated(write, raw)).toBe(false)
  })
  it('keeps finite OpenAPI paths in the actual automatic build and exact public validator', () => {
    const contract = read('packages/openapi/src/paths/welding.yml')
    expect([...contract.matchAll(/^  (\/api\/[^:]+):$/gm)].map(match => match[1])).toEqual([
      '/api/welding/jwks', '/api/welding/authority', '/api/welding/cad-assets/tickets', '/api/welding/plans',
      '/api/welding/resources/import/templates/{format}', '/api/welding/resources/import/preview',
      '/api/welding/resources/import/commit',
      '/api/welding/resources', '/api/welding/resources/catalog',
      '/api/welding/resources/{resource_id}/version-catalog', '/api/welding/process-references/candidate-catalog',
      '/api/welding/resources/{resource_id}/versions/{version_id}',
      '/api/welding/resources/{resource_id}/versions/{version_id}/diagram',
      '/api/welding/resources/{resource_id}/revisions',
      '/api/welding/plans/product-context', '/api/welding/plans/product-candidates',
      '/api/welding/plans/drawing-candidates', '/api/welding/plans/bom-candidates',
      '/api/welding/plans/reuse-product-candidates', '/api/welding/plans/reuse-product-context',
      '/api/welding/plans/reuse-bom-candidates',
      '/api/welding/plans/recovery-authority',
      '/api/welding/plans/{plan_id}/versions/{version_id}',
      '/api/welding/plans/{plan_id}/versions/{version_id}/draft',
      '/api/welding/plans/{plan_id}/versions/{version_id}/source-review',
      '/api/welding/plans/{plan_id}/versions/{version_id}/source-changes',
      '/api/welding/plans/{plan_id}/versions/{version_id}/source-changes/{change_id}',
      '/api/welding/plans/{plan_id}/versions/{version_id}/source-changes/{change_id}/documents/{side}',
      '/api/welding/plans/{plan_id}/versions/{version_id}/source-change-preparations',
      '/api/welding/plans/{plan_id}/versions/{version_id}/source-change-preparations/{context_id}',
      '/api/welding/plans/{plan_id}/versions/{version_id}/cad-contexts',
      '/api/welding/plans/{plan_id}/versions/{version_id}/cad-contexts/{context_id}',
      '/api/welding/render-templates',
      '/api/welding/plans/{plan_id}/versions/{version_id}/renders',
      '/api/welding/artifacts/{generation_id}',
      '/api/welding/artifacts/{generation_id}/files/{format}',
      '/api/welding/artifacts/{generation_id}/retry',
      '/api/welding/plans/{plan_id}/versions/{version_id}/review-state',
      '/api/welding/plans/{plan_id}/versions/{version_id}/review-history',
      '/api/welding/plans/{plan_id}/versions/{version_id}/publication',
      '/api/welding/plans/{plan_id}/versions/{version_id}/publication/files/{format}',
      '/api/welding/plans/{plan_id}/publications',
      '/api/welding/plans/{plan_id}/publication-comparison',
      '/api/welding/plans/{plan_id}/versions/{version_id}/validate',
      '/api/welding/plans/{plan_id}/versions/{version_id}/submit',
      '/api/welding/plans/{plan_id}/versions/{version_id}/review',
      '/api/welding/plans/{plan_id}/versions/{version_id}/withdraw',
      '/api/welding/plans/{plan_id}/versions/{version_id}/reopen',
      '/api/welding/plans/{plan_id}/versions/{version_id}/final-renders',
      '/api/welding/plans/{plan_id}/versions/{version_id}/release',
      '/api/welding/plans/{plan_id}/versions/{version_id}/revise',
      '/api/welding/plans/{plan_id}/versions/{version_id}/workflow-receipts/resolve',
      '/api/welding/plans/{plan_id}/versions/{version_id}/reuse',
      '/api/welding/plans/{plan_id}/versions/{version_id}/reuse-receipts/resolve',
      '/api/welding/plans/{plan_id}/versions/{version_id}/reuse-provenance',
    ])
    expect(contract).toContain('security: []')
    expect(contract).toContain('bearerAuth: []')
    expect(contract).toContain('yuantus.welding_generation_authority/1')
    expect(read('packages/openapi/tools/build.ts')).toContain("fs.readdirSync(pathsDir).filter(f => f.endsWith('.yml'))")
    expect(read('packages/openapi/tools/validate.ts')).toContain("p === '/api/welding/jwks'")
    const generated = JSON.parse(read('packages/openapi/dist/openapi.json')).paths
    expect(generated['/api/welding/jwks'].get.security).toEqual([])
    expect(generated['/api/welding/authority'].get.security).toEqual([{ bearerAuth: [] }])
    expect(generated['/api/welding/cad-assets/tickets'].post.security).toEqual([{ bearerAuth: [] }])
    const dto = generated['/api/welding/authority'].get.responses['200'].content['application/json'].schema
    expect(dto.additionalProperties).toBe(false)
    expect(dto.properties.owner.required).toEqual(['tenant_id', 'org_id', 'auth_user_id', 'rbac_user_id'])
    expect(generated['/api/welding/plans'].post.security).toEqual([{ bearerAuth: [] }])
    expect(generated['/api/welding/resources'].post.responses['201']).toBeDefined()
    expect(generated['/api/welding/resources/import/templates/{format}'].get.responses['200']).toBeDefined()
    expect(generated['/api/welding/resources/import/preview'].post.requestBody.content['application/octet-stream']).toBeDefined()
    expect(generated['/api/welding/resources/import/commit'].post.responses['201']).toBeDefined()
    expect(generated['/api/welding/resources/{resource_id}/versions/{version_id}'].get.responses['200']).toBeDefined()
    expect(generated['/api/welding/resources/{resource_id}/revisions'].post.responses['201']).toBeDefined()
    expect(generated['/api/welding/plans/recovery-authority'].post.security).toEqual([{ bearerAuth: [] }])
    expect(generated['/api/welding/plans/{plan_id}/versions/{version_id}/cad-contexts/{context_id}'].delete.responses['204']).toBeDefined()
    expect(generated['/api/welding/plans/{plan_id}/versions/{version_id}/renders'].post.responses['202']).toBeDefined()
    expect(generated['/api/welding/artifacts/{generation_id}/retry'].post.security).toEqual([{ bearerAuth: [] }])
    for (const path of ['/api/welding/artifacts/{generation_id}/files/{format}',
      '/api/welding/plans/{plan_id}/versions/{version_id}/publication/files/{format}']) {
      const download = generated[path].get
      expect(download.security).toEqual([{ bearerAuth: [] }])
      expect(download.parameters.find((parameter: { name: string }) => parameter.name === 'format').schema.enum).toEqual(['pdf', 'docx'])
      expect(Object.keys(download.responses['200'].content).sort()).toEqual([
        'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ])
    }
    expect(generated['/api/welding/plans/{plan_id}/versions/{version_id}/validate'].post.responses['200']).toBeDefined()
    expect(generated['/api/welding/plans/{plan_id}/versions/{version_id}/workflow-receipts/resolve'].post.responses['200']).toBeDefined()
    expect(generated['/api/welding/plans/{plan_id}/versions/{version_id}/final-renders'].post.responses['202']).toBeDefined()
    for (const [path, method] of [['reuse', 'post'], ['reuse-receipts/resolve', 'post'], ['reuse-provenance', 'get']]) {
      const operation = generated[`/api/welding/plans/{plan_id}/versions/{version_id}/${path}`][method]
      expect(operation.security).toEqual([{ bearerAuth: [] }])
      expect(operation.responses['200']).toBeDefined()
    }
    expect(generated['/api/welding/plans/{plan_id}/versions/{version_id}/reuse'].post.description).toContain('independent 16-field ACK')
    expect(generated['/api/welding/plans/{plan_id}/versions/{version_id}/reuse-receipts/resolve'].post.description).toContain('without a workflow envelope')
    expect(generated['/api/welding/plans/{plan_id}/publication-comparison'].get.parameters.map((value: { name: string }) => value.name))
      .toEqual(['plan_id', 'from_version_id', 'to_version_id'])
  })
  it('is discoverable by the existing backend Vitest CI command without an excluded file', async () => {
    const config = (await import('../../vitest.config')).default
    for (const file of ['tests/unit/welding-identity.test.ts', 'tests/unit/welding-contract.test.ts', 'tests/unit/welding-plan-adapter.test.ts',
      'tests/unit/welding-resource-import.test.ts']) {
      expect(config.test?.exclude).not.toContain(file)
    }
    expect(read('.github/workflows/plugin-tests.yml')).toContain('pnpm --filter @metasheet/core-backend test')
    expect(JSON.parse(read('packages/core-backend/package.json')).scripts.test).toBe('vitest')
  })
})

describe('reuse target selection OpenAPI contract', () => {
  const operations = [
    ['reuse-product-candidates', 'listWeldingPlanReuseProductCandidates'],
    ['reuse-product-context', 'getWeldingPlanReuseProductContext'],
    ['reuse-bom-candidates', 'listWeldingPlanReuseBomCandidates'],
  ] as const

  it.each(operations)('declares the exact authenticated read-only %s contract', (name, operationId) => {
    const document = JSON.parse(read('packages/openapi/dist/openapi.json'))
    const item = document.paths[`/api/welding/plans/${name}`]
    expect(item).toBeDefined()
    expect(Object.keys(item)).toEqual(['get'])
    const operation = item.get
    expect(operation.operationId).toBe(operationId)
    expect(Object.values(document.paths).flatMap(value => Object.values(value as Record<string, { operationId?: string }>))
      .filter(value => value.operationId === operationId)).toHaveLength(1)
    expect(operation.security).toEqual([{ bearerAuth: [] }])
    expect(operation.requestBody).toBeUndefined()
    expect(operation.description).toMatch(/read-only/i)
    expect(operation.responses['200'].description).toContain('no-store')
    for (const status of ['400', '401', '403', '404', '502', '503']) expect(operation.responses[status]).toBeDefined()
    const lookup = name === 'reuse-product-candidates'
    expect(operation.parameters.map((parameter: { name: string }) => parameter.name).sort())
      .toEqual(lookup ? ['limit', 'query'] : ['product_id', 'product_version_id'])
    for (const parameter of operation.parameters) {
      expect(parameter.in).toBe('query')
      if (parameter.name === 'limit') {
        expect(parameter.required ?? false).toBe(false)
        expect(parameter.schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 20, default: 20 })
      } else {
        expect(parameter.required).toBe(true)
        expect(parameter.schema).toMatchObject({ type: 'string', minLength: 1, maxLength: lookup ? 100 : 64 })
      }
    }
    const response = operation.responses['200'].content['application/json'].schema
    expect(response.type).toBe('object')
    expect(response.additionalProperties).toBe(false)
    const context = name === 'reuse-product-context'
    expect([...response.required].sort()).toEqual(context ? ['product', 'schema'] : ['items'])
    expect(Object.keys(response.properties).sort()).toEqual(context ? ['product', 'schema'] : ['items'])
    if (context) expect(response.properties.schema.enum).toEqual(['yuantus.welding_plan_entry/1'])
    else {
      expect(response.properties.items.type).toBe('array')
      expect(response.properties.items.maxItems).toBe(20)
    }
    const metadata = context ? response.properties.product : response.properties.items.items
    const bom = name === 'reuse-bom-candidates'
    const keys = bom ? ['baseline_id', 'fingerprint', 'name', 'number'] : ['item_id', 'name', 'number', 'version_id', 'version_label']
    expect(metadata.type).toBe('object')
    expect(metadata.additionalProperties).toBe(false)
    expect([...metadata.required].sort()).toEqual(keys)
    expect(Object.keys(metadata.properties).sort()).toEqual(keys)
    for (const key of bom ? ['baseline_id'] : ['item_id', 'version_id'])
      expect(metadata.properties[key]).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 })
    expect(metadata.properties.name).toMatchObject({ type: 'string', maxLength: 256 })
    expect(metadata.properties.number).toMatchObject({ type: 'string', maxLength: bom ? 256 : 128 })
    if (bom) expect(metadata.properties.fingerprint).toMatchObject({ type: 'string', pattern: '^[0-9a-f]{64}$' })
    else expect(metadata.properties.version_label).toMatchObject({ type: 'string', nullable: true, maxLength: 64 })
  })

  it('includes exactly the three named selection GETs in source and all generated contracts', () => {
    const source = read('packages/openapi/src/paths/welding.yml')
    const expected = operations.map(([name]) => `/api/welding/plans/${name}`).sort()
    expect([...source.matchAll(/^  (\/api\/welding\/plans\/reuse-[^:]+):$/gm)].map(match => match[1]).sort()).toEqual(expected)
    for (const file of ['packages/openapi/dist/combined.openapi.yml', 'packages/openapi/dist/openapi.yaml']) {
      const generated = read(file)
      for (const [name, operationId] of operations) {
        expect(generated).toContain(`/api/welding/plans/${name}:`)
        expect(generated).toContain(`operationId: ${operationId}`)
        expect(source).toContain(`operationId: ${operationId}`)
      }
    }
    const paths = JSON.parse(read('packages/openapi/dist/openapi.json')).paths
    expect(Object.keys(paths).filter(path => path.startsWith('/api/welding/plans/reuse-')).sort()).toEqual(expected)
  })
})
