import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

/**
 * Lock-7 G-14 — the FIVE hand copies of the NodeFieldAccess access enum (R-1) are asserted equal by
 * EXACT SET, and the site list itself is asserted, so a SIXTH copy added later fails the census rather
 * than passing unnoticed. These are hand copies — the compiler catches none of the drift. The count is
 * a swept finding, not a remembered figure (an earlier Lock-7 draft said four and missed
 * templateAuthoring.ts's guard). Dropping a member from any ONE site reds a distinct extractor here.
 */
const REPO = resolve(__dirname, '../../../..')
const MEMBERS = ['editable', 'hidden', 'readonly'] // sorted

// The five named sites (R-1), each with the exact construct that carries the enum members.
const SITES: Array<{ file: string; label: string; extract: (src: string) => string[] }> = [
  {
    file: 'packages/core-backend/src/types/approval-product.ts',
    label: 'backend NodeFieldAccess type',
    extract: (src) => membersOf(/NodeFieldAccess\s*=\s*((?:'[^']+'\s*\|?\s*)+)/, src),
  },
  {
    file: 'packages/core-backend/src/services/ApprovalProductService.ts',
    label: 'backend NODE_FIELD_ACCESS_VALUES Set',
    extract: (src) => membersOf(/NODE_FIELD_ACCESS_VALUES\s*=\s*new Set<NodeFieldAccess>\(\[([^\]]*)\]/, src),
  },
  {
    file: 'apps/web/src/types/approval.ts',
    label: 'FE NodeFieldAccess type',
    extract: (src) => membersOf(/NodeFieldAccess\s*=\s*((?:'[^']+'\s*\|?\s*)+)/, src),
  },
  {
    file: 'apps/web/src/approvals/approvalNodeEdit.ts',
    label: 'FE literal array',
    extract: (src) => membersOf(/\[([^\]]*)\]\s*as const\)\.includes\(permission\.access\)/, src),
  },
  {
    file: 'apps/web/src/approvals/templateAuthoring.ts',
    label: 'FE isNodeFieldAccess guard',
    extract: (src) => membersOf(/isNodeFieldAccess[\s\S]{0,160}?return ([^\n]+)/, src),
  },
]

function membersOf(re: RegExp, src: string): string[] {
  const m = src.match(re)
  if (!m) return []
  const found = new Set<string>()
  for (const q of m[1]!.matchAll(/'([^']+)'/g)) found.add(q[1]!)
  return [...found].sort()
}

function read(file: string): string {
  return readFileSync(join(REPO, file), 'utf8')
}

describe('NodeFieldAccess enum mirror (Lock-7 G-14 / R-1)', () => {
  for (const site of SITES) {
    it(`${site.label} declares EXACTLY {editable, readonly, hidden}`, () => {
      const members = site.extract(read(site.file))
      // Dropping (or adding) a member from THIS site reds this distinct named test.
      expect(members, `${site.file} (${site.label})`).toEqual(MEMBERS)
    })
  }

  it('the site list is exactly FIVE — a sixth independent copy fails the census', () => {
    // Census: scan both src trees for any of the three enum SHAPES (type union / member array / guard
    // disjunction). The set of files carrying one must equal the five named sites; a sixth copy in any
    // form adds a file (or a second construct in an existing file) and reds this test.
    const shapePatterns = [
      /'editable'\s*\|\s*'readonly'\s*\|\s*'hidden'/, // type union (sites 1, 3)
      /'editable'\s*,\s*'readonly'\s*,\s*'hidden'/, // member array — Set / literal (sites 2, 4)
      /=== 'editable'\s*\|\|\s*value === 'readonly'\s*\|\|\s*value === 'hidden'/, // isNodeFieldAccess guard (site 5)
    ]
    const roots = ['packages/core-backend/src', 'apps/web/src']
    const carriers = new Set<string>()
    for (const root of roots) {
      for (const abs of walk(join(REPO, root))) {
        if (!abs.endsWith('.ts') && !abs.endsWith('.vue')) continue
        if (abs.includes('__tests__') || abs.includes('/tests/') || abs.endsWith('.spec.ts') || abs.endsWith('.test.ts')) continue
        const src = readFileSync(abs, 'utf8')
        if (shapePatterns.some((re) => re.test(src))) carriers.add(abs.slice(REPO.length + 1))
      }
    }
    expect([...carriers].sort()).toEqual(SITES.map((s) => s.file).sort())
  })
})

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = join(dir, entry)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      yield* walk(abs)
    } else {
      yield abs
    }
  }
}
