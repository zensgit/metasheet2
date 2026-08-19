import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ATTENDANCE_RULES_ME_OMIT_HEADERS } from '../src/views/attendance/rulesMeContract'

/**
 * FE↔server key-set sync for the rules/me SR-1 header contract (#5012).
 *
 * Standalone spec ON PURPOSE (gate round-3 P2-1): it lives in the always-on
 * `web-tests` required lane, so a PR that edits ONLY the plugin source still runs
 * it — attendance-web-guard's classifier skips vitest entirely for plugins/**
 * changes, which made the previous in-dashboard placement blind to exactly the
 * server-only drift it exists to catch. readFileSync-only, no Vue mount, so it
 * never touches the attendance component quarantine.
 */
describe('rules/me FE omit set ↔ server forbidden set sync', () => {
  it('the shared FE constant equals ATTENDANCE_RULES_ME_FORBIDDEN_HEADER_KEYS in the plugin source', () => {
    const pluginSource = readFileSync(
      join(__dirname, '../../../plugins/plugin-attendance/index.cjs'),
      'utf8',
    )
    const anchor = pluginSource.match(
      /const ATTENDANCE_RULES_ME_FORBIDDEN_HEADER_KEYS = new Set\(\[([^\]]+)\]\)/,
    )
    expect(anchor, 'server forbidden-set literal must be found in the plugin source').toBeTruthy()
    // Both quote styles: plugins/ has no eslint config and index.cjs already mixes
    // quoting, so a double-quoted 8th key must red this leg too (round-3 P3-1).
    const serverKeys = [...(anchor as RegExpMatchArray)[1].matchAll(/['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    )
    // Structural, not enumerated (枚举陷阱不收敛): every comma-separated entry in the
    // capture must have yielded a key — an entry in ANY unrecognized delimiter
    // (backtick, template literal, bare identifier) reds this instead of vanishing.
    const entryCount = (anchor as RegExpMatchArray)[1]
      .split(',')
      .filter((entry) => entry.trim().length > 0).length
    expect(serverKeys.length).toBe(entryCount)
    expect(serverKeys.length).toBeGreaterThan(0)
    expect([...ATTENDANCE_RULES_ME_OMIT_HEADERS].sort()).toEqual([...serverKeys].sort())
  })
})
