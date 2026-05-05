import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const rootDir = path.resolve(import.meta.dirname, '../..')
const contractPath = path.join(rootDir, 'docs/api/multitable-yjs-events.asyncapi.json')
const backendPath = path.join(rootDir, 'packages/core-backend/src/collab/yjs-websocket-adapter.ts')
const frontendPath = path.join(rootDir, 'apps/web/src/multitable/composables/useYjsDocument.ts')

const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
const backend = readFileSync(backendPath, 'utf8')
const frontend = readFileSync(frontendPath, 'utf8')

const clientEvents = [
  'yjs:subscribe',
  'yjs:message',
  'yjs:update',
  'yjs:presence',
  'yjs:unsubscribe',
]

const serverEvents = [
  'yjs:message',
  'yjs:update',
  'yjs:presence',
  'yjs:error',
  'yjs:invalidated',
]

function collectMessageNames(operation) {
  return operation.message.oneOf
    .map((entry) => entry.$ref.replace('#/components/messages/', ''))
    .map((messageKey) => contract.components.messages[messageKey]?.name)
    .filter(Boolean)
}

test('multitable yjs AsyncAPI contract stays aligned with runtime event names', () => {
  assert.equal(contract.asyncapi, '2.6.0')
  assert.equal(contract.servers.yjs.url, '/yjs')
  assert.equal(contract.servers.yjs.protocol, 'socket.io')

  const channel = contract.channels['/yjs']
  assert.ok(channel, 'missing /yjs channel')
  assert.equal(channel.bindings.socketio.namespace, '/yjs')

  assert.deepEqual(collectMessageNames(channel.publish), clientEvents)
  assert.deepEqual(collectMessageNames(channel.subscribe), serverEvents)

  for (const eventName of clientEvents) {
    assert.match(backend, new RegExp(`socket\\.on\\(\\s*['"]${eventName.replace(':', '\\:')}['"]`), `backend does not listen for ${eventName}`)
  }

  for (const eventName of serverEvents) {
    assert.match(backend, new RegExp(`\\.emit\\(\\s*['"]${eventName.replace(':', '\\:')}['"]`), `backend does not emit ${eventName}`)
  }

  assert.match(frontend, /socketIO\('\/yjs'/, 'frontend does not connect to /yjs namespace')
  for (const eventName of clientEvents) {
    assert.match(frontend, new RegExp(`\\.emit\\(\\s*['"]${eventName.replace(':', '\\:')}['"]`), `frontend does not emit ${eventName}`)
  }
  for (const eventName of serverEvents) {
    assert.match(frontend, new RegExp(`socket\\.on\\(\\s*['"]${eventName.replace(':', '\\:')}['"]`), `frontend does not handle ${eventName}`)
  }
})

test('multitable yjs contract preserves auth, permission, and invalidation semantics', () => {
  const errorCodeEnum = contract.components.schemas.YjsError.properties.code.enum
  assert.deepEqual(errorCodeEnum, ['UNAUTHENTICATED', 'NOT_FOUND', 'FORBIDDEN'])
  assert.deepEqual(contract.components.schemas.YjsInvalidated.properties.reason.enum, ['rest-write'])

  assert.match(backend, /UNAUTHENTICATED: token required/, 'missing handshake token-required rejection')
  assert.match(backend, /UNAUTHENTICATED: invalid token/, 'missing handshake invalid-token rejection')
  assert.match(backend, /code: 'NOT_FOUND', message: 'Record not found'/, 'missing record not-found error')
  assert.match(backend, /code: 'FORBIDDEN', message: 'No read access'/, 'missing read access error')
  assert.match(backend, /code: 'FORBIDDEN', message: 'No write access'/, 'missing write access error')
  assert.match(backend, /code: 'FORBIDDEN', message: 'Not subscribed'/, 'missing not-subscribed error')
  assert.match(backend, /reason: 'rest-write'/, 'missing rest-write invalidation reason')

  assert.equal(
    contract.components.schemas.YjsPresenceSnapshot.required.join(','),
    'recordId,activeCount,users',
  )
  assert.equal(
    contract.components.schemas.YjsPresenceUser.required.join(','),
    'id,fieldIds',
  )
})
