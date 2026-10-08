import { describe, expect, test } from 'vitest'

import {
  BPMN_TIMER_POLLER_ENABLED_ENV,
  isBpmnTimerPollerEnabled,
} from '../bpmnTimerPollerConfig'

describe('BPMN timer poller env-gate config (#4770/#4779 Plan B)', () => {
  test('env key is the documented ENABLE_BPMN_TIMER_POLLER name', () => {
    expect(BPMN_TIMER_POLLER_ENABLED_ENV).toBe('ENABLE_BPMN_TIMER_POLLER')
  })

  test('unset env defaults to disabled', () => {
    expect(isBpmnTimerPollerEnabled({})).toBe(false)
  })

  test.each([
    'false',
    'FALSE',
    'TRUE',
    'True',
    '1',
    'yes',
    'on',
    '',
    ' true',
    'true ',
  ])('rejects every non-exact value %j as disabled (strict equality, not truthy coercion)', (value) => {
    expect(isBpmnTimerPollerEnabled({ [BPMN_TIMER_POLLER_ENABLED_ENV]: value })).toBe(false)
  })

  test('only the exact literal "true" enables the poller', () => {
    expect(isBpmnTimerPollerEnabled({ [BPMN_TIMER_POLLER_ENABLED_ENV]: 'true' })).toBe(true)
  })

  test('is indifferent to unrelated env keys (no accidental coupling to DISABLE_WORKFLOW or WORKFLOW_ENABLED)', () => {
    expect(isBpmnTimerPollerEnabled({ DISABLE_WORKFLOW: 'true', WORKFLOW_ENABLED: 'true' })).toBe(false)
    expect(isBpmnTimerPollerEnabled({
      DISABLE_WORKFLOW: 'false',
      WORKFLOW_ENABLED: 'false',
      [BPMN_TIMER_POLLER_ENABLED_ENV]: 'true',
    })).toBe(true)
  })

  test('defaults to reading process.env when no override is supplied', () => {
    const original = process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
    try {
      delete process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
      expect(isBpmnTimerPollerEnabled()).toBe(false)
      process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = 'true'
      expect(isBpmnTimerPollerEnabled()).toBe(true)
    } finally {
      if (original === undefined) delete process.env[BPMN_TIMER_POLLER_ENABLED_ENV]
      else process.env[BPMN_TIMER_POLLER_ENABLED_ENV] = original
    }
  })
})
