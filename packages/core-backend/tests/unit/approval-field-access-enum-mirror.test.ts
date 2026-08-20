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
 *
 * MECHANISM FIX (2026-08-20, P2-1): an independent gate proved the file-carrier scan below was
 * outcome-shaped, not mechanism-shaped — all six `shapePatterns` matched only ALREADY-COMPLETE
 * four-member forms, so a hand copy carrying the STALE THREE-member list (missing `required`,
 * precisely the drift class this census exists to prevent) was not recognised as a carrier at all and
 * the census passed green (14/14) with the drift live in the tree; a positive control carrying a
 * complete four-member copy correctly red. The scan is now member-count-agnostic: it recognises a
 * carrier by the SHAPE it carries (a union / Set / guard / wire-enum built from two or more of the
 * four access-tier words), regardless of how many of the four are present, and then asserts EVERY
 * recognised occurrence is complete as its own named test — so an incomplete copy REDS BY NAME instead
 * of vanishing. Two real two-member matches in the scanned trees are NOT `NodeFieldAccess` copies at
 * all (`RoleFieldPolicy.editability` in `types/plugin.ts`, `FieldEditability` in `AfterSalesView.vue`
 * — unrelated field-policy types that happen to share two of the four words) and one is a real,
 * deliberate PARTIAL derivation (`NODE_FIELD_ACCESS_WRITABLE_VALUES`, Lock-7B §2.2, `editable ∪
 * required` only); per the gate's instruction none are silently threshold-excluded — each is an
 * explicit, symbol-anchored `PARTIAL_CARRIER_ALLOWLIST` entry near the bottom of this file, and a test
 * asserts every entry is actually exercised so a dead exemption reds instead of rotting.
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

  // --- P2-1 fix: shape-based, member-count-agnostic carrier census (see the top-of-file docstring) ---

  interface ShapeMatch {
    snippet: string
    members: string[]
    index: number
  }
  interface ShapeFamily {
    label: string
    checkComplete: boolean
    find: (src: string) => ShapeMatch[]
  }

  const WORD_ALT = MEMBERS.join('|') // 'editable|hidden|readonly|required'

  function wordsIn(text: string, wordRe: RegExp): string[] {
    const found = new Set<string>()
    for (const m of text.matchAll(wordRe)) {
      const w = m[1]!
      if ((MEMBERS as string[]).includes(w)) found.add(w)
    }
    return [...found].sort()
  }

  function matchesOf(src: string, re: RegExp, wordRe: RegExp): ShapeMatch[] {
    return [...src.matchAll(re)].map((m) => ({ snippet: m[0], members: wordsIn(m[0], wordRe), index: m.index ?? -1 }))
  }

  // Each family matches a run of TWO OR MORE access-tier words joined by the connector real code uses
  // for that shape, regardless of how many of the four are present — completeness is asserted
  // separately below, per occurrence, which is the mechanism the outcome-shaped predecessor lacked.
  const SHAPE_FAMILIES: ShapeFamily[] = [
    {
      label: 'type union',
      checkComplete: true,
      find: (src) => matchesOf(src, new RegExp(`'(?:${WORD_ALT})'(?:\\s*\\|\\s*'(?:${WORD_ALT})')+`, 'g'), /'([a-z]+)'/g),
    },
    {
      label: 'member array (Set/literal)',
      checkComplete: true,
      find: (src) =>
        matchesOf(src, new RegExp(`\\[\\s*'(?:${WORD_ALT})'(?:\\s*,\\s*'(?:${WORD_ALT})')+\\s*\\]`, 'g'), /'([a-z]+)'/g),
    },
    {
      label: 'guard disjunction',
      checkComplete: true,
      find: (src) =>
        matchesOf(
          src,
          new RegExp(`[\\w.]+\\s*===\\s*'(?:${WORD_ALT})'(?:\\s*\\|\\|\\s*[\\w.]+\\s*===\\s*'(?:${WORD_ALT})')+`, 'g'),
          /'([a-z]+)'/g,
        ),
    },
    {
      // Still name-anchored (compiler-guarded exhaustiveness already forces all four keys), unlike the
      // other families — kept member-agnostic in form for uniformity, but it can never actually be
      // incomplete without failing `tsc` first.
      label: 'rank table (C-3, compiler-guarded)',
      checkComplete: true,
      find: (src) => {
        const m = src.match(/NODE_FIELD_ACCESS_RANK\s*:\s*Record<NodeFieldAccess,\s*number>\s*=\s*\{([^}]*)\}/)
        return m ? [{ snippet: m[0], members: wordsIn(m[1]!, /(\w+)\s*:\s*\d+/g), index: m.index ?? -1 }] : []
      },
    },
    {
      label: 'OpenAPI wire enum (C-8)',
      checkComplete: true,
      find: (src) =>
        matchesOf(
          src,
          new RegExp(`enum:\\s*\\[\\s*(?:${WORD_ALT})(?:\\s*,\\s*(?:${WORD_ALT}))+\\s*\\]`, 'g'),
          new RegExp(`(${WORD_ALT})`, 'g'),
        ),
    },
    {
      // C-9's message is DERIVED (`[...NODE_FIELD_ACCESS_VALUES]`) and never carries a literal member
      // list — that absence IS its correctness (OD-L7B-10) — so it contributes to carrier-FILE
      // detection but is excluded from the per-occurrence completeness check, not from detection.
      label: 'derived publish message (C-9, carries no member list by design)',
      checkComplete: false,
      find: (src) => {
        const m = src.match(/NODE_FIELD_ACCESS_VALUES_MESSAGE\s*=\s*\(\(\)\s*=>/)
        return m ? [{ snippet: m[0], members: [], index: m.index ?? -1 }] : []
      },
    },
  ]

  // Explicit, honest exemptions (G-14 / P2-1 — "if a file legitimately carries a subset, it needs an
  // explicit commented exemption entry, not silent invisibility"). `nearSymbol` must appear within
  // `symbolWindow` bytes of the match, so an entry cannot excuse an UNRELATED occurrence that happens
  // to land in the same file with the same member set but away from the symbol it is pinned to.
  const PARTIAL_CARRIER_ALLOWLIST: Array<{
    file: string
    members: string[]
    nearSymbol: string
    symbolWindow: number
    reason: string
  }> = [
    {
      file: 'packages/core-backend/src/types/approval-product.ts',
      members: ['editable', 'required'],
      nearSymbol: 'NODE_FIELD_ACCESS_WRITABLE_VALUES',
      symbolWindow: 200,
      reason:
        'Lock-7B §2.2 DERIVED writable subset (editable ∪ required only, by design) — not a hand ' +
        'mirror of the full enum; this file is already a complete carrier via C-1/C-2 above.',
    },
    {
      file: 'packages/core-backend/src/types/plugin.ts',
      members: ['editable', 'readonly'],
      nearSymbol: 'RoleFieldPolicy',
      symbolWindow: 200,
      reason:
        "Unrelated plugin RBAC field-policy editability — no 'hidden'/'required' member; visibility " +
        "('hidden'/'visible') is a separate field on the same interface.",
    },
    {
      file: 'apps/web/src/views/AfterSalesView.vue',
      members: ['editable', 'readonly'],
      nearSymbol: 'FieldEditability',
      symbolWindow: 200,
      reason:
        "Unrelated after-sales ticket field policy — visibility ('hidden'/'visible') is a separate " +
        'sibling type on the same interface, not part of this union.',
    },
  ]
  const allowlistHits = new Set<number>()

  function exemption(file: string, src: string, match: ShapeMatch): boolean {
    const sortedMembers = [...match.members].sort()
    for (let i = 0; i < PARTIAL_CARRIER_ALLOWLIST.length; i++) {
      const entry = PARTIAL_CARRIER_ALLOWLIST[i]!
      if (entry.file !== file) continue
      if (JSON.stringify([...entry.members].sort()) !== JSON.stringify(sortedMembers)) continue
      const start = Math.max(0, match.index - entry.symbolWindow)
      const end = match.index + match.snippet.length + entry.symbolWindow
      if (!src.slice(start, end).includes(entry.nearSymbol)) continue
      allowlistHits.add(i)
      return true
    }
    return false
  }

  interface Occurrence {
    file: string
    label: string
    snippet: string
    members: string[]
    index: number
    checkComplete: boolean
  }

  function scanTree(): Occurrence[] {
    const roots = ['packages/core-backend/src', 'apps/web/src', 'packages/openapi/src']
    const occurrences: Occurrence[] = []
    for (const root of roots) {
      for (const abs of walk(join(REPO, root))) {
        if (!abs.endsWith('.ts') && !abs.endsWith('.vue') && !abs.endsWith('.yml')) continue
        if (abs.includes('__tests__') || abs.includes('/tests/') || abs.endsWith('.spec.ts') || abs.endsWith('.test.ts')) continue
        // openapi dist/dist-sdk are GENERATED artifacts (§0.4 "Declared scope") — regenerated by CI
        // (G-14b), deliberately outside this hand-copy census.
        if (abs.includes(`${join(REPO, 'packages/openapi')}/dist`)) continue
        const file = abs.slice(REPO.length + 1)
        const src = readFileSync(abs, 'utf8')
        for (const family of SHAPE_FAMILIES) {
          for (const match of family.find(src)) {
            if (exemption(file, src, match)) continue
            occurrences.push({
              file,
              label: family.label,
              snippet: match.snippet,
              members: match.members,
              index: match.index,
              checkComplete: family.checkComplete,
            })
          }
        }
      }
    }
    return occurrences
  }

  // Computed ONCE at collection time (mirrors the `SITES` pattern above), so both the file-list test
  // and the dynamically-generated per-occurrence completeness tests below share one tree walk.
  const occurrences = scanTree()

  it('the NINE sites live in exactly SEVEN files — an unlisted eighth file carrying a copy fails the census', () => {
    // Carrier detection is SHAPE-based and member-count-agnostic: a file counts as a carrier the
    // moment it holds ANY recognised union/Set/guard/Record/wire-enum/derived-message shape, complete
    // or not — an incomplete one still adds a NEW carrier file here (this is exactly what the
    // predecessor missed), and is separately asserted incomplete below.
    const carriers = new Set(occurrences.map((o) => o.file))
    const expectedFiles = [...new Set([...SITES.map((s) => s.file), 'packages/core-backend/src/services/ApprovalProductService.ts'])].sort()
    expect([...carriers].sort()).toEqual(expectedFiles)
    // Floor, so a regression that narrows the shape patterns back down to "match nothing" cannot pass
    // by shrinking BOTH `carriers` and `expectedFiles` to empty at once (an empty scan is not evidence
    // of absence — feedback_empty_read_is_not_absence): every expected file must have contributed at
    // least one occurrence, and the total occurrence count must be at least the number of expected
    // files (types/approval-product.ts alone contributes two — C-1 and C-2 — so this is a true floor,
    // not a tautology).
    expect(occurrences.length).toBeGreaterThanOrEqual(expectedFiles.length)
    for (const file of expectedFiles) {
      expect(occurrences.some((o) => o.file === file), `${file} contributed zero occurrences`).toBe(true)
    }
  })

  for (const occ of occurrences.filter((o) => o.checkComplete)) {
    it(`${occ.file} :: ${occ.label} @${occ.index} carries EXACTLY the four ratified members (\`${occ.snippet.slice(0, 70).replace(/\s+/g, ' ')}\`)`, () => {
      // This is the test that did not exist before the fix: dropping (or never having carried) a
      // member from THIS occurrence reds this distinct, dynamically-named test, naming both the file
      // and the byte offset — a stale hand copy is recognised BY its incomplete member set now,
      // instead of being invisible to the scan that found it.
      expect([...occ.members].sort(), `${occ.file}@${occ.index} (${occ.label})`).toEqual(MEMBERS)
    })
  }

  it('every PARTIAL_CARRIER_ALLOWLIST entry is exercised — a dead exemption reds instead of rotting silently', () => {
    for (let i = 0; i < PARTIAL_CARRIER_ALLOWLIST.length; i++) {
      const entry = PARTIAL_CARRIER_ALLOWLIST[i]!
      expect(allowlistHits.has(i), `allowlist entry for ${entry.file} (${entry.nearSymbol}) matched nothing this run`).toBe(true)
    }
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
