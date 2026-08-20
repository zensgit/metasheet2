import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

/**
 * Lock-7 G-14 (widened by Lock-7B OD-L7B-10, docs/development/approval-lock7b-required-at-node-
 * 20260820.md §0.4/§3) — the hand-mirrored sites of the `NodeFieldAccess` access enum are asserted
 * equal by EXACT SET (the `SITES` loop below), and — as of MECHANISM FIX v2/v3/v4, further down this
 * docstring — the census ALSO scans the trees it walks for any literal co-occurrence of the same
 * four words it does not already know about (v2/v3), AND pins the exact COUNT of complete copies
 * per already-tracked file (v4), so a NEW copy landing in an already-scanned file — incomplete or a
 * brand-new complete duplicate alike — is caught rather than passing unnoticed, subject to the
 * mechanism's own honestly-stated residual
 * (several concrete gaps, labelled (a)–(h) — see the letters just above `PARTIAL_CARRIER_ALLOWLIST`
 * below; deliberately NOT phrased as an unqualified "any incomplete copy anywhere fails the census"
 * guarantee, and the letter RANGE rather than a transcribed count is what a future edit must keep in
 * sync — see the note at the top of that list). These are hand copies —
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
 * prose) within a 150-byte proximity window, regardless of what connects them. `ApprovalGraphNodeConfigEditor.vue`'s
 * field-access option list — R1's live example — was also CONVERTED to import the canonical
 * `NODE_FIELD_ACCESS_VALUES` array instead of hand-writing the four literals, removing that carrier
 * rather than merely allowlisting it.
 *
 * MECHANISM FIX v3 (2026-08-20, third-round requalification, finding R7): an UNCONDITIONAL
 * "a cluster may never merge across a declaration boundary" rule was tried FIRST and MEASURED, not
 * assumed, to be the wrong fix — under it, R1's own B6 shape (`const E = 'editable'`; `const R =
 * 'required'`; `const H = 'hidden'`; then `new Set([E, R, H, 'readonly'])`, four separate top-level
 * statements each carrying exactly one tracked word) reduces every occurrence to its own 1-member
 * cluster, drops the whole file below the 2-member floor, and the file stops being detected as a
 * carrier at all — strictly WORSE than v2, and a regression this fix is required not to introduce.
 * v3 (implemented below) instead adds a NARROWER, still-effective gate on top of v2's proximity
 * window: a third independent gate proved the window, taken alone, was a genuine DEFECT — a STALE
 * (incomplete) hand copy landing within 150 bytes of any REAL carrier's declaration was unioned into
 * that carrier's cluster and silently inherited its completeness, with no allowlist involvement at
 * all, in BOTH directions (above or below) and even for a 2-member fragment; five of the report's six
 * silent reproductions plus a self-added below-placement variant all RED under the fix below (one
 * report item, on inspection, turned out to be a DIFFERENT, pre-existing gap — see residual (g) — not
 * an instance of this one). v3 does NOT widen or narrow the 150-byte window; it adds a SECOND,
 * independent gate that proximity clustering must also clear: two occurrences may merge across a
 * declaration/statement boundary only when NEITHER of the two units either side of that boundary is,
 * on its own, already a 2+-member candidate carrier — permissive enough to keep detecting B6 (chaining
 * through single-word units is untouched), strict enough that a stale/foreign TS/JS DECLARATION or
 * YAML MAPPING KEY which already holds 2+ of the four words by itself can never borrow a neighbour's
 * completeness. That guarantee is SCOPED to file types where a boundary is actually derived — it does
 * NOT extend into Vue TEMPLATE markup (no boundary is derived there at all, deliberately, to keep
 * cross-element proximity working for FormView.vue / TemplateAuthoringView.vue's allowlisted pairs —
 * see residual (h)). See the full mechanism docstring immediately above `PARTIAL_CARRIER_ALLOWLIST`
 * below for the boundary derivation and the honestly-scoped residual this leaves (this is NOT an
 * unconditional "any incomplete copy anywhere fails the census" guarantee — several concrete gaps are
 * named there, letters (a)–(h)).
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

  // --- MECHANISM v2/v3 (2026-08-20, R1 then R7 requalification fixes): shape-agnostic LITERAL
  //     CO-OCCURRENCE, now gated by declaration boundaries ---
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
  // WHY 150 AND NOT WIDER — CORRECTED BY MECHANISM FIX v3 (R7). A prior version of this paragraph
  // argued getting the window too WIDE only "merges unrelated code into false candidate carriers …
  // which does not hide a real drift". That claim was FALSE, and a third independent gate (R7)
  // disproved it directly, seven ways: a STALE (incomplete) hand copy landing within the window of
  // ANY real carrier's declaration — above it, below it, even a 2-member fragment — unioned into that
  // carrier's cluster and silently inherited its completeness, with NO allowlist involvement at all.
  // A wide window was exactly the mechanism that hid the drift, the opposite of what the old
  // paragraph claimed. MECHANISM FIX v3 fixes this WITHOUT touching the 150-byte figure below (moving
  // the number was never the defect — the union rule was): clustering now ALSO requires that a merge
  // crossing a declaration/statement boundary (see the boundary description above
  // `PARTIAL_CARRIER_ALLOWLIST`) never touch a unit that is, on its own, already a 2+-member candidate
  // carrier. A real complete carrier is exactly such a unit (all of C-1, C-2, C-3, C-5, C-6, C-7, C-8
  // and the two new FE sites place all four words inside ONE declaration, never split across a
  // boundary) — so an adjacent stale/foreign TS/JS DECLARATION or YAML MAPPING KEY can no longer
  // borrow its completeness, REGARDLESS of window width, WITHIN THOSE FILE TYPES. This does NOT extend
  // into Vue TEMPLATE markup, where no boundary is derived at all (see below and residual (h)) — a
  // stale/foreign carrier written as template attribute values, not a TS/JS declaration, is not
  // covered by this sentence. What the window still governs, honestly, is ONLY how far apart two
  // occurrences may sit WITHIN a chain of units that never independently reach 2 members (a legitimate
  // multi-line reformat, or R1's B6 `const` indirection) — getting it too SMALL still fails CLOSED
  // there (splits into incomplete fragments that RED unless an allowlist entry excuses each); getting
  // it too WIDE still risks merging genuinely unrelated single-word occurrences into a spurious
  // partial cluster (residual (d)) — but, post-v3, WIDE no longer risks silently completing a stale
  // copy, because the boundary gate refuses that specific union unconditionally. Residual (b)'s
  // window-evasion gap is the mirror case this file was always honest about: a copy whose members are
  // spread WIDER than a human would ever reasonably format them.
  //
  // DECLARATION BOUNDARIES (MECHANISM FIX v3 / R7) — how a "unit" is derived and why the merge rule
  // is NOT a blanket "never cross a boundary". Boundaries are found by two CHEAP, file-type-keyed
  // structural markers, never a real parser:
  //   - TS/JS/Vue-script: a line with NO leading whitespace (column 0) starting with `export`
  //     followed by `const`/`let`/`var`/`type`/`interface`/`enum`/`function`/`class`, or one of those
  //     keywords unexported. This is deliberately narrow: it fires on every real carrier's own
  //     top-level declaration line (all nine are `export const`/`export type` at column 0) and on
  //     every R7 stale-copy shape reported (each was itself a top-level `const`/`export const`), but
  //     it does NOT fire inside Vue TEMPLATE markup (`<div>`, `<el-option>`, `<label>`, …), which
  //     starts with `<`, not a keyword — so the proximity-only behaviour the cross-element/cross-tag
  //     partial-carrier allowlist entries below rely on (FormView.vue's `hidden`+`required` pair
  //     spanning a `<div>` and a nested `<label>`; TemplateAuthoringView.vue's linear-editor options)
  //     is completely unaffected by v3. The COST of that choice is real, not merely theoretical, and
  //     is named as residual (h) below rather than left as a side effect of this paragraph: v3's
  //     per-unit gate cannot close R7-style absorption inside template markup, because a single
  //     `<el-option value="…">` tag naturally carries exactly one tracked word and so never reaches
  //     the 2-member threshold the gate keys off, no matter how the unit boundary is drawn there.
  //   - YAML (`.yml`): every mapping-key line (`key:`), at ANY indentation depth, starts a new unit —
  //     cheaper than tracking indentation levels, and sufficient because no real carrier or allowlist
  //     entry in this repo needs two DIFFERENT YAML keys' values merged into one cluster.
  // A cluster may merge two occurrences across a boundary ONLY IF NEITHER of the two units either
  // side of that specific crossing is, on its OWN (counting only that one unit's own occurrences,
  // never the accumulating cluster), already a 2-or-more-member candidate carrier. This is a
  // deliberately weaker rule than "never cross a boundary at all", and the difference matters: an
  // absolute rule was tried first and REJECTED because it silently stopped detecting R1's own B6
  // shape (`const E = 'editable'`; `const R = 'required'`; `const H = 'hidden'`; then
  // `new Set([E, R, H, 'readonly'])`) — four separate top-level statements, each carrying exactly ONE
  // tracked word on its own, so an absolute per-boundary block reduces every occurrence to its own
  // 1-member cluster and the whole file vanishes below the 2-member floor, undoing v2's own fix for
  // that exact shape. Under the per-unit rule, chaining through a run of single-literal units stays
  // exactly as permissive as before v3 (B6 still resolves to one complete 4-member cluster), while a
  // stale/foreign declaration that ALREADY holds 2+ of the four words by itself — every R7 shape — is
  // judged entirely on its own occurrences the instant either side of a crossing reaches that
  // threshold, because a unit reaching it is, definitionally, already a candidate partial or complete
  // carrier in its own right and merging it into a neighbour would either manufacture a false
  // completion (R7) or steal credit from a genuinely separate finding. `spansDeclarationBoundary`
  // (set on each `CarrierCluster`, gating `isComplete` alongside the member-count check below)
  // recomputes this SAME 2+-member-endpoint condition independently from the cluster's final span,
  // rather than being trusted forward from the merge loop, so a bug in the loop's own `blocked` check
  // cannot silently let a boundary-spanning, already-multi-member-endpoint cluster take the complete
  // short-circuit. Residual (f) below names the narrower gap this weaker-than-absolute rule leaves
  // open on its own terms.
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
  // RESIDUAL (stated precisely, not swept under this mechanism's greater reach than v1's, and NOT
  // pinned to a transcribed count that can silently go stale — this file's own COUNT HISTORY
  // discipline at the top applies here too): this scan is NOT an unconditional guarantee that "any
  // file anywhere carrying an incomplete copy fails the census". The gaps below, labelled (a)–(h), are
  // ALL that are currently known; grep this file for the next unused letter before adding one, and
  // update the "labelled (a)–(h)" cross-references at the top of this file (there are two) in the same
  // change. Most are inherent to literal-text scanning rather than to shape enumeration, so no amount
  // of ADDING shape families would close them either — (f), (g) and (h) are the three exceptions, all
  // introduced or newly surfaced by MECHANISM FIX v3 itself and named so, not folded silently into the
  // older letters:
  //   (a) SCOPE — only `packages/core-backend/src`, `apps/web/src`, `packages/openapi/src` are
  //       walked (via the same `readdirSync`-based `walk()` as before, so a NEW file in an
  //       already-scanned tree is picked up automatically; a copy in a tree not walked at all, or in
  //       a `.test.ts`/`.spec.ts`/`__tests__` file, or under a directory literally named `dist` or
  //       `dist-sdk` ANYWHERE (not just under `packages/openapi`), is out of scope by the same design
  //       the v1 scan already had). This also names the EXTENSION allowlist explicitly, which prior
  //       revisions of this residual did not: `scanTree` only reads files ending `.ts`, `.vue`, or
  //       `.yml` — a copy written in `.js`, `.mjs`, `.tsx`, `.json`, or `.yaml` is invisible even
  //       inside an otherwise-scanned root, and this is not hypothetical: `src/server.js` and
  //       `src/db/migrations/_meta/applied.json` both live inside `packages/core-backend/src` today,
  //       a scanned root, and neither is walked;
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
  //   (e) BACKTICK LITERALS — `QUOTED_LITERAL_RE` recognises `'` and `"` as quote characters, never
  //       a backtick, so a genuine backtick STRING-LITERAL TYPE (`` `editable` | `readonly` ``, valid
  //       TypeScript, just an unusual style) is invisible to the quoted form; the bare-word form does
  //       not rescue it either, because a backtick is not one of the bare-delimiter characters (the
  //       delimiter set was deliberately chosen NARROW, from the real carriers' actual punctuation —
  //       see the PROXIMITY WINDOW discussion above — and a backtick-fenced bare word satisfies
  //       neither `delimBefore` nor `delimAfter`). This was found empirically (own-devised probe
  //       shape, not one of R1's eleven) while replaying this fix's own evasion suite — see the PR
  //       body. It is a DIFFERENT gap from (c): the words ARE present as literal text, just fenced by
  //       a quote character this scan does not recognise, so it is not closed by the compiler-guard
  //       backstop that covers (c). Adding backtick to `QUOTED_LITERAL_RE` would close this
  //       particular probe but reopen the ORIGINAL false-positive problem the backtick-adjacency
  //       check exists to prevent (this file's own JSDoc comments quote identifiers with backtick
  //       code-spans throughout) — recognising backtick required a way to tell a markdown code-span
  //       from a real backtick string literal that this text-level scan does not have, so it is left
  //       named here rather than "fixed" by re-widening the pattern and re-introducing prose noise.
  //   (f) SINGLE-LITERAL-UNIT SPLITTING (MECHANISM FIX v3) — the boundary gate above blocks a merge
  //       only when EITHER side of the crossing is, on its own, already a 2+-member unit; chaining
  //       through a run of units that each carry exactly ONE tracked word is deliberately still
  //       permitted (that permissiveness is what keeps R1's B6 const-indirection shape detected — see
  //       the DECLARATION BOUNDARIES discussion above). A drifter who splits a stale copy into THREE
  //       separate single-word declarations (`const A = 'editable'`; `const B = 'readonly'`;
  //       `const C = 'hidden'`), each never independently reaching 2 members, then adds a fourth
  //       single-word declaration holding `'required'` within the window, evades: the running cluster
  //       accumulates all four through crossings where neither immediate endpoint is ever, by itself,
  //       a 2+-member unit, and completes silently (own-devised probe, verified: three single-word
  //       consts + one separate, plainly-unrelated single-word const holding 'required' — 43 passed,
  //       no failure — see the PR body). None of the reported R7 reproductions took this shape (every
  //       one used a single MULTI-member array/object literal for the stale part, the natural
  //       "accidental hand copy" shape) and it requires a drifter to deliberately fragment a value
  //       across as many single-purpose declarations as there are stale members — a materially more
  //       contrived construction than an accidental copy-paste — but it is a real, narrower residual
  //       of the v3 fix and is recorded rather than left implicit;
  //   (g) DUPLICATE COMPLETE CARRIER — CLOSED by MECHANISM FIX v4 (see the `EXPECTED_COMPLETE_
  //       CLUSTER_COUNT` assertion immediately after the carrier-file census test below). Kept as a
  //       retired letter rather than reused or deleted, per this file's own COUNT HISTORY discipline
  //       at the top: a BRAND NEW, already-COMPLETE four-member hand copy added inside a file that is
  //       already in `expectedFiles` used to contribute its own new cluster (visible in the
  //       per-cluster test list) that was complete and therefore asserted nothing — the census had no
  //       notion of "this file should carry exactly N complete carriers". This was NOT an R7
  //       cluster-merge-absorption case (nothing merges; the new copy is complete from the moment it
  //       is written, so there is no incompleteness for a boundary gate to protect) — it was a
  //       structurally different gap that MECHANISM FIX v3's boundary gate did not close and was not
  //       designed to. v4 closes it directly: every file that currently carries N complete clusters is
  //       pinned to exactly N, so a brand-new complete duplicate (N+1) reds immediately instead of
  //       waiting for it to later go stale.
  //   (h) VUE TEMPLATE MARKUP (MECHANISM FIX v3, NARROWED by v4) — `declarationBoundaries`
  //       deliberately derives NO boundaries inside Vue TEMPLATE content (see the DECLARATION
  //       BOUNDARIES discussion above): that permissiveness is what keeps FormView.vue's
  //       `hidden`+`required` pair (a `<div>`'s class binding and a NESTED `<label>`'s, two different
  //       elements) and TemplateAuthoringView.vue's by-design three-option list clustering correctly.
  //       The SAME permissiveness means v3's per-unit gate is INERT inside template markup: every
  //       individual `<el-option value="…">` (or similar) tag naturally carries exactly ONE tracked
  //       word, so no template-markup unit can ever independently reach the 2-member threshold the
  //       gate keys off. The ORIGINAL live reproduction (own-devised probe, not one of the six
  //       reported R7 reproductions) — three `<el-option value="editable|readonly|hidden">` lines plus
  //       an unrelated `<span data-state="required">` within the window, appended to an ALREADY-listed
  //       file (`MetaSheetPermissionManager.vue`, far from its own existing clusters) — chained through
  //       single-member units into its OWN NEW complete four-member cluster, and is now CAUGHT: v4's
  //       per-file complete-count pin does not care WHY a file's complete-cluster count grew, only
  //       THAT it did, so this specific probe now reds `MetaSheetPermissionManager.vue carries 1
  //       complete NodeFieldAccess copies, expected 0` (re-verified against this head). What v4 does
  //       NOT catch, and what remains the true, narrower continuation of (h): an INCOMPLETE stale copy
  //       written in template markup that ABSORBS INTO an ALREADY-COUNTED complete Vue-template
  //       carrier (extending that ONE cluster's byte span rather than contributing an independent NEW
  //       one) — v4 pins a per-file COUNT of complete clusters, not their identity or span, so a
  //       merge that leaves the count unchanged is invisible to it exactly as it is to v3's boundary
  //       gate. This requires a real, hand-written COMPLETE four-member carrier living in Vue template
  //       markup for the stale copy to merge into — none exists in the tree today
  //       (`ApprovalGraphNodeConfigEditor.vue`'s `<el-option>` list, the one that used to, was
  //       converted to import the canonical array in round 2) — so nothing currently evades this
  //       narrower gap either, but a NEW template-markup carrier written in the future, with a stale
  //       copy planted to merge into it rather than beside it, still would. Closing this fully would
  //       need parsing actual tag nesting (treating a parent element's subtree as the unit), a
  //       materially larger change than the cheap regex boundaries used elsewhere in this mechanism,
  //       and was not attempted this round — recorded here rather than left implicit or covered by an
  //       unqualified claim.
  // These are the honest scope of "shape-agnostic": agnostic to CONNECTOR syntax (the failure class
  // R1 found), as of v3, to a stale copy's PROXIMITY to a real TS/JS-declaration or YAML-key carrier,
  // and, as of v4, to a brand-new COMPLETE duplicate of an existing carrier appearing in an
  // already-tracked file — not agnostic to file scope, file extension, spatial layout,
  // literal-vs-symbolic encoding, allowlist anchor collisions, the specific quote/delimiter character
  // set recognised, a copy fragmented across many single-purpose declarations, or proximity to a
  // carrier living inside Vue TEMPLATE markup specifically.

  interface CarrierCluster {
    file: string
    start: number
    end: number
    members: string[] // distinct, sorted
    snippet: string
    spansDeclarationBoundary: boolean // set by clusterOccurrences; see MECHANISM FIX v3 below
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

  // TS/JS top-level (column-0) declaration-start keywords. Deliberately does NOT match Vue TEMPLATE
  // markup (`<div>`, `<label>`, …), which starts with `<`, not a keyword — see the MECHANISM FIX v3
  // docstring above `clusterOccurrences` for why that is required, not an oversight.
  const TS_DECLARATION_BOUNDARY_RE = /^(export\s+)?(const|let|var|type|interface|enum|function|class)\b/gm
  // Every YAML mapping-key line, at ANY indentation depth, starts a new declaration/mapping unit.
  const YAML_KEY_BOUNDARY_RE = /^[ \t]*[A-Za-z_][\w.-]*:/gm

  /**
   * Positions where a NEW declaration/statement-ish unit begins, per MECHANISM FIX v3 below.
   */
  function declarationBoundaries(file: string, src: string): number[] {
    const re = file.endsWith('.yml') || file.endsWith('.yaml') ? YAML_KEY_BOUNDARY_RE : TS_DECLARATION_BOUNDARY_RE
    const boundaries: number[] = []
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) boundaries.push(m.index)
    return boundaries
  }

  // Which unit (0-indexed segment between consecutive boundaries) `pos` falls in — the count of
  // boundary starts at-or-before `pos`.
  function unitIndexOf(boundaries: number[], pos: number): number {
    let lo = 0
    let hi = boundaries.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (boundaries[mid]! <= pos) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  function clusterOccurrences(file: string, src: string): CarrierCluster[] {
    const occ = rawLiteralOccurrences(src)
    const boundaries = declarationBoundaries(file, src)
    const withUnit = occ.map((o) => ({ ...o, unit: unitIndexOf(boundaries, o.index) }))

    // Distinct tracked words each unit carries ON ITS OWN, ignoring every other unit — computed
    // once, from the SAME occurrence list clustering will walk. A unit that independently reaches 2
    // is already a candidate partial/complete carrier in its own right (a hand-written array/object/
    // union literal listing two or more of the four words together); one that never exceeds 1 is a
    // single-literal alias (`const E = 'editable'`, a `case 'editable':` label, one YAML `- editable`
    // list item, …) that carries no drift signal by itself — see MECHANISM FIX v3 below for why the
    // clustering rule keys off THIS distinction rather than blocking every boundary crossing.
    const unitMemberCounts = new Map<number, Set<string>>()
    for (const o of withUnit) {
      let set = unitMemberCounts.get(o.unit)
      if (!set) unitMemberCounts.set(o.unit, (set = new Set()))
      set.add(o.word)
    }
    const isMultiMemberUnit = (unit: number) => (unitMemberCounts.get(unit)?.size ?? 0) >= 2

    const clusters: CarrierCluster[] = []
    let cur: (CarrierCluster & { lastUnit: number }) | null = null
    for (const o of withUnit) {
      const crossesBoundary = cur !== null && o.unit !== cur.lastUnit
      // A boundary crossing is refused only when at least one of the two units either side of it is
      // ALREADY, on its own, a 2+-member candidate carrier — chaining through a run of harmless
      // single-literal units (B6's `const E =`/`const R =`/`const H =` indirection, a `switch`
      // ladder's `case` labels, a YAML block list's `- editable` items) stays exactly as permissive
      // as before MECHANISM FIX v3. What changes is a stale/foreign multi-member declaration (R7):
      // the instant either endpoint of a crossing is itself a 2+-member unit, the crossing is
      // refused, so that unit is judged ENTIRELY on its own occurrences, never merged with a
      // neighbour's.
      const blocked = crossesBoundary && (isMultiMemberUnit(cur!.lastUnit) || isMultiMemberUnit(o.unit))
      if (cur && o.index - cur.end <= PROXIMITY_WINDOW && !blocked) {
        cur.end = Math.max(cur.end, o.end)
        cur.lastUnit = o.unit
        if (!cur.members.includes(o.word)) cur.members.push(o.word)
      } else {
        cur = { file, start: o.index, end: o.end, members: [o.word], snippet: '', spansDeclarationBoundary: false, lastUnit: o.unit }
        clusters.push(cur)
      }
    }
    for (const c of clusters) {
      c.members.sort()
      c.snippet = src.slice(c.start, c.end).replace(/\s+/g, ' ').slice(0, 90)
      // Defense in depth, RECOMPUTED independently of the merge loop above rather than carried
      // forward from it, so a future bug in that loop's `blocked` check cannot silently re-open R7
      // by letting a boundary-spanning, ALREADY-2+-member-unit-adjacent cluster take the
      // `isComplete` short-circuit below. True iff the cluster's final span straddles a boundary
      // whose EITHER side is (independently, on its own occurrences) a 2+-member unit — the exact
      // condition the merge loop's `blocked` check refuses, checked here again from the cluster's
      // resulting span rather than trusted from construction. A cluster built entirely by chaining
      // through single-literal units (B6's `const E =`/`const R =`/`const H =` indirection, a
      // `switch` ladder, a YAML block list) legitimately straddles boundaries too, but never one
      // where either side independently reaches 2 — this stays false for those, by design.
      c.spansDeclarationBoundary = boundaries.some(
        (b) => b > c.start && b < c.end && (isMultiMemberUnit(unitIndexOf(boundaries, b - 1)) || isMultiMemberUnit(unitIndexOf(boundaries, b))),
      )
    }
    return clusters.filter((c) => c.members.length >= 2)
  }

  // MECHANISM FIX v4 (2026-08-20, third-round requalification's own N18 reproduction, disclosed as
  // residual (g) above until this fix) — closes DUPLICATE COMPLETE CARRIER: v3's boundary gate only
  // ever protects an INCOMPLETE unit from borrowing a neighbour's completeness; it has nothing to say
  // about a brand-new hand copy that is COMPLETE the moment it is written, because such a copy never
  // needs to merge with anything to pass the `isComplete` short-circuit. At this head, exactly TEN
  // complete (all-four-member, non-boundary-spanning) clusters exist across SEVEN files — every
  // known NodeFieldAccess mirror site plus ONE incidental complete copy already living inside a
  // doc-comment in `templateAuthoring.ts` (`FIELD_ACCESS_LABELS`'s `.vue` sibling contributes its
  // own from MECHANISM FIX v2, `approval-product.ts` contributes two — the type alias and the Set —
  // because they are separate declarations that do not merge across the boundary between them, same
  // for `apps/web/src/types/approval.ts`). `EXPECTED_COMPLETE_CLUSTER_COUNT` below pins that
  // per-file count exactly, the same exact-match discipline `SITES` and `expectedFiles` already use
  // elsewhere in this file: a file gaining an (N+1)th complete cluster — hand-copied, not merged —
  // reds immediately by named file, rather than silently asserting nothing until it later drifts.
  const EXPECTED_COMPLETE_CLUSTER_COUNT: Record<string, number> = {
    'packages/core-backend/src/services/approval-form-redaction.ts': 1, // C-3 rank table
    'packages/core-backend/src/types/approval-product.ts': 2, // C-1 type alias + C-2 Set (separate declarations)
    'apps/web/src/approvals/approvalNodeEdit.ts': 1, // C-6 literal array
    'apps/web/src/approvals/components/ApprovalGraphNodeConfigEditor.vue': 1, // FIELD_ACCESS_LABELS (v2)
    'apps/web/src/approvals/templateAuthoring.ts': 2, // C-7 isNodeFieldAccess guard + a doc-comment copy of the wire shape
    'apps/web/src/types/approval.ts': 2, // C-5 type alias + FE NODE_FIELD_ACCESS_VALUES export (v2, separate declarations)
    'packages/openapi/src/base.yml': 1, // C-8 wire enum
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
      // MECHANISM FIX v3 (R7): `type FieldVisibility = 'hidden' | 'visible'` and the very next line
      // `type FieldEditability = 'readonly' | 'editable'` are two SEPARATE column-0 declarations, so
      // they no longer cluster together — FieldVisibility's lone 'hidden' occurrence falls below the
      // 2-member floor and contributes no cluster at all; only FieldEditability's own two words form
      // one now. Pre-v3 this was one merged 3-member {editable, hidden, readonly} cluster; the
      // updated member set below is what the SAME real declaration now types as.
      file: 'apps/web/src/views/AfterSalesView.vue',
      members: ['editable', 'readonly'],
      nearSymbol: 'FieldEditability',
      symbolWindow: 150,
      reason: 'Same TicketFieldPolicy system: the FieldEditability type declaration itself.',
    },
    {
      // Unchanged by MECHANISM FIX v3: `const isRefundAmountHidden = computed(...)` and
      // `const isRefundAmountEditable = computed(...)` are two SEPARATE column-0 `const`
      // declarations, but EACH carries only ONE tracked word on its own ('hidden' / 'editable' —
      // 'visible' inside `isRefundAmountEditable`'s own predicate is not a tracked word), so neither
      // is independently a 2+-member unit and the boundary between them does not block chaining
      // (see the `isMultiMemberUnit` gate in `clusterOccurrences`) — this pair still merges into one
      // 2-member cluster exactly as before v3, and still needs this entry.
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

  it('complete NodeFieldAccess carriers: each file holds EXACTLY its pinned count of complete four-member copies (MECHANISM FIX v4, closes residual (g) / N18)', () => {
    // Recomputes "complete" the SAME way the per-cluster tests below do (four members, never spanning
    // a declaration boundary) rather than importing a shared flag, so this test independently catches
    // a bug in that computation instead of trusting it forward.
    const completeCounts = new Map<string, number>()
    for (const c of allClusters) {
      if (c.members.length === MEMBERS.length && !c.spansDeclarationBoundary) {
        completeCounts.set(c.file, (completeCounts.get(c.file) ?? 0) + 1)
      }
    }
    // Every file that currently carries a complete copy must carry EXACTLY the pinned count — a
    // brand-new hand-written complete duplicate (N18: an already-complete four-member copy added to
    // an already-tracked file, never merging with anything, so v3's boundary gate has nothing to
    // refuse) pushes some file's count to N+1 and reds here by name, instead of silently asserting
    // nothing until it later drifts.
    for (const [file, count] of completeCounts) {
      expect(count, `${file} carries ${count} complete NodeFieldAccess copies, expected ${EXPECTED_COMPLETE_CLUSTER_COUNT[file] ?? 0}`).toBe(
        EXPECTED_COMPLETE_CLUSTER_COUNT[file] ?? 0,
      )
    }
    // And the reverse: every PINNED file must still show its expected count (a complete carrier that
    // accidentally loses a member, or picks up a spurious boundary-spanning flag, undercounts here too
    // — belt-and-suspenders with the per-cluster tests below, which name the specific occurrence).
    for (const [file, expected] of Object.entries(EXPECTED_COMPLETE_CLUSTER_COUNT)) {
      expect(completeCounts.get(file) ?? 0, `${file} expected ${expected} complete NodeFieldAccess copies, found ${completeCounts.get(file) ?? 0}`).toBe(
        expected,
      )
    }
  })

  for (const f of scanned) {
    for (const c of f.clusters) {
      // Captured at COLLECTION time, before the test body runs — this is where the real teeth live.
      // Dropping (or never having carried) a member from a real hand copy shrinks `c.members` below
      // four distinct words HERE, which routes this exact source location into a differently-named,
      // one-fewer-member test that must then clear the allowlist check below (and normally can't,
      // since no allowlist entry has four members and none is scoped to a real NodeFieldAccess site)
      // — a stale hand copy IN ITS OWN DECLARATION is recognised BY its incomplete member set,
      // instead of being invisible to the scan that found it. A stale copy sitting near (but in a
      // DIFFERENT declaration from) a real complete carrier is recognised the SAME way, because
      // `isComplete` below is ALSO false for any cluster `clusterOccurrences` marked as spanning a
      // declaration boundary — see MECHANISM FIX v3 above `PARTIAL_CARRIER_ALLOWLIST` for why this
      // half did NOT hold before v3 (R7) and does now. `isComplete` is not asserted directly below
      // beyond that gate (the `c.members.length === 4` half would be vacuously true by construction:
      // `c.members` is already a deduped subset of `MEMBERS`) — the assertion that carries weight is
      // the allowlist check, which the `isComplete` branch is exempt from.
      const isComplete = c.members.length === MEMBERS.length && !c.spansDeclarationBoundary
      it(`${c.file} @${c.start}-${c.end} :: {${c.members.join(', ')}} (\`${c.snippet}\`)`, () => {
        const matches = isComplete ? [] : matchingAllowlistEntries(c, f.src)
        if (!isComplete && matches.length === 1) allowlistHits.add(matches[0]!)
        expect(
          isComplete || matches.length === 1,
          isComplete
            ? ''
            : `${c.file}@${c.start} carries {${c.members.join(', ')}}` +
                (c.spansDeclarationBoundary && c.members.length === MEMBERS.length
                  ? ' but the cluster SPANS MORE THAN ONE DECLARATION (MECHANISM FIX v3 / R7) — a ' +
                    'multi-declaration cluster is never treated as complete, even carrying all four ' +
                    'words, because at least one contributing declaration is a DIFFERENT unit from ' +
                    'the real carrier and must be judged on its own'
                  : ' of the four ratified members') +
                ` and matched ${matches.length} PARTIAL_CARRIER_ALLOWLIST entries (expected ` +
                `exactly 1${matches.length ? ': ' + matches.map((i) => PARTIAL_CARRIER_ALLOWLIST[i]!.nearSymbol).join(', ') : ''}) — ` +
                (matches.length === 0
                  ? 'either complete this copy to {editable, hidden, readonly, required} within ONE ' +
                    'declaration or add a new, symbol-anchored allowlist entry justifying the partial match'
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
