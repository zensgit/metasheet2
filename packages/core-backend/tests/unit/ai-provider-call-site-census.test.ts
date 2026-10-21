/**
 * PROVIDER CALL-SITE CENSUS — pins the governed-AI scope claim.
 *
 * `governed-ai-service.ts`'s header claims that every provider call in this
 * package passes through the `authorizeAiRoute()` routing choke. That claim is
 * only true while the set of provider call sites stays exactly the two known
 * ones. Adversarial review's P0 was precisely that the guard mediated NOTHING
 * while the live path called the provider directly — so the scope claim needs a
 * test, not a promise.
 *
 * This census walks the real source tree and fails if:
 *   - a NEW `.complete(` provider call site appears (someone added a third path), or
 *   - either known call site stops being preceded by the routing choke.
 *
 * If you are adding a legitimate new AI call site: route it through
 * `authorizeAiRoute()` (or better, through `GovernedAiService.suggest()`), then add
 * it here with its data class. Deleting an entry to make this pass is the one
 * move that is never correct.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(__dirname, '..', '..', 'src')

/** The complete, reviewed roster of provider-call sites in packages/core-backend/src. */
const KNOWN_CALL_SITES = [
  'services/ai-bulk-shared.ts', // runShortcutCore — shipped shortcut / bulk-fill / async worker
  'services/governed-ai-service.ts', // the boundary itself
].sort()

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
      walkTsFiles(full, acc)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      acc.push(full)
    }
  }
  return acc
}

function relative(file: string): string {
  return file.slice(SRC_ROOT.length + 1).split('\\').join('/')
}

describe('AI provider call-site census (pins the governed-AI scope claim)', () => {
  const files = walkTsFiles(SRC_ROOT)

  it('finds a non-trivial source tree (the walker itself is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('every `.complete(` provider call site is a KNOWN, routing-gated one', () => {
    const found: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      // Strip block comments so a doc mention of `.complete()` is not a call site.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '')
      // A real call: `<something>.complete({` — the provider client's only signature.
      if (/\.complete\(\s*\{/.test(code)) found.push(relative(file))
    }
    expect(found.sort()).toEqual(KNOWN_CALL_SITES)
  })

  it('BOTH known call sites import the routing choke `authorizeAiRoute`', () => {
    for (const site of KNOWN_CALL_SITES) {
      const text = readFileSync(join(SRC_ROOT, site), 'utf8')
      expect(text, `${site} must import authorizeAiRoute`).toContain('authorizeAiRoute')
    }
  })

  it('the live shortcut/bulk path gates on the BUSINESS class and calls the choke BEFORE the provider', () => {
    const text = readFileSync(join(SRC_ROOT, 'services/ai-bulk-shared.ts'), 'utf8')
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '')
    const gateAt = code.indexOf('authorizeAiRoute(')
    const callAt = code.search(/\.complete\(\s*\{/)
    expect(gateAt, 'routing choke must be present').toBeGreaterThan(-1)
    expect(callAt, 'provider call must be present').toBeGreaterThan(-1)
    // Ordering is the property: the gate must precede the provider call.
    expect(gateAt).toBeLessThan(callAt)
    // And it must be pinned to the business class, not a caller-supplied one.
    expect(code).toContain("AI_SHORTCUT_DATA_CLASS: AiDataClass = 'business'")
    expect(code).toContain('authorizeAiRoute(pre.provider, AI_SHORTCUT_DATA_CLASS)')
  })
})
