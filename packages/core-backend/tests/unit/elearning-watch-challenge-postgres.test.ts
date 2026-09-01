import { describe, expect, it } from 'vitest'
import {
  ELEARNING_WATCH_CHALLENGE_REQUEST_DOMAIN,
  ELEARNING_WATCH_CHALLENGE_REQUEST_HASH_VERSION,
  ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION,
  createElearningWatchChallengePrompt,
  deriveElearningWatchChallengeRequestHash,
} from '../../src/services/elearning-watch-challenge-postgres'

const INPUT = {
  orgId: 'org-a',
  userId: 'user-a',
  sessionId: '11111111-1111-4111-8111-111111111111',
  challengeId: '22222222-2222-4222-8222-222222222222',
  selections: [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ] as const,
}

describe('elearning watch challenge PostgreSQL authority helpers', () => {
  it('derives a stable domain-separated values-free request hash', () => {
    const hash = deriveElearningWatchChallengeRequestHash(INPUT)
    expect(ELEARNING_WATCH_CHALLENGE_REQUEST_DOMAIN).toBe('elearning.watch.challenge.ack.v2')
    expect(ELEARNING_WATCH_CHALLENGE_REQUEST_HASH_VERSION).toBe(2)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(deriveElearningWatchChallengeRequestHash({ ...INPUT })).toBe(hash)
    expect(hash).not.toContain(INPUT.orgId)
    expect(hash).not.toContain(INPUT.userId)
  })

  it('changes identity for every authority dimension', () => {
    const original = deriveElearningWatchChallengeRequestHash(INPUT)
    for (const changed of [
      { ...INPUT, orgId: 'org-b' },
      { ...INPUT, userId: 'user-b' },
      { ...INPUT, sessionId: '33333333-3333-4333-8333-333333333333' },
      { ...INPUT, challengeId: '44444444-4444-4444-8444-444444444444' },
      { ...INPUT, selections: [INPUT.selections[1], INPUT.selections[0]] as const },
    ]) {
      expect(deriveElearningWatchChallengeRequestHash(changed)).not.toBe(original)
    }
  })

  it('creates a stable six-option prompt with two distinct ordered targets', () => {
    const prompt = createElearningWatchChallengePrompt()
    expect(prompt.promptVersion).toBe(ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION)
    expect(prompt.options).toHaveLength(6)
    expect(new Set(prompt.options.map((option) => option.optionId)).size).toBe(6)
    expect(new Set(prompt.options.map((option) => option.label)).size).toBe(6)
    expect(prompt.expectedSelections).toHaveLength(2)
    expect(prompt.expectedSelections[0]).not.toBe(prompt.expectedSelections[1])
    const labelById = new Map(prompt.options.map((option) => [option.optionId, option.label]))
    expect(prompt.targets).toEqual([
      labelById.get(prompt.expectedSelections[0]),
      labelById.get(prompt.expectedSelections[1]),
    ])
  })
})
