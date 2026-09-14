/**
 * W5-B R3: every shipped deploy template sets NODE_ENV=production, and the backend now fail-closes
 * when ENCRYPTION_KEY / ENCRYPTION_SALT are unset or left at the built-in default
 * (packages/core-backend/src/security/encrypted-secrets.ts). A template that does not even MENTION
 * the two variables produces an instance that dies on its first stored credential — the failure
 * lands on the customer, not on us.
 *
 * The on-prem package scripts copy these files verbatim (no value injection), so the template IS
 * the contract. This guard holds it.
 *
 * Values-free by construction: it asserts the keys are DECLARED and EMPTY, and fails if a template
 * ever ships a non-empty value (a baked-in secret is worse than a missing one).
 */
import fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const TEMPLATES = [
  'docker/app.env.example',
  'docker/app.env.attendance-onprem.template',
  'docker/app.env.multitable-onprem.template',
  'docker/app.staging.env.example',
  'docker/app.env.attendance-onprem.ready.env',
]

const REQUIRED_KEYS = ['ENCRYPTION_KEY', 'ENCRYPTION_SALT']

function readTemplate(rel: string): string[] {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split(/\r?\n/)
}

/**
 * Nearest preceding non-blank line, skipping the sibling ENCRYPTION_* assignment: the two keys
 * share one comment block, so requiring a comment immediately above EACH of them would only force
 * a duplicated paragraph.
 */
function nearestPrecedingNonBlank(lines: string[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim()
    if (trimmed.length === 0) continue
    if (REQUIRED_KEYS.some(key => trimmed.startsWith(`${key}=`))) continue
    return trimmed
  }
  return null
}

describe('deploy templates declare the encryption material', () => {
  for (const rel of TEMPLATES) {
    it(`${rel} declares ENCRYPTION_KEY / ENCRYPTION_SALT, empty and explained`, () => {
      const lines = readTemplate(rel)

      // Sanity: this guard only matters for templates that actually run as production.
      expect(lines.some(line => /^NODE_ENV=production\s*$/.test(line))).toBe(true)

      for (const key of REQUIRED_KEYS) {
        const index = lines.findIndex(line => new RegExp(`^${key}=`).test(line))
        expect(
          index,
          `${rel} does not declare ${key}; an instance deployed from it fails closed on its first stored credential`,
        ).toBeGreaterThanOrEqual(0)

        // Empty on purpose: never ship a value, not even an example one.
        expect(lines[index].trim()).toBe(`${key}=`)

        const preceding = nearestPrecedingNonBlank(lines, index)
        expect(
          preceding !== null && preceding.startsWith('#'),
          `${key} in ${rel} has no preceding comment explaining that production requires it`,
        ).toBe(true)
      }
    })
  }
})
