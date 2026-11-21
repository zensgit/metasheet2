import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Schema = {
  $ref?: string
  type?: string
  additionalProperties?: boolean
  required?: string[]
  enum?: unknown[]
  nullable?: boolean
  pattern?: string
  properties?: Record<string, Schema>
  allOf?: Schema[]
  not?: { required: string[] }
}
type Operation = {
  operationId: string
  security: Array<{ bearerAuth: unknown[] }>
  requestBody: { content: { 'application/json': { schema: Schema } } }
  responses: Record<string, {
    headers?: Record<string, { schema: Schema }>
    content?: { 'application/json': { schema: Schema } }
  }>
}
type Document = { components: { schemas: Record<string, Schema> }; paths: Record<string, Record<string, Operation>> }

const openapiRoot = resolve(__dirname, '../../../openapi')
const readYaml = (path: string) => yaml.load(readFileSync(resolve(openapiRoot, path), 'utf8')) as Document
const source = readYaml('src/base.yml')
source.paths = Object.assign({}, ...[
  'me-notifications', 'admin-directory-notification', 'admin-directory-capabilities',
].map((name) => readYaml(`src/paths/${name}.yml`).paths))
const documents: Array<[string, Document]> = [
  ['source', source],
  ['combined', readYaml('dist/combined.openapi.yml')],
  ['yaml', readYaml('dist/openapi.yaml')],
  ['json', JSON.parse(readFileSync(resolve(openapiRoot, 'dist/openapi.json'), 'utf8')) as Document],
]
const testPath = '/api/me/notification-endpoints/{id}/test'
const verificationPath = '/api/admin/directory/notification-verification'

describe('N78 07b notification OpenAPI', () => {
  for (const [name, document] of documents) {
    const schemas = document.components.schemas

    it(`${name}: test request has no recipient/content input and the UI-compatible result has three outcomes`, () => {
      const input = schemas.NotificationTestSendRequest
      expect(input.additionalProperties).toBe(false)
      expect(input.required).toEqual(['confirm', 'idempotencyKey'])
      expect(Object.keys(input.properties!)).toEqual(['confirm', 'idempotencyKey'])
      expect(input.properties!.confirm.enum).toEqual([true])
      const pattern = new RegExp(input.properties!.idempotencyKey.pattern!)
      for (const key of ['test_123', '1234567', 'x'.repeat(65), 'bad key 1', 'abc12345\n', 'a/bc12345']) {
        expect(pattern.test(key)).toBe(key === 'test_123')
      }
      const result = schemas.NotificationTestSendResult
      expect(result.additionalProperties).toBe(false)
      expect(result.required).toEqual(['outcome', 'code', 'testSendId'])
      expect(result.properties!.outcome.enum).toEqual(['accepted', 'failed', 'outcome_unknown'])
      const operation = document.paths[testPath].post
      expect(operation.security).toEqual([{ bearerAuth: [] }])
      expect(Object.keys(operation.responses).sort()).toEqual(['200', '401', '404', '409', '422', '429', '500', '503'])
      expect(operation.responses['429'].headers!['Retry-After'].schema.type).toBe('integer')
    })

    it(`${name}: endpoint listing exposes live delivery availability with the locked reason vocabulary`, () => {
      const delivery = schemas.NotificationEndpointListing.properties!.delivery
      expect(delivery.required).toEqual(['enabled', 'testSendAvailable', 'reason'])
      expect(delivery.properties!.enabled).toEqual({ type: 'boolean' })
      expect(delivery.properties!.testSendAvailable).toEqual({ type: 'boolean' })
      expect(delivery.properties!.reason.nullable).toBe(true)
      expect(delivery.properties!.reason.enum).toEqual(['delivery_disabled', 'capability_off', 'not_verified', 'endpoint_unusable', null])
    })

    it(`${name}: only admin verification accepts a recipient and the evidence response contains no fingerprint`, () => {
      const input = schemas.NotificationVerificationRequest
      expect(input.additionalProperties).toBe(false)
      expect(input.required).toEqual(['integrationId', 'level'])
      expect(Object.keys(input.properties!)).toEqual(['integrationId', 'level', 'recipientUserId'])
      expect(input.properties!.level.enum).toEqual(['token', 'send'])
      expect(input.properties!.recipientUserId.pattern).toBe('^[^\\s,]{1,64}$')
      expect(schemas.NotificationVerificationResult.required).toEqual(['result', 'evidence'])
      const evidence = schemas.NotificationVerificationSummary
      expect(evidence.additionalProperties).toBe(false)
      expect(Object.keys(evidence.properties!)).toEqual(['level', 'verifiedUntil', 'valid'])
      const report = schemas.NotificationVerificationReport
      expect(report.additionalProperties).toBe(false)
      expect(Object.keys(report.properties!)).toEqual([
        'integrationId', 'integration', 'requestedLevel', 'reachedLevel', 'passed', 'scope',
        'resolution', 'accessToken', 'notification', 'failure',
      ])
      expect(JSON.stringify(report)).not.toMatch(/tupleFingerprint|tuple_fingerprint|recipientUserId"/)
      expect(document.paths[verificationPath].post.security).toEqual([{ bearerAuth: [] }])
    })

    it(`${name}: the gated notification capability cannot carry legacy details`, () => {
      const notification = schemas.DirectoryIntegrationCapabilities.properties!.capabilities.properties!.notification
      expect(notification.$ref).toBe('#/components/schemas/DirectoryIntegrationNotificationCapability')
      const state = schemas.DirectoryIntegrationNotificationCapability
      expect(state.additionalProperties).toBe(false)
      expect(Object.keys(state.properties!)).toEqual(['enabled', 'governance', 'effective', 'reason', 'anchor'])
      expect(state.properties!.governance.enum).toEqual(['gated', 'unsupported'])
      expect(state.properties!.reason.enum).not.toContain('governed_by_legacy_path')
      for (const property of ['enabled', 'effective', 'anchor']) {
        expect(state.properties![property]).toEqual(schemas.DirectoryIntegrationCapability.properties![property])
      }
    })
  }

  it('generated contracts retain the same notification paths and schemas as the source', () => {
    for (const [, document] of documents.slice(1)) {
      for (const path of Object.keys(source.paths)) expect(document.paths[path]).toEqual(source.paths[path])
      for (const [name, schema] of Object.entries(source.components.schemas)) {
        if (name.startsWith('Notification') || name.startsWith('DirectoryIntegrationCapabilit')) {
          expect(document.components.schemas[name]).toEqual(schema)
        }
      }
    }
    const sdk = readFileSync(resolve(openapiRoot, 'dist-sdk/index.d.ts'), 'utf8')
    expect(sdk).toContain(`"${testPath}"`)
    expect(sdk).toContain(`"${verificationPath}"`)
    expect(sdk).toContain('testMyNotificationEndpoint: {')
    expect(sdk).toContain('verifyDirectoryNotificationConnection: {')
    expect(sdk).toContain('outcome: "accepted" | "failed" | "outcome_unknown";')
    const notificationType = sdk.split('DirectoryIntegrationNotificationCapability: {')[1].split('DirectoryIntegrationCapabilities: {')[0]
    expect(notificationType).not.toContain('legacy')
  })
})
