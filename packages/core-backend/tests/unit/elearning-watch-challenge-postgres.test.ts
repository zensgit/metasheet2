import { describe, expect, it } from 'vitest'
import {
  ELEARNING_WATCH_CHALLENGE_REQUEST_DOMAIN,
  deriveElearningWatchChallengeRequestHash,
} from '../../src/services/elearning-watch-challenge-postgres'

const INPUT = {
  orgId: 'org-a',
  userId: 'user-a',
  sessionId: '11111111-1111-4111-8111-111111111111',
  challengeId: '22222222-2222-4222-8222-222222222222',
}

describe('elearning watch challenge PostgreSQL authority helpers', () => {
  it('derives a stable domain-separated values-free request hash', () => {
    const hash = deriveElearningWatchChallengeRequestHash(INPUT)
    expect(ELEARNING_WATCH_CHALLENGE_REQUEST_DOMAIN).toBe('elearning.watch.challenge.ack.v1')
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
    ]) {
      expect(deriveElearningWatchChallengeRequestHash(changed)).not.toBe(original)
    }
  })
})
