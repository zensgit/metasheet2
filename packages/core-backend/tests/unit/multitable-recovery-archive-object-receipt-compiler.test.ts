import { createHash } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  compileRecoveryArchiveObjectReceipt,
  RecoveryArchiveObjectReceiptCompilerError,
  type RecoveryArchiveObjectReceiptCompileInput,
} from '../../src/multitable/recovery-archive-object-receipt-compiler'
import type { RecoveryArchiveTransactionDepthProbe } from '../../src/multitable/recovery-archive-crypto'
import type {
  RecoveryArchiveObjectDescriptor,
  RecoveryArchiveObjectPutOutcome,
  RecoveryArchiveObjectPutRequest,
  RecoveryArchiveObjectStoreProvider,
} from '../../src/multitable/recovery-archive-object-store'
import {
  recordRecoveryArchiveObjectUploaded,
  type RecoveryArchiveObjectReceiptEvidence,
} from '../../src/multitable/recovery-archive-object-receipts'

const GENERATION_ID = '11111111-2222-3333-4444-555555555555'
const OBJECT_ID = 'a'.repeat(64)
const PLAINTEXT_SHA256 = 'f'.repeat(64)
const BYTES = Buffer.from('sealed-section-ciphertext', 'utf8')
const EXPIRES_AT = '2027-08-28T00:00:00.000Z'
const SHA256_HEX = /^[0-9a-f]{64}$/

const INVALID_INPUT = 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT'
const TRANSACTION_REFUSED = 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_TRANSACTION_REFUSED'
const PROVIDER_FAILED = 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_PROVIDER_FAILED'

const EVIDENCE_KEYS = [
  'attachmentId',
  'ciphertextSha256',
  'generationId',
  'headReceiptSha256',
  'idempotencyKey',
  'keyId',
  'objectClass',
  'objectId',
  'ownerFence',
  'ownerId',
  'ownerKind',
  'plaintextSha256',
  'providerVersion',
  'putReceiptSha256',
  'sectionName',
  'sizeBytes',
]

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function makeObject(overrides: Partial<RecoveryArchiveObjectPutRequest> = {}): RecoveryArchiveObjectPutRequest {
  const bytes = new Uint8Array(overrides.bytes ?? BYTES)
  return {
    generationId: GENERATION_ID,
    objectId: OBJECT_ID,
    version: 'provider-version-1',
    expiresAt: EXPIRES_AT,
    pinned: false,
    ...overrides,
    bytes,
    sha256: overrides.sha256 ?? digest(bytes),
    size: overrides.size ?? String(bytes.byteLength),
  }
}

function descriptorOf(object: RecoveryArchiveObjectPutRequest): RecoveryArchiveObjectDescriptor {
  return {
    generationId: object.generationId,
    objectId: object.objectId,
    version: object.version,
    sha256: object.sha256,
    size: object.size,
    expiresAt: object.expiresAt,
    pinned: object.pinned,
  }
}

interface FakeProviderOptions {
  putOutcome?: RecoveryArchiveObjectPutOutcome
  putResultObject?: unknown
  putError?: unknown
  headResult?: unknown
  headError?: unknown
  onPut?: (request: RecoveryArchiveObjectPutRequest) => void
  onHead?: (request: unknown) => void
  capturePutResult?: (result: { outcome: RecoveryArchiveObjectPutOutcome; object: RecoveryArchiveObjectDescriptor }) => void
}

type FakeProvider = RecoveryArchiveObjectStoreProvider & { calls: string[] }

function createFakeProvider(object: RecoveryArchiveObjectPutRequest, options: FakeProviderOptions = {}): FakeProvider {
  const calls: string[] = []
  const descriptor = descriptorOf(object)
  return {
    calls,
    async put(request) {
      calls.push('put')
      options.onPut?.(request)
      if ('putError' in options) throw options.putError
      const result = {
        outcome: options.putOutcome ?? 'created',
        object: 'putResultObject' in options ? options.putResultObject : { ...descriptor },
      }
      options.capturePutResult?.(result as { outcome: RecoveryArchiveObjectPutOutcome; object: RecoveryArchiveObjectDescriptor })
      return result as never
    },
    async get() {
      throw new Error('unexpected_get')
    },
    async head(request) {
      calls.push('head')
      options.onHead?.(request)
      if ('headError' in options) throw options.headError
      if ('headResult' in options) return options.headResult as never
      return { ...descriptor }
    },
    async deleteExpired() {
      throw new Error('unexpected_deleteExpired')
    },
    async pin() {
      throw new Error('unexpected_pin')
    },
  }
}

function depthProbe(...depths: unknown[]): RecoveryArchiveTransactionDepthProbe {
  let index = 0
  return {
    currentTransactionDepth() {
      const depth = depths[Math.min(index, depths.length - 1)]
      index += 1
      return depth as number
    },
  }
}

function throwingProbe(): RecoveryArchiveTransactionDepthProbe {
  return {
    currentTransactionDepth() {
      throw new Error('depth_source_secret')
    },
  }
}

function makeInput(overrides: Partial<RecoveryArchiveObjectReceiptCompileInput> = {}): RecoveryArchiveObjectReceiptCompileInput {
  const object = overrides.object ?? makeObject()
  return {
    provider: createFakeProvider(object),
    transactionDepth: depthProbe(0),
    object,
    objectClass: 'section',
    sectionName: 'records',
    attachmentId: null,
    keyId: 'key-1',
    plaintextSha256: PLAINTEXT_SHA256,
    ownerKind: 'worker',
    ownerId: 'worker-1',
    ownerFence: '1',
    ...overrides,
  }
}

async function compilerErrorOf(run: () => Promise<unknown>): Promise<RecoveryArchiveObjectReceiptCompilerError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveObjectReceiptCompilerError)
    return error as RecoveryArchiveObjectReceiptCompilerError
  }
  throw new Error('expected_receipt_compiler_refusal')
}

function expectValuesFree(error: RecoveryArchiveObjectReceiptCompilerError, forbidden: readonly string[]): void {
  expect(error.message).toBe(error.code)
  expect('cause' in error).toBe(false)
  const surface = `${error.name}\n${error.message}\n${error.stack ?? ''}`
  for (const value of forbidden) {
    expect(surface).not.toContain(value)
  }
}

describe('Phase D-H2 compileRecoveryArchiveObjectReceipt', () => {
  test('created and existing PUT outcomes produce byte-identical evidence in PUT-then-HEAD order', async () => {
    // Guard-mutation discriminator: folding the PUT outcome into any digest, or skipping HEAD,
    // turns this test red.
    const object = makeObject()
    const createdProvider = createFakeProvider(object, { putOutcome: 'created' })
    const existingProvider = createFakeProvider(object, { putOutcome: 'existing' })

    const created = await compileRecoveryArchiveObjectReceipt(makeInput({ object, provider: createdProvider }))
    const existing = await compileRecoveryArchiveObjectReceipt(makeInput({ object, provider: existingProvider }))

    expect(createdProvider.calls).toEqual(['put', 'head'])
    expect(existingProvider.calls).toEqual(['put', 'head'])
    expect(existing).toEqual(created)

    expect(Object.keys(created).sort()).toEqual(EVIDENCE_KEYS)
    expect(Object.isFrozen(created)).toBe(true)
    expect(created).toMatchObject({
      generationId: object.generationId,
      objectId: object.objectId,
      objectClass: 'section',
      sectionName: 'records',
      attachmentId: null,
      keyId: 'key-1',
      providerVersion: object.version,
      plaintextSha256: PLAINTEXT_SHA256,
      ciphertextSha256: object.sha256,
      sizeBytes: object.size,
      ownerKind: 'worker',
      ownerId: 'worker-1',
      ownerFence: '1',
      idempotencyKey: 'badbabda4297661659ce9439bb4375a6617da13c0f0ccc5e0f77a9fa089ed8ab',
      putReceiptSha256: 'a4fb5b18b4d3f09e18627dad8c08b64ea3c0bbb4cfad8478776c0566359fce96',
      headReceiptSha256: '5d9f2c2520ec5d10ee7595857f2405aa2af1a2c288fc39c24c3423544a6b4453',
    })
    expect(created.idempotencyKey).toMatch(SHA256_HEX)
    expect(created.putReceiptSha256).toMatch(SHA256_HEX)
    expect(created.headReceiptSha256).toMatch(SHA256_HEX)
    expect(new Set([created.idempotencyKey, created.putReceiptSha256, created.headReceiptSha256]).size).toBe(3)
  })

  test('compiled evidence is admissible to the existing DB receipt authority normalization', async () => {
    const evidence = await compileRecoveryArchiveObjectReceipt(makeInput())
    const result = await recordRecoveryArchiveObjectUploaded(
      async () => ({
        rows: [
          {
            generation_id: evidence.generationId,
            object_id: evidence.objectId,
            object_class: evidence.objectClass,
            section_name: evidence.sectionName,
            attachment_id: evidence.attachmentId,
            state: 'uploaded',
          },
        ],
        rowCount: 1,
      }),
      evidence,
    )
    expect(result).toEqual({
      generationId: evidence.generationId,
      objectId: evidence.objectId,
      objectClass: evidence.objectClass,
      sectionName: evidence.sectionName,
      attachmentId: evidence.attachmentId,
      state: 'uploaded',
    })
  })

  test('changing every immutable identity/binding/classification field changes all three digests', async () => {
    const object = makeObject()
    const base = await compileRecoveryArchiveObjectReceipt(makeInput({ object }))
    const variants: Array<[string, () => Promise<RecoveryArchiveObjectReceiptEvidence>]> = [
      ['generationId', () => compileRecoveryArchiveObjectReceipt(makeInput({ object: makeObject({ generationId: '22222222-3333-4444-5555-666666666666' }) }))],
      ['objectId', () => compileRecoveryArchiveObjectReceipt(makeInput({ object: makeObject({ objectId: 'b'.repeat(64) }) }))],
      ['version', () => compileRecoveryArchiveObjectReceipt(makeInput({ object: makeObject({ version: 'provider-version-2' }) }))],
      ['bytes/hash/size', () => compileRecoveryArchiveObjectReceipt(makeInput({ object: makeObject({ bytes: Buffer.from('other-ciphertext') }) }))],
      ['expiresAt', () => compileRecoveryArchiveObjectReceipt(makeInput({ object: makeObject({ expiresAt: '2028-01-01T00:00:00.000Z' }) }))],
      ['pinned', () => compileRecoveryArchiveObjectReceipt(makeInput({ object: makeObject({ pinned: true }) }))],
      ['keyId', () => compileRecoveryArchiveObjectReceipt(makeInput({ object, keyId: 'key-2' }))],
      ['plaintextSha256', () => compileRecoveryArchiveObjectReceipt(makeInput({ object, plaintextSha256: 'e'.repeat(64) }))],
      ['objectClass manifest', () => compileRecoveryArchiveObjectReceipt(makeInput({ object, objectClass: 'manifest', sectionName: null }))],
      ['objectClass attachment', () => compileRecoveryArchiveObjectReceipt(makeInput({ object, objectClass: 'attachment', sectionName: null, attachmentId: 'attachment-1' }))],
      ['sectionName', () => compileRecoveryArchiveObjectReceipt(makeInput({ object, sectionName: 'links' }))],
    ]
    for (const [name, run] of variants) {
      const changed = await run()
      expect(changed.idempotencyKey, name).not.toBe(base.idempotencyKey)
      expect(changed.putReceiptSha256, name).not.toBe(base.putReceiptSha256)
      expect(changed.headReceiptSha256, name).not.toBe(base.headReceiptSha256)
    }

    const firstAttachment = await compileRecoveryArchiveObjectReceipt(
      makeInput({ object, objectClass: 'attachment', sectionName: null, attachmentId: 'attachment-1' }),
    )
    const secondAttachment = await compileRecoveryArchiveObjectReceipt(
      makeInput({ object, objectClass: 'attachment', sectionName: null, attachmentId: 'attachment-2' }),
    )
    expect(secondAttachment.idempotencyKey).not.toBe(firstAttachment.idempotencyKey)
    expect(secondAttachment.putReceiptSha256).not.toBe(firstAttachment.putReceiptSha256)
    expect(secondAttachment.headReceiptSha256).not.toBe(firstAttachment.headReceiptSha256)
  })

  test('owner/fence takeover preserves all three digests but changes the returned owner fields', async () => {
    const object = makeObject()
    const base = await compileRecoveryArchiveObjectReceipt(makeInput({ object }))
    const taken = await compileRecoveryArchiveObjectReceipt(
      makeInput({ object, ownerKind: 'worker-takeover', ownerId: 'worker-9', ownerFence: '7' }),
    )

    expect(taken.idempotencyKey).toBe(base.idempotencyKey)
    expect(taken.putReceiptSha256).toBe(base.putReceiptSha256)
    expect(taken.headReceiptSha256).toBe(base.headReceiptSha256)
    expect(taken.ownerKind).toBe('worker-takeover')
    expect(taken.ownerId).toBe('worker-9')
    expect(taken.ownerFence).toBe('7')
  })

  test('invalid input/classification/proxy/accessor/sparse or aliased byte shapes refuse before any provider call', async () => {
    const mutations: Array<[string, (input: RecoveryArchiveObjectReceiptCompileInput) => void]> = [
      ['missing key', (input) => { delete (input as Record<string, unknown>).keyId }],
      ['extra key', (input) => { (input as Record<string, unknown>).unexpected = 'x' }],
      ['symbol key on input', (input) => { Object.defineProperty(input, Symbol('unexpected'), { value: 'x' }) }],
      ['accessor on input', (input) => { Object.defineProperty(input, 'keyId', { get: () => 'key-1', configurable: true }) }],
      ['accessor on object', (input) => { Object.defineProperty(input.object, 'version', { get: () => 'provider-version-1', configurable: true }) }],
      ['sparse object', (input) => { delete (input.object as Record<string, unknown>).pinned }],
      ['symbol key on object', (input) => { Object.defineProperty(input.object, Symbol('unexpected'), { value: 'x' }) }],
      ['null provider', (input) => { input.provider = null as never }],
      ['null transactionDepth', (input) => { input.transactionDepth = null as never }],
      ['bytes as string', (input) => { input.object.bytes = 'not-bytes' as never }],
      ['bytes as plain array', (input) => { input.object.bytes = [1, 2, 3] as never }],
      ['bytes as aliased shape', (input) => { input.object.bytes = { byteLength: 4, buffer: new ArrayBuffer(8) } as never }],
      ['bytes as dataview', (input) => { input.object.bytes = new DataView(new ArrayBuffer(4)) as never }],
      ['byte/hash mismatch', (input) => { input.object.sha256 = '0'.repeat(64) }],
      ['byte/size mismatch', (input) => { input.object.size = String(input.object.bytes.byteLength + 1) }],
      ['generationId shape', (input) => { input.object.generationId = 'not-a-uuid' }],
      ['objectId shape', (input) => { input.object.objectId = 'abc' }],
      ['version blank', (input) => { input.object.version = ' ' }],
      ['version non-opaque', (input) => { input.object.version = 'has space' }],
      ['sha256 uppercase', (input) => { input.object.sha256 = input.object.sha256.toUpperCase() }],
      ['expiresAt shape', (input) => { input.object.expiresAt = '2027-08-28' }],
      ['pinned non-boolean', (input) => { input.object.pinned = 'false' as never }],
      ['objectClass unknown', (input) => { input.objectClass = 'chunk' as never }],
      ['section with attachmentId', (input) => { input.attachmentId = 'attachment-1' }],
      ['section with null name', (input) => { input.sectionName = null }],
      ['section with non-canonical name', (input) => { input.sectionName = 'bogus' as never }],
      ['attachment keeping sectionName', (input) => { input.objectClass = 'attachment'; input.attachmentId = 'attachment-1' }],
      ['attachment with null id', (input) => { input.objectClass = 'attachment'; input.sectionName = null }],
      ['attachment with blank id', (input) => { input.objectClass = 'attachment'; input.sectionName = null; input.attachmentId = '   ' }],
      ['attachment with non-opaque id', (input) => { input.objectClass = 'attachment'; input.sectionName = null; input.attachmentId = 'has space' }],
      ['manifest keeping sectionName', (input) => { input.objectClass = 'manifest' }],
      ['manifest with attachmentId', (input) => { input.objectClass = 'manifest'; input.sectionName = null; input.attachmentId = 'attachment-1' }],
      ['keyId blank', (input) => { input.keyId = '' }],
      ['plaintextSha256 shape', (input) => { input.plaintextSha256 = 'zz' }],
      ['ownerKind blank', (input) => { input.ownerKind = '' }],
      ['ownerId non-opaque', (input) => { input.ownerId = 'has space' }],
      ['ownerFence zero', (input) => { input.ownerFence = '0' }],
      ['ownerFence non-canonical', (input) => { input.ownerFence = '01' }],
    ]
    for (const [name, mutate] of mutations) {
      const input = makeInput()
      const provider = input.provider as FakeProvider
      mutate(input)
      const error = await compilerErrorOf(() => compileRecoveryArchiveObjectReceipt(input))
      expect(error.code, name).toBe(INVALID_INPUT)
      expect(provider.calls, name).toEqual([])
    }

    const { proxy, revoke } = Proxy.revocable(makeInput(), {})
    revoke()
    const proxyError = await compilerErrorOf(() =>
      compileRecoveryArchiveObjectReceipt(proxy as RecoveryArchiveObjectReceiptCompileInput),
    )
    expect(proxyError.code).toBe(INVALID_INPUT)
  })

  test('provider drift, missing HEAD, provider throws, and typed-looking hostile errors normalize values-free', async () => {
    const PROVIDER_SECRET = 'secret-provider-host:5432'
    const cases: Array<[string, (descriptor: RecoveryArchiveObjectDescriptor) => FakeProviderOptions]> = [
      ['put outcome drift', () => ({ putOutcome: 'replaced' as RecoveryArchiveObjectPutOutcome })],
      ['put object drift', (descriptor) => ({ putResultObject: { ...descriptor, version: 'drifted-version' } })],
      ['put result extra key', (descriptor) => ({ putResultObject: { ...descriptor, extra: 'x' } })],
      ['put throws', () => ({ putError: new Error(PROVIDER_SECRET) })],
      ['put throws typed-looking compiler error', () => ({
        putError: new RecoveryArchiveObjectReceiptCompilerError(TRANSACTION_REFUSED),
      })],
      ['put throws fake code object', () => ({ putError: { code: TRANSACTION_REFUSED, message: PROVIDER_SECRET } })],
      ['head missing', () => ({ headResult: null })],
      ['head drift', (descriptor) => ({ headResult: { ...descriptor, sha256: '0'.repeat(64) } })],
      ['head pin drift', (descriptor) => ({ headResult: { ...descriptor, pinned: !descriptor.pinned } })],
      ['head result extra key', (descriptor) => ({ headResult: { ...descriptor, extra: 'x' } })],
      ['head garbage', () => ({ headResult: 'garbage' })],
      ['head throws', () => ({ headError: new Error(PROVIDER_SECRET) })],
    ]
    for (const [name, optionsOf] of cases) {
      const object = makeObject()
      const provider = createFakeProvider(object, optionsOf(descriptorOf(object)))
      const error = await compilerErrorOf(() => compileRecoveryArchiveObjectReceipt(makeInput({ object, provider })))
      expect(error.code, name).toBe(PROVIDER_FAILED)
      expectValuesFree(error, [PROVIDER_SECRET])
    }
  })

  test('nonzero or unreadable transaction depth refuses with zero provider calls', async () => {
    // Guard-mutation discriminator: dropping the transaction check turns this test red.
    const probes: Array<[string, RecoveryArchiveTransactionDepthProbe]> = [
      ['depth 1', depthProbe(1)],
      ['throwing probe', throwingProbe()],
      ['NaN depth', depthProbe(Number.NaN)],
      ['negative depth', depthProbe(-1)],
      ['fractional depth', depthProbe(0.5)],
      ['non-number depth', depthProbe('0')],
    ]
    for (const [name, transactionDepth] of probes) {
      const object = makeObject()
      const provider = createFakeProvider(object)
      const error = await compilerErrorOf(() =>
        compileRecoveryArchiveObjectReceipt(makeInput({ object, provider, transactionDepth })),
      )
      expect(error.code, name).toBe(TRANSACTION_REFUSED)
      expect(provider.calls, name).toEqual([])
      expectValuesFree(error, ['depth_source_secret'])
    }
  })

  test('a depth that opens between PUT and HEAD makes HEAD refuse after exactly one PUT', async () => {
    const object = makeObject()
    const provider = createFakeProvider(object)
    const error = await compilerErrorOf(() =>
      compileRecoveryArchiveObjectReceipt(makeInput({ object, provider, transactionDepth: depthProbe(0, 1) })),
    )
    expect(error.code).toBe(TRANSACTION_REFUSED)
    expect(provider.calls).toEqual(['put'])
  })

  test('post-invocation caller mutation cannot alter the snapshotted evidence', async () => {
    const expected = await compileRecoveryArchiveObjectReceipt(makeInput({ object: makeObject() }))
    const input = makeInput({ object: makeObject() })

    const pending = compileRecoveryArchiveObjectReceipt(input)
    // The snapshot is taken synchronously before the first await, so none of this is visible.
    input.object.bytes[0] = input.object.bytes[0] ^ 0xff
    input.object.version = 'caller-mutated'
    input.object.sha256 = '0'.repeat(64)
    input.keyId = 'caller-mutated'
    input.sectionName = 'links'
    input.ownerId = 'caller-mutated'
    input.ownerFence = '9'

    const evidence = await pending
    expect(evidence).toEqual(expected)
  })

  test('provider request and result mutation cannot alter the returned evidence', async () => {
    const expected = await compileRecoveryArchiveObjectReceipt(makeInput({ object: makeObject() }))
    const object = makeObject()
    let retainedResult: { outcome: RecoveryArchiveObjectPutOutcome; object: RecoveryArchiveObjectDescriptor } | undefined
    const provider = createFakeProvider(object, {
      onPut: (request) => {
        request.bytes[0] = request.bytes[0] ^ 0xff
        request.version = 'provider-mutated'
        request.sha256 = '0'.repeat(64)
      },
      onHead: (request) => {
        (request as Record<string, unknown>).expectedSha256 = '0'.repeat(64)
      },
      capturePutResult: (result) => {
        retainedResult = result
      },
    })
    const input = makeInput({ object, provider })

    const evidence = await compileRecoveryArchiveObjectReceipt(input)
    expect(evidence).toEqual(expected)

    // Mutating every alias still held after completion changes nothing: the evidence is frozen
    // and was derived only from the validated immutable snapshot, never from provider objects.
    if (!retainedResult) throw new Error('expected_captured_put_result')
    retainedResult.object.version = 'post-return-mutation'
    input.object.version = 'post-return-mutation'
    expect(evidence.providerVersion).toBe('provider-version-1')
    expect(evidence).toEqual(expected)
  })
})
