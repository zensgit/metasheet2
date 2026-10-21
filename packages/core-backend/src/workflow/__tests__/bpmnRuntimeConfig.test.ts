import { describe, expect, test, vi } from 'vitest'

import {
  BPMN_RUNTIME_ENABLED_ENV,
  BPMN_RUNTIME_DISABLE_ENV,
  BPMN_RUNTIME_DISABLED_MESSAGE,
  isBpmnRuntimeEnabled,
  requireBpmnRuntimeEnabled,
} from '../bpmnRuntimeConfig'

describe('BPMN runtime fail-closed env-gate (P0-S S1)', () => {
  test('env key names are the documented flags', () => {
    expect(BPMN_RUNTIME_ENABLED_ENV).toBe('ENABLE_BPMN_RUNTIME')
    expect(BPMN_RUNTIME_DISABLE_ENV).toBe('DISABLE_WORKFLOW')
  })

  test('unset env defaults to disabled (fail-closed)', () => {
    expect(isBpmnRuntimeEnabled({})).toBe(false)
  })

  test.each(['false', 'FALSE', 'True', 'TRUE', '1', 'yes', 'on', '', ' true '])(
    'non-exact value %j is disabled',
    (value) => {
      expect(isBpmnRuntimeEnabled({ [BPMN_RUNTIME_ENABLED_ENV]: value })).toBe(false)
    },
  )

  test("exact 'true' enables", () => {
    expect(isBpmnRuntimeEnabled({ [BPMN_RUNTIME_ENABLED_ENV]: 'true' })).toBe(true)
  })

  test("DISABLE_WORKFLOW='true' forces off even when ENABLE_BPMN_RUNTIME='true'", () => {
    expect(
      isBpmnRuntimeEnabled({
        [BPMN_RUNTIME_ENABLED_ENV]: 'true',
        [BPMN_RUNTIME_DISABLE_ENV]: 'true',
      }),
    ).toBe(false)
  })

  test('non-true DISABLE_WORKFLOW does not force off', () => {
    expect(
      isBpmnRuntimeEnabled({
        [BPMN_RUNTIME_ENABLED_ENV]: 'true',
        [BPMN_RUNTIME_DISABLE_ENV]: 'false',
      }),
    ).toBe(true)
  })
})

describe('requireBpmnRuntimeEnabled middleware (P0-S S1)', () => {
  function makeRes() {
    const res = {
      statusCode: 0 as number,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(body: unknown) {
        this.body = body
        return body
      },
    }
    return res
  }

  test('disabled runtime → 503 BPMN_RUNTIME_DISABLED, next NOT called', () => {
    vi.stubEnv('ENABLE_BPMN_RUNTIME', '')
    const res = makeRes()
    const next = vi.fn()
    requireBpmnRuntimeEnabled({}, res, next)
    expect(res.statusCode).toBe(503)
    expect(res.body).toMatchObject({ success: false, code: 'BPMN_RUNTIME_DISABLED' })
    expect(res.body).toMatchObject({ error: BPMN_RUNTIME_DISABLED_MESSAGE })
    expect(next).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  test("enabled runtime → next() called, no status written", () => {
    vi.stubEnv('DISABLE_WORKFLOW', '')
    vi.stubEnv('ENABLE_BPMN_RUNTIME', 'true')
    const res = makeRes()
    const next = vi.fn()
    requireBpmnRuntimeEnabled({}, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(0)
    vi.unstubAllEnvs()
  })

  test('DISABLE_WORKFLOW=true still 503 even with ENABLE_BPMN_RUNTIME=true', () => {
    vi.stubEnv('ENABLE_BPMN_RUNTIME', 'true')
    vi.stubEnv('DISABLE_WORKFLOW', 'true')
    const res = makeRes()
    const next = vi.fn()
    requireBpmnRuntimeEnabled({}, res, next)
    expect(res.statusCode).toBe(503)
    expect(next).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})
