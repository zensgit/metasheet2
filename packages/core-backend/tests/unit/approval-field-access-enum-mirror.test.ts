import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import ts from 'typescript'
// MECHANISM FIX v5 — the real parser for `.ts` files and the `<script>`/`<script setup>` block of
// `.vue` files (see the DECLARATION BOUNDARIES section further down). `@vue/compiler-sfc` is the
// SAME SFC parser `vue-tsc` itself uses to split a `.vue` file into blocks — declared as an explicit
// devDependency of THIS package (`packages/core-backend`, which owns this test) rather than resolved
// out of `apps/web`'s dependency tree by path, so `pnpm install --frozen-lockfile` links it
// deterministically regardless of which workspace package runs the test.
import { parse as parseVueSfc } from '@vue/compiler-sfc'

/**
 * THE COMPILER IS THE PRIMARY GATE. THIS FILE IS A BEST-EFFORT BACKSTOP, NOT THE PRIMARY GUARANTEE.
 *
 * The primary guarantee that `NodeFieldAccess` cannot silently drift is `Record<NodeFieldAccess, …>`
 * exhaustiveness (`NODE_FIELD_ACCESS_RANK` in `approval-form-redaction.ts`, `FIELD_ACCESS_LABELS` in
 * `ApprovalGraphNodeConfigEditor.vue`) plus, as of MECHANISM FIX v5, that the union TYPE itself is now
 * DERIVED — on both backend and FE — from a single `as const` tuple that is also the runtime value
 * every consumer imports (`NODE_FIELD_ACCESS_VALUES`), rather than being an independently
 * hand-written literal a human must remember to keep in sync with a second one. Add a fifth member to
 * either tuple and `tsc`/`vue-tsc` red at every `Record<NodeFieldAccess, …>` site immediately —
 * proven by mutation in the PR that introduced this paragraph, not asserted (add the member, run
 * `tsc --noEmit` / `vue-tsc -b`, observe the exact error, revert byte-identically). THIS is the
 * mechanism that actually closes the "a fifth member lands and something silently doesn't notice"
 * class for the sites it covers.
 *
 * What remains is the residual the compiler CANNOT see: syntactically-valid places that spell out the
 * CURRENT four members as their own literals rather than importing/deriving from the canonical tuple
 * — a YAML wire enum (`packages/openapi/src/base.yml`, which cannot import a TypeScript constant), a
 * doc-comment that happens to quote all four words, or (this file's own honestly-scoped residual list
 * below) a stale/incomplete hand copy the AST- or regex-based scan below cannot attribute correctly.
 * This file exists ONLY for that residual — it is a text-level backstop, best-effort by construction,
 * never a substitute for converting a hand copy to an import wherever conversion is possible (see the
 * carrier inventory in the PR body: every site that COULD import the canonical tuple now does; C-8
 * (YAML) and Vue TEMPLATE markup are the two classes that structurally cannot).
 *
 * Below this point: the hand-mirrored sites of the `NodeFieldAccess` access enum that remain hand
 * copies are asserted equal by EXACT SET (the `SITES` loop below), and — as of MECHANISM FIX v2/v3/v4,
 * further down this docstring — the census ALSO scans the trees it walks for any literal co-occurrence
 * of the same four words it does not already know about (v2/v3), AND pins the exact COUNT of complete
 * copies per already-tracked file (v4), so a NEW copy landing in an already-scanned file — incomplete
 * or a brand-new complete duplicate alike — is caught rather than passing unnoticed, subject to the
 * mechanism's own honestly-stated residual
 * (several concrete gaps, labelled (a)–(i) — see the letters just above `PARTIAL_CARRIER_ALLOWLIST`
 * below; deliberately NOT phrased as an unqualified "any incomplete copy anywhere fails the census"
 * guarantee, and the letter RANGE rather than a transcribed count is what a future edit must keep in
 * sync — see the note at the top of that list).
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
 * named there, letters (a)–(i)).
 *
 * MECHANISM FIX v5 (2026-08-20, fourth-round requalification, finding R8) has TWO independent halves,
 * and downgrades the file's own claim to match:
 *
 * HALF 1 — a REAL PARSER replaces v3's boundary regex, for `.ts` files and the `<script>`/
 * `<script setup>` block of `.vue`. R8 proved `TS_DECLARATION_BOUNDARY_RE` fired ONLY at column 0, so
 * a stale copy written INSIDE the same unit as a real complete carrier — a second `if` beside C-6's
 * canonical check inside one function body, an indented `const` above it, an indented `const` in a
 * `<script setup>` block — never crossed a boundary at all and was silently absorbed into the real
 * carrier's completeness (three live reproductions against `approvalNodeEdit.ts` and
 * `ApprovalGraphNodeConfigEditor.vue`, confirmed via a `PROBE_DUMP` mechanism trace, not inferred).
 * v5 replaces the regex with the TypeScript compiler API (`ts.createSourceFile` + a full node walk)
 * for those file types: every `ts.Statement`, at ANY nesting depth — not just top-level — is its own
 * unit, and each literal occurrence is attributed to the SMALLEST (innermost) statement span
 * containing it (span CONTAINMENT, not a boundary-count bucket — a flat count scheme mis-attributes
 * an occurrence in an OUTER statement to whichever INNER statement's boundary it most recently
 * crossed, once that inner statement has closed; a real shape in this tree,
 * `NODE_FIELD_ACCESS_VALUES_MESSAGE`'s IIFE in `ApprovalProductService.ts`, is exactly an outer
 * statement containing two nested ones). This is a MECHANISM change, not another pattern: it closes
 * the declaration-boundary class for `.ts` files and Vue `<script>` blocks — real reproductions of
 * every R8 finding now RED (see the PR body for the replay table), with all seven R7 reproductions,
 * the twelve R1 shapes, and every teeth mutation re-verified GREEN/RED as labelled at this head. It
 * does NOT close the class for Vue TEMPLATE markup (no parser is warranted there — see residual (h),
 * unchanged) or for YAML (`.yml` keeps its own boundary regex unchanged — R8 found that half already
 * TIGHT). A NEW, narrower residual is a direct consequence of moving the boundary to STATEMENT
 * granularity: a stale copy sharing the SAME statement as a real carrier — a second, comma-joined
 * `const` declarator on the identical `VariableStatement`, or a second array argument in the same
 * call expression — is still absorbed, because it is textually part of ONE statement, not two. Named
 * as residual (i) below, verified live (not hypothetical) against this file's own converted carriers.
 *
 * HALF 2 — CONVERSION: every hand-written member-list site that COULD import/derive from the
 * canonical tuple instead of hand-copying it now does. `apps/web/src/approvals/approvalNodeEdit.ts`
 * (C-6) and `apps/web/src/approvals/templateAuthoring.ts`'s `isNodeFieldAccess` (C-7) now read
 * `NODE_FIELD_ACCESS_VALUES` instead of hand-writing the four literals a second time (own G-2-style
 * anti-gate `describe` blocks below prove the literal shape is GONE, not merely that the new call
 * exists). Backend `NodeFieldAccess`/`NODE_FIELD_ACCESS_VALUES` (C-1/C-2) and FE
 * `NodeFieldAccess`/`NODE_FIELD_ACCESS_VALUES` (C-5) — each previously TWO independently hand-written
 * literal lists the compiler checked in only ONE direction — are now BOTH derived from a single
 * `NODE_FIELD_ACCESS_MEMBERS` tuple per side, so the type and the runtime value cannot desynchronise
 * BY CONSTRUCTION, not merely by a test (the compiler-gate teeth proof at the top of this file's
 * docstring is this same conversion's payoff). `approvalNodeEdit.ts` had exactly one literal cluster
 * in the whole file, so converting it removed its ONLY carrier — the file drops out of
 * `expectedFiles` below entirely, not merely out of `SITES`. `packages/openapi/src/base.yml` (C-8, a
 * YAML wire enum) and Vue TEMPLATE markup are the two classes that structurally cannot import a
 * TypeScript constant and remain allowlisted/hand-written carriers — named, not silently left as an
 * oversight (see the carrier inventory in the PR body).
 */
const REPO = resolve(__dirname, '../../../..')
const MEMBERS = ['editable', 'hidden', 'readonly', 'required'] // sorted

// MECHANISM FIX v5 (compiler-primary carrier inventory) shrank this from SEVEN literal-member-list
// sites to FOUR (C-1/C-2 collapsed into one, C-5 collapsed into one, C-6 and C-7 CONVERTED away
// entirely — see their own anti-gate `describe` blocks below, alongside C-4's). C-3 and C-8 are
// unchanged: C-3 was already compiler-guarded (`Record<NodeFieldAccess, number>`) and C-8 is the
// OpenAPI wire enum, a YAML file that cannot import a TypeScript constant. C-9 is handled in its own
// describe block below instead of this member-equality loop, because its message is DERIVED at
// runtime from `NODE_FIELD_ACCESS_VALUES` (OD-L7B-10) and therefore carries no literal member strings
// in source for a member-list extractor to find; the requirement IS the absence of a hand-written
// literal, asserted by shape (and, behaviourally, by the actual 400 message text in
// `approval-product-service.test.ts`'s P1-C describe block).
const SITES: Array<{ file: string; label: string; extract: (src: string) => string[] }> = [
  {
    file: 'packages/core-backend/src/types/approval-product.ts',
    label: 'backend NodeFieldAccess member tuple (C-1/C-2, MECHANISM FIX v5: type + Set now BOTH derived from this ONE literal)',
    extract: (src) => membersOf(/NODE_FIELD_ACCESS_MEMBERS\s*=\s*\[([^\]]*)\]\s*as const/, src),
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
    label: 'FE NodeFieldAccess member tuple (C-5, MECHANISM FIX v5: type + array now BOTH derived from this ONE literal)',
    extract: (src) => membersOf(/NODE_FIELD_ACCESS_MEMBERS\s*=\s*\[([^\]]*)\]\s*as const/, src),
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

  // MECHANISM FIX v5 anti-gate, same reason the SITES member-equality loop above is not enough on
  // its own for C-1/C-2/C-5: the SITES extractor for these two files only reads
  // `NODE_FIELD_ACCESS_MEMBERS`'s own four members — it says nothing about whether `NodeFieldAccess`
  // (the TYPE) and `NODE_FIELD_ACCESS_VALUES` (the runtime Set/array) still DERIVE from that tuple, as
  // opposed to a regression that reverts the type back to an independent literal union while leaving
  // the tuple in place unused. That regression would leave the tuple's own four members intact (SITES
  // stays green) while silently un-doing the ENTIRE point of the v5 collapse — the compiler-primary
  // claim at the top of this file's docstring ("the type and the runtime value cannot desynchronise
  // BY CONSTRUCTION") would become FALSE with no test catching it. Asserted here by shape (source
  // text present/absent), the same G-2-style discipline C-4/C-6/C-7 already use, and MUTATION-VERIFIED
  // (revert the type alias to a literal union with the tuple left intact — reds; revert the Set/array
  // to an independent literal — reds; see the PR body).
  describe('C-1/C-2 — backend NodeFieldAccess type + NODE_FIELD_ACCESS_VALUES are DERIVED from ONE tuple, never independent literals (MECHANISM FIX v5, G-2-style anti-gate)', () => {
    const src = read('packages/core-backend/src/types/approval-product.ts')

    it('the type is DERIVED — `(typeof NODE_FIELD_ACCESS_MEMBERS)[number]` — not an independent literal union', () => {
      expect(src).toMatch(/export type NodeFieldAccess = \(typeof NODE_FIELD_ACCESS_MEMBERS\)\[number\]/)
    })

    it('does NOT contain the retired independent literal union (the pre-v5 shape of this type)', () => {
      expect(src).not.toMatch(/export type NodeFieldAccess = 'editable' \| 'readonly'/)
    })

    it('the Set is DERIVED — `new Set<NodeFieldAccess>(NODE_FIELD_ACCESS_MEMBERS)` — not an independent literal array', () => {
      expect(src).toMatch(/export const NODE_FIELD_ACCESS_VALUES = new Set<NodeFieldAccess>\(NODE_FIELD_ACCESS_MEMBERS\)/)
    })

    it('does NOT contain the retired independent literal Set (the pre-v5 shape of this declaration)', () => {
      expect(src).not.toMatch(/new Set<NodeFieldAccess>\(\['editable'/)
    })
  })

  describe('C-5 — FE NodeFieldAccess type + NODE_FIELD_ACCESS_VALUES are DERIVED from ONE tuple, never independent literals (MECHANISM FIX v5, G-2-style anti-gate)', () => {
    const src = read('apps/web/src/types/approval.ts')

    it('the type is DERIVED — `(typeof NODE_FIELD_ACCESS_MEMBERS)[number]` — not an independent literal union', () => {
      expect(src).toMatch(/export type NodeFieldAccess = \(typeof NODE_FIELD_ACCESS_MEMBERS\)\[number\]/)
    })

    it('does NOT contain the retired independent literal union (the pre-v5 shape of this type)', () => {
      expect(src).not.toMatch(/export type NodeFieldAccess = 'editable' \| 'readonly'/)
    })

    it('the array is DERIVED — `= NODE_FIELD_ACCESS_MEMBERS` — not an independent literal array', () => {
      expect(src).toMatch(/export const NODE_FIELD_ACCESS_VALUES: readonly NodeFieldAccess\[\] = NODE_FIELD_ACCESS_MEMBERS/)
    })

    it('does NOT contain the retired independent literal array (the pre-v5 shape of this declaration)', () => {
      expect(src).not.toMatch(/readonly NodeFieldAccess\[\] = \['editable'/)
    })
  })

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

  describe('C-6 — approvalNodeEdit.ts field-permission validation reads NODE_FIELD_ACCESS_VALUES, never a literal array (MECHANISM FIX v5, G-2-style anti-gate)', () => {
    const src = read('apps/web/src/approvals/approvalNodeEdit.ts')

    it('reads NODE_FIELD_ACCESS_VALUES.includes(permission.access) — the mechanical enumeration form', () => {
      expect(src).toMatch(/NODE_FIELD_ACCESS_VALUES\.includes\(permission\.access\)/)
    })

    it('does NOT contain the retired literal array (an appended member there would still match this)', () => {
      // The shape this site carried before MECHANISM FIX v5:
      //   (['editable', 'readonly', 'hidden', 'required'] as const).includes(permission.access)
      expect(src).not.toMatch(/\[\s*'editable'\s*,\s*'readonly'\s*,\s*'hidden'/)
    })

    it('imports NODE_FIELD_ACCESS_VALUES as a VALUE from the canonical FE types module', () => {
      expect(src).toMatch(/import\s*\{[^}]*\bNODE_FIELD_ACCESS_VALUES\b[^}]*\}\s*from\s*'\.\.\/types\/approval'/)
    })
  })

  describe('C-7 — templateAuthoring.ts isNodeFieldAccess reads NODE_FIELD_ACCESS_VALUES, never a literal disjunction (MECHANISM FIX v5, G-2-style anti-gate)', () => {
    const src = read('apps/web/src/approvals/templateAuthoring.ts')

    it('reads NODE_FIELD_ACCESS_VALUES.includes(value) — the mechanical enumeration form', () => {
      expect(src).toMatch(/\(NODE_FIELD_ACCESS_VALUES as readonly string\[\]\)\.includes\(value\)/)
    })

    it('does NOT contain the retired literal disjunction chain (an appended `|| value === X` arm would still match this)', () => {
      // The shape this site carried before MECHANISM FIX v5:
      //   value === 'editable' || value === 'readonly' || value === 'hidden' || value === 'required'
      expect(src).not.toMatch(/value === 'editable' \|\| value === 'readonly'/)
    })

    it('imports NODE_FIELD_ACCESS_VALUES as a VALUE from the canonical FE types module', () => {
      expect(src).toMatch(/import\s*\{[^}]*\bNODE_FIELD_ACCESS_VALUES\b[^}]*\}\s*from\s*'\.\.\/types\/approval'/)
    })
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
  // DECLARATION BOUNDARIES (MECHANISM FIX v3 / R7, TS/JS/Vue-script HALF SUPERSEDED by MECHANISM FIX
  // v5 / R8 below) — how a "unit" is derived and why the merge rule is NOT a blanket "never cross a
  // boundary". A unit is found by a file-type-keyed structural marker — a REAL PARSER for `.ts` files
  // and the `<script>`/`<script setup>` block of `.vue`, a cheap regex for everything else, and the
  // split is deliberate, not an oversight (see the docstring at the top of this file):
  //   - TS/JS, and the `<script>`/`<script setup>` block of `.vue` (MECHANISM FIX v5, `astStatement
  //     UnitResolver` / `vueUnitResolver` below): every `ts.Statement` node, walked via
  //     `ts.createSourceFile` at ANY nesting depth — not just top-level. v3's shipped mechanism used a
  //     column-0-only regex here instead (`TS_DECLARATION_BOUNDARY_RE`, kept below ONLY as the `.vue`
  //     SFC-parse-failure fallback); a fourth-round requalification (finding R8) proved that regime
  //     let a stale copy written INSIDE the same unit as a real carrier — a second `if` beside C-6's
  //     canonical check inside one function body, an indented `const` above it, an indented `const` in
  //     a `<script setup>` block, all of which are indented and therefore invisible to a column-0
  //     match — silently absorb into that carrier's completeness. Real AST statement boundaries exist
  //     at EVERY nesting depth regardless of indentation, so v5 closes that class for these file types:
  //     each literal occurrence is attributed to the SMALLEST (innermost) statement span containing
  //     it — by CONTAINMENT, not a boundary-count bucket, because a flat count mis-attributes an
  //     occurrence in an OUTER statement to an INNER statement's already-closed boundary (a real shape
  //     in this tree: `NODE_FIELD_ACCESS_VALUES_MESSAGE`'s IIFE in `ApprovalProductService.ts` is one
  //     outer statement containing two nested ones). An occurrence in no statement's span at all
  //     (comment prose, or — for `.vue` — anything outside every script block) shares a unit id with
  //     the nearest PRECEDING statement's end, exactly reproducing v3's template permissiveness for
  //     the `.vue` template region (see below) while keeping a multi-word comment as ONE cluster. This
  //     does NOT fire inside Vue TEMPLATE markup itself — no statement exists there for the parser to
  //     find — so the proximity-only behaviour the cross-element/cross-tag partial-carrier allowlist
  //     entries below rely on (FormView.vue's `hidden`+`required` pair spanning a `<div>` and a nested
  //     `<label>`; TemplateAuthoringView.vue's linear-editor options) is unaffected by v5, exactly as
  //     it was unaffected by v3. The COST of that scope choice is real, not merely theoretical, and is
  //     named as residual (h) below rather than left as a side effect of this paragraph: this gate
  //     cannot close R7/R8-style absorption inside template markup, because a single
  //     `<el-option value="…">` tag naturally carries exactly one tracked word and so never reaches
  //     the 2-member threshold the gate keys off, no matter how the unit boundary is drawn there — and
  //     no parser is warranted for template markup at all (see the top-of-file docstring's "compiler
  //     is the primary gate" framing: HTML/Vue template attribute values are not something `tsc` types
  //     check either way, so there is no compiler backstop to lean on here, only this text scan).
  //   - YAML (`.yml`): UNCHANGED by v5 — every mapping-key line (`key:`), at ANY indentation depth,
  //     starts a new unit — cheaper than tracking indentation levels, and sufficient because no real
  //     carrier or allowlist entry in this repo needs two DIFFERENT YAML keys' values merged into one
  //     cluster, AND because R8's own YAML probe (a stale sibling key next to the real wire enum) reds
  //     under the unchanged regex — this half was already tight, not merely unexamined.
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
  // short-circuit. Residual (f) below named the narrower gap this weaker-than-absolute rule was
  // believed to leave open — CLOSED, retroactively, by MECHANISM FIX v4's complete-cluster count pin;
  // see (f)'s own entry for the re-verification.
  //
  // Clustering with 2+ distinct words finds THIRTEEN files with at least one candidate cluster in the
  // scanned trees at this window (MECHANISM FIX v5: down from fourteen — converting `approvalNodeEdit
  // .ts`'s only cluster away removed the file from this list entirely, not merely from `SITES`) — only
  // SIX of which are complete four-member NodeFieldAccess copies (MECHANISM FIX v5: down from seven —
  // the C-1/C-2 and C-5 tuple collapses did not remove a FILE from this count, only a redundant
  // DECLARATION within `approval-product.ts` and `apps/web/src/types/approval.ts`, so those two files
  // still count once each; `approvalNodeEdit.ts` dropping out is what actually shrank the file count).
  // See `EXPECTED_COMPLETE_CLUSTER_COUNT` below for the authoritative per-file counts — not a number
  // transcribed into prose that can silently go stale the next time a site is converted, per this
  // file's own COUNT HISTORY discipline. Every other cluster is a real but UNRELATED or
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
  // MECHANISM FIX v5 pushed the SAME conversion discipline further, this round against every
  // remaining hand copy that COULD import/derive rather than hand-write (the carrier inventory in the
  // PR body has the full accounting): `apps/web/src/approvals/approvalNodeEdit.ts` (C-6) and
  // `apps/web/src/approvals/templateAuthoring.ts`'s `isNodeFieldAccess` (C-7) now read
  // `NODE_FIELD_ACCESS_VALUES` instead of hand-writing the member list/disjunction a second time —
  // `approvalNodeEdit.ts` had exactly one literal cluster in the whole file, so this conversion
  // removed its ONLY carrier and the file drops out of `expectedFiles` below entirely. Backend
  // `NodeFieldAccess`/`NODE_FIELD_ACCESS_VALUES` (C-1/C-2) and FE
  // `NodeFieldAccess`/`NODE_FIELD_ACCESS_VALUES` (C-5) go further still: each was previously TWO
  // independent hand-written literal lists (a type union and a runtime Set/array) that the compiler
  // checked in only ONE direction; both sides now derive the type AND the runtime value from a SINGLE
  // `NODE_FIELD_ACCESS_MEMBERS` tuple, so they cannot desynchronise by construction. `base.yml` (C-8,
  // a YAML wire enum) and Vue TEMPLATE markup remain hand-written, named explicitly as the two classes
  // that structurally cannot import a TypeScript constant, not left as an unexamined gap.
  //
  // RESIDUAL (stated precisely, not swept under this mechanism's greater reach than v1's, and NOT
  // pinned to a transcribed count that can silently go stale — this file's own COUNT HISTORY
  // discipline at the top applies here too): this scan is NOT an unconditional guarantee that "any
  // file anywhere carrying an incomplete copy fails the census". The gaps below, labelled (a)–(i), are
  // ALL that are currently known; grep this file for the next unused letter before adding one, and
  // update the "labelled (a)–(i)" cross-references at the top of this file (there are two) in the same
  // change. Most are inherent to literal-text scanning rather than to shape enumeration, so no amount
  // of ADDING shape families would close them either — (f), (g), (h) and (i) are the four exceptions,
  // introduced or newly surfaced by MECHANISM FIX v3/v4/v5 and named so, not folded silently into the
  // older letters. (f) and (g) are RETIRED (closed) letters, kept rather than reused or deleted, per
  // this file's own COUNT HISTORY discipline:
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
  //   (f) SINGLE-LITERAL-UNIT SPLITTING — CLOSED, RETROACTIVELY, by MECHANISM FIX v4 (re-verified at
  //       THIS head while writing v5's docstring pass, because the claim below turned out to be
  //       STALE, not merely superseded — corrected here rather than silently carried forward). The
  //       boundary gate blocks a merge only when EITHER side of the crossing is, on its own, already a
  //       2+-member unit; chaining through a run of units that each carry exactly ONE tracked word is
  //       deliberately still permitted (that permissiveness is what keeps R1's B6 const-indirection
  //       shape detected — see the DECLARATION BOUNDARIES discussion above). A drifter who splits a
  //       stale copy into THREE separate single-word declarations (`const A = 'editable'`; `const B =
  //       'readonly'`; `const C = 'hidden'`), each never independently reaching 2 members, then adds a
  //       fourth single-word declaration holding `'required'` within the window, WAS believed (this
  //       file's own v3-era text) to "complete silently — 43 passed, no failure". Re-run at this head
  //       (own-devised probe, `cp`-restored, appended to an ALREADY-`expectedFiles` file with no
  //       existing complete cluster): the chained result IS a genuine new complete four-member
  //       cluster (`isComplete` true, confirmed by the passing per-cluster test naming it), and
  //       precisely BECAUSE it is complete, MECHANISM FIX v4's per-file complete-COUNT pin — which
  //       counts every complete cluster a file holds, regardless of HOW it became complete — reds
  //       immediately: `PluginRbacProvisioningService.ts carries 1 complete NodeFieldAccess copies,
  //       expected 0`. v4 was designed for a DIFFERENT case (a single already-complete hand copy, N18)
  //       and was never aimed at single-literal-unit splitting specifically, but its mechanism — a
  //       per-file count of COMPLETE clusters, not of HOW each one was constructed — structurally
  //       cannot distinguish "one hand-written complete literal" from "four single-word literals that
  //       chained into a complete cluster": either way the file's complete-cluster count moves from N
  //       to N+1, and the pin catches BOTH. There is no placement that clears the chain (needed to
  //       keep B6-style detection alive) while ALSO staying invisible to v4's count, because becoming
  //       COMPLETE is exactly the condition v4 keys off. Kept as a retired letter, per this file's own
  //       COUNT HISTORY discipline, rather than deleted or reused;
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
  //   (i) SAME-STATEMENT SHARING (MECHANISM FIX v5, R8) — v5's AST boundary is STATEMENT granularity,
  //       not expression granularity: two literal clusters that are textually part of the SAME
  //       `ts.Statement` are never separated, because a single statement is, by definition, one unit.
  //       A stale copy comma-joined onto the REAL carrier's own declaration — a second
  //       `VariableDeclaration` on the identical `VariableStatement`
  //       (`export const NODE_FIELD_ACCESS_MEMBERS = [...] as const, STALE = [...]`) — shares that one
  //       unit with the real carrier and is silently absorbed, exactly as R8's column-0 gap used to
  //       allow across STATEMENTS. Verified LIVE against this file's own post-conversion canonical
  //       tuple (own-devised probe, `cp`-restored: 42 passed, no failure — see the PR body), not
  //       hypothetical. This is a real, narrower residual of choosing STATEMENT as the unit rather than
  //       a finer (and much more invasive) EXPRESSION-level walk — a deliberately weaker granularity,
  //       for the same reason v3 chose the weaker-than-absolute boundary rule over an unconditional
  //       one: closing it fully would mean walking into every array/object literal and call-expression
  //       argument list looking for a second, unrelated literal collection sharing the same enclosing
  //       expression, which is a materially larger change than the statement-level walk implemented
  //       this round, and was not attempted — recorded here, not swept into (f) (which is about
  //       chaining THROUGH single-literal units across DIFFERENT statements, a distinct mechanism) or
  //       silently left uncovered by the compiler-is-primary-gate paragraph at the top of this file
  //       (the compiler does NOT catch this either: `NODE_FIELD_ACCESS_MEMBERS, STALE = [...]` is
  //       perfectly valid TypeScript, and `STALE` is simply an unused, unexported local the compiler
  //       has no reason to flag).
  // These are the honest scope of "shape-agnostic": agnostic to CONNECTOR syntax (the failure class
  // R1 found), as of v3/v5, to a stale copy's PROXIMITY to a real TS/JS-declaration or YAML-key
  // carrier PROVIDED it is not textually part of the SAME STATEMENT as that carrier (i), as of v4, to
  // a brand-new COMPLETE duplicate of an existing carrier appearing in an already-tracked file
  // REGARDLESS of whether that duplicate arrived as one hand-written literal or as several
  // single-word declarations that chained into completeness (f, closed retroactively) — not agnostic
  // to file scope, file extension, spatial layout, literal-vs-symbolic encoding, allowlist anchor
  // collisions, the specific quote/delimiter character set recognised, same-statement sharing, or
  // proximity to a carrier living inside Vue TEMPLATE markup specifically (no parser reaches there —
  // see (h) and the top-of-file "compiler is the primary gate" paragraph).

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

  // Every YAML mapping-key line, at ANY indentation depth, starts a new declaration/mapping unit.
  // Unchanged by MECHANISM FIX v5 — the third-round requalification (R8) found this half already
  // TIGHT (probe Y1 reds); only the TS/JS half needed a real parser.
  const YAML_KEY_BOUNDARY_RE = /^[ \t]*[A-Za-z_][\w.-]*:/gm
  // FALLBACK ONLY (MECHANISM FIX v5): the retired v3 column-0 regex. No longer the primary TS/JS
  // boundary source — kept as the `.vue` SFC-parse-failure fallback below, so a file the real parser
  // cannot handle degrades to the mechanism this file shipped with before v5 rather than to zero
  // protection.
  const TS_DECLARATION_BOUNDARY_RE = /^(export\s+)?(const|let|var|type|interface|enum|function|class)\b/gm

  // Which unit (0-indexed segment between consecutive boundaries) `pos` falls in — the count of
  // boundary starts at-or-before `pos`. Used by the YAML resolver (unchanged mechanism) and by the
  // `.vue` SFC-parse-failure fallback below.
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

  type UnitResolver = (pos: number) => number

  function yamlUnitResolver(src: string): UnitResolver {
    const boundaries: number[] = []
    YAML_KEY_BOUNDARY_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = YAML_KEY_BOUNDARY_RE.exec(src))) boundaries.push(m.index)
    return (pos) => unitIndexOf(boundaries, pos)
  }

  /**
   * MECHANISM FIX v5 (2026-08-20, requalification #3, finding R8) — the real TypeScript compiler API
   * for `.ts` files and the `<script>`/`<script setup>` block of `.vue` files, replacing v3's
   * column-0-only regex. See the DECLARATION BOUNDARIES docstring above `PARTIAL_CARRIER_ALLOWLIST`
   * for the full R8 story; this is the mechanism itself.
   *
   * Walks EVERY `ts.Statement` node in the file, at ANY nesting depth — not just top-level. This is
   * the actual fix: v3's regex only recognised a "new unit" at column 0, so two SIBLING statements
   * sharing one function/block body (an `if` beside another `if`, a `const` beside another `const`,
   * both indented inside the same function) were invisibly ONE unit, and a stale copy written as the
   * second one silently absorbed into the first one's completeness (R8's P-A1/P-A4/P-A5). Real AST
   * statement boundaries exist at every nesting depth regardless of indentation, so this closes that
   * specific class for the file types a parser is warranted for.
   *
   * Attribution is by SPAN CONTAINMENT, not a boundary-count bucket (a flat "count of boundaries at
   * or before this position" scheme — the v3 shape — silently mis-attributes an occurrence in an
   * OUTER statement to whichever INNER statement's boundary happens to have been crossed most
   * recently, once that inner statement has already closed; a real shape in this very file,
   * `ApprovalProductService.ts`'s `NODE_FIELD_ACCESS_VALUES_MESSAGE = (() => { const parts = …; return
   * … })()`, is exactly an outer statement with two nested statements inside it). Per occurrence, the
   * SMALLEST (innermost) statement span containing its position is its unit id — the statement's own
   * start offset, which is unique per statement in a file. An occurrence in no statement's span at
   * all (comment prose — the `templateAuthoring.ts:998` doc-comment copy is a live example — or, for
   * `.vue`, anything outside every script block) is attributed to a unit id derived from the END of
   * the nearest PRECEDING statement (or "nothing precedes it" if none does) — ONE shared id per gap,
   * not one id per occurrence (which would fragment a multi-word comment into single-word pieces) and
   * not one sitewide sentinel (which would lump every comment and every template tag in a file into a
   * single pseudo-unit and could start blocking crossings that succeed today). This keeps the
   * `templateAuthoring.ts` doc-comment cluster intact and complete, and keeps Vue TEMPLATE markup
   * chaining through the trailing "nothing left to declare" gap exactly as v3 always did — see residual
   * (h): this file does NOT parse template markup with the AST at all, by design (below).
   */
  function astStatementUnitResolver(src: string, fileNameForParser: string): UnitResolver {
    const sf = ts.createSourceFile(fileNameForParser, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const spans: Array<{ start: number; end: number }> = []
    const visit = (node: ts.Node): void => {
      if (ts.isStatement(node) && node.kind !== ts.SyntaxKind.NotEmittedStatement && node.kind !== ts.SyntaxKind.EmptyStatement) {
        spans.push({ start: node.getStart(sf), end: node.getEnd() })
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sf, visit)
    return (pos) => {
      let innermost: { start: number; end: number } | null = null
      let precedingEnd = -1
      for (const s of spans) {
        if (s.start <= pos && pos < s.end) {
          if (!innermost || s.start > innermost.start) innermost = s
        } else if (s.end <= pos && s.end > precedingEnd) {
          precedingEnd = s.end
        }
      }
      // Real statement starts are always >= 0. Gap ids are always <= -999,999,999 (a large fixed
      // offset minus `precedingEnd`, which is itself either a real, non-negative statement-end
      // position or the -1 sentinel for "nothing precedes this position") — chosen so the two id
      // spaces can never overlap (a file would need over a billion bytes of preceding content to
      // reach zero), so equality between a statement id and a gap id is structurally impossible, and
      // two DIFFERENT gaps (different `precedingEnd`) still resolve to two different ids.
      return innermost ? innermost.start : -1_000_000_000 - precedingEnd
    }
  }

  /**
   * `.vue`: split into its script block(s) via `@vue/compiler-sfc` (the same parser `vue-tsc` uses),
   * run `astStatementUnitResolver` on each block's own content, and offset every resulting id back to
   * absolute file positions. TEMPLATE markup and anything outside a script block contributes NO
   * boundaries of its own — deliberately unchanged from v3 (see residual (h) and the DECLARATION
   * BOUNDARIES docstring above `PARTIAL_CARRIER_ALLOWLIST`): that permissiveness is what keeps
   * FormView.vue's cross-element `hidden`+`required` pair and TemplateAuthoringView.vue's linear-editor
   * options clustering correctly. A position outside every script block shares the trailing unit id of
   * whichever script block most recently precedes it (mirroring the gap-fallback inside
   * `astStatementUnitResolver`, for the identical reason); a `.vue` file with NO `<script>` block at
   * all gets a single shared id for the whole file, matching v3's template behaviour exactly (nothing
   * to protect, because there is no code there to protect). If `@vue/compiler-sfc` itself throws on a
   * file it cannot parse, this falls back to the retired v3 column-0 regex over the RAW file text — at
   * least as protective as the mechanism this file shipped with before v5, never silently zero.
   */
  function vueUnitResolver(absPath: string, src: string): UnitResolver {
    let descriptor: ReturnType<typeof parseVueSfc>['descriptor']
    try {
      descriptor = parseVueSfc(src, { filename: absPath }).descriptor
    } catch {
      const boundaries: number[] = []
      TS_DECLARATION_BOUNDARY_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = TS_DECLARATION_BOUNDARY_RE.exec(src))) boundaries.push(m.index)
      return (pos) => unitIndexOf(boundaries, pos)
    }
    const rawBlocks = [descriptor.script, descriptor.scriptSetup].filter(
      (b): b is NonNullable<typeof b> => !!b,
    )
    if (rawBlocks.length === 0) return () => -1 // no <script> at all — nothing to protect (matches v3's template-only behaviour)
    const blocks = rawBlocks
      .map((b) => ({ offset: b.loc.start.offset, len: b.content.length, resolve: astStatementUnitResolver(b.content, absPath + '.script.ts') }))
      .sort((a, b) => a.offset - b.offset)
    return (pos) => {
      for (const b of blocks) {
        if (pos >= b.offset && pos < b.offset + b.len) return b.resolve(pos - b.offset)
      }
      let owner: (typeof blocks)[number] | null = null
      for (const b of blocks) if (b.offset + b.len <= pos) owner = b
      return owner ? owner.resolve(owner.len) : -1
    }
  }

  function unitResolverFor(file: string, src: string): UnitResolver {
    if (file.endsWith('.yml') || file.endsWith('.yaml')) return yamlUnitResolver(src)
    const abs = join(REPO, file)
    if (file.endsWith('.vue')) return vueUnitResolver(abs, src)
    return astStatementUnitResolver(src, abs)
  }

  function clusterOccurrences(file: string, src: string): CarrierCluster[] {
    const occ = rawLiteralOccurrences(src)
    const unitOf = unitResolverFor(file, src)
    const withUnit = occ.map((o) => ({ ...o, unit: unitOf(o.index) }))

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
      // `isComplete` short-circuit below. True iff the cluster's final span contains occurrences from
      // MORE THAN ONE unit AND at least one of those units is (independently, on its own occurrences)
      // a 2+-member unit — the exact condition the merge loop's `blocked` check refuses, checked here
      // again from the cluster's resulting span and the SAME per-occurrence unit ids rather than
      // trusted from construction. (MECHANISM FIX v5: recomputed from occurrence-level unit
      // membership rather than by re-walking a physical boundary-position list — the TS/JS path no
      // longer has one; a real AST statement's identity IS its start offset, not a position in an
      // array — but the predicate is unchanged.) A cluster built entirely by chaining through
      // single-literal units (B6's `const E =`/`const R =`/`const H =` indirection, a `switch`
      // ladder, a YAML block list) legitimately spans multiple units too, but never one where any of
      // them independently reaches 2 — this stays false for those, by design.
      const unitsInSpan = new Set(withUnit.filter((o) => o.index >= c.start && o.index < c.end).map((o) => o.unit))
      c.spansDeclarationBoundary = unitsInSpan.size > 1 && [...unitsInSpan].some((u) => isMultiMemberUnit(u))
    }
    return clusters.filter((c) => c.members.length >= 2)
  }

  // MECHANISM FIX v4 (2026-08-20, third-round requalification's own N18 reproduction, disclosed as
  // residual (g) above until this fix) — closes DUPLICATE COMPLETE CARRIER: v3's boundary gate only
  // ever protects an INCOMPLETE unit from borrowing a neighbour's completeness; it has nothing to say
  // about a brand-new hand copy that is COMPLETE the moment it is written, because such a copy never
  // needs to merge with anything to pass the `isComplete` short-circuit. `EXPECTED_COMPLETE_
  // CLUSTER_COUNT` below pins that per-file count exactly, the same exact-match discipline `SITES`
  // and `expectedFiles` already use elsewhere in this file: a file gaining an (N+1)th complete
  // cluster — hand-copied, not merged — reds immediately by named file, rather than silently
  // asserting nothing until it later drifts.
  //
  // MECHANISM FIX v5 changed these counts via CONVERSION, not detection: `approvalNodeEdit.ts` (C-6)
  // is gone from this table entirely — it had exactly one literal cluster in the whole file, so
  // converting it to import `NODE_FIELD_ACCESS_VALUES` removed its only carrier, and it also drops
  // out of `expectedFiles` below. `approval-product.ts` (backend C-1/C-2), `apps/web/src/types/
  // approval.ts` (FE C-5), and `templateAuthoring.ts` (C-7) each go from 2 complete clusters to 1:
  // the backend/FE pairs used to be TWO separate declarations (a type alias plus a Set/array) that
  // each independently held all four literals; both are now DERIVED from one shared
  // `NODE_FIELD_ACCESS_MEMBERS` tuple, so only the tuple's own declaration still carries the
  // literals. `templateAuthoring.ts` loses its `isNodeFieldAccess` literal disjunction to the same
  // kind of conversion, leaving only the pre-existing, UNCHANGED doc-comment copy (see MECHANISM FIX
  // v4's own note, retained below) as that file's one complete cluster.
  const EXPECTED_COMPLETE_CLUSTER_COUNT: Record<string, number> = {
    'packages/core-backend/src/services/approval-form-redaction.ts': 1, // C-3 rank table
    'packages/core-backend/src/types/approval-product.ts': 1, // C-1/C-2, MECHANISM FIX v5: ONE tuple, type + Set both derived
    'apps/web/src/approvals/components/ApprovalGraphNodeConfigEditor.vue': 1, // FIELD_ACCESS_LABELS (v2)
    'apps/web/src/approvals/templateAuthoring.ts': 1, // a doc-comment copy of the wire shape (C-7's own literal chain converted away in v5)
    'apps/web/src/types/approval.ts': 1, // C-5, MECHANISM FIX v5: ONE tuple, type + array both derived
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
      // MECHANISM FIX v5 (AST statement boundaries): `normalizeFieldPolicy`'s `visibility` and
      // `editability` values are computed by TWO SEPARATE `const` statements. Pre-v5, both lived in
      // the SAME flat column-0-less unit (the whole function body), so the lone 'hidden' from the
      // `visibility` ternary chained straight into the 'readonly'/'editable' pair from the
      // `editability` ternary as ONE 3-member cluster. v5 correctly recognises these as two different
      // statements: `visibility`'s own unit carries only 'hidden' (1 distinct word, below the
      // 2-member cluster floor — filtered out, no allowlist entry needed for it at all) and
      // `editability`'s own unit is independently a 2-member {editable, readonly} unit, so the
      // crossing between them is now BLOCKED (exactly the R7/R8 guarantee working as intended on a
      // real, previously-over-merged occurrence). The member set below and the anchor were updated to
      // match this more precise decomposition — `normalizeFieldPolicy` itself (the function name,
      // 448 bytes away) no longer reaches the tightened window; `const editability` (44 bytes away,
      // the exact statement whose ternary this cluster IS) is both closer and more precise.
      file: 'packages/core-backend/src/services/PluginRbacProvisioningService.ts',
      members: ['editable', 'readonly'],
      nearSymbol: 'const editability',
      symbolWindow: 100,
      reason: "Same unrelated RoleFieldPolicy (plugin.ts) system: the `editability` ternary alone (its sibling `visibility` ternary contributes only a single 'hidden' occurrence, below the 2-member cluster floor).",
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
      // MECHANISM FIX v5: `approvalNodeEdit.ts` (C-6) is gone from this list — converting its field-
      // permission check to `NODE_FIELD_ACCESS_VALUES.includes(...)` removed its only literal cluster
      // entirely, so the file no longer carries ANY 2+-member co-occurrence for `scanTree` to find.
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
