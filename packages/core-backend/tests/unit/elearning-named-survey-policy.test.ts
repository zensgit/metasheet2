import { describe, expect, it } from 'vitest'

import {
  ELEARNING_NAMED_SURVEY_DOMAIN,
  ElearningNamedSurveyPolicyError,
  createElearningNamedSurveyBinding,
  evaluateElearningNamedSurveySubmission,
} from '../../src/services/elearning-named-survey-policy'

const SENTINEL = 'secret-named-survey-value'

function binding(overrides: Record<string, unknown> = {}) {
  return {
    bindingRevision: 'binding-v1',
    orgId: 'org-1',
    sheetId: 'sheet-1',
    surveyKey: 'survey-1',
    trainingKey: 'training-1',
    viewId: 'view-1',
    ...overrides,
  }
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    _eventId: 'event-1',
    actorId: 'learner-1',
    mode: 'create',
    recordId: 'record-1',
    sheetId: 'sheet-1',
    viewId: 'view-1',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected named survey policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningNamedSurveyPolicyError)
    const policyError = error as ElearningNamedSurveyPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning named survey policy', () => {
  it('creates an exact immutable form-view binding', () => {
    const result = createElearningNamedSurveyBinding(binding())
    expect(result).toEqual({
      bindingRevision: 'binding-v1',
      orgId: 'org-1',
      sheetId: 'sheet-1',
      surveyKey: 'survey-1',
      trainingKey: 'training-1',
      viewId: 'view-1',
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('accepts a matching named form submission as a completion intent', () => {
    const result = evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      event(),
    )
    expect(result).toEqual({
      bindingRevision: 'binding-v1',
      completionEffect: {
        actorUserId: 'learner-1',
        effectKey: expect.stringMatching(
          new RegExp(`^${ELEARNING_NAMED_SURVEY_DOMAIN}:[a-f0-9]{64}$`),
        ),
        kind: 'named_survey_completion',
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        reference: {
          orgId: 'org-1',
          recordId: 'record-1',
          sheetId: 'sheet-1',
          surveyKey: 'survey-1',
          trainingKey: 'training-1',
          viewId: 'view-1',
        },
      },
      eventId: 'event-1',
      eventMode: 'create',
      reason: null,
      status: 'accepted',
    })
  })

  it('keeps completion identity and payload stable across create/update event delivery', () => {
    const created = evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      event(),
    )
    const updated = evaluateElearningNamedSurveySubmission(
      binding({ bindingRevision: 'binding-v2' }),
      { orgId: 'org-1' },
      event({ _eventId: 'event-2', mode: 'update' }),
    )
    expect(updated.eventId).toBe('event-2')
    expect(updated.eventMode).toBe('update')
    expect(updated.completionEffect?.effectKey).toBe(created.completionEffect?.effectKey)
    expect(updated.completionEffect?.payloadDigest).toBe(
      created.completionEffect?.payloadDigest,
    )
  })

  it('rejects a different form view even when the sheet matches', () => {
    expect(evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      event({ viewId: 'view-other' }),
    )).toEqual({
      bindingRevision: 'binding-v1',
      completionEffect: null,
      eventId: 'event-1',
      eventMode: 'create',
      reason: 'binding_mismatch',
      status: 'ignored',
    })
  })

  it('rejects a different sheet even when the view key matches', () => {
    expect(evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      event({ sheetId: 'sheet-other' }),
    )).toMatchObject({
      completionEffect: null,
      reason: 'binding_mismatch',
      status: 'ignored',
    })
  })

  it('rejects cross-organization context without producing an effect', () => {
    expect(evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-2' },
      event(),
    )).toMatchObject({
      completionEffect: null,
      reason: 'context_mismatch',
      status: 'ignored',
    })
  })

  it('rejects anonymous submissions for the named-survey contract', () => {
    expect(evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      event({ actorId: null }),
    )).toMatchObject({
      completionEffect: null,
      reason: 'anonymous_not_allowed',
      status: 'ignored',
    })
  })

  it('requires viewId and rejects the current legacy producer shape fail-closed', () => {
    const { viewId: _viewId, ...legacyEvent } = event()
    expectCode(() => evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      legacyEvent,
    ), 'invalid_event')
  })

  it('scopes effect identity by organization, actor, survey, and training', () => {
    const effect = (bindingInput: unknown, eventInput: unknown) => (
      evaluateElearningNamedSurveySubmission(
        bindingInput,
        { orgId: (bindingInput as { orgId: string }).orgId },
        eventInput,
      ).completionEffect
    )
    const original = effect(binding(), event())
    const otherOrg = effect(binding({ orgId: 'org-2' }), event())
    const otherActor = effect(binding(), event({ actorId: 'learner-2' }))
    const otherSurvey = effect(binding({ surveyKey: 'survey-2' }), event())
    const otherTraining = effect(binding({ trainingKey: 'training-2' }), event())
    expect(new Set([
      original?.effectKey,
      otherOrg?.effectKey,
      otherActor?.effectKey,
      otherSurvey?.effectKey,
      otherTraining?.effectKey,
    ]).size).toBe(5)
  })

  it('turns a second record for the same learner and survey into a digest conflict', () => {
    const original = evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      event(),
    ).completionEffect
    const duplicateRecord = evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      event({ _eventId: 'event-2', recordId: 'record-2' }),
    ).completionEffect
    expect(duplicateRecord?.effectKey).toBe(original?.effectKey)
    expect(duplicateRecord?.payloadDigest).not.toBe(original?.payloadDigest)
  })

  it('rejects malformed bindings, contexts, and events values-free', () => {
    for (const input of [
      null,
      {},
      binding({ viewId: `${SENTINEL}\0` }),
      { ...binding(), extra: SENTINEL },
    ]) {
      expectCode(() => evaluateElearningNamedSurveySubmission(
        input,
        { orgId: 'org-1' },
        event(),
      ), 'invalid_binding')
    }
    for (const input of [null, {}, { orgId: '' }, { orgId: 'org-1', extra: SENTINEL }]) {
      expectCode(() => evaluateElearningNamedSurveySubmission(
        binding(),
        input,
        event(),
      ), 'invalid_context')
    }
    for (const input of [
      null,
      {},
      event({ mode: SENTINEL }),
      event({ actorId: '\ud800' }),
      { ...event(), extra: SENTINEL },
    ]) {
      expectCode(() => evaluateElearningNamedSurveySubmission(
        binding(),
        { orgId: 'org-1' },
        input,
      ), 'invalid_event')
    }
    const throwing = Object.defineProperty(event(), 'viewId', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      throwing,
    ), 'invalid_event')
  })

  it('returns deeply immutable and closed decisions', () => {
    const accepted = evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-1' },
      event(),
    )
    expect(Reflect.ownKeys(accepted)).toEqual([
      'bindingRevision',
      'completionEffect',
      'eventId',
      'eventMode',
      'reason',
      'status',
    ])
    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted.completionEffect)).toBe(true)
    expect(Object.isFrozen(accepted.completionEffect?.reference)).toBe(true)

    const ignored = evaluateElearningNamedSurveySubmission(
      binding(),
      { orgId: 'org-2' },
      event(),
    )
    expect(Object.isFrozen(ignored)).toBe(true)
  })
})
