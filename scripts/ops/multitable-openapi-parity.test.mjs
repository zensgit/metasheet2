import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const rootDir = path.resolve(import.meta.dirname, '../..')
const openapiPath = path.join(rootDir, 'packages/openapi/dist/openapi.json')
const openapi = JSON.parse(readFileSync(openapiPath, 'utf8'))

const expectedFieldTypes = [
  'string',
  'number',
  'boolean',
  'date',
  'dateTime',
  'formula',
  'select',
  'multiSelect',
  'link',
  'person',
  'lookup',
  'rollup',
  'attachment',
  'currency',
  'percent',
  'rating',
  'url',
  'email',
  'phone',
  'barcode',
  'location',
  'longText',
  'autoNumber',
  'createdTime',
  'modifiedTime',
  'createdBy',
  'modifiedBy',
]

const expectedViewTypes = [
  'grid',
  'form',
  'kanban',
  'gallery',
  'calendar',
  'timeline',
  'gantt',
  'hierarchy',
]

test('multitable openapi stays aligned with runtime contracts', () => {
  const paths = openapi.paths ?? {}
  const schemas = openapi.components?.schemas ?? {}

  assert.ok(paths['/api/multitable/person-fields/prepare']?.post, 'missing person-field prepare endpoint')
  assert.ok(paths['/api/multitable/templates']?.get, 'missing template catalog endpoint')
  assert.ok(paths['/api/multitable/templates/{templateId}/install']?.post, 'missing template install endpoint')
  assert.ok(paths['/api/multitable/sheets/{sheetId}']?.delete, 'missing sheet delete endpoint')
  assert.ok(paths['/api/multitable/records/{recordId}']?.patch, 'missing single-record patch endpoint')
  assert.ok(paths['/api/multitable/sheets/{sheetId}/import-xlsx']?.post, 'missing xlsx import endpoint')
  assert.ok(paths['/api/multitable/sheets/{sheetId}/export-xlsx']?.get, 'missing xlsx export endpoint')
  assert.ok(
    paths['/api/multitable/sheets/{sheetId}/records/{recordId}/subscriptions']?.get,
    'missing record subscription status endpoint',
  )
  assert.ok(
    paths['/api/multitable/sheets/{sheetId}/records/{recordId}/subscriptions/me']?.put,
    'missing current-user record subscribe endpoint',
  )
  assert.ok(
    paths['/api/multitable/sheets/{sheetId}/records/{recordId}/subscriptions/me']?.delete,
    'missing current-user record unsubscribe endpoint',
  )
  assert.ok(
    paths['/api/multitable/record-subscription-notifications']?.get,
    'missing record subscription notification list endpoint',
  )

  assert.deepEqual(schemas.MultitableFieldType?.enum, expectedFieldTypes)
  assert.deepEqual(schemas.MultitableViewType?.enum, expectedViewTypes)
  assert.equal(
    paths['/api/multitable/templates']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.properties?.templates?.items?.$ref,
    '#/components/schemas/MultitableTemplate',
  )
  assert.equal(
    paths['/api/multitable/templates/{templateId}/install']?.post?.responses?.['201']?.content?.['application/json']?.schema?.properties?.data?.$ref,
    '#/components/schemas/MultitableTemplateInstallResult',
  )
  assert.equal(
    schemas.MultitableTemplateField?.properties?.type?.$ref,
    '#/components/schemas/MultitableFieldType',
  )
  assert.equal(
    schemas.MultitableTemplateView?.properties?.type?.$ref,
    '#/components/schemas/MultitableViewType',
  )
  assert.equal(
    paths['/api/multitable/fields']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.type?.$ref,
    '#/components/schemas/MultitableFieldType',
  )
  assert.equal(
    paths['/api/multitable/fields/{fieldId}']?.patch?.requestBody?.content?.['application/json']?.schema?.properties?.type?.$ref,
    '#/components/schemas/MultitableFieldType',
  )
  assert.equal(
    paths['/api/multitable/views']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.type?.$ref,
    '#/components/schemas/MultitableViewType',
  )
  assert.equal(
    paths['/api/multitable/views/{viewId}']?.patch?.requestBody?.content?.['application/json']?.schema?.properties?.type?.$ref,
    '#/components/schemas/MultitableViewType',
  )
  assert.equal(
    paths['/api/multitable/sheets/{sheetId}/export-xlsx']?.get?.responses?.['200']?.headers?.['X-MetaSheet-XLSX-Truncated']?.schema?.enum?.join(','),
    'true,false',
  )
  assert.equal(
    paths['/api/multitable/sheets/{sheetId}/export-xlsx']?.get?.responses?.['200']?.headers?.['Content-Disposition']?.schema?.type,
    'string',
  )

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
  assert.equal(
    paths['/api/multitable/sheets/{sheetId}/records/{recordId}/subscriptions']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.$ref,
    '#/components/schemas/MultitableRecordSubscriptionStatus',
  )
  assert.equal(
    paths['/api/multitable/sheets/{sheetId}/records/{recordId}/subscriptions/me']?.put?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.$ref,
    '#/components/schemas/MultitableRecordSubscriptionStatus',
  )
  assert.equal(
    paths['/api/multitable/sheets/{sheetId}/records/{recordId}/subscriptions/me']?.delete?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.$ref,
    '#/components/schemas/MultitableRecordSubscriptionStatus',
  )
  assert.equal(
    paths['/api/multitable/record-subscription-notifications']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data?.properties?.items?.items?.$ref,
    '#/components/schemas/MultitableRecordSubscriptionNotification',
  )

  assert.equal(schemas.MultitableView?.properties?.type?.$ref, '#/components/schemas/MultitableViewType')
  assert.equal(schemas.MultitableField?.properties?.type?.$ref, '#/components/schemas/MultitableFieldType')
  assert.deepEqual(
    schemas.MultitableSheetPermissionSubjectType?.enum,
    ['user', 'role', 'member-group'],
  )
  assert.equal(
    schemas.MultitableRecordSubscriptionStatus?.properties?.subscription?.allOf?.[0]?.$ref,
    '#/components/schemas/MultitableRecordSubscription',
  )
  assert.equal(
    schemas.MultitableRecordSubscriptionNotification?.properties?.eventType?.$ref,
    '#/components/schemas/MultitableRecordSubscriptionNotificationType',
  )
  assert.equal(schemas.MultitableView?.properties?.config?.type, 'object')
  assert.equal(schemas.MultitableField?.properties?.options?.items?.properties?.value?.type, 'string')
  assert.equal(
    schemas.MultitableViewData?.properties?.attachmentSummaries?.$ref,
    '#/components/schemas/MultitableViewAttachmentSummaries',
  )
  assert.equal(
    schemas.MultitableViewData?.properties?.meta?.$ref,
    '#/components/schemas/MultitableViewMeta',
  )
  assert.equal(
    schemas.MultitableViewMeta?.properties?.capabilityOrigin?.$ref,
    '#/components/schemas/MultitableCapabilityOrigin',
  )
  assert.equal(
    schemas.MultitableViewMeta?.properties?.permissions?.$ref,
    '#/components/schemas/MultitableScopedPermissions',
  )
  assert.equal(
    schemas.MultitableScopedPermissions?.properties?.fieldPermissions?.$ref,
    '#/components/schemas/MultitableFieldPermissions',
  )
  assert.equal(
    schemas.MultitableScopedPermissions?.properties?.viewPermissions?.$ref,
    '#/components/schemas/MultitableViewPermissions',
  )
  assert.equal(
    schemas.MultitableScopedPermissions?.properties?.rowActions?.$ref,
    '#/components/schemas/MultitableRowActions',
  )
  assert.equal(
    schemas.MultitableScopedPermissions?.properties?.rowActionOverrides?.additionalProperties?.$ref,
    '#/components/schemas/MultitableRowActions',
  )
  assert.equal(
    Object.hasOwn(schemas.MultitableViewData?.properties ?? {}, 'fieldCapabilities'),
    false,
    'view data should not expose stale fieldCapabilities',
  )
  assert.equal(
    Object.hasOwn(schemas.MultitableViewData?.properties ?? {}, 'dependencyGraph'),
    false,
    'view data should not expose stale dependencyGraph',
  )
  assert.equal(
    schemas.MultitableContext?.properties?.capabilityOrigin?.$ref,
    '#/components/schemas/MultitableCapabilityOrigin',
  )
  assert.equal(
    schemas.MultitableContext?.properties?.fieldPermissions?.$ref,
    '#/components/schemas/MultitableFieldPermissions',
  )
  assert.equal(
    schemas.MultitableContext?.properties?.viewPermissions?.$ref,
    '#/components/schemas/MultitableViewPermissions',
  )
  assert.ok(
    schemas.MultitableContext?.required?.includes('capabilityOrigin'),
    'context must document runtime capabilityOrigin',
  )
  assert.ok(
    schemas.MultitableContext?.required?.includes('fieldPermissions'),
    'context must document runtime fieldPermissions',
  )
  assert.equal(
    Object.hasOwn(schemas.MultitableContext?.properties ?? {}, 'fieldCapabilities'),
    false,
    'context should not expose stale fieldCapabilities',
  )
  assert.equal(
    schemas.MultitableRecordContext?.properties?.attachmentSummaries?.$ref,
    '#/components/schemas/MultitableAttachmentSummaryMap',
  )
  assert.equal(
    schemas.MultitableRecordContext?.properties?.capabilityOrigin?.$ref,
    '#/components/schemas/MultitableCapabilityOrigin',
  )
  assert.equal(
    schemas.MultitableRecordContext?.properties?.fieldPermissions?.$ref,
    '#/components/schemas/MultitableFieldPermissions',
  )
  assert.equal(
    schemas.MultitableRecordContext?.properties?.viewPermissions?.$ref,
    '#/components/schemas/MultitableViewPermissions',
  )
  assert.equal(
    schemas.MultitableRecordContext?.properties?.rowActions?.$ref,
    '#/components/schemas/MultitableRowActions',
  )
  assert.ok(
    schemas.MultitableRecordContext?.required?.includes('capabilityOrigin'),
    'record context must document runtime capabilityOrigin',
  )
  assert.ok(
    schemas.MultitableRecordContext?.required?.includes('fieldPermissions'),
    'record context must document runtime fieldPermissions',
  )
  assert.ok(
    schemas.MultitableRecordContext?.required?.includes('rowActions'),
    'record context must document runtime rowActions',
  )
  assert.equal(
    Object.hasOwn(schemas.MultitableRecordContext?.properties ?? {}, 'fieldCapabilities'),
    false,
    'record context should not expose stale fieldCapabilities',
  )
  assert.equal(
    Object.hasOwn(schemas.MultitableRecordContext?.properties ?? {}, 'dependencyGraph'),
    false,
    'record context should not expose stale dependencyGraph',
  )
  assert.equal(
    schemas.MultitableCapabilityOrigin?.properties?.source?.enum?.join(','),
    'admin,global-rbac,sheet-grant,sheet-scope',
  )
  assert.deepEqual(
    schemas.MultitableCapabilities?.required?.filter((key) => key === 'canManageSheetAccess' || key === 'canExport'),
    ['canManageSheetAccess', 'canExport'],
  )
  assert.equal(
    schemas.MultitableFormContext?.properties?.attachmentSummaries?.$ref,
    '#/components/schemas/MultitableAttachmentSummaryMap',
  )
  assert.equal(
    schemas.MultitableFormContext?.properties?.capabilityOrigin?.$ref,
    '#/components/schemas/MultitableCapabilityOrigin',
  )
  assert.equal(
    schemas.MultitableFormContext?.properties?.fieldPermissions?.$ref,
    '#/components/schemas/MultitableFieldPermissions',
  )
  assert.equal(
    schemas.MultitableFormContext?.properties?.viewPermissions?.$ref,
    '#/components/schemas/MultitableViewPermissions',
  )
  assert.equal(
    schemas.MultitableFormContext?.properties?.rowActions?.$ref,
    '#/components/schemas/MultitableRowActions',
  )
  assert.ok(
    schemas.MultitableFormContext?.required?.includes('fieldPermissions'),
    'form context must document runtime fieldPermissions',
  )
  assert.equal(
    Object.hasOwn(schemas.MultitableFormContext?.properties ?? {}, 'fieldCapabilities'),
    false,
    'form context should not expose stale fieldCapabilities',
  )
  assert.equal(
    Object.hasOwn(schemas.MultitableFormContext?.properties ?? {}, 'dependencyGraph'),
    false,
    'form context should not expose stale dependencyGraph',
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
