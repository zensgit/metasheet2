import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Bare-hex ratchet for AttendanceView.vue (hex→UF-token migration design-lock
// §4): the count of raw hex colors may only go DOWN. New styles must consume
// UF --ms-* tokens; each migration batch lowers the ceiling. If this test
// fails because you ADDED a hex color, use a token instead; if it fails
// because you migrated some (count dropped), lower MAX_BARE_HEX to the new
// count so the ratchet holds the gain.
const MAX_BARE_HEX = 285

// PR/issue references in comments (e.g. "#2333") are valid hex-digit runs, so
// comments must be stripped before counting — otherwise citing a PR number in
// a comment would trip the ratchet as a false positive.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
}

describe('AttendanceView bare-hex ratchet', () => {
  it(`has at most ${MAX_BARE_HEX} bare hex colors (monotonically decreasing)`, () => {
    const source = stripComments(readFileSync(resolve(__dirname, '../src/views/AttendanceView.vue'), 'utf8'))
    const matches = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(matches.length).toBeLessThanOrEqual(MAX_BARE_HEX)
  })

  it('exact-token hexes stay migrated (no regression of batch B1)', () => {
    const source = readFileSync(resolve(__dirname, '../src/views/AttendanceView.vue'), 'utf8')
    // These values equal UF tokens byte-for-byte; batch B1 migrated every
    // property-aligned occurrence. A reappearance means a new style hardcoded
    // a value that has a token (--ms-text-1/-2, --ms-border(-light), --ms-bg-page).
    for (const hex of ['#111827', '#4b5563', '#d1d5db', '#f5f6f8']) {
      expect(source.includes(hex), `expected no bare ${hex} (use its UF token)`).toBe(false)
    }
  })
})
