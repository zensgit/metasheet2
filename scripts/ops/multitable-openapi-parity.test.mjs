import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const rootDir = path.resolve(import.meta.dirname, '../..')
const openapiPath = path.join(rootDir, 'packages/openapi/dist/openapi.json')
const openapi = JSON.parse(readFileSync(openapiPath, 'utf8'))

test('multitable openapi stays aligned with runtime contracts', () => {
  const paths = openapi.paths ?? {}
  const schemas = openapi.components?.schemas ?? {}

  assert.ok(paths['/api/multitable/person-fields/prepare']?.post, 'missing person-field prepare endpoint')
  assert.ok(paths['/api/multitable/sheets/{sheetId}']?.delete, 'missing sheet delete endpoint')
  assert.ok(paths['/api/multitable/records/{recordId}']?.patch, 'missing single-record patch endpoint')

  assert.equal(
    paths['/api/multitable/view']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.$ref,
    '#/components/schemas/MultitableViewData',
  )
  assert.ok(paths['/api/multitable/views']?.get, 'missing view list endpoint')
  assert.equal(paths['/api/multitable/views']?.get?.parameters?.[0]?.name, 'sheetId')
  assert.equal(paths['/api/multitable/views']?.get?.parameters?.[0]?.required, true)
  assert.equal(
    paths['/api/multitable/views']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.properties?.views?.type,
    'array',
  )
  assert.ok(
    paths['/api/multitable/views']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.properties?.views?.items,
    'missing view list item schema',
  )
  assert.equal(
    paths['/api/multitable/views']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.config?.type,
    'object',
  )
  assert.equal(
    paths['/api/multitable/views/{viewId}']?.patch?.requestBody?.content?.['application/json']?.schema?.properties?.config?.type,
    'object',
  )
  assert.equal(
    paths['/api/multitable/views/{viewId}']?.delete?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.properties?.deleted?.type,
    'string',
  )
  assert.ok(paths['/api/multitable/views/{viewId}']?.delete?.responses?.['404'], 'missing view delete not-found response')
  assert.equal(paths['/api/multitable/records']?.post?.requestBody?.content?.['application/json']?.schema?.anyOf?.length, 2)
  assert.equal(paths['/api/multitable/patch']?.post?.requestBody?.content?.['application/json']?.schema?.anyOf?.length, 2)
  assert.equal(paths['/api/multitable/records/{recordId}']?.patch?.requestBody?.content?.['application/json']?.schema?.anyOf?.length, 2)
  assert.equal(
    paths['/api/multitable/views/{viewId}/submit']?.post?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.$ref,
    '#/components/schemas/MultitableFormSubmitResult',
  )
  assert.equal(
    paths['/api/multitable/patch']?.post?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.$ref,
    '#/components/schemas/MultitablePatchResult',
  )

  assert.equal(schemas.MultitableView?.properties?.config?.type, 'object')
  assert.equal(schemas.MultitableField?.properties?.options?.items?.properties?.value?.type, 'string')
  assert.equal(
    schemas.MultitableViewData?.properties?.attachmentSummaries?.$ref,
    '#/components/schemas/MultitableViewAttachmentSummaries',
  )
  assert.equal(
    schemas.MultitableRecordContext?.properties?.attachmentSummaries?.$ref,
    '#/components/schemas/MultitableAttachmentSummaryMap',
  )
  assert.equal(
    schemas.MultitableFormContext?.properties?.attachmentSummaries?.$ref,
    '#/components/schemas/MultitableAttachmentSummaryMap',
  )
  assert.equal(
    schemas.MultitableFormSubmitResult?.properties?.attachmentSummaries?.$ref,
    '#/components/schemas/MultitableAttachmentSummaryMap',
  )
  assert.equal(
    schemas.MultitablePatchResult?.properties?.attachmentSummaries?.$ref,
    '#/components/schemas/MultitableViewAttachmentSummaries',
  )
})
