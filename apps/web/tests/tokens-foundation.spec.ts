import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * UF-1 guard: styles/tokens.css is the single source of truth per the UI
 * foundation design-lock (docs/development/ui-foundation-design-lock-20260706.md).
 * These assertions pin the contract, not the palette values.
 */
const tokensCss = readFileSync(resolve(__dirname, '../src/styles/tokens.css'), 'utf8')

describe('UF-1 design-token foundation (tokens.css)', () => {
  it('defines --ms-color-danger (previously a ghost token referenced with a fallback hex)', () => {
    expect(tokensCss).toMatch(/--ms-color-danger:\s*#[0-9a-fA-F]{6}\s*;/)
  })

  it('maps --el-color-primary to var(--ms-color-primary)', () => {
    expect(tokensCss).toMatch(/--el-color-primary:\s*var\(--ms-color-primary\)\s*;/)
  })

  it('contains no !important (tokens win by import order, not specificity hacks)', () => {
    expect(tokensCss).not.toContain('!important')
  })

  // Generic elevation + control-sizing tokens added when the multitable grid line
  // (design-lock §8, an independent line) needed values the UF-1 base did not yet
  // define. Pinned here so a future "dead CSS" sweep cannot silently drop them —
  // they are consumed by the grid/toolbar surface, not just their own file.
  it.each([
    '--ms-control-height',
    '--ms-shadow-card',
    '--ms-shadow-pop',
  ])('defines the generic foundation token %s', (token) => {
    expect(tokensCss).toMatch(new RegExp(`${token}:\\s*[^;]+;`))
  })
})
