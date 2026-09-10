import { describe, expect, it } from 'vitest'

import {
  ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION,
  ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION,
  ELEARNING_OPEN_COMPLETION_EVALUATOR_VERSION,
  ElearningOpenCompletionPolicyError,
  createElearningOpenCompletionPolicy,
  evaluateElearningOpenCompletion,
  type ElearningOpenCompletionItemType,
} from '../../src/services/elearning-open-completion-policy'

const SENTINEL = 'secret-open-completion-value'
const ITEM_ID = '10000000-0000-4000-8000-000000000001'
const REVISION_ID = '20000000-0000-4000-8000-000000000001'
const EVENT_ID = '30000000-0000-4000-8000-000000000001'
const SHA256_RE = /^[0-9a-f]{64}$/

function policy(itemType: ElearningOpenCompletionItemType = 'article') {
  return {
    contentRevisionId: REVISION_ID,
    courseVersionItemId: ITEM_ID,
    itemType,
    policyVersion: itemType === 'article'
      ? ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION
      : ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION,
  }
}

function event(itemType: ElearningOpenCompletionItemType = 'article') {
  return {
    eventId: EVENT_ID,
    eventKind: itemType === 'article' ? 'article_open' : 'external_link_launch',
    serverReceivedAt: '2026-08-28T04:00:00.000Z',
  }
}

function expectInvalid(action: () => unknown): void {
  try {
    action()
    throw new Error('expected open completion policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningOpenCompletionPolicyError)
    const policyError = error as ElearningOpenCompletionPolicyError
    expect(policyError.code).toBe('invalid_input')
    expect(policyError.message).toBe('invalid_input')
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning open completion policy', () => {
  it('keeps an article incomplete until a server-owned open event exists', () => {
    const result = evaluateElearningOpenCompletion(
      createElearningOpenCompletionPolicy(policy()),
      null,
    )
    expect(result).toEqual({
      assurance: 'weak_server_recorded_open',
      completed: false,
      completedAt: null,
      contentRevisionId: REVISION_ID,
      courseVersionItemId: ITEM_ID,
      evaluatorVersion: ELEARNING_OPEN_COMPLETION_EVALUATOR_VERSION,
      evidenceDigest: null,
      eventId: null,
      eventKind: 'article_open',
      itemType: 'article',
      policyVersion: ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION,
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('derives article completion from the canonical server event', () => {
    const result = evaluateElearningOpenCompletion(
      createElearningOpenCompletionPolicy({
        ...policy(),
        contentRevisionId: REVISION_ID.toUpperCase(),
        courseVersionItemId: ITEM_ID.toUpperCase(),
      }),
      {
        ...event(),
        eventId: EVENT_ID.toUpperCase(),
        serverReceivedAt: '2026-08-28T12:00:00+08:00',
      },
    )
    expect(result).toMatchObject({
      assurance: 'weak_server_recorded_open',
      completed: true,
      completedAt: '2026-08-28T04:00:00.000Z',
      contentRevisionId: REVISION_ID,
      courseVersionItemId: ITEM_ID,
      eventId: EVENT_ID,
      eventKind: 'article_open',
      itemType: 'article',
      policyVersion: ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION,
    })
    expect(result.evidenceDigest).toMatch(SHA256_RE)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('labels external launch evidence separately and honestly as weak', () => {
    const article = evaluateElearningOpenCompletion(
      createElearningOpenCompletionPolicy(policy('article')),
      event('article'),
    )
    const external = evaluateElearningOpenCompletion(
      createElearningOpenCompletionPolicy(policy('external_link')),
      event('external_link'),
    )
    expect(external).toMatchObject({
      assurance: 'weak_server_recorded_launch',
      completed: true,
      eventKind: 'external_link_launch',
      itemType: 'external_link',
      policyVersion: ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION,
    })
    expect(external.evidenceDigest).toMatch(SHA256_RE)
    expect(external.evidenceDigest).not.toBe(article.evidenceDigest)
  })

  it('rejects item, policy, and event-kind mismatches', () => {
    for (const [candidatePolicy, observation] of [
      [{ ...policy('article'), policyVersion: ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION }, null],
      [{ ...policy('external_link'), policyVersion: ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION }, null],
      [{ ...policy('article'), itemType: 'video' }, null],
      [policy('article'), event('external_link')],
      [policy('external_link'), event('article')],
    ] as const) {
      expectInvalid(() => evaluateElearningOpenCompletion(
        createElearningOpenCompletionPolicy(candidatePolicy),
        observation,
      ))
    }
  })

  it('rejects invalid identities and non-times', () => {
    for (const [candidatePolicy, observation] of [
      [{ ...policy(), courseVersionItemId: 'item-1' }, null],
      [{ ...policy(), contentRevisionId: 'revision-1' }, null],
      [policy(), { ...event(), eventId: 'event-1' }],
      [policy(), { ...event(), serverReceivedAt: 'not-a-time' }],
      [policy(), { ...event(), serverReceivedAt: '2026-08-28' }],
      [policy(), { ...event(), serverReceivedAt: '2026-02-30T00:00:00Z' }],
      [policy(), { ...event(), serverReceivedAt: '2026-08-28T04:00:00+24:00' }],
      [policy(), { ...event(), serverReceivedAt: 1_788_000_000 }],
    ] as const) {
      expectInvalid(() => evaluateElearningOpenCompletion(
        createElearningOpenCompletionPolicy(candidatePolicy),
        observation,
      ))
    }
  })

  it('rejects client completion assertions and hostile objects values-free', () => {
    for (const [candidatePolicy, observation] of [
      [{ ...policy(), completed: true }, null],
      [policy(), { ...event(), completed: true }],
      [policy(), { ...event(), secret: SENTINEL }],
    ] as const) {
      expectInvalid(() => evaluateElearningOpenCompletion(
        createElearningOpenCompletionPolicy(candidatePolicy),
        observation,
      ))
    }
    const hostile = event()
    Object.defineProperty(hostile, 'serverReceivedAt', {
      enumerable: true,
      get() {
        throw new Error(SENTINEL)
      },
    })
    expectInvalid(() => evaluateElearningOpenCompletion(
      createElearningOpenCompletionPolicy(policy()),
      hostile,
    ))
  })

  it('produces deterministic evidence bound to event identity and server time', () => {
    const normalized = createElearningOpenCompletionPolicy(policy())
    const first = evaluateElearningOpenCompletion(normalized, event())
    const replay = evaluateElearningOpenCompletion(normalized, event())
    const later = evaluateElearningOpenCompletion(normalized, {
      ...event(),
      serverReceivedAt: '2026-08-28T04:00:01.000Z',
    })
    const anotherEvent = evaluateElearningOpenCompletion(normalized, {
      ...event(),
      eventId: '30000000-0000-4000-8000-000000000002',
    })
    expect(replay.evidenceDigest).toBe(first.evidenceDigest)
    expect(later.evidenceDigest).not.toBe(first.evidenceDigest)
    expect(anotherEvent.evidenceDigest).not.toBe(first.evidenceDigest)
  })
})
