import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import * as adminGrantCodec from '../../src/auth/admin-login-grant-intent'
import {
  ADMIN_GRANT_INTENT_HASH_DOMAIN,
  ADMIN_GRANT_PURPOSE_REGISTRY,
  AdminGrantIntentError,
  encodeAdminGrantIntent,
  hashAdminGrantIntent,
  normalizeAdminGrantIntent,
} from '../../src/auth/admin-login-grant-intent'
import unitConfig from '../../vitest.config'
import { importEdgeViolations, importSpecifiers, listSourceFiles, NON_LITERAL_SPECIFIER } from '../helpers/import-edge-allowlist'

const BACKEND_ROOT = path.resolve(__dirname, '..', '..')
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..', '..')
const MODULE_PATH = path.join(BACKEND_ROOT, 'src/auth/admin-login-grant-intent.ts')
const MODULE_STEM = 'admin-login-grant-intent'
const READER_PATH = path.join(BACKEND_ROOT, 'src/auth/admin-grant-receiving-reader.ts')
const READER_STEM = 'admin-grant-receiving-reader'
const READER_EDGE = ['packages/core-backend/src/auth/admin-grant-receiving-reader.ts', './admin-login-grant-intent'] as const
const CODEC_IMPORT_EDGES = [
  READER_EDGE,
  ['packages/core-backend/src/auth/admin-grant-proof-storage.ts', './admin-login-grant-intent'],
  ['packages/core-backend/src/auth/admin-grant-proof.ts', './admin-login-grant-intent'],
  ['packages/core-backend/src/auth/admin-grant-proof.ts', './admin-login-grant-intent'],
  ['packages/core-backend/src/auth/admin-login-grant-command.ts', './admin-login-grant-intent'],
  ['packages/core-backend/src/auth/admin-login-grant-command.ts', './admin-login-grant-intent'],
  ['packages/core-backend/src/auth/strict-login-grant-bundle.ts', './admin-login-grant-intent'],
  ['packages/core-backend/src/auth/strict-login-grant-bundle.ts', './admin-login-grant-intent'],
] as const
const RECEIVING_IMPORT_EDGES = [
  ['packages/core-backend/src/auth/admin-grant-proof.ts', './admin-grant-receiving-reader'],
  ['packages/core-backend/src/auth/admin-grant-proof.ts', './admin-grant-receiving-reader'],
] as const
const EXPECTED_REGISTRY = {
  admin_login_grant_enable: {
    targetKind: 'confirmed_identity_set',
    actorMethod: 'local_password',
    targetClass: 'standard',
    productionAvailable: false,
  },
}
const INTENT_FIELDS = [
  'purpose', 'commandId', 'actorId', 'orgId', 'provider',
  'connectionId', 'applicationRevision', 'targets',
] as const
const TARGET_FIELDS = [
  'userId', 'identityId', 'bindingRevision', 'evidenceId',
  'evidenceWitness', 'accessGeneration', 'privilegeWitness',
] as const

function targetFixture(userId = 'User-B') {
  return {
    userId,
    identityId: 'abcdefab-0123-4567-89ab-abcdef012345',
    bindingRevision: '12',
    evidenceId: 'Evidence:Opaque/Case-B',
    evidenceWitness: 'Evidence-Witness:opaque|Not-a-hash',
    accessGeneration: '23',
    privilegeWitness: 'a1'.repeat(32),
  }
}

function intentFixture() {
  return {
    purpose: 'admin_login_grant_enable',
    commandId: 'Command:Opaque/Case-A',
    actorId: 'Actor-Admin',
    orgId: 'Org-Case',
    provider: 'dingtalk',
    connectionId: 'abcdefab-2345-6789-abcd-abcdef012345',
    applicationRevision: '34',
    targets: [targetFixture()],
  }
}

function expectInvalid(input: unknown): void {
  for (const operation of [normalizeAdminGrantIntent, encodeAdminGrantIntent, hashAdminGrantIntent]) {
    let failure: unknown
    try {
      operation(input)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AdminGrantIntentError)
    expect(Object.fromEntries(Object.entries(failure as Error))).toEqual({
      code: 'ADMIN_LOGIN_GRANT_INTENT_INVALID',
      name: 'AdminGrantIntentError',
    })
    expect((failure as Error).message).toBe('Invalid admin login grant intent')
    expect(Object.hasOwn(failure as Error, 'cause')).toBe(false)
  }
}

function codecLoadSpecifiers(source: string, fileName: string): string[] {
  if (!source.includes(MODULE_STEM)) return []
  return importSpecifiers(source, fileName)
    .filter((specifier) => specifier === NON_LITERAL_SPECIFIER || specifier.includes(MODULE_STEM))
}

function readerLoadSpecifiers(source: string, fileName: string): string[] {
  if (!source.includes(READER_STEM)) return []
  return importSpecifiers(source, fileName)
    .filter((specifier) => specifier === NON_LITERAL_SPECIFIER || specifier.includes(READER_STEM))
}

function productionLoadEdges(loadSpecifiers: (source: string, fileName: string) => string[]): string[][] {
  const roots = [path.join(BACKEND_ROOT, 'src'), path.join(BACKEND_ROOT, 'plugins'), path.join(REPO_ROOT, 'plugins')]
  return roots.flatMap((root) => listSourceFiles(root)
    .filter((file) => !/(?:^|[/\\])(?:tests|__tests__)(?:[/\\]|$)|\.(?:test|spec)\./.test(file))
    .flatMap((file) => loadSpecifiers(readFileSync(file, 'utf8'), file)
      .map((specifier) => [path.relative(REPO_ROOT, file).replaceAll('\\', '/'), specifier])))
    .sort((left, right) => `${left[0]}\u0000${left[1]}`.localeCompare(`${right[0]}\u0000${right[1]}`))
}

function registryProblems(registry: unknown): string[] {
  if (!isDeepStrictEqual(registry, EXPECTED_REGISTRY)) return ['registry_shape']
  if (!Object.isFrozen(registry)
    || !Object.isFrozen((registry as typeof EXPECTED_REGISTRY).admin_login_grant_enable)) return ['registry_mutable']
  return []
}

function matchesExclusion(pattern: string, candidate: string): boolean {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1
      if (pattern[index + 1] === '/') {
        expression += '(?:.*/)?'
        index += 1
      } else expression += '.*'
    } else if (character === '*') expression += '[^/]*'
    else if (character === '?') expression += '[^/]'
    else {
      if ('{}[]!'.includes(character)) throw new Error('Unsupported exclusion pattern')
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`${expression}$`).test(candidate)
}

describe('offline admin grant intent codec', () => {
  it('copies the complete accepted single-target intent without attesting it', () => {
    const input = intentFixture()
    const result = normalizeAdminGrantIntent(input)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
    expect(result.targets).not.toBe(input.targets)
    expect(result.targets[0]).not.toBe(input.targets[0])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.targets)).toBe(true)
    expect(Object.isFrozen(result.targets[0])).toBe(true)
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(input.targets)).toBe(false)
    expect(Object.isFrozen(input.targets[0])).toBe(false)
    const next = normalizeAdminGrantIntent(input)
    expect(next).not.toBe(result)
    expect(next.targets[0]).not.toBe(result.targets[0])
    input.commandId = 'changed'
    input.targets[0].evidenceWitness = 'changed'
    input.targets.push(targetFixture('User-C'))
    expect(result).toEqual(intentFixture())
    expect(() => Reflect.set(result, 'commandId', 'changed')).not.toThrow()
    expect(Reflect.set(result, 'commandId', 'changed')).toBe(false)
    expect(Reflect.set(result.targets[0], 'evidenceId', 'changed')).toBe(false)
    expect(Reflect.set(result.targets, '0', targetFixture('different'))).toBe(false)
  })

  it('sorts unchanged user IDs by code unit without deduplicating or merging case', () => {
    const input = intentFixture()
    input.targets = ['user-ä', 'user-a', 'User-A'].map((userId) => targetFixture(userId))
    const result = normalizeAdminGrantIntent(input)
    expect(result.targets.map((target) => target.userId)).toEqual(['User-A', 'user-a', 'user-ä'])
    expect(input.targets.map((target) => target.userId)).toEqual(['user-ä', 'user-a', 'User-A'])
    expect(result.targets.every((target) => Object.isFrozen(target))).toBe(true)
    expect(encodeAdminGrantIntent(input)).toBe(encodeAdminGrantIntent({ ...input, targets: [...input.targets].reverse() }))
    expect(hashAdminGrantIntent(input)).toBe(hashAdminGrantIntent({ ...input, targets: [...input.targets].reverse() }))
  })

  it('pins structured field encoding, explicit count and the independently composed domain hash', () => {
    const input = intentFixture()
    const expected = `{"purpose":"admin_login_grant_enable","commandId":"Command:Opaque/Case-A","actorId":"Actor-Admin","orgId":"Org-Case","provider":"dingtalk","connectionId":"abcdefab-2345-6789-abcd-abcdef012345","applicationRevision":"34","targetCount":1,"targets":[{"userId":"User-B","identityId":"abcdefab-0123-4567-89ab-abcdef012345","bindingRevision":"12","evidenceId":"Evidence:Opaque/Case-B","evidenceWitness":"Evidence-Witness:opaque|Not-a-hash","accessGeneration":"23","privilegeWitness":"${'a1'.repeat(32)}"}]}`
    expect(encodeAdminGrantIntent(input)).toBe(expected)
    expect(ADMIN_GRANT_INTENT_HASH_DOMAIN).toBe('metasheet:admin-login-grant-intent:v1|')
    expect(hashAdminGrantIntent(input)).toBe(createHash('sha256')
      .update('metasheet:admin-login-grant-intent:v1|', 'utf8')
      .update(expected, 'utf8').digest('hex'))
    expect(hashAdminGrantIntent(input)).not.toBe(createHash('sha256').update(expected, 'utf8').digest('hex'))
    const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(input).reverse())
    reordered.targets = [Object.fromEntries(Object.entries(input.targets[0]).reverse())]
    expect(encodeAdminGrantIntent(reordered)).toBe(expected)
  })

  it.each([
    ['commandId', 'different-command'],
    ['actorId', 'different-actor'],
    ['orgId', 'different-org'],
    ['connectionId', '00000000-0000-0000-0000-000000000000'],
    ['applicationRevision', '35'],
  ])('binds changed intent field %s into the digest', (field, replacement) => {
    const input = intentFixture()
    expect(hashAdminGrantIntent({ ...input, [field]: replacement })).not.toBe(hashAdminGrantIntent(input))
  })

  it.each([
    ['userId', 'another-user'],
    ['identityId', '00000000-0000-0000-0000-000000000000'],
    ['bindingRevision', '13'],
    ['evidenceId', 'another-evidence'],
    ['evidenceWitness', 'another-opaque-witness'],
    ['accessGeneration', '24'],
    ['privilegeWitness', 'b2'.repeat(32)],
  ])('binds changed target field %s into the digest', (field, replacement) => {
    const input = intentFixture()
    const changed = { ...input, targets: [{ ...input.targets[0], [field]: replacement }] }
    expect(hashAdminGrantIntent(changed)).not.toBe(hashAdminGrantIntent(input))
  })

  it('binds the complete set and distinguishes structured fields containing delimiters', () => {
    const input = intentFixture()
    const added = { ...input, targets: [...input.targets, targetFixture('User-C')] }
    expect(JSON.parse(encodeAdminGrantIntent(added)).targetCount).toBe(2)
    expect(hashAdminGrantIntent(added)).not.toBe(hashAdminGrantIntent(input))
    const first = { ...input, commandId: 'command|actor', actorId: 'admin' }
    const second = { ...input, commandId: 'command', actorId: 'actor|admin' }
    expect(first.commandId + '|' + first.actorId).toBe(second.commandId + '|' + second.actorId)
    expect(hashAdminGrantIntent(first)).not.toBe(hashAdminGrantIntent(second))
    const escaped = { ...input, commandId: '"\\\n|🧪', orgId: 'é' }
    expect(JSON.parse(encodeAdminGrantIntent(escaped)).commandId).toBe(escaped.commandId)
    expect(hashAdminGrantIntent(escaped)).not.toBe(hashAdminGrantIntent({ ...escaped, orgId: 'e\u0301' }))
  })

  it('preserves canonical opaque IDs and evidence witness without UUID/SHA/length policy or normalization', () => {
    const input = intentFixture()
    input.commandId = 'Opaque|Command:Case With Spaces'
    input.actorId = 'actor-Case'
    input.orgId = 'Org Case'
    input.targets[0].userId = 'Actor-Case'
    input.targets[0].evidenceId = 'Evidence|not-a-UUID/' + 'x'.repeat(4096)
    input.targets[0].evidenceWitness = 'Evidence|NOT-a-SHA/Case'
    expect(normalizeAdminGrantIntent(input)).toEqual(input)
    expect(hashAdminGrantIntent(input)).not.toBe(hashAdminGrantIntent({ ...input, commandId: 'opaque|Command' }))
    expect(hashAdminGrantIntent(input)).not.toBe(hashAdminGrantIntent({ ...input, orgId: 'org case' }))
  })

  it('normalizes only actual UUID fields without restricting UUID versions or variants', () => {
    const input = intentFixture()
    const uppercase = {
      ...input,
      connectionId: input.connectionId.toUpperCase(),
      targets: [{ ...input.targets[0], identityId: input.targets[0].identityId.toUpperCase() }],
    }
    expect(normalizeAdminGrantIntent(uppercase)).toEqual(input)
    expect(hashAdminGrantIntent(uppercase)).toBe(hashAdminGrantIntent(input))
    expect(normalizeAdminGrantIntent({
      ...input,
      connectionId: '00000000-0000-0000-0000-000000000000',
      targets: [{ ...input.targets[0], identityId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }],
    }).targets[0].identityId).toBe('ffffffff-ffff-ffff-ffff-ffffffffffff')
  })

  it.each(['0', '9007199254740993', '9223372036854775807'])('preserves exact mapped bigint %s', (decimal) => {
    const input = intentFixture()
    input.targets[0].bindingRevision = decimal
    input.targets[0].accessGeneration = decimal
    expect(normalizeAdminGrantIntent(input).targets[0]).toEqual(input.targets[0])
    expect(JSON.parse(encodeAdminGrantIntent(input)).targets[0].accessGeneration).toBe(decimal)
  })

  it('does not impose a future storage bound on applicationRevision', () => {
    const input = { ...intentFixture(), applicationRevision: '9'.repeat(100) }
    expect(normalizeAdminGrantIntent(input).applicationRevision).toBe(input.applicationRevision)
    expect(JSON.parse(encodeAdminGrantIntent(input)).applicationRevision).toBe(input.applicationRevision)
  })

  it.each([null, undefined, [], 'intent', 1, true, new Date()])('rejects non-record intent %s', (input) => {
    expectInvalid(input)
  })

  it.each(INTENT_FIELDS)('rejects missing intent field %s', (field) => {
    const input: Record<string, unknown> = intentFixture()
    delete input[field]
    expectInvalid(input)
  })

  it.each(TARGET_FIELDS)('rejects missing target field %s', (field) => {
    const target: Record<string, unknown> = targetFixture()
    delete target[field]
    expectInvalid({ ...intentFixture(), targets: [target] })
  })

  it.each(['', 'ADMIN_LOGIN_GRANT_ENABLE', 'login_grant_enable', 'constructor', '__proto__', null, 1])('rejects unknown purpose %s', (purpose) => {
    expectInvalid({ ...intentFixture(), purpose })
  })

  it.each(['', 'DINGTALK', 'wecom', 'constructor', null, 1])('rejects unknown provider %s', (provider) => {
    expectInvalid({ ...intentFixture(), provider })
  })

  for (const field of ['commandId', 'actorId', 'orgId'] as const) {
    it.each(['', ' ', '\t', ' opaque', 'opaque ', '\nopaque', 'opaque\n', null, undefined, 1, true, {}, new String('opaque')])(`rejects invalid opaque intent ${field}: %s`, (replacement) => {
      expectInvalid({ ...intentFixture(), [field]: replacement })
    })
  }

  for (const field of ['userId', 'evidenceId', 'evidenceWitness'] as const) {
    it.each(['', ' ', '\t', ' opaque', 'opaque ', '\nopaque', 'opaque\n', null, undefined, 1, true, {}, new String('opaque')])(`rejects invalid opaque target ${field}: %s`, (replacement) => {
      expectInvalid({ ...intentFixture(), targets: [{ ...targetFixture(), [field]: replacement }] })
    })
  }

  it.each(['', 'abc', 'abcdefab0123456789ababcdef012345', '{abcdefab-0123-4567-89ab-abcdef012345}', ' abcdefab-0123-4567-89ab-abcdef012345', 'abcdefab-0123-4567-89ab-abcdef012345\n', null, 1])('rejects noncanonical UUID %s in both UUID fields', (replacement) => {
    expectInvalid({ ...intentFixture(), connectionId: replacement })
    expectInvalid({ ...intentFixture(), targets: [{ ...targetFixture(), identityId: replacement }] })
  })

  it.each(['', '-1', '+1', '00', '01', '1.0', '1e2', ' 1', '1 ', '1\n', '１', null, 1, 1n])('rejects noncanonical decimal %s in every revision/generation field', (replacement) => {
    expectInvalid({ ...intentFixture(), applicationRevision: replacement })
    expectInvalid({ ...intentFixture(), targets: [{ ...targetFixture(), bindingRevision: replacement }] })
    expectInvalid({ ...intentFixture(), targets: [{ ...targetFixture(), accessGeneration: replacement }] })
  })

  it.each(['9223372036854775808', '9999999999999999999', '1' + '0'.repeat(100)])('rejects mapped bigint overflow %s before any conversion', (replacement) => {
    expectInvalid({ ...intentFixture(), targets: [{ ...targetFixture(), bindingRevision: replacement }] })
    expectInvalid({ ...intentFixture(), targets: [{ ...targetFixture(), accessGeneration: replacement }] })
  })

  it.each(['', 'opaque', 'A1'.repeat(32), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(64) + '\n', null, 1])('requires the actual privilege producer witness format %s', (privilegeWitness) => {
    expectInvalid({ ...intentFixture(), targets: [{ ...targetFixture(), privilegeWitness }] })
  })

  it.each([undefined, null, {}, 'targets', [], [null], [undefined]])('rejects missing/empty/malformed target sets %s', (targets) => {
    expectInvalid({ ...intentFixture(), targets })
  })

  it('rejects duplicate subject IDs even when their other pins differ and rejects actor as any target', () => {
    const input = intentFixture()
    expectInvalid({ ...input, targets: [targetFixture(), { ...targetFixture(), evidenceId: 'changed' }] })
    expectInvalid({ ...input, targets: [targetFixture(), targetFixture(input.actorId)] })
  })

  it('rejects unknown, symbol, hidden, inherited and accessor properties without reading getters', () => {
    const input = intentFixture()
    expectInvalid({ ...input, SECRET_UNKNOWN_KEY: 'SECRET_VALUE' })
    expectInvalid({ ...input, targets: [{ ...targetFixture(), connectionId: input.connectionId }] })
    expectInvalid({ ...input, [Symbol('SECRET_KEY')]: 'SECRET_VALUE' })
    const hidden = Object.defineProperty(intentFixture(), 'SECRET_HIDDEN', { value: 'SECRET_VALUE' })
    expectInvalid(hidden)
    expectInvalid(Object.assign(Object.create({ inherited: true }), input))
    expectInvalid({ ...input, targets: [Object.assign(Object.create({ inherited: true }), targetFixture())] })
    let reads = 0
    const accessor = Object.defineProperty(intentFixture(), 'commandId', { get() { reads += 1; return 'SECRET_VALUE' } })
    expectInvalid(accessor)
    const targetAccessor = Object.defineProperty(targetFixture(), 'evidenceId', { get() { reads += 1; return 'SECRET_VALUE' } })
    expectInvalid({ ...input, targets: [targetAccessor] })
    expect(reads).toBe(0)
  })

  it('accepts own data in null-prototype containers and copies them into normal frozen output', () => {
    const input = Object.assign(Object.create(null), intentFixture())
    const target = Object.assign(Object.create(null), targetFixture())
    const targets = [target]
    Object.setPrototypeOf(targets, null)
    input.targets = targets
    expect(normalizeAdminGrantIntent(input)).toEqual(intentFixture())
  })

  it('rejects sparse/extended/accessor arrays without invoking getters', () => {
    const input = intentFixture()
    expectInvalid({ ...input, targets: new Array(1) })
    expectInvalid({ ...input, targets: Object.assign([targetFixture()], { extra: true }) })
    expectInvalid({ ...input, targets: Object.assign([targetFixture()], { [Symbol('extra')]: true }) })
    expectInvalid({ ...input, targets: Object.setPrototypeOf([targetFixture()], { inherited: true }) })
    let reads = 0
    const accessor = [targetFixture()]
    Object.defineProperty(accessor, '0', { get() { reads += 1; return targetFixture() } })
    expectInvalid({ ...input, targets: accessor })
    expect(reads).toBe(0)
  })

  it('maps reflection exceptions to the same fixed error without cause or request text', () => {
    const input = new Proxy(intentFixture(), { ownKeys() { throw new Error('SECRET_DRIVER_VALUE') } })
    expectInvalid(input)
    const revoked = Proxy.revocable(intentFixture(), {})
    revoked.revoke()
    expectInvalid(revoked.proxy)
  })
})

describe('offline codec import and availability boundary', () => {
  it('keeps the exact deeply frozen registry unavailable, without an availability service', () => {
    expect(registryProblems(ADMIN_GRANT_PURPOSE_REGISTRY)).toEqual([])
    expect(importSpecifiers(readFileSync(MODULE_PATH, 'utf8'), MODULE_PATH)).toEqual(['node:crypto'])
    expect(Object.keys(adminGrantCodec).sort()).toEqual([
      'ADMIN_GRANT_INTENT_HASH_DOMAIN',
      'ADMIN_GRANT_PURPOSE_REGISTRY',
      'AdminGrantIntentError',
      'encodeAdminGrantIntent',
      'hashAdminGrantIntent',
      'normalizeAdminGrantIntent',
    ])
    expect(Reflect.set(ADMIN_GRANT_PURPOSE_REGISTRY.admin_login_grant_enable, 'productionAvailable', true)).toBe(false)
  })

  it.each([
    ['true availability', Object.freeze({ admin_login_grant_enable: Object.freeze({ ...EXPECTED_REGISTRY.admin_login_grant_enable, productionAvailable: true }) })],
    ['truthy availability', Object.freeze({ admin_login_grant_enable: Object.freeze({ ...EXPECTED_REGISTRY.admin_login_grant_enable, productionAvailable: 'false' }) })],
    ['missing entry', Object.freeze({})],
    ['extra purpose', Object.freeze({ ...EXPECTED_REGISTRY, other_purpose: EXPECTED_REGISTRY.admin_login_grant_enable })],
    ['mutable parent', { admin_login_grant_enable: Object.freeze({ ...EXPECTED_REGISTRY.admin_login_grant_enable }) }],
    ['mutable child', Object.freeze({ admin_login_grant_enable: { ...EXPECTED_REGISTRY.admin_login_grant_enable } })],
  ])('detects registry boundary negative fixture: %s', (_label, registry) => {
    expect(registryProblems(registry)).not.toEqual([])
  })

  it('scans plugin source without following a dependency cycle', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plugin-imports-'))
    try {
      const plugin = path.join(root, 'plugin-example')
      mkdirSync(plugin)
      const entry = path.join(plugin, 'index.cjs')
      writeFileSync(entry, '')
      symlinkSync(root, path.join(plugin, 'node_modules'), 'dir')
      expect(listSourceFiles(root)).toEqual([entry])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds the exact codec import multiset in backend and both plugin roots', () => {
    expect(importEdgeViolations(productionLoadEdges(codecLoadSpecifiers) as Array<[string, string]>, CODEC_IMPORT_EDGES)).toEqual([])
    expect(importSpecifiers(readFileSync(READER_PATH, 'utf8'), READER_PATH)).toEqual([
      './admin-grant-application-material',
      './admin-login-grant-intent',
      './security-action-privilege',
      '../rbac/authorization-input-brand',
      '../rbac/authorization-input-lock',
      '../rbac/authorization-privilege-witness-plan',
    ])
  })

  it('finds exactly the two proof-service receiving-reader imports', () => {
    expect(importEdgeViolations(productionLoadEdges(readerLoadSpecifiers) as Array<[string, string]>, RECEIVING_IMPORT_EDGES)).toEqual([])
  })

  it('rejects omitted, duplicated, relocated and computed codec or receiving edges', () => {
    for (const expected of [CODEC_IMPORT_EDGES, RECEIVING_IMPORT_EDGES]) {
      expect(importEdgeViolations(expected, expected)).toEqual([])
      expected.forEach((edge, index) => {
        const omitted = expected.filter((_candidate, candidateIndex) => candidateIndex !== index)
        expect(importEdgeViolations(omitted, expected)).not.toEqual([])
        expect(importEdgeViolations([...expected, edge], expected)).not.toEqual([])
        expect(importEdgeViolations([...omitted, ['packages/core-backend/src/auth/other.ts', edge[1]]], expected)).not.toEqual([])
        expect(importEdgeViolations([...omitted, [edge[0], NON_LITERAL_SPECIFIER]], expected)).not.toEqual([])
      })
    }
  })

  it.each([
    ['static import', "import { normalizeAdminGrantIntent } from './auth/admin-login-grant-intent'"],
    ['type import', "import type { AdminGrantIntent } from './auth/admin-login-grant-intent'"],
    ['barrel re-export', "export * from './auth/admin-login-grant-intent'"],
    ['named re-export', "export { hashAdminGrantIntent } from './auth/admin-login-grant-intent'"],
    ['import equals', "import codec = require('./auth/admin-login-grant-intent')"],
    ['require', "const codec = require('./auth/admin-login-grant-intent')"],
    ['dynamic import', "const codec = import('./auth/admin-login-grant-intent')"],
    ['template literal', 'const codec = import(`./auth/admin-login-grant-intent`)'],
    ['type expression', "type Codec = import('./auth/admin-login-grant-intent').AdminGrantIntent"],
    ['computed load', "const name = './auth/admin-login-grant-intent'; const codec = require(name)"],
    ['split computed load', "const codec = import('./auth/' + 'admin-login-grant-intent')"],
  ])('detects an actual load in negative fixture: %s', (_label, source) => {
    expect(codecLoadSpecifiers(source, 'fixture.ts')).toHaveLength(1)
  })

  it('does not treat a comment or unrelated import as a codec load', () => {
    expect(codecLoadSpecifiers("// admin-login-grant-intent\nimport { createHash } from 'node:crypto'", 'fixture.ts')).toEqual([])
    expect(codecLoadSpecifiers("const label = 'admin-login-grant-intent'", 'fixture.ts')).toEqual([])
  })

  it.each([
    ['static import', "import { resolveAdminGrantTargetSet } from './auth/admin-grant-receiving-reader'"],
    ['type import', "import type { AdminGrantPreparedSnapshot } from './auth/admin-grant-receiving-reader'"],
    ['barrel re-export', "export * from './auth/admin-grant-receiving-reader'"],
    ['named re-export', "export { assertPreparedAdminGrantConsume } from './auth/admin-grant-receiving-reader'"],
    ['import equals', "import reader = require('./auth/admin-grant-receiving-reader')"],
    ['require', "const reader = require('./auth/admin-grant-receiving-reader')"],
    ['dynamic import', "const reader = import('./auth/admin-grant-receiving-reader')"],
    ['template literal', 'const reader = import(`./auth/admin-grant-receiving-reader`)'],
    ['type expression', "type Reader = import('./auth/admin-grant-receiving-reader').AdminGrantPreparedSnapshot"],
    ['computed load', "const name = './auth/admin-grant-receiving-reader'; const reader = require(name)"],
    ['split computed load', "const reader = import('./auth/' + 'admin-grant-receiving-reader')"],
  ])('detects an actual receiving-reader load in negative fixture: %s', (_label, source) => {
    expect(readerLoadSpecifiers(source, 'fixture.ts')).toHaveLength(1)
  })

  it('does not treat a comment or unrelated import as a receiving-reader load', () => {
    expect(readerLoadSpecifiers("// admin-grant-receiving-reader\nimport { createHash } from 'node:crypto'", 'fixture.ts')).toEqual([])
    expect(readerLoadSpecifiers("const label = 'admin-grant-receiving-reader'", 'fixture.ts')).toEqual([])
  })

  it('belongs to the actual default backend unit lane, not its coverage exclude list', () => {
    const manifest: { scripts: Record<string, string> } = JSON.parse(readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8'))
    expect(manifest.scripts['test:unit']).toBe('vitest run tests/unit --reporter=dot')
    expect(unitConfig.test?.include).toBeUndefined()
    const candidate = 'tests/unit/admin-login-grant-intent.test.ts'
    expect((unitConfig.test?.exclude ?? []).filter((pattern) => matchesExclusion(pattern, candidate))).toEqual([])
    expect(matchesExclusion('tests/unit/**', candidate)).toBe(true)
    expect(matchesExclusion('**/admin-login-grant-intent.test.ts', candidate)).toBe(true)
    expect(matchesExclusion('**/node_modules/**', candidate)).toBe(false)
  })
})
