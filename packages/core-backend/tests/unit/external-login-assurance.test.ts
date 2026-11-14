import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  evaluateSecurityActionPolicy,
  evaluateSecurityActionPurposeAvailability,
  isPrivilegeSensitive,
  isSecurityActionPurpose,
  isSecurityActionPurposeAvailable,
  PRIVILEGE_CLASSES,
  SECURITY_ACTION_ASSURANCE_LEVELS,
  SECURITY_ACTION_METHODS,
  SECURITY_ACTION_POLICY_REVISION,
  SECURITY_ACTION_PREREQUISITES,
  SECURITY_ACTION_PURPOSE_REGISTRY,
  SECURITY_ACTION_PURPOSES,
} from '../../src/auth/external-login-assurance'
import type { SecurityActionPolicyDecision, SecurityActionPrerequisites, SecurityActionPurpose } from '../../src/auth/external-login-assurance'
import {
  classifyPrivilege,
  computePrivilegeWitness,
  HIGH_PRIVILEGE_REASONS,
  PRIVILEGE_WITNESS_DOMAIN,
} from '../../src/auth/security-action-privilege'
import { privilegeRow, readInputs } from '../helpers/security-action-privilege-harness'
import { collectImportEdges, importEdgeViolations, importSpecifiers, listSourceFiles } from '../helpers/import-edge-allowlist'
import type { ImportEdge } from '../helpers/import-edge-allowlist'

const SRC = path.resolve(__dirname, '..', '..', 'src')
const MODULE_PATH = path.join(SRC, 'auth', 'external-login-assurance.ts')
/** The only files in `src` that may import the policy module, as exact edges relative to `src`. */
const POLICY_IMPORTER_ALLOWLIST: ReadonlyArray<ImportEdge> = [
  ['auth/security-action-privilege.ts', './external-login-assurance'],
  ['auth/security-action-proof.ts', './external-login-assurance'],
  ['auth/security-action-proof.ts', './external-login-assurance'],
]
/** Allowlists are posix. path.relative on Windows returns backslashes. */
function posixImportEdges(edges: ReadonlyArray<ImportEdge>): ImportEdge[] {
  return edges.map(([file, specifier]) => [file.replaceAll('\\', '/'), specifier])
}

const PROTOTYPE_KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty'] as const
const UNKNOWN_PURPOSES = ['', 'bind', 'EXTERNAL_IDENTITY_BIND', undefined, null, 0, {}, ...PROTOTYPE_KEYS] as const

const LOCAL = { method: 'local_password', assurance: 'local_password' } as const
const EXTERNAL = {
  method: 'external_reauth', assurance: 'external_platform_asserted',
  methodConnectionId: 'connection-method', targetConnectionId: 'connection-target',
} as const
const SELF_SERVICE_DENIED = ['external_identity_bind', 'login_grant_enable'] as const
const LOCAL_ONLY_WHEN_HIGH = ['external_identity_unbind', 'login_grant_disable'] as const

const allowed: SecurityActionPolicyDecision = { allowed: true }
const refused = (code: string): SecurityActionPolicyDecision => ({ allowed: false, code } as SecurityActionPolicyDecision)

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
}

function prerequisites(overrides: Partial<SecurityActionPrerequisites> = {}): SecurityActionPrerequisites {
  return {
    proofService: true,
    localCredentialProvenanceConstraint: true,
    authorizationInputSerialization: true,
    browserBinding: true,
    verificationAttemptLimits: true,
    externalReauthMethod: true,
    purposeTargets: {
      external_identity_bind: true, external_identity_unbind: true, login_grant_enable: true, login_grant_disable: true,
    },
    ...overrides,
  }
}

describe('security action assurance policy', () => {
  it('decides every purpose, class and method pair as the matrix states', () => {
    for (const purpose of SECURITY_ACTION_PURPOSES) {
      expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'standard', ...LOCAL })).toEqual(allowed)
      expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'standard', ...EXTERNAL })).toEqual(allowed)
    }
    for (const purpose of SELF_SERVICE_DENIED) {
      expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'high', ...LOCAL }))
        .toEqual(refused('SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED'))
      expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'high', ...EXTERNAL }))
        .toEqual(refused('SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED'))
    }
    for (const purpose of LOCAL_ONLY_WHEN_HIGH) {
      expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'high', ...LOCAL })).toEqual(allowed)
      expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'high', ...EXTERNAL }))
        .toEqual(refused('SECURITY_ACTION_ASSURANCE_INSUFFICIENT'))
    }
  })

  const mismatchedAssurance = [
    ['undefined assurance', { ...LOCAL, assurance: undefined }],
    ['null assurance', { ...LOCAL, assurance: null }],
    ['empty assurance', { ...LOCAL, assurance: '' }],
    ['unknown assurance', { ...LOCAL, assurance: 'unknown' }],
    ['upper-case assurance', { ...LOCAL, assurance: 'LOCAL_PASSWORD' }],
    ['local password with external assurance', { ...LOCAL, assurance: 'external_platform_asserted' }],
    ['external method with local assurance', { ...EXTERNAL, assurance: 'local_password' }],
    ['external method without assurance', { ...EXTERNAL, assurance: undefined }],
    ['unknown method', { ...LOCAL, method: 'sms_code' }],
    ['missing method', { ...LOCAL, method: undefined }],
    ['prototype key method', { ...LOCAL, method: 'constructor' }],
  ] as const

  it.each(mismatchedAssurance)('never treats %s as sufficient', (_label, overrides) => {
    for (const purpose of SECURITY_ACTION_PURPOSES) {
      expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'standard', ...overrides }))
        .toEqual(refused('SECURITY_ACTION_ASSURANCE_INSUFFICIENT'))
    }
    for (const purpose of SELF_SERVICE_DENIED) {
      expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'high', ...overrides }))
        .toEqual(refused('SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED'))
    }
    for (const purpose of LOCAL_ONLY_WHEN_HIGH) {
      expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'high', ...overrides }))
        .toEqual(refused('SECURITY_ACTION_ASSURANCE_INSUFFICIENT'))
    }
  })

  it.each([
    ['the method connection equals the target connection', { ...EXTERNAL, targetConnectionId: EXTERNAL.methodConnectionId }],
    ['the method connection equals the target connection written in another case', { ...EXTERNAL, methodConnectionId: 'Connection-A', targetConnectionId: 'connection-a' }],
    ['the method connection equals the target connection with surrounding whitespace', { ...EXTERNAL, methodConnectionId: ' connection-a ', targetConnectionId: 'connection-a' }],
    ['the method connection is missing', { ...EXTERNAL, methodConnectionId: undefined }],
    ['the method connection is null', { ...EXTERNAL, methodConnectionId: null }],
    ['the method connection is blank', { ...EXTERNAL, methodConnectionId: '   ' }],
    ['the method connection is not a string', { ...EXTERNAL, methodConnectionId: 7 }],
    ['the target connection is missing', { ...EXTERNAL, targetConnectionId: undefined }],
    ['the target connection is blank', { ...EXTERNAL, targetConnectionId: '' }],
    ['a local password names a method connection', { ...LOCAL, methodConnectionId: 'connection-method' }],
  ] as const)('refuses an external method when %s', (_label, overrides) => {
    expect(evaluateSecurityActionPolicy({ purpose: 'external_identity_unbind', privilegeClass: 'standard', ...overrides }))
      .toEqual(refused('SECURITY_ACTION_ASSURANCE_INSUFFICIENT'))
  })

  it('accepts an external method whose connection differs from the target', () => {
    expect(evaluateSecurityActionPolicy({ purpose: 'external_identity_unbind', privilegeClass: 'standard', ...EXTERNAL, targetConnectionId: 'connection-b' }))
      .toEqual(allowed)
  })

  it.each(UNKNOWN_PURPOSES)('refuses an unknown purpose before any other check: case %#', (purpose) => {
    expect(isSecurityActionPurpose(purpose)).toBe(false)
    expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'standard', ...LOCAL }))
      .toEqual(refused('SECURITY_ACTION_PURPOSE_UNAVAILABLE'))
    expect(evaluateSecurityActionPolicy({ purpose, privilegeClass: 'high', ...EXTERNAL }))
      .toEqual(refused('SECURITY_ACTION_PURPOSE_UNAVAILABLE'))
  })

  it.each([null, undefined, 'external_identity_bind', 42, [], () => undefined])('refuses a non-object input: case %#', (input) => {
    expect(evaluateSecurityActionPolicy(input as never)).toEqual(refused('SECURITY_ACTION_PURPOSE_UNAVAILABLE'))
  })

  it.each(['', 'admin', 'STANDARD', undefined, null, 'constructor', 1, {}])('treats an unknown privilege class as high: case %#', (privilegeClass) => {
    expect(evaluateSecurityActionPolicy({ purpose: 'external_identity_bind', privilegeClass, ...LOCAL }))
      .toEqual(refused('SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED'))
    expect(evaluateSecurityActionPolicy({ purpose: 'external_identity_unbind', privilegeClass, ...LOCAL })).toEqual(allowed)
    expect(evaluateSecurityActionPolicy({ purpose: 'external_identity_unbind', privilegeClass, ...EXTERNAL }))
      .toEqual(refused('SECURITY_ACTION_ASSURANCE_INSUFFICIENT'))
  })

  it('refuses high privilege self-service before judging the assurance level', () => {
    expect(evaluateSecurityActionPolicy({ purpose: 'external_identity_bind', privilegeClass: 'high', method: 'local_password', assurance: 'unknown' }))
      .toEqual(refused('SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED'))
  })

  it('returns a decision for every combination of values without throwing', () => {
    const garbage: unknown[] = ['', 'x', 'constructor', '__proto__', 0, 1, -1, NaN, true, false, null, undefined, {}, [], Symbol('s'), () => undefined, 'local_password', 'external_reauth', 'external_platform_asserted', 'standard', 'high']
    const purposes: unknown[] = [...SECURITY_ACTION_PURPOSES, ...UNKNOWN_PURPOSES]
    let seed = 2463534242
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    const pick = (values: unknown[]) => values[next() % values.length]
    for (let round = 0; round < 2000; round += 1) {
      const decision = evaluateSecurityActionPolicy({
        purpose: pick(purposes), privilegeClass: pick(garbage), method: pick(garbage), assurance: pick(garbage),
        methodConnectionId: pick(garbage), targetConnectionId: pick(garbage),
      })
      expect(typeof decision.allowed).toBe('boolean')
      if (decision.allowed === false) expect(decision.code).toMatch(/^SECURITY_ACTION_/)
    }
  })

  it('pins the policy revision to a fingerprint of the matrix, the classification fixtures and the witness composition', async () => {
    const classes: unknown[] = [...PRIVILEGE_CLASSES, 'unknown']
    const methods: unknown[] = [...SECURITY_ACTION_METHODS, 'unknown', null]
    const assurances: unknown[] = [...SECURITY_ACTION_ASSURANCE_LEVELS, 'unknown', null]
    const connections: Array<Record<string, unknown>> = [
      { methodConnectionId: 'connection-a', targetConnectionId: 'connection-b' },
      { methodConnectionId: 'connection-a', targetConnectionId: 'connection-a' },
      {},
    ]
    const matrix: unknown[] = []
    for (const purpose of SECURITY_ACTION_PURPOSES) for (const privilegeClass of classes) for (const method of methods)
      for (const assurance of assurances) for (const connection of connections) {
        matrix.push({ purpose, privilegeClass, method, assurance, ...connection, decision: evaluateSecurityActionPolicy({ purpose, privilegeClass, method, assurance, ...connection }) })
      }
    const fixtures = [
      {},
      { is_admin: true },
      { role: ' Admin ' },
      { role_ids: ['admin'] },
      { role_ids: ['attendance_admin'] },
      { department_scopes: [['attendance', 'd1', true]] },
      { direct_codes: ['x:*'] },
      { role_permission_pairs: [['operator', 'users:write']] },
      { legacy_permissions: [['*:*']] },
      { is_admin: true, role: 'admin', role_ids: ['admin', 'x_admin'], direct_codes: ['*:*'], role_permission_pairs: [['x_admin', 'roles:write']], member_group_scopes: [['x', 'g1']], admissions: [['x', false]] },
    ]
    const classifications: unknown[] = []
    for (const fixture of fixtures) {
      const inputs = await readInputs(privilegeRow(fixture))
      classifications.push({ fixture, ...classifyPrivilege(inputs) })
    }
    const witnessFixture = await readInputs({ role_ids: ['b', 'B', 'a'], direct_codes: ['tasks:write'], admissions: [['attendance', true]] })
    const composition = {
      domain: PRIVILEGE_WITNESS_DOMAIN,
      reasons: HIGH_PRIVILEGE_REASONS,
      keys: ['isAdmin', 'role', 'roleIds', 'directCodes', 'rolePermissions', 'legacyPermissions', 'admissions', 'delegatedDepartmentScopes', 'delegatedMemberGroupScopes'],
      witness: computePrivilegeWitness(witnessFixture),
    }
    const fingerprint = createHash('sha256').update(canonical({ matrix, classifications, composition })).digest('hex')
    expect(Number.isInteger(SECURITY_ACTION_POLICY_REVISION) && SECURITY_ACTION_POLICY_REVISION > 0).toBe(true)
    // Re-pin only. Policy decisions are unchanged, so SECURITY_ACTION_POLICY_REVISION stays 1.
    // The digest moved because fixtures[5].department_scopes is now ['attendance','d1', true]
    // (the column default) and composition.domain is metasheet:security-action:privilege:v2|.
    // composition.witness is that domain over the canonical inputs of
    // { role_ids: ['b','B','a'], direct_codes: ['tasks:write'], admissions: [['attendance', true]] }
    // with privilegeRow defaults for every other grant input (no department scope on that row).
    expect(
      { revision: SECURITY_ACTION_POLICY_REVISION, fingerprint },
      'The policy matrix, the outcome of a pinned classification fixture or the witness composition changed: review whether SECURITY_ACTION_POLICY_REVISION must be incremented, then re-pin the fingerprint',
    ).toEqual({ revision: 1, fingerprint: '4fc473aa4394b8aa03f9f00c251c185a761c2b9a11496b122414fe7b70789704' })
  })
})

describe('security action purpose registry', () => {
  const ENV_KEYS = ['SECURITY_ACTION_PROOF_ENABLED', 'EXTERNAL_IDENTITY_SELF_BIND_ENABLED', 'EXTERNAL_IDENTITY_LOGIN_ENABLED', 'SECURITY_ACTION_PURPOSES_AVAILABLE', 'RBAC_OPTIONAL', 'NODE_ENV'] as const
  const saved = new Map<string, string | undefined>()
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    saved.clear()
  })

  it('keeps every purpose unavailable in production and pins every prerequisite false', () => {
    for (const purpose of [...SECURITY_ACTION_PURPOSES, ...UNKNOWN_PURPOSES]) {
      expect(isSecurityActionPurposeAvailable(purpose)).toBe(false)
    }
    expect(SECURITY_ACTION_PREREQUISITES.proofService).toBe(false)
    expect(SECURITY_ACTION_PREREQUISITES.localCredentialProvenanceConstraint).toBe(false)
    expect(SECURITY_ACTION_PREREQUISITES.authorizationInputSerialization).toBe(false)
    expect(SECURITY_ACTION_PREREQUISITES.browserBinding).toBe(false)
    expect(SECURITY_ACTION_PREREQUISITES.verificationAttemptLimits).toBe(false)
    expect(SECURITY_ACTION_PREREQUISITES.externalReauthMethod).toBe(false)
    expect(SECURITY_ACTION_PREREQUISITES.purposeTargets).toEqual({
      external_identity_bind: false, external_identity_unbind: false, login_grant_enable: false, login_grant_disable: false,
    })
    expect(Object.keys(SECURITY_ACTION_PREREQUISITES).sort()).toEqual(
      ['authorizationInputSerialization', 'browserBinding', 'externalReauthMethod', 'localCredentialProvenanceConstraint', 'proofService', 'purposeTargets', 'verificationAttemptLimits'],
    )
    expect(Object.isFrozen(SECURITY_ACTION_PREREQUISITES)).toBe(true)
    expect(Object.isFrozen(SECURITY_ACTION_PREREQUISITES.purposeTargets)).toBe(true)
  })

  it('keeps every purpose unavailable whatever the environment says', () => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key])
    for (const key of ENV_KEYS) process.env[key] = 'true'
    process.env.RBAC_OPTIONAL = '1'
    process.env.NODE_ENV = 'development'
    for (const purpose of SECURITY_ACTION_PURPOSES) expect(isSecurityActionPurposeAvailable(purpose)).toBe(false)
    expect(readFileSync(MODULE_PATH, 'utf8')).not.toContain('process.env')
  })

  it('makes every purpose available only when every prerequisite is delivered', () => {
    for (const purpose of SECURITY_ACTION_PURPOSES) {
      expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites())).toBe(true)
      expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites({ proofService: false }))).toBe(false)
      expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites({ localCredentialProvenanceConstraint: false }))).toBe(false)
      expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites({ authorizationInputSerialization: false }))).toBe(false)
      expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites({ browserBinding: false }))).toBe(false)
      expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites({ verificationAttemptLimits: false }))).toBe(false)
    }
    for (const missing of SECURITY_ACTION_PURPOSES) {
      const targets = { ...prerequisites().purposeTargets, [missing]: false }
      for (const purpose of SECURITY_ACTION_PURPOSES) {
        expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites({ purposeTargets: targets }))).toBe(purpose !== missing)
      }
    }
    // Serialization is required for every purpose, whether or not its outcome depends on the privilege class.
    for (const externalReauthMethod of [false, true]) {
      const unserialized = prerequisites({ authorizationInputSerialization: false, externalReauthMethod })
      for (const purpose of SECURITY_ACTION_PURPOSES) {
        expect(evaluateSecurityActionPurposeAvailability(purpose, unserialized)).toBe(false)
      }
    }
  })

  it('derives privilege sensitivity from the matrix and the delivered methods', () => {
    for (const externalReauthMethod of [false, true]) {
      const p = prerequisites({ externalReauthMethod })
      expect(isPrivilegeSensitive('external_identity_bind', p)).toBe(true)
      expect(isPrivilegeSensitive('login_grant_enable', p)).toBe(true)
      expect(isPrivilegeSensitive('external_identity_unbind', p)).toBe(externalReauthMethod)
      expect(isPrivilegeSensitive('login_grant_disable', p)).toBe(externalReauthMethod)
    }
  })

  it.each(['true', 1, {}, [], 'yes', () => true])('treats a non-boolean prerequisite value as unmet: case %#', (value) => {
    const fields = ['proofService', 'localCredentialProvenanceConstraint', 'authorizationInputSerialization', 'browserBinding', 'verificationAttemptLimits'] as const
    for (const field of fields) {
      for (const purpose of SECURITY_ACTION_PURPOSES) {
        expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites({ [field]: value } as never))).toBe(false)
      }
    }
    const targets = Object.fromEntries(SECURITY_ACTION_PURPOSES.map((purpose) => [purpose, value]))
    for (const purpose of SECURITY_ACTION_PURPOSES) {
      expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites({ purposeTargets: targets } as never))).toBe(false)
    }
    for (const purpose of [...UNKNOWN_PURPOSES]) {
      expect(evaluateSecurityActionPurposeAvailability(purpose, prerequisites())).toBe(false)
    }
    expect(evaluateSecurityActionPurposeAvailability('external_identity_bind', null as never)).toBe(false)
  })

  it('exposes a production entry point without an injection point', () => {
    expect(isSecurityActionPurposeAvailable.length).toBe(1)
    const file = ts.createSourceFile('m.ts', readFileSync(MODULE_PATH, 'utf8'), ts.ScriptTarget.Latest, true)
    const declaration = file.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'isSecurityActionPurposeAvailable')
    expect(declaration?.parameters).toHaveLength(1)
    expect(declaration?.parameters[0].initializer).toBeUndefined()
    expect(declaration?.parameters[0].questionToken).toBeUndefined()
    expect(declaration?.parameters[0].dotDotDotToken).toBeUndefined()
    const users = listSourceFiles(SRC).filter((file) => readFileSync(file, 'utf8').includes('evaluateSecurityActionPurposeAvailability'))
    expect(users).toEqual([MODULE_PATH])
  })

  it('registers exactly the closed purpose set with one empty-slot purpose', () => {
    expect(Object.keys(SECURITY_ACTION_PURPOSE_REGISTRY).sort()).toEqual([...SECURITY_ACTION_PURPOSES].sort())
    const emptySlot = (Object.keys(SECURITY_ACTION_PURPOSE_REGISTRY) as SecurityActionPurpose[])
      .filter((purpose) => SECURITY_ACTION_PURPOSE_REGISTRY[purpose].targetKind === 'empty_slot')
    expect(emptySlot).toEqual(['external_identity_bind'])
    for (const key of PROTOTYPE_KEYS) expect(Object.hasOwn(SECURITY_ACTION_PURPOSE_REGISTRY, key)).toBe(false)
    expect(Object.isFrozen(SECURITY_ACTION_PURPOSE_REGISTRY)).toBe(true)
    expect(Object.isFrozen(SECURITY_ACTION_PURPOSE_REGISTRY.external_identity_bind)).toBe(true)
  })

  it('has no runtime import', () => {
    const source = readFileSync(MODULE_PATH, 'utf8')
    const imports = source.split('\n').filter((line) => /^\s*import\b/.test(line))
    expect(imports.filter((line) => !/^\s*import\s+type\b/.test(line))).toEqual([])
    expect(source).not.toMatch(/\brequire\s*\(/)
  })

  it('is imported by exactly the allowlisted files: the classifier and the action proof service', () => {
    const edges = posixImportEdges(collectImportEdges(SRC, /external-login-assurance/, (file) => readFileSync(file, 'utf8')))
    expect(importEdgeViolations(edges, POLICY_IMPORTER_ALLOWLIST)).toEqual([])
    for (const file of listSourceFiles(SRC)) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/(?:require|import)\(\s*['"`][^'"`]*external-login-assurance/)
    }
  })

  it('reports any importer the allowlist does not name, in the same directory or elsewhere, by import or by re-export', () => {
    const allowed = POLICY_IMPORTER_ALLOWLIST
    expect(importEdgeViolations(allowed, allowed)).toEqual([])
    expect(importEdgeViolations([...allowed, ['auth/scratch-importer.ts', './external-login-assurance']], allowed))
      .toEqual(['unexpected: auth/scratch-importer.ts -> ./external-login-assurance'])
    expect(importEdgeViolations([...allowed, ['services/scratch.ts', '../auth/external-login-assurance']], allowed))
      .toEqual(['unexpected: services/scratch.ts -> ../auth/external-login-assurance'])
    const reExport = importSpecifiers("export { SECURITY_ACTION_PURPOSES } from './external-login-assurance'\n")
      .map((specifier): ImportEdge => ['auth/scratch-reexport.ts', specifier])
    expect(importEdgeViolations([...allowed, ...reExport], allowed)).toEqual(['unexpected: auth/scratch-reexport.ts -> ./external-login-assurance'])
    const loaded = importSpecifiers("module.exports = () => [require(`./external-login-assurance`), import(`./external-login-assurance`)]\n", 'scratch.js')
      .map((specifier): ImportEdge => ['scratch.js', specifier])
    expect(importEdgeViolations([...allowed, ...loaded], allowed)).toEqual(['unexpected: scratch.js -> ./external-login-assurance', 'unexpected: scratch.js -> ./external-login-assurance'])
    expect(importEdgeViolations(allowed.slice(0, -1), allowed)).toEqual(['missing: auth/security-action-proof.ts -> ./external-login-assurance'])
  })
})
