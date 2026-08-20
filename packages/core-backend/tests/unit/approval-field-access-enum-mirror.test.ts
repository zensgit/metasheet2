import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

/**
 * Lock-7 G-14 (widened by Lock-7B OD-L7B-10, docs/development/approval-lock7b-required-at-node-
 * 20260820.md §0.4/§3) — the hand-mirrored sites of the `NodeFieldAccess` access enum are asserted
 * equal by EXACT SET (the `SITES` loop below), and — as of MECHANISM FIX v2, further down this
 * docstring — the census ALSO scans the trees it walks for any literal co-occurrence of the same
 * four words it does not already know about, so a NEW copy landing in an already-scanned file is
 * caught rather than passing unnoticed, subject to v2's own honestly-stated residual (three concrete
 * gaps, named just above `PARTIAL_CARRIER_ALLOWLIST` below — this is deliberately NOT phrased as an
 * unqualified "any incomplete copy anywhere fails the census" guarantee). These are hand copies —
 * the compiler catches none of the drift for most of them; `NODE_FIELD_ACCESS_RANK` (C-3, backend)
 * and `FIELD_ACCESS_LABELS` (`ApprovalGraphNodeConfigEditor.vue`, added by v2) are the two
 * EXCEPTIONS — both are `Record<NodeFieldAccess, …>`, so TypeScript itself fails the build on a
 * missing key.
 *
 * COUNT HISTORY (a swept finding, never a remembered figure — G-14): Lock-7 R-1 found FIVE
 * (`editable`/`readonly`/`hidden`, three members). An independent review of the Lock-7B draft (P2-1)
 * found a NINTH site (C-9, the publish-rejection message) the first sweep missed; §0.4 re-swept at
 * `a0edbe39a4` and settled on NINE at that point in time, four of which (C-3/C-4/C-8/C-9) were new
 * to this file. C-4 (`resolveFieldAccessAtNodes`'s inline filter) is DELIBERATELY not a member-list
 * site any more — Lock-7B OD-L7B-10 replaced its literal chain with a mechanical
 * `NODE_FIELD_ACCESS_VALUES.has(...)` call, so it is asserted by SHAPE (mechanical-call present,
 * literal-chain absent) in its own `describe` block below, not by the member-equality loop the
 * others share. The count is NOT re-pinned to a new fixed number here: MECHANISM FIX v2 both removed
 * a hand-written site (`ApprovalGraphNodeConfigEditor.vue`'s field-access `<el-option>`s, converted
 * to import the canonical array) and added two (that same file's new `FIELD_ACCESS_LABELS` map, and
 * a new FE `NODE_FIELD_ACCESS_VALUES` export) — the current, authoritative count is whatever the
 * `SITES` loop plus the carrier-file census below actually find, not a number transcribed into prose
 * that can silently go stale the next time a site is added, removed, or converted.
 *
 * MECHANISM FIX v1 (2026-08-20, P2-1, SUPERSEDED by v2 below): an independent gate proved the
 * file-carrier scan below was outcome-shaped, not mechanism-shaped — all six `shapePatterns` matched
 * only ALREADY-COMPLETE four-member forms, so a hand copy carrying the STALE THREE-member list
 * (missing `required`) was not recognised as a carrier at all and the census passed green with the
 * drift live in the tree. v1's fix made the scan member-count-agnostic WITHIN six named carrier
 * shapes (union / Set / guard / rank table / wire enum / derived message).
 *
 * MECHANISM FIX v2 (2026-08-20, R1 requalification): a second independent gate (finding R1) planted
 * EIGHT MORE realistic stale-copy shapes the same four words can appear in — none of them matched any
 * of v1's six named families, including the shipped Lock-7 syntax of C-4 itself (`candidate !==
 * 'editable' && …`) and the shape `ApprovalGraphNodeConfigEditor.vue`'s live authoring surface
 * actually used (`.vue` `<el-option value="...">`). Six named shapes becoming eleven evasions is the
 * non-converging trap-enumeration failure mode — a seventh and eighth family would only find a ninth
 * evasion. v2 (implemented below, replacing the shape-family scan entirely) drops shape recognition
 * and detects a carrier by LITERAL CO-OCCURRENCE instead: two or more of the four ratified words
 * spelled out as literals (quoted, bare object/YAML key, or bare list/flow item — never as English
 * prose) within a 150-byte proximity window, regardless of what connects them. See the full mechanism
 * docstring immediately above `PARTIAL_CARRIER_ALLOWLIST` below for the window derivation, the
 * preprocessing that excludes comment prose, and the honestly-scoped residual (this is NOT an
 * unconditional "any incomplete copy anywhere fails the census" guarantee — three concrete gaps are
 * named there). `ApprovalGraphNodeConfigEditor.vue`'s field-access option list — R1's live example —
 * was also CONVERTED to import the canonical `NODE_FIELD_ACCESS_VALUES` array instead of hand-writing
 * the four literals, removing that carrier rather than merely allowlisting it.
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

  // --- MECHANISM v2 (2026-08-20, R1 requalification fix): shape-agnostic LITERAL CO-OCCURRENCE ---
  //
  // The v1 scan (P2-1, see the top-of-file docstring) still recognised "carrier syntax" — six named
  // regex families (type union, Set/array, guard disjunction, rank table, wire enum, derived
  // message). An independent requalification (finding R1) planted eight MORE realistic stale-copy
  // shapes the same four member words can appear in — double-quoted unions, a `!==`/`&&` guard chain
  // (the SHIPPED Lock-7 syntax of C-4 itself, before OD-L7B-10 replaced it), a `switch`/`case`
  // ladder, an unnamed `Record<string, number>` rank map, an array with comment-interleaved members,
  // `const` indirection before the list, block-style YAML, and `.vue` template attribute values (the
  // shape `ApprovalGraphNodeConfigEditor.vue`'s live four-member field-access `<el-option>` list
  // actually used) — and every one of them evaded, because none of those eight are among the six
  // named families. Six families becoming eleven evasions is the non-converging trap-enumeration
  // failure mode; a seventh and eighth named family would only find a ninth evasion.
  //
  // This scan drops shape recognition entirely. It does not ask "is this a union / a Set / a
  // switch". It asks only: do two or more of the four ratified words appear as LITERALS — not as
  // English prose — close together in this file? A "literal" is one of three low-level,
  // shape-independent forms, chosen to cover every carrier syntax actually observed (C-1..C-9, the
  // eleven R1 shapes, and the three NEW shapes exercised in this fix's own probe run — see the PR
  // body):
  //   (1) a single- OR double-quoted string literal ('editable' / "editable") — covers TS unions,
  //       Set/array literals, `===`/`!==` guard chains (any connector), `switch case` labels, and
  //       Vue/HTML attribute values (`value="editable"`);
  //   (2) a bare (UNQUOTED) object/mapping key immediately followed by ':' (`editable: 0`) — covers
  //       TS/JS object-literal keys and YAML mapping keys;
  //   (3) a bare token used as a list/array item — immediately preceded by '[', ',', or '{', or
  //       immediately followed by ',', ']', '}', or end-of-line, OR alone on a line right after a
  //       YAML '-' list marker — covers OpenAPI flow-style bare enums (`[editable, readonly, ...]`)
  //       and YAML block-style lists (`- editable`).
  // `const` indirection (`const E = 'editable'`) is not a fourth form: it is already form (1) at the
  // point of declaration, and a human writing that pattern necessarily declares the four consts near
  // each other for the code to stay readable — which is exactly what proximity clustering below
  // catches.
  //
  // Two shape-independent PREPROCESSING steps remove prose that would otherwise create false
  // positives from COMMENTS, not carrier syntax: a quoted match immediately touching a backtick on
  // either side (`` `'required'` ``, this repo's convention for quoting an identifier inside Markdown
  // prose) is discarded, and `.vue` files have `<!-- … -->` blocks blanked out (length-preserving, so
  // byte offsets elsewhere are unaffected) before scanning. `//`/`/* */` comment text is NOT
  // stripped — a comment that happens to spell out a COMPLETE four-member copy verbatim (one exists
  // in `templateAuthoring.ts`, documenting the exact wire shape) is harmless noise, not a false
  // negative, so stripping it would only add risk (a naive `//` stripper can misparse a string
  // literal that itself contains `//`, e.g. a URL) for no correctness gain.
  //
  // PROXIMITY WINDOW = 150 bytes, chosen from the real carriers, not the evasions: every one of C-1,
  // C-2, C-3, C-5, C-6, C-7, C-8 and the two new FE sites this fix adds (`NODE_FIELD_ACCESS_VALUES`
  // in `apps/web/src/types/approval.ts` and `FIELD_ACCESS_LABELS` in
  // `ApprovalGraphNodeConfigEditor.vue` — see below) place all four words within 10-90 bytes of each
  // other, on one line or a few short lines. 150 gives roughly 2x headroom for a reasonable
  // multi-line reformat (one member per line, each with a short trailing comment) without being so
  // wide that it starts merging genuinely UNRELATED statements — at 400 bytes, two more spurious
  // clusters appear (an error-message string's "Field is hidden: …" colon-prose, and an unrelated
  // `required`-parameter-name coincidence 64KB away in a file that also holds a real carrier) that
  // 150 already excludes. Occurrences chain: two literals adjacent within 150 bytes join one
  // cluster, and a cluster transitively spans further when each step is within budget.
  //
  // WHY 150 AND NOT WIDER, stated as a direction argument, not just a headroom number: getting the
  // window too SMALL fails CLOSED for a real four-member copy — it splits into two clusters, each
  // incomplete, and an incomplete cluster with no matching allowlist entry REDS loudly, by name. A
  // real copy can therefore only go SILENT if the window is too small AND a coincidentally-matching
  // allowlist entry happens to excuse the resulting fragment — a narrow, structurally unlikely
  // failure this file's own `matchingAllowlistEntries` exactly-one-match check narrows further (see
  // residual (d) below). Getting the window too WIDE fails OPEN in the more dangerous direction: it
  // merges unrelated code into false "candidate carriers", which does not hide a real drift but does
  // grow the allowlist with looser, more collision-prone anchors (residual (d)) — the opposite of
  // safe. 150 is therefore chosen from below (the tightest window that still unions every real
  // carrier into one complete cluster) rather than from above (an arbitrarily generous margin), and
  // residual (b)'s window-evasion gap is exactly the mirror of this: a copy whose members are spread
  // WIDER than a human would ever reasonably format them.
  //
  // Clustering with 2+ distinct words finds FOURTEEN files with at least one candidate cluster in
  // the scanned trees at this window — only SEVEN of which are complete four-member NodeFieldAccess
  // copies (the census's actual site list). Every other cluster is a real but UNRELATED or
  // DELIBERATELY-PARTIAL collision — most are the multitable `MetaFieldPermission {visible,
  // readOnly}` / after-sales `TicketFieldPolicy` / plugin `RoleFieldPolicy` systems this repo's own
  // prior audits already named as distinct from `NodeFieldAccess`, plus one JSON-Schema `required:`
  // keyword collision in `base.yml`, plus the linear editor's BY-DESIGN three-option list (Lock-7B
  // G-15 / OD-L7B-7: `required` is inapplicable to non-handler nodes). Each gets its own explicit,
  // symbol-anchored `PARTIAL_CARRIER_ALLOWLIST` entry below, PER OCCURRENCE — never a blanket
  // file-level exemption (an unrelated stale copy landing later in the SAME file, near a DIFFERENT
  // symbol, still reds).
  //
  // CONVERSION, not just detection: `ApprovalGraphNodeConfigEditor.vue`'s field-access `<el-option>`
  // list — R1 finding B8's live, previously-invisible carrier — no longer hand-writes the four
  // literals at all. It now imports `NODE_FIELD_ACCESS_VALUES` (a new FE-side export mirroring
  // backend `NODE_FIELD_ACCESS_VALUES`) and renders a `v-for` over it, filtered to exclude
  // `required` on non-handler nodes exactly as the retired `v-if` did. That REMOVES a carrier —
  // strictly better than allowlisting it — rather than merely excusing it; it is now one of the
  // COMPLETE sites this census tracks, via a compiler-guarded `Record<NodeFieldAccess, string>`
  // label map (`FIELD_ACCESS_LABELS`) that plays the same exhaustiveness role C-3's rank table plays
  // on the backend.
  //
  // RESIDUAL (stated precisely, not swept under this mechanism's greater reach than v1's): this scan
  // is NOT an unconditional guarantee that "any file anywhere carrying an incomplete copy fails the
  // census". Three concrete gaps remain, all inherent to literal-text scanning rather than to shape
  // enumeration, so no amount of ADDING shape families would close them either:
  //   (a) SCOPE — only `packages/core-backend/src`, `apps/web/src`, `packages/openapi/src` are
  //       walked (via the same `readdirSync`-based `walk()` as before, so a NEW file in an
  //       already-scanned tree is picked up automatically; a copy in a tree not walked at all, or in
  //       a `.test.ts`/`.spec.ts`/`__tests__` file, or under `openapi/dist*`, is out of scope by the
  //       same design the v1 scan already had);
  //   (b) WINDOW EVASION — a copy whose four members are deliberately spread further apart than 150
  //       bytes (e.g. four separate top-level consts, each used independently, never co-located)
  //       does not cluster and is invisible; widening the window trades this off against merging
  //       unrelated code (see above) rather than closing it;
  //   (c) NON-LITERAL ENCODING — a copy that never spells the four words as text at all (a purely
  //       numeric rank table with no member names, a differently-named alias scheme, or values built
  //       by string concatenation/interpolation instead of a literal) carries no literal for this
  //       scan to find; TypeScript's own `Record<NodeFieldAccess, …>` exhaustiveness check is the
  //       backstop for exactly this case on the two compiler-guarded sites (C-3, and now
  //       `FIELD_ACCESS_LABELS`);
  //   (d) ALLOWLIST-WINDOW COLLISION — an entry excuses a cluster by (file, exact member SET,
  //       nearSymbol-within-window), not by a cryptographically unique identity. Two REAL collisions
  //       surfaced while tuning this exact allowlist below (`resolveFieldPerm`'s window reaching a
  //       neighbouring CALL site; `role.editability`'s bare form recurring inside
  //       `normalizeRuntimeAdminRolePolicy`'s own body) and are now guarded by `matchingAllowlistEntries`
  //       requiring EXACTLY ONE match rather than the first — which turns a FUTURE such collision
  //       between two EXISTING entries into a direct, named red instead of a silently-stolen credit.
  //       What that guard does NOT catch: a genuinely NEW, unrelated stale copy landing entirely
  //       within an EXISTING entry's (file, window) with the SAME member subset — it would match that
  //       one entry alone and be silently (and wrongly) excused. This is the same shape as the prior
  //       requalification's R5 nit, narrowed but not eliminated by per-occurrence anchoring.
  // These are the honest scope of "shape-agnostic": agnostic to CONNECTOR syntax (the failure class
  // R1 found), not agnostic to file scope, spatial layout, literal-vs-symbolic encoding, or allowlist
  // anchor collisions.

  interface CarrierCluster {
    file: string
    start: number
    end: number
    members: string[] // distinct, sorted
    snippet: string
  }

  const PROXIMITY_WINDOW = 150
  const WORD_ALT = MEMBERS.join('|') // 'editable|hidden|readonly|required'

  const QUOTED_LITERAL_RE = new RegExp(`(['"])(${WORD_ALT})\\1`, 'g')
  const BARE_WORD_RE = new RegExp(`\\b(${WORD_ALT})\\b`, 'g')

  interface RawOccurrence {
    index: number
    end: number
    word: string
  }

  function rawLiteralOccurrences(src: string): RawOccurrence[] {
    const occ: RawOccurrence[] = []
    const quotedSpans: Array<[number, number]> = []
    QUOTED_LITERAL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = QUOTED_LITERAL_RE.exec(src))) {
      const start = m.index
      const end = start + m[0].length
      // A quote immediately touching a backtick on either side is Markdown code-span prose (this
      // repo's convention: `` `'required'` `` inside a doc comment), not a code literal.
      if (src[start - 1] === '`' || src[end] === '`') continue
      occ.push({ index: start, end, word: m[2]! })
      quotedSpans.push([start, end])
    }
    BARE_WORD_RE.lastIndex = 0
    while ((m = BARE_WORD_RE.exec(src))) {
      const start = m.index
      const end = start + m[0].length
      if (quotedSpans.some(([s, e]) => start >= s && end <= e)) continue // already counted as quoted
      let b = start - 1
      while (b >= 0 && (src[b] === ' ' || src[b] === '\t')) b--
      let a = end
      while (a < src.length && (src[a] === ' ' || src[a] === '\t')) a++
      const before = b >= 0 ? src[b] : ''
      const after = a < src.length ? src[a] : ''
      const lineStart = src.lastIndexOf('\n', start - 1) + 1
      const isYamlListItem = /^[ \t]*-[ \t]*$/.test(src.slice(lineStart, start))
      const delimBefore = isYamlListItem || before === '[' || before === ',' || before === '{'
      const delimAfter = after === ':' || after === ',' || after === ']' || after === '}' || after === '' || src[a] === '\n'
      if (delimBefore || delimAfter) occ.push({ index: start, end, word: m[1]! })
    }
    occ.sort((x, y) => x.index - y.index)
    return occ
  }

  function clusterOccurrences(file: string, src: string): CarrierCluster[] {
    const occ = rawLiteralOccurrences(src)
    const clusters: CarrierCluster[] = []
    let cur: CarrierCluster | null = null
    for (const o of occ) {
      if (cur && o.index - cur.end <= PROXIMITY_WINDOW) {
        cur.end = Math.max(cur.end, o.end)
        if (!cur.members.includes(o.word)) cur.members.push(o.word)
      } else {
        cur = { file, start: o.index, end: o.end, members: [o.word], snippet: '' }
        clusters.push(cur)
      }
    }
    for (const c of clusters) {
      c.members.sort()
      c.snippet = src.slice(c.start, c.end).replace(/\s+/g, ' ').slice(0, 90)
    }
    return clusters.filter((c) => c.members.length >= 2)
  }

  // Explicit, honest exemptions for candidate clusters that are real but NOT a NodeFieldAccess copy
  // (a genuinely unrelated field-policy system sharing 2-3 of the four words) or a deliberate
  // partial derivation. `nearSymbol` must appear within `symbolWindow` bytes of the cluster, so an
  // entry cannot excuse an UNRELATED occurrence that lands later in the SAME file with the SAME
  // member set near a DIFFERENT symbol.
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
      members: ['editable', 'hidden', 'readonly'],
      nearSymbol: 'RoleFieldPolicy',
      symbolWindow: 200,
      reason:
        "Unrelated plugin RBAC field-policy type: sibling `visibility: 'visible'|'hidden'` and " +
        "`editability: 'editable'|'readonly'` fields on the same interface — no 'required' member.",
    },
    {
      file: 'packages/core-backend/src/services/PluginRbacProvisioningService.ts',
      members: ['editable', 'hidden', 'readonly'],
      nearSymbol: 'normalizeFieldPolicy',
      symbolWindow: 400,
      reason: 'Normalizes the SAME unrelated RoleFieldPolicy (plugin.ts) visibility/editability pair.',
    },
    {
      file: 'apps/web/src/multitable/components/MetaSheetPermissionManager.vue',
      members: ['hidden', 'readonly'],
      nearSymbol: 'setFieldTemplateDraft',
      symbolWindow: 300,
      reason:
        "Multitable MetaFieldPermission {visible, readOnly} template-level state <select> — the " +
        "unrelated system this file's own docstring already distinguishes from NodeFieldAccess.",
    },
    {
      file: 'apps/web/src/multitable/components/MetaSheetPermissionManager.vue',
      members: ['hidden', 'readonly'],
      nearSymbol: 'setFieldPermDraft',
      symbolWindow: 300,
      reason: 'Same MetaFieldPermission system, the per-subject field-level state <select>.',
    },
    {
      file: 'apps/web/src/multitable/components/MetaSheetPermissionManager.vue',
      members: ['hidden', 'readonly'],
      // 'function resolveFieldPerm' (not the bare name) — the bare name also appears as a CALL from
      // the neighbouring `applyFieldPerm`, close enough to `fieldPermFromDraftValue`'s own cluster to
      // wrongly satisfy that entry's window too (verified: it did, until this was tightened).
      nearSymbol: 'function resolveFieldPerm',
      symbolWindow: 350,
      reason: 'Same MetaFieldPermission system: {visible, readOnly} -> draft-state derivation.',
    },
    {
      file: 'apps/web/src/multitable/components/MetaSheetPermissionManager.vue',
      members: ['hidden', 'readonly'],
      nearSymbol: 'fieldPermFromDraftValue',
      symbolWindow: 200,
      reason:
        'Same MetaFieldPermission system: draft-state -> {visible, readOnly} derivation (inverse of ' +
        'resolveFieldPerm).',
    },
    {
      file: 'apps/web/src/multitable/components/MetaSheetPermissionManager.vue',
      members: ['hidden', 'readonly'],
      nearSymbol: 'meta-sheet-perm__badge',
      symbolWindow: 200,
      reason: 'Same MetaFieldPermission system: CSS badge color selectors keyed on the same two states.',
    },
    {
      file: 'apps/web/src/multitable/utils/meta-permission-labels.ts',
      members: ['hidden', 'readonly'],
      nearSymbol: 'fieldStateText',
      symbolWindow: 200,
      reason: 'Same MetaFieldPermission system: state-value -> localized label lookup.',
    },
    {
      file: 'apps/web/src/views/AfterSalesView.vue',
      members: ['editable', 'hidden', 'readonly'],
      // The template-only `:id` string, not the bare `role.editability` binding — the bare form
      // ALSO appears inside `normalizeRuntimeAdminRolePolicy`'s own body (`role.editability ===
      // 'editable'`), close enough to wrongly satisfy that entry's window too (verified: it did,
      // until this was tightened).
      nearSymbol: 'after-sales-runtime-admin-field-policy',
      symbolWindow: 300,
      reason:
        "Unrelated after-sales TicketFieldPolicy runtime-admin <select> pair (visibility/" +
        "editability) — no 'required' member.",
    },
    {
      file: 'apps/web/src/views/AfterSalesView.vue',
      members: ['editable', 'hidden', 'readonly'],
      nearSymbol: 'FieldEditability',
      symbolWindow: 150,
      reason: 'Same TicketFieldPolicy system: the FieldVisibility/FieldEditability type declarations themselves.',
    },
    {
      file: 'apps/web/src/views/AfterSalesView.vue',
      members: ['editable', 'hidden'],
      nearSymbol: 'isRefundAmountEditable',
      symbolWindow: 150,
      reason: 'Same TicketFieldPolicy system: a computed deriving refund-amount editability from visibility/editability.',
    },
    {
      file: 'apps/web/src/views/AfterSalesView.vue',
      members: ['editable', 'hidden', 'readonly'],
      nearSymbol: 'normalizeRuntimeAdminRolePolicy',
      symbolWindow: 300,
      reason: 'Same TicketFieldPolicy system: role-policy normalization function.',
    },
    {
      file: 'apps/web/src/views/AfterSalesView.vue',
      members: ['hidden', 'readonly'],
      nearSymbol: 'syncRuntimeAdminRolePolicy',
      symbolWindow: 200,
      reason: 'Same TicketFieldPolicy system: forces editability to readonly when visibility is hidden.',
    },
    {
      file: 'apps/web/src/views/FormView.vue',
      members: ['hidden', 'required'],
      nearSymbol: 'isFieldVisible',
      symbolWindow: 150,
      reason:
        "Unrelated dynamic CSS-class binding (`{ hidden: !isFieldVisible(field) }`) coinciding with " +
        "the same field's own `required` validation flag — not a NodeFieldAccess copy.",
    },
    {
      file: 'apps/web/src/views/approval/TemplateAuthoringView.vue',
      members: ['editable', 'hidden', 'readonly'],
      nearSymbol: 'approval-step-field-access',
      symbolWindow: 300,
      reason:
        'BY DESIGN, not stale: the LINEAR editor renders exactly these three options (Lock-7 G-13 / ' +
        "Lock-7B G-15, OD-L7B-7) — `required` is unsatisfiable on a non-handler approval step and is " +
        "never offered here.",
    },
    {
      file: 'packages/openapi/src/base.yml',
      members: ['editable', 'required'],
      nearSymbol: 'MultitableFieldCapability',
      symbolWindow: 350,
      reason:
        "Coincidental collision with the unrelated multitable `MultitableFieldCapability` schema's " +
        "own JSON-Schema `required:` keyword (its required-PROPERTIES list) landing near its " +
        "`editable: type: boolean` field flag — not a NodeFieldAccess wire enum.",
    },
  ]
  const allowlistHits = new Set<number>()

  // Returns EVERY entry that matches this cluster, not just the first — an occurrence must match
  // EXACTLY ONE. Returning on first match (the v1/P2-1 shape) let a too-generous `symbolWindow`
  // silently "steal" credit for a DIFFERENT occurrence sharing the same file+members, which shows up
  // only as a confusing "entry X matched nothing" failure on the unrelated exercised-check below —
  // exactly what happened twice while tuning this file's own allowlist (`resolveFieldPerm`'s window
  // reaching a neighbouring call site; `role.editability`'s bare form appearing a second time inside
  // `normalizeRuntimeAdminRolePolicy`'s own body). Requiring exactly one match turns that class of
  // bug into a direct, named failure on the OCCURRENCE itself instead of an indirect one on whichever
  // entry happened to lose the race.
  function matchingAllowlistEntries(cluster: CarrierCluster, src: string): number[] {
    const matches: number[] = []
    for (let i = 0; i < PARTIAL_CARRIER_ALLOWLIST.length; i++) {
      const entry = PARTIAL_CARRIER_ALLOWLIST[i]!
      if (entry.file !== cluster.file) continue
      if (JSON.stringify(entry.members.slice().sort()) !== JSON.stringify(cluster.members)) continue
      const start = Math.max(0, cluster.start - entry.symbolWindow)
      const end = cluster.end + entry.symbolWindow
      if (!src.slice(start, end).includes(entry.nearSymbol)) continue
      matches.push(i)
    }
    return matches
  }

  interface FileClusters {
    file: string
    src: string
    clusters: CarrierCluster[]
  }

  function scanTree(): FileClusters[] {
    const roots = ['packages/core-backend/src', 'apps/web/src', 'packages/openapi/src']
    const out: FileClusters[] = []
    for (const root of roots) {
      for (const abs of walk(join(REPO, root))) {
        if (!abs.endsWith('.ts') && !abs.endsWith('.vue') && !abs.endsWith('.yml')) continue
        if (abs.includes('__tests__') || abs.includes('/tests/') || abs.endsWith('.spec.ts') || abs.endsWith('.test.ts')) continue
        // openapi dist/dist-sdk are GENERATED artifacts (§0.4 "Declared scope") — regenerated by CI
        // (G-14b), deliberately outside this hand-copy census.
        if (abs.includes(`${join(REPO, 'packages/openapi')}/dist`)) continue
        const file = abs.slice(REPO.length + 1)
        let src = readFileSync(abs, 'utf8')
        if (abs.endsWith('.vue')) {
          // Blank Vue/HTML comments (length-preserving, so offsets elsewhere are unaffected) —
          // comment prose is not a code literal (see mechanism docstring above).
          src = src.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '))
        }
        const clusters = clusterOccurrences(file, src)
        if (clusters.length) out.push({ file, src, clusters })
      }
    }
    return out
  }

  // Computed ONCE at collection time (mirrors the `SITES` pattern above), so both the file-list test
  // and the dynamically-generated per-cluster tests below share one tree walk.
  const scanned = scanTree()
  const allClusters = scanned.flatMap((f) => f.clusters)

  it('carrier file census: exactly this set of files carries a 2+-member literal co-occurrence within the proximity window', () => {
    const carrierFiles = new Set(allClusters.map((c) => c.file))
    const expectedFiles = [
      'apps/web/src/approvals/approvalNodeEdit.ts',
      'apps/web/src/approvals/components/ApprovalGraphNodeConfigEditor.vue',
      'apps/web/src/approvals/templateAuthoring.ts',
      'apps/web/src/multitable/components/MetaSheetPermissionManager.vue',
      'apps/web/src/multitable/utils/meta-permission-labels.ts',
      'apps/web/src/types/approval.ts',
      'apps/web/src/views/AfterSalesView.vue',
      'apps/web/src/views/FormView.vue',
      'apps/web/src/views/approval/TemplateAuthoringView.vue',
      'packages/core-backend/src/services/PluginRbacProvisioningService.ts',
      'packages/core-backend/src/services/approval-form-redaction.ts',
      'packages/core-backend/src/types/approval-product.ts',
      'packages/core-backend/src/types/plugin.ts',
      'packages/openapi/src/base.yml',
    ].sort()
    expect([...carrierFiles].sort()).toEqual(expectedFiles)
    // Floor, so a regression that narrows the literal/delimiter patterns back down to "match
    // nothing" cannot pass by shrinking BOTH sides to empty at once (an empty scan is not evidence of
    // absence — feedback_empty_read_is_not_absence): every expected file must have contributed at
    // least one cluster, and the total cluster count must be at least the number of expected files.
    expect(allClusters.length).toBeGreaterThanOrEqual(expectedFiles.length)
    for (const file of expectedFiles) {
      expect(allClusters.some((c) => c.file === file), `${file} contributed zero clusters`).toBe(true)
    }
  })

  for (const f of scanned) {
    for (const c of f.clusters) {
      // Captured at COLLECTION time, before the test body runs — this is where the real teeth live.
      // Dropping (or never having carried) a member from a real hand copy shrinks `c.members` below
      // four distinct words HERE, which routes this exact source location into a differently-named,
      // one-fewer-member test that must then clear the allowlist check below (and normally can't,
      // since no allowlist entry has four members and none is scoped to a real NodeFieldAccess site)
      // — a stale hand copy is recognised BY its incomplete member set, instead of being invisible to
      // the scan that found it. `isComplete` itself is not asserted directly below (it would be
      // vacuously true by construction: `c.members` is already a deduped subset of `MEMBERS`, so
      // `c.members.length === 4` already IS `c.members equals MEMBERS`) — the assertion that carries
      // weight is the allowlist check, which the `isComplete` branch is exempt from.
      const isComplete = c.members.length === MEMBERS.length
      it(`${c.file} @${c.start}-${c.end} :: {${c.members.join(', ')}} (\`${c.snippet}\`)`, () => {
        const matches = isComplete ? [] : matchingAllowlistEntries(c, f.src)
        if (!isComplete && matches.length === 1) allowlistHits.add(matches[0]!)
        expect(
          isComplete || matches.length === 1,
          isComplete
            ? ''
            : `${c.file}@${c.start} carries ONLY {${c.members.join(', ')}} of the four ratified ` +
                `members and matched ${matches.length} PARTIAL_CARRIER_ALLOWLIST entries (expected ` +
                `exactly 1${matches.length ? ': ' + matches.map((i) => PARTIAL_CARRIER_ALLOWLIST[i]!.nearSymbol).join(', ') : ''}) — ` +
                (matches.length === 0
                  ? 'either complete this copy to {editable, hidden, readonly, required} or add a ' +
                    'new, symbol-anchored allowlist entry justifying the partial match'
                  : 'tighten nearSymbol/symbolWindow on the colliding entries so exactly one matches'),
        ).toBe(true)
      })
    }
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
