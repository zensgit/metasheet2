import { describe, expect, it } from 'vitest'
import {
  ELEARNING_CERTIFICATE_ISSUE_DOMAIN,
  ELEARNING_CERTIFICATE_ISSUE_HASH_VERSION,
  ElearningCertificatePolicyError,
  normalizeElearningCertificateIssue,
  parseElearningCertificateTemplateParameters,
} from '../../src/services/elearning-certificate-policy'

function baseInput() {
  return {
    certificateId: 'certificate-1',
    effectKey: 'course-completion:course-1',
    issuedAt: '2026-08-28T08:30:00+08:00',
    orgId: 'org-1',
    parameters: {
      courseName: '安全培训',
      learnerName: '林学员',
    },
    templateRevisionId: 'certificate-template-revision-1',
    templateText: '授予 #learnerName# 完成 #courseName#；再次确认 #learnerName#',
    userId: 'user-1',
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected certificate policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningCertificatePolicyError)
    const policyError = error as ElearningCertificatePolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.name).toBe('ElearningCertificatePolicyError')
    expect(policyError.cause).toBeUndefined()
    const surface = `${policyError.message}\n${policyError.stack ?? ''}`
    expect(surface).not.toContain('secret')
  }
}

describe('elearning certificate template policy', () => {
  it('parses unique placeholders in first-appearance order and freezes the list', () => {
    const result = parseElearningCertificateTemplateParameters(
      '授予 #learnerName# 完成 #courseName#；再次 #learnerName#',
    )
    expect(result).toEqual(['learnerName', 'courseName'])
    expect(Object.isFrozen(result)).toBe(true)
    expect(() => {
      ;(result as string[]).push('other')
    }).toThrow(TypeError)
  })

  it('supports static templates and adjacent placeholders', () => {
    expect(parseElearningCertificateTemplateParameters('静态证书')).toEqual([])
    expect(parseElearningCertificateTemplateParameters('')).toEqual([])
    expect(parseElearningCertificateTemplateParameters('#first##second#')).toEqual([
      'first',
      'second',
    ])
  })

  it('rejects malformed, ambiguous, or invalid placeholder text', () => {
    for (const templateText of [
      '#',
      'before #name',
      'name#',
      '##',
      '# #',
      '# name#',
      '#name #',
      '#a# trailing #',
      `#${'x'.repeat(129)}#`,
      `prefix\0#name#`,
      `prefix\ud800#name#`,
      '#name\udc00#',
    ]) {
      expectCode(
        () => parseElearningCertificateTemplateParameters(templateText),
        'invalid_template',
      )
    }
    expectCode(() => parseElearningCertificateTemplateParameters(null), 'invalid_template')
    expectCode(() => parseElearningCertificateTemplateParameters({}), 'invalid_template')
    expectCode(
      () => parseElearningCertificateTemplateParameters('x'.repeat((16 * 1_024) + 1)),
      'invalid_template',
    )
  })

  it('rejects more than 64 unique placeholders without rejecting duplicates', () => {
    const unique = Array.from({ length: 65 }, (_, index) => `#p${index}#`).join('')
    expectCode(
      () => parseElearningCertificateTemplateParameters(unique),
      'invalid_template',
    )
    const duplicate = Array.from({ length: 100 }, () => '#same#').join('')
    expect(parseElearningCertificateTemplateParameters(duplicate)).toEqual(['same'])
  })
})

describe('elearning certificate issuance policy', () => {
  it('returns a frozen exact-shape intent with a cloned parameter snapshot', () => {
    const input = baseInput()
    const result = normalizeElearningCertificateIssue(input)

    expect(Object.keys(result).sort()).toEqual([
      'certificateId',
      'effectKey',
      'issuedAt',
      'orgId',
      'parameterSnapshot',
      'requestHash',
      'requestHashVersion',
      'templateRevisionId',
      'userId',
    ])
    expect(result).toMatchObject({
      certificateId: 'certificate-1',
      effectKey: 'course-completion:course-1',
      issuedAt: '2026-08-28T00:30:00.000Z',
      orgId: 'org-1',
      parameterSnapshot: {
        courseName: '安全培训',
        learnerName: '林学员',
      },
      requestHashVersion: ELEARNING_CERTIFICATE_ISSUE_HASH_VERSION,
      templateRevisionId: 'certificate-template-revision-1',
      userId: 'user-1',
    })
    expect(ELEARNING_CERTIFICATE_ISSUE_DOMAIN).toBe('elearning.certificate.issue.v1')
    expect(result.requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.parameterSnapshot)).toBe(true)
    expect(Object.getPrototypeOf(result.parameterSnapshot)).toBeNull()
    expect(result.parameterSnapshot).not.toBe(input.parameters)
  })

  it('does not allocate a serial or pretend a rendered artifact exists', () => {
    const result = normalizeElearningCertificateIssue(baseInput())
    expect(result).not.toHaveProperty('serial')
    expect(result).not.toHaveProperty('serialNumber')
    expect(result).not.toHaveProperty('rendered')
    expect(result).not.toHaveProperty('renderedArtifact')
    expect(result).not.toHaveProperty('templateText')
  })

  it('normalizes identity, timestamp, and parameter values before hashing', () => {
    const input = baseInput()
    input.certificateId = ' certificate-1 '
    input.effectKey = ' course-completion:course-1 '
    input.orgId = ' org-1 '
    input.userId = ' user-1 '
    input.templateRevisionId = ' certificate-template-revision-1 '
    input.parameters.courseName = ' 安全培训 '
    input.parameters.learnerName = ' 林学员 '

    const normalized = normalizeElearningCertificateIssue(input)
    const canonical = normalizeElearningCertificateIssue(baseInput())
    expect(normalized).toEqual(canonical)
  })

  it('produces the same hash for reordered input and parameter keys', () => {
    const first = normalizeElearningCertificateIssue(baseInput())
    const source = baseInput()
    const reordered = {
      userId: source.userId,
      templateText: source.templateText,
      parameters: {
        learnerName: source.parameters.learnerName,
        courseName: source.parameters.courseName,
      },
      orgId: source.orgId,
      templateRevisionId: source.templateRevisionId,
      issuedAt: source.issuedAt,
      effectKey: source.effectKey,
      certificateId: source.certificateId,
    }
    const second = normalizeElearningCertificateIssue(reordered)
    expect(second.requestHash).toBe(first.requestHash)
    expect(second).toEqual(first)
  })

  it('changes the hash when every normalized business payload field changes', () => {
    const original = baseInput()
    const baseline = normalizeElearningCertificateIssue(original).requestHash
    const mutations: Array<(input: ReturnType<typeof baseInput>) => void> = [
      (input) => { input.certificateId = 'certificate-2' },
      (input) => { input.effectKey = 'course-completion:course-2' },
      (input) => { input.issuedAt = '2026-08-28T08:31:00+08:00' },
      (input) => { input.orgId = 'org-2' },
      (input) => { input.parameters.courseName = '进阶安全培训' },
      (input) => { input.templateRevisionId = 'certificate-template-revision-2' },
      (input) => { input.templateText = '授予 #learnerName# 完成课程 #courseName#' },
      (input) => { input.userId = 'user-2' },
    ]
    for (const mutate of mutations) {
      const input = baseInput()
      mutate(input)
      expect(normalizeElearningCertificateIssue(input).requestHash).not.toBe(baseline)
    }
  })

  it('makes same-identity different payload detectable by a later authority adapter', () => {
    const first = baseInput()
    const second = baseInput()
    second.parameters.courseName = '另一课程'
    const firstResult = normalizeElearningCertificateIssue(first)
    const secondResult = normalizeElearningCertificateIssue(second)

    expect({
      orgId: secondResult.orgId,
      userId: secondResult.userId,
      certificateId: secondResult.certificateId,
      effectKey: secondResult.effectKey,
    }).toEqual({
      orgId: firstResult.orgId,
      userId: firstResult.userId,
      certificateId: firstResult.certificateId,
      effectKey: firstResult.effectKey,
    })
    expect(secondResult.requestHash).not.toBe(firstResult.requestHash)
  })

  it('requires the parameter key set to exactly match the template placeholders', () => {
    const missing = baseInput()
    delete (missing.parameters as Partial<typeof missing.parameters>).courseName
    expectCode(() => normalizeElearningCertificateIssue(missing), 'invalid_parameters')

    const extra = baseInput() as ReturnType<typeof baseInput> & {
      parameters: Record<string, string>
    }
    extra.parameters.extra = 'secret-extra'
    expectCode(() => normalizeElearningCertificateIssue(extra), 'invalid_parameters')

    const staticTemplate = baseInput()
    staticTemplate.templateText = '静态证书'
    staticTemplate.parameters = {} as typeof staticTemplate.parameters
    expect(normalizeElearningCertificateIssue(staticTemplate).parameterSnapshot).toEqual({})
  })

  it('preserves prototype-named parameter keys as frozen own data properties', () => {
    const input = baseInput() as ReturnType<typeof baseInput> & {
      parameters: Record<string, string>
    }
    input.templateText = '#__proto__# #constructor#'
    const parameters = Object.create(null) as Record<string, string>
    Object.defineProperty(parameters, '__proto__', {
      enumerable: true,
      value: 'prototype value',
    })
    Object.defineProperty(parameters, 'constructor', {
      enumerable: true,
      value: 'constructor value',
    })
    input.parameters = parameters

    const result = normalizeElearningCertificateIssue(input)
    expect(Object.keys(result.parameterSnapshot).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.prototype.hasOwnProperty.call(result.parameterSnapshot, '__proto__')).toBe(true)
    expect(result.parameterSnapshot.__proto__).toBe('prototype value')
    expect(result.parameterSnapshot.constructor).toBe('constructor value')
    expect(Object.getPrototypeOf(result.parameterSnapshot)).toBeNull()
  })

  it('does not retain or mutate caller-owned objects', () => {
    const input = baseInput()
    const result = normalizeElearningCertificateIssue(input)
    const hash = result.requestHash
    input.parameters.courseName = 'mutated'
    input.parameters.learnerName = 'mutated'
    input.templateText = 'mutated'
    expect(result.parameterSnapshot).toEqual({
      courseName: '安全培训',
      learnerName: '林学员',
    })
    expect(result.requestHash).toBe(hash)
  })

  it('rejects extra, missing, symbol, or non-enumerable issuance fields', () => {
    expectCode(
      () => normalizeElearningCertificateIssue({ ...baseInput(), extra: 'secret-extra' }),
      'invalid_input',
    )
    const missing = baseInput() as Partial<ReturnType<typeof baseInput>>
    delete missing.userId
    expectCode(() => normalizeElearningCertificateIssue(missing), 'invalid_input')
    expectCode(
      () => normalizeElearningCertificateIssue({
        ...baseInput(),
        [Symbol('secret-symbol')]: 'secret-symbol-value',
      }),
      'invalid_input',
    )
    const nonEnumerable = baseInput()
    Object.defineProperty(nonEnumerable, 'hidden', { value: 'secret-hidden' })
    expectCode(() => normalizeElearningCertificateIssue(nonEnumerable), 'invalid_input')
  })

  it('rejects invalid identity fields without exposing their values', () => {
    for (const key of [
      'certificateId',
      'effectKey',
      'orgId',
      'templateRevisionId',
      'userId',
    ] as const) {
      for (const value of ['', '   ', `secret\0value`, '\ud800', null, 7, true, {}, []]) {
        expectCode(
          () => normalizeElearningCertificateIssue({ ...baseInput(), [key]: value }),
          'invalid_input',
        )
      }
    }
  })

  it('rejects non-absolute, impossible, or invalid issuedAt values', () => {
    for (const issuedAt of [
      '2026-08-28',
      '2026-08-28T08:30:00',
      '2026-02-30T08:30:00Z',
      '2026-13-01T08:30:00Z',
      '2026-08-28T25:00:00Z',
      '2026-08-28T08:60:00Z',
      '2026-08-28T08:30:60Z',
      '2026-08-28T08:30:00+25:00',
      'secret-date',
      new Date(),
      null,
      0,
    ]) {
      expectCode(
        () => normalizeElearningCertificateIssue({ ...baseInput(), issuedAt }),
        'invalid_issued_at',
      )
    }
  })

  it('rejects invalid parameter maps and values', () => {
    for (const parameters of [
      null,
      undefined,
      [],
      'secret-parameters',
      7,
      new Date(),
      { courseName: '', learnerName: '林学员' },
      { courseName: '   ', learnerName: '林学员' },
      { courseName: 7, learnerName: '林学员' },
      { courseName: 'secret\0value', learnerName: '林学员' },
      { courseName: '\ud800', learnerName: '林学员' },
      { courseName: '安全培训', learnerName: 'x'.repeat(2_049) },
      { ...baseInput().parameters, [Symbol('secret-symbol')]: 'secret-value' },
    ]) {
      expectCode(
        () => normalizeElearningCertificateIssue({ ...baseInput(), parameters }),
        'invalid_parameters',
      )
    }
    const hidden = baseInput().parameters
    Object.defineProperty(hidden, 'hidden', { value: 'secret-hidden' })
    expectCode(
      () => normalizeElearningCertificateIssue({ ...baseInput(), parameters: hidden }),
      'invalid_parameters',
    )
  })

  it('fails closed on hostile input and parameter proxies', () => {
    const throwingRoot = baseInput()
    Object.defineProperty(throwingRoot, 'userId', {
      enumerable: true,
      get() { throw new Error('secret-root-getter') },
    })
    expectCode(() => normalizeElearningCertificateIssue(throwingRoot), 'invalid_input')
    expectCode(
      () => normalizeElearningCertificateIssue(new Proxy(baseInput(), {
        ownKeys() { throw new Error('secret-root-ownkeys') },
      })),
      'invalid_input',
    )
    expectCode(
      () => normalizeElearningCertificateIssue(new Proxy(baseInput(), {
        getOwnPropertyDescriptor() { throw new Error('secret-root-descriptor') },
      })),
      'invalid_input',
    )

    const throwingParameters = baseInput().parameters
    Object.defineProperty(throwingParameters, 'courseName', {
      enumerable: true,
      get() { throw new Error('secret-parameter-getter') },
    })
    expectCode(
      () => normalizeElearningCertificateIssue({ ...baseInput(), parameters: throwingParameters }),
      'invalid_parameters',
    )
    expectCode(
      () => normalizeElearningCertificateIssue({
        ...baseInput(),
        parameters: new Proxy(baseInput().parameters, {
          getPrototypeOf() { throw new Error('secret-parameter-prototype') },
        }),
      }),
      'invalid_parameters',
    )
    expectCode(
      () => normalizeElearningCertificateIssue({
        ...baseInput(),
        parameters: new Proxy(baseInput().parameters, {
          ownKeys() { throw new Error('secret-parameter-ownkeys') },
        }),
      }),
      'invalid_parameters',
    )
  })

  it('reads each issuance and parameter field at most once', () => {
    const source = baseInput()
    const reads = new Map<string, number>()
    const input = {}
    for (const [key, value] of Object.entries(source)) {
      if (key === 'parameters') continue
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          reads.set(key, (reads.get(key) ?? 0) + 1)
          return value
        },
      })
    }
    const parameterReads = new Map<string, number>()
    const parameters = {}
    for (const [key, value] of Object.entries(source.parameters)) {
      Object.defineProperty(parameters, key, {
        enumerable: true,
        get() {
          parameterReads.set(key, (parameterReads.get(key) ?? 0) + 1)
          return value
        },
      })
    }
    Object.defineProperty(input, 'parameters', {
      enumerable: true,
      get() {
        reads.set('parameters', (reads.get('parameters') ?? 0) + 1)
        return parameters
      },
    })

    normalizeElearningCertificateIssue(input)
    expect(Object.fromEntries(reads)).toEqual({
      certificateId: 1,
      effectKey: 1,
      issuedAt: 1,
      orgId: 1,
      parameters: 1,
      templateRevisionId: 1,
      templateText: 1,
      userId: 1,
    })
    expect(Object.fromEntries(parameterReads)).toEqual({ courseName: 1, learnerName: 1 })
  })
})
