import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

/**
 * Lock-7 G-14 (widened by Lock-7B OD-L7B-10, docs/development/approval-lock7b-required-at-node-
 * 20260820.md §0.4/§3) — the NINE hand-mirrored sites of the `NodeFieldAccess` access enum are
 * asserted equal by EXACT SET, and the site list itself is asserted, so a TENTH copy added later
 * fails the census rather than passing unnoticed. These are hand copies — the compiler catches none
 * of the drift for seven of the nine (C-3's `Record<NodeFieldAccess, number>` is the one exception:
 * TypeScript itself fails the build on a missing key).
 *
 * COUNT HISTORY (a swept finding, never a remembered figure — G-14): Lock-7 R-1 found FIVE
 * (`editable`/`readonly`/`hidden`, three members). An independent review of the Lock-7B draft (P2-1)
 * found a NINTH site (C-9, the publish-rejection message) the first sweep missed; §0.4 re-swept at
 * `a0edbe39a4` and settled on NINE, four of which (C-3/C-4/C-8/C-9) are new to this file. C-4
 * (`resolveFieldAccessAtNodes`'s inline filter) is DELIBERATELY not a member-list site any more —
 * Lock-7B OD-L7B-10 replaced its literal chain with a mechanical `NODE_FIELD_ACCESS_VALUES.has(...)`
 * call, so it is asserted by SHAPE (mechanical-call present, literal-chain absent) in its own
 * `describe` block below, not by the member-equality loop the other eight share.
 */
const REPO = resolve(__dirname, '../../../..')
const MEMBERS = ['editable', 'hidden', 'readonly', 'required'] // sorted

// The SEVEN LITERAL-MEMBER-LIST sites (C-1, C-2, C-3, C-5, C-6, C-7, C-8). C-4 and C-9 are handled in
// their own describe blocks below instead of this member-equality loop: C-4 because Lock-7B
// intentionally converted it FROM a literal list TO a mechanical enumeration call (OD-L7B-10) —
// asserting it here would defeat the anti-appended-arm gate (G-2) — and C-9 because its message is
// DERIVED at runtime from `NODE_FIELD_ACCESS_VALUES` (OD-L7B-10) and therefore carries no literal
// member strings in source for a member-list extractor to find; the requirement IS the absence of a
// hand-written literal, asserted by shape (and, behaviourally, by the actual 400 message text in
// `approval-product-service.test.ts`'s P1-C describe block).
const SITES: Array<{ file: string; label: string; extract: (src: string) => string[] }> = [
  {
    file: 'packages/core-backend/src/types/approval-product.ts',
    label: 'backend NodeFieldAccess type (C-1)',
    extract: (src) => membersOf(/NodeFieldAccess\s*=\s*((?:'[^']+'\s*\|?\s*)+)/, src),
  },
  {
    file: 'packages/core-backend/src/types/approval-product.ts',
    label: 'backend NODE_FIELD_ACCESS_VALUES Set (C-2)',
    extract: (src) => membersOf(/NODE_FIELD_ACCESS_VALUES\s*=\s*new Set<NodeFieldAccess>\(\[([^\]]*)\]/, src),
  },
  {
    file: 'packages/core-backend/src/services/approval-form-redaction.ts',
    label: 'backend NODE_FIELD_ACCESS_RANK Record keys (C-3, compiler-guarded)',
    extract: (src) => {
      const m = src.match(/NODE_FIELD_ACCESS_RANK\s*:\s*Record<NodeFieldAccess,\s*number>\s*=\s*\{([^}]*)\}/)
      if (!m) return []
      return [...new Set([...m[1]!.matchAll(/(\w+)\s*:\s*\d+/g)].map((q) => q[1]!))].sort()
    },
  },
  {
    file: 'apps/web/src/types/approval.ts',
    label: 'FE NodeFieldAccess type (C-5)',
    extract: (src) => membersOf(/NodeFieldAccess\s*=\s*((?:'[^']+'\s*\|?\s*)+)/, src),
  },
  {
    file: 'apps/web/src/approvals/approvalNodeEdit.ts',
    label: 'FE literal array (C-6)',
    extract: (src) => membersOf(/\[([^\]]*)\]\s*as const\)\.includes\(permission\.access\)/, src),
  },
  {
    file: 'apps/web/src/approvals/templateAuthoring.ts',
    label: 'FE isNodeFieldAccess guard (C-7)',
    extract: (src) => membersOf(/isNodeFieldAccess[\s\S]{0,220}?return ([^\n]+)/, src),
  },
  {
    file: 'packages/openapi/src/base.yml',
    label: 'OpenAPI fieldAccess wire enum (C-8)',
    extract: (src) => membersOf(/fieldAccess:[\s\S]{0,200}?enum:\s*\[([^\]]*)\]/, src, /(\w+)/g),
  },
]

/**
 * Extracts quoted-string members from a regex match's first capture group. The OpenAPI site (C-8)
 * carries BARE (unquoted) YAML scalars (`enum: [editable, readonly, hidden, required]`), so it passes
 * a bare-word pattern; every other site is TypeScript string-literal syntax and uses the default.
 */
function membersOf(re: RegExp, src: string, wordPattern: RegExp = /'([^']+)'/g): string[] {
  const m = src.match(re)
  if (!m) return []
  const found = new Set<string>()
  for (const q of m[1]!.matchAll(wordPattern)) found.add(q[1]!)
  return [...found].sort()
}

function read(file: string): string {
  return readFileSync(join(REPO, file), 'utf8')
}

describe('NodeFieldAccess enum mirror (Lock-7 G-14 / Lock-7B OD-L7B-10)', () => {
  for (const site of SITES) {
    it(`${site.label} declares EXACTLY {editable, hidden, readonly, required}`, () => {
      const members = site.extract(read(site.file))
      // Dropping (or adding) a member from THIS site reds this distinct named test.
      expect(members, `${site.file} (${site.label})`).toEqual(MEMBERS)
    })
  }

  describe('C-4 — resolveFieldAccessAtNodes is a MECHANICAL enumeration, never a literal chain (G-2 anti-gate)', () => {
    const src = read('packages/core-backend/src/services/approval-form-redaction.ts')

    it('reads NODE_FIELD_ACCESS_VALUES.has(candidate) — the mechanical enumeration form', () => {
      expect(src).toMatch(/NODE_FIELD_ACCESS_VALUES\.has\(candidate\)/)
    })

    it('does NOT contain the retired literal disjunction chain (an appended `|| candidate === X` arm would still match this)', () => {
      // The shipped Lock-7 shape this site used to carry, before OD-L7B-10:
      //   candidate !== 'editable' && candidate !== 'readonly' && candidate !== 'hidden'
      // An implementation that "fixes" C-4 by appending `|| candidate === 'required'` to a REVIVED
      // literal chain would satisfy the member-equality check trivially (there is no member-equality
      // check on this site any more) but still fail THIS shape assertion — which is exactly the
      // anti-gate G-2 requires: the mechanism is asserted by reading the diff, not the outcome.
      expect(src).not.toMatch(/candidate\s*!==\s*'editable'\s*&&\s*candidate\s*!==\s*'readonly'/)
    })

    it('imports NODE_FIELD_ACCESS_VALUES as a VALUE (not type-only) from the canonical types module', () => {
      expect(src).toMatch(/import\s*\{[^}]*\bNODE_FIELD_ACCESS_VALUES\b[^}]*\}\s*from\s*'\.\.\/types\/approval-product'/)
    })
  })

  describe('C-9 — the publish-rejection message is DERIVED from NODE_FIELD_ACCESS_VALUES, never hand-rewritten (OD-L7B-10)', () => {
    const src = read('packages/core-backend/src/services/ApprovalProductService.ts')

    it('builds the message from `[...NODE_FIELD_ACCESS_VALUES]`, not a literal string', () => {
      expect(src).toMatch(/NODE_FIELD_ACCESS_VALUES_MESSAGE\s*=\s*\(\(\)\s*=>\s*\{/)
      expect(src).toMatch(/\[\.\.\.NODE_FIELD_ACCESS_VALUES\]/)
    })

    it('the normalizer reads the DERIVED constant, not a hand-written string, in its failValidation call', () => {
      expect(src).toMatch(/failValidation\(context, `\$\{entryPath\}\.access must be \$\{NODE_FIELD_ACCESS_VALUES_MESSAGE\}`\)/)
    })

    it('does NOT contain the retired hand-written three-member message (the Lock-7 shape this site used to carry)', () => {
      expect(src).not.toMatch(/access must be editable, readonly, or hidden/)
    })

    // The BEHAVIOURAL half — the actual 400 an author receives says "editable, readonly, hidden, or
    // required" — is asserted in approval-product-service.test.ts's "P1-C node field permissions"
    // describe block ("rejects an invalid access enum before hitting the database"), which drives the
    // real normalizeNodeFieldPermissions/failValidation code path end-to-end. Duplicating an exact
    // 400-body assertion here would just re-implement that test against the same source text.
  })

  it('the NINE sites live in exactly SEVEN files — an unlisted eighth file carrying a copy fails the census', () => {
    // Census: scan both src trees for any of the enum-carrying SHAPES (member list, Record keys,
    // guard disjunction, wire enum, or the derived-message IIFE). The set of FILES carrying at least
    // one such shape must equal the seven files the nine named sites live in (types/approval-
    // product.ts hosts both C-1 and C-2; approval-form-redaction.ts hosts both C-3 and C-4) — an
    // unlisted eighth file adds a new carrier and reds this test. C-4's mechanical-call form is
    // DELIBERATELY excluded from this shape scan (it carries no member LIST to census — its own file
    // is still covered via C-3's Record-keys pattern) and is asserted by its own describe block above.
    const shapePatterns = [
      /'editable'\s*\|\s*'readonly'\s*\|\s*'hidden'\s*\|\s*'required'/, // type union (C-1, C-5)
      /'editable'\s*,\s*'readonly'\s*,\s*'hidden'\s*,\s*'required'/, // member array — Set/literal (C-2, C-6)
      /=== 'editable'\s*\|\|\s*value === 'readonly'\s*\|\|\s*value === 'hidden'\s*\|\|\s*value === 'required'/, // isNodeFieldAccess guard (C-7)
      /NODE_FIELD_ACCESS_RANK\s*:\s*Record<NodeFieldAccess,\s*number>\s*=\s*\{/, // rank table (C-3)
      /enum:\s*\[editable,\s*readonly,\s*hidden,\s*required\]/, // OpenAPI wire enum (C-8)
      /NODE_FIELD_ACCESS_VALUES_MESSAGE\s*=\s*\(\(\)\s*=>/, // derived publish message (C-9)
    ]
    const roots = ['packages/core-backend/src', 'apps/web/src', 'packages/openapi/src']
    const carriers = new Set<string>()
    for (const root of roots) {
      for (const abs of walk(join(REPO, root))) {
        if (!abs.endsWith('.ts') && !abs.endsWith('.vue') && !abs.endsWith('.yml')) continue
        if (abs.includes('__tests__') || abs.includes('/tests/') || abs.endsWith('.spec.ts') || abs.endsWith('.test.ts')) continue
        // openapi dist/dist-sdk are GENERATED artifacts (§0.4 "Declared scope") — regenerated by CI
        // (G-14b), deliberately outside this hand-copy census.
        if (abs.includes(`${join(REPO, 'packages/openapi')}/dist`)) continue
        const src = readFileSync(abs, 'utf8')
        if (shapePatterns.some((re) => re.test(src))) carriers.add(abs.slice(REPO.length + 1))
      }
    }
    // C-9 lives in ApprovalProductService.ts but is asserted by its own describe block above (its
    // message is derived, not a literal list), so it is not one of the SITES member-list entries —
    // named here explicitly rather than left implicit.
    const expectedFiles = [...new Set([...SITES.map((s) => s.file), 'packages/core-backend/src/services/ApprovalProductService.ts'])].sort()
    expect([...carriers].sort()).toEqual(expectedFiles)
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
      if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-sdk') continue
      yield* walk(abs)
    } else {
      yield abs
    }
  }
}
