import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import {
  ELEARNING_WATCH_CHALLENGE_REQUEST_DOMAIN,
  ELEARNING_WATCH_CHALLENGE_REQUEST_HASH_VERSION,
  ELEARNING_WATCH_CHALLENGE_PROMPT_VERSION,
  createElearningWatchChallengePrompt,
  createElearningWatchChallengePublicPrompt,
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

function crc32(value: Buffer): number {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function expectCanonicalPng(base64: string): void {
  const png = Buffer.from(base64, 'base64')
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(png.length).toBeLessThanOrEqual(64 * 1024)
  let offset = 8
  const kinds: string[] = []
  const imageData: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = png.readUInt32BE(offset + 8 + length)
    expect(crc32(Buffer.concat([type, data]))).toBe(expectedCrc)
    kinds.push(type.toString('ascii'))
    if (type.toString('ascii') === 'IHDR') {
      expect(data.readUInt32BE(0)).toBe(360)
      expect(data.readUInt32BE(4)).toBe(260)
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0])
    }
    if (type.toString('ascii') === 'IDAT') imageData.push(data)
    offset += 12 + length
  }
  expect(offset).toBe(png.length)
  expect(kinds).toEqual(['IHDR', 'IDAT', 'IEND'])
  const pixels = inflateSync(Buffer.concat(imageData))
  expect(pixels).toHaveLength((360 * 4 + 1) * 260)
  for (let row = 0; row < 260; row += 1) expect(pixels[row * (360 * 4 + 1)]).toBe(0)
  expect(new Set(pixels).size).toBeGreaterThan(4)
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
    const publicPrompt = createElearningWatchChallengePublicPrompt(prompt)
    expect(Object.keys(publicPrompt).sort()).toEqual([
      'imageHeight', 'imagePngBase64', 'imageWidth', 'options', 'promptVersion',
    ])
    expect(publicPrompt.promptVersion).toBe('raster-position-v2')
    expect(publicPrompt.options).toHaveLength(6)
    expect(publicPrompt.options.map((option) => option.optionId))
      .toEqual(prompt.options.map((option) => option.optionId))
    expect(publicPrompt.options.every((option) => Object.keys(option).sort().join(',')
      === 'height,optionId,width,x,y')).toBe(true)
    const serialized = JSON.stringify(publicPrompt)
    for (const option of prompt.options) expect(serialized).not.toContain(option.label)
    expect(serialized).not.toContain('targets')
    expect(serialized).not.toContain('expectedSelections')
    expectCanonicalPng(publicPrompt.imagePngBase64)
    expect(createElearningWatchChallengePublicPrompt(prompt)).toEqual(publicPrompt)
  })
})
