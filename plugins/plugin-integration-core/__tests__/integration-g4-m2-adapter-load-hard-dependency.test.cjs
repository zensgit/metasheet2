'use strict'

/**
 * G4 / M2 — "NO CREDENTIAL-STRIPPED FALLBACK ON AN ADAPTER LOAD PATH".
 *
 * Design: `docs/development/integration-g4-structural-enforcement-design-20260908.md`
 *   * §2 I2 — the SQL public projection may not be adapter input, and NO adapter load point in this
 *     cut may degrade because `getExternalSystemForAdapter` is missing.
 *   * §3 M2  — route `requireService` and runner `requireDependency` gain the accessor as a HARD
 *     dependency; the 13 ternary fallbacks become direct calls; the 2 C6 target overloads lose their
 *     method-existence condition but keep the peek -> kind -> reload order.
 *   * §4 M2-a / M2-b — what each of these tests must be able to catch, and what it may not claim.
 *
 * WHY A SEPARATE SUITE, AND WHAT EACH HALF IS FOR
 * -----------------------------------------------
 * The failure this closes (#5538's shape, restated in the design's §1 table) is not "a guard was
 * wrong" — it is "a guard was OPTIONAL, so removing it broke nothing that anyone was watching". Two
 * independent things therefore have to be witnessed, and neither may be allowed to stand in for the
 * other:
 *
 *   M2-a  CONSTRUCTION.  A services object / deps object WITHOUT the decrypting accessor must be
 *         refused at mount time. Mutation: delete the name from the dependency list -> registration
 *         succeeds -> the refusal tests below go red. This says nothing about what any route does.
 *
 *   M2-b  CALL SITES.  Every adapter load must actually read the decrypting accessor. Two guards:
 *         a STRUCTURAL one (an allowlist of the exact expression forms the two production modules
 *         may use) and RUNTIME ones (the object handed to `createAdapter` is the one the decrypting
 *         accessor returned, not the public projection). The two catch DIFFERENT mutations, and
 *         saying so precisely is the whole point:
 *
 *           restore the ternary at one site  -> the STRUCTURAL test goes red; the runtime tests
 *                                               CANNOT see it (with the accessor present the ternary
 *                                               and the direct call behave identically).
 *           swap one site to the public one  -> that site's RUNTIME test goes red (and the
 *                                               structural test too, because the line changed).
 *
 *         WHAT THE STRUCTURAL GUARD IS AND IS NOT. It is line-oriented: it audits every physical
 *         source line that MENTIONS one of the accessor names, and every such line must be verbatim
 *         on the roster below. So any rewrite whose text still names an accessor — a ternary, a
 *         `||` coalesce, `?.`, a bracket read, a quoted name, a destructuring alias — is red at the
 *         line that names it. It is NOT an AST analysis: a call made through a binding created
 *         somewhere the name never appears literally (a computed string, a re-export from a third
 *         module) is outside its reach, and the `route-swap:*` runtime half is what covers that
 *         direction. The anti-fake-green control below pins the three rewrites an earlier version of
 *         this file could not see.
 *
 * The design also rules out a NON-discriminating report: once the hard dependency exists, "restore
 * the ternary AND use a stub that omits the accessor" fails registration in the original too, so it
 * proves nothing. Every mutation in `scripts/g4-m2-mutation-probe.cjs` is one that the ORIGINAL
 * passes and the mutant fails.
 *
 * ALIASING IS THE OTHER FAKE-GREEN. Every registry stub here returns two DIFFERENT objects from the
 * two accessors — the public one with the kind's private config subtree deleted and no credentials,
 * exactly as `external-systems.cjs publicRow()` builds it. A stub that aliases one function to the
 * other cannot tell a degraded call site from a correct one.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * PROBE TRAP — `G4_M2_MUTATION` without `-r ./scripts/g4-m2-mutation-probe.cjs` is a FAKE GREEN.
 *
 * The env var alone does nothing: the probe only patches `Module._compile` / `fs.readFileSync` when
 * it is PRELOADED. Running `G4_M2_MUTATION=route-fallback:3 node <this file>` therefore used to
 * print a clean 14/14 for a mutation that never happened — the exact shape the probe's own header
 * claims to rule out. The probe now plants `globalThis[Symbol.for('metasheet.g4.m2.mutation-probe')]`
 * at load; a request with no probe behind it dies here instead of reporting a pass.
 */
const MUTATION_PROBE_MARKER = Symbol.for('metasheet.g4.m2.mutation-probe')
const REQUESTED_MUTATION = String(process.env.G4_M2_MUTATION || '').trim()
if (REQUESTED_MUTATION.length > 0 && !globalThis[MUTATION_PROBE_MARKER]) {
  throw new Error(
    `G4_M2_MUTATION=${JSON.stringify(REQUESTED_MUTATION)} is set but scripts/g4-m2-mutation-probe.cjs `
      + 'was never preloaded, so NOTHING was mutated. A pass here would be evidence for a mutation '
      + 'that did not happen. Re-run as: '
      + 'G4_M2_MUTATION=<id> node -r ./scripts/g4-m2-mutation-probe.cjs <test file>',
  )
}

const httpRoutes = require('../lib/http-routes.cjs')
const { createPipelineRunner } = require('../lib/pipeline-runner.cjs')

const PLUGIN_ROOT = path.resolve(__dirname, '..')
const HTTP_ROUTES_FILE = path.join(PLUGIN_ROOT, 'lib', 'http-routes.cjs')
const PIPELINE_RUNNER_FILE = path.join(PLUGIN_ROOT, 'lib', 'pipeline-runner.cjs')

const TENANT_ID = 't_g4'
const WRITER = Object.freeze({ id: 'u_write', tenantId: TENANT_ID, permissions: ['integration:write'] })
const READER = Object.freeze({ id: 'u_read', tenantId: TENANT_ID, permissions: ['integration:read'] })

// ============================================================================================
// PART 1 — M2-b STRUCTURAL: the two production modules may only express these forms
// ============================================================================================

/**
 * Physical source lines, with WHOLE-LINE `//` comments dropped and nothing else dropped.
 *
 * Deliberately NOT a comment-stripping parser, and deliberately no longer a comment-line SKIPPER
 * either. An earlier version also dropped every line whose trimmed text started with `*` or `/*`,
 * which discarded the WHOLE line rather than the comment on it — so a line that OPENS with a closed
 * inline block comment and then carries a real statement (see the `inline block comment` case in the
 * anti-fake-green control below, which spells the sequence out in a string literal because a block
 * comment cannot contain one) was invisible to this guard. Now the only line that disappears is one
 * that is a comment from its first non-blank character to its end (`//`), which cannot hide an
 * expression. The cost is that a doc-comment line naming one of these accessors is audited like code
 * and has to be on the roster (see the `*_DOC_MENTIONS` blocks): re-wording prose next to a
 * credential accessor turns this suite red and has to be re-approved. That is the fail-closed
 * direction; a cleverer stripper — one that has to decide whether a `/*` inside a string or a regex
 * opens a comment — is the other one.
 *
 * `\r?\n` because `lib/pipeline-runner.cjs` is not `eol=lf` in `.gitattributes` and is CRLF on a
 * `core.autocrlf=true` Windows checkout.
 */
function codeLinesFrom(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line, index) => ({ number: index + 1, text: line.trim() }))
    .filter(({ text: line }) => line.length > 0)
    .filter(({ text: line }) => !line.startsWith('//'))
}

function codeLines(file) {
  return codeLinesFrom(fs.readFileSync(file, 'utf8'))
}

/**
 * Mentions the DECRYPTING accessor. `\b` on both ends so the match is on the IDENTIFIER, however it
 * is written: `.getExternalSystemForAdapter`, `'getExternalSystemForAdapter'`,
 * `registry["getExternalSystemForAdapter"]`, `const { getExternalSystemForAdapter: load } = …`.
 */
const DECRYPTING = /\bgetExternalSystemForAdapter\b/

/**
 * Mentions the CREDENTIAL-STRIPPED public accessor — again on the identifier, not on `.name` and
 * `'name'` only, which is what let a bracket read and a destructuring alias slip past.
 *
 * The trailing `\b` already excludes the four sibling accessors (`…ForAdapter`, `…AdapterConfig`,
 * `…ForSealedSnapshot`, `…InstanceDigest`): a suffix is a word character, so there is no boundary
 * to match. The negative lookahead is redundant with it ON PURPOSE — it states which siblings exist
 * and which roster they belong to, so removing a sibling accessor from the codebase does not quietly
 * widen this pattern. The quoted alternative is likewise redundant with `\b…\b`; it is kept so that
 * `registry["getExternalSystem"]` is visibly, not incidentally, in scope.
 */
const PUBLIC_PROJECTION = /\bgetExternalSystem\b(?!ForAdapter|AdapterConfig|ForSealedSnapshot|InstanceDigest)|["'`]getExternalSystem["'`]/

/**
 * The OTHER two credential-free reads of the registry, audited by the same roster.
 *
 * `listExternalSystems` returns public projections (`publicRow()` per row) and
 * `getExternalSystemAdapterConfig` returns `{ id, kind, config }` WITHOUT decrypting. Either result
 * has the shape `createAdapter` accepts, so either could be fed to an adapter build without any
 * line of it naming `getExternalSystem` — which is exactly why they belong on the reviewed
 * non-adapter roster rather than outside the guard's field of view.
 */
const OTHER_PUBLIC_READS = /\blistExternalSystems\b|\bgetExternalSystemAdapterConfig\b/

/** The roster a line belongs to: decrypting wins, so each line is audited exactly once. */
const PUBLIC_READ = Object.freeze({
  test: (text) => (PUBLIC_PROJECTION.test(text) || OTHER_PUBLIC_READS.test(text)) && !DECRYPTING.test(text),
})

/**
 * THE ONLY FORMS AN ADAPTER LOAD MAY TAKE in `lib/http-routes.cjs`.
 *
 * Anything else mentioning the decrypting accessor — a restored `typeof … === 'function' ? … : …`
 * ternary, a `… || externalSystems.getExternalSystem` coalesce, an `externalSystems?.
 * getExternalSystemForAdapter` optional call — matches none of these and is a red.
 */
const ROUTE_DECRYPTING_FORMS = Object.freeze([
  {
    // The HARD dependency itself. Written out in full so that removing the accessor from the list
    // (the M2-a mutation) also moves this structural guard — reported as such, never as the
    // designed witness for M2-a, which is the registration test in PART 2.
    exact: "const externalSystems = requireService('externalSystemRegistry', ['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems'])",
    count: 1,
    why: 'the registration-time hard dependency (§3 M2)',
  },
  {
    exact: 'const loadSystem = externalSystems.getExternalSystemForAdapter.bind(externalSystems)',
    count: 11,
    why: 'an unconditional adapter-load binding',
  },
  {
    exact: 'const loadSourceSystem = externalSystems.getExternalSystemForAdapter.bind(externalSystems)',
    count: 2,
    why: 'an unconditional C6 SOURCE adapter-load binding (dry-run + apply)',
  },
  {
    exact: 'targetSystem = await externalSystems.getExternalSystemForAdapter(targetSystemScope)',
    count: 2,
    why: 'the C6 target credential RELOAD, reached only through the kind check above it',
  },
])

/**
 * BLOCK-COMMENT lines of `lib/http-routes.cjs` that name the decrypting accessor.
 *
 * They are here because `codeLinesFrom` no longer skips a line for starting with `*`: skipping was
 * what let a statement hide behind an inline block comment. A doc line carries no expression, so the
 * `why` on each is the same one; what the entry buys is that re-wording prose that sits next to a
 * credential accessor is a deliberate, re-reviewed change rather than a silent one.
 */
const ROUTE_DECRYPTING_DOC_MENTIONS = Object.freeze([
  '* called BEFORE the first credential reload (`getExternalSystemForAdapter` decrypts), which is',
  '* the route, and it calls `getExternalSystemForAdapter`, which DECRYPTS the source system\'s',
  '* `getExternalSystemForAdapter` resolves the canonical/legacy Connection ITSELF, inside the load,',
].map((exact) => Object.freeze({ exact, count: 1, why: 'doc-comment prose; carries no expression' })))

/**
 * EVERY REMAINING PUBLIC-PROJECTION READ in `lib/http-routes.cjs`, each with the reason it is not an
 * adapter load. This is the half that makes the guard structural rather than a spot check: a new
 * public read cannot appear in this module without a reviewer adding it here and saying why the
 * object never reaches `createAdapter`.
 */
const ROUTE_PUBLIC_PROJECTION_FORMS = Object.freeze([
  {
    exact: 'const sourceSystem = await externalSystems.getExternalSystem(scopedInput(req, { id: pipeline.sourceSystemId }))',
    count: 1,
    why: 'B2a: the source system KIND for the registration key. Contracted to precede any credential reload; the fence tests assert the decrypting accessor was called zero times on a refusal.',
  },
  {
    exact: 'const targetSystem = await externalSystems.getExternalSystem(scopedInput(req, { id: pipeline.targetSystemId }))',
    count: 1,
    why: 'E3-01: the target KIND for the safe-lifecycle check. Identifying a kind must not itself reload secrets.',
  },
  {
    exact: ": (typeof externalSystems.getExternalSystem === 'function'",
    count: 1,
    why: 'peekTableActionSourceBinding second preference. A values-free, connection-free peek whose only consumer is the read-PRINCIPAL resolution; it builds no adapter and the field it reads (config.dataSourceOwnerId) survives the public projection.',
  },
  {
    exact: '? externalSystems.getExternalSystem.bind(externalSystems)',
    count: 1,
    why: 'the same peek, continued.',
  },
  {
    exact: 'return sendOk(res, await externalSystems.getExternalSystem(scopedInput(req, { id: requestParams(req).id })))',
    count: 1,
    why: 'the public GET route — the projection IS the response body.',
  },
  {
    exact: 'let targetSystem = await externalSystems.getExternalSystem(targetSystemScope)',
    count: 2,
    why: 'the C6 PEEK. Kept first on purpose (§3 M2): the kind is the cheapest fact, and only adapter-backed kinds are then re-loaded with credentials.',
  },
  {
    exact: 'getExternalSystem: (input) => externalSystems.getExternalSystem(input),',
    count: 2,
    why: 'handed to resolveC6WritePlanInputs for the K3 B4 same-INSTANCE comparison, which reads baseUrl/kind only. Credentials reach that planner through the already-reloaded targetSystem, not through this seam.',
  },
  {
    exact: 'const candidate = await externalSystems.getExternalSystem({ ...listScope, id: externalSystemId })',
    count: 1,
    why: 'source-binding admission check: kind + accessibility of a candidate row. Nothing downstream builds an adapter from it.',
  },
  {
    exact: 'function resolveC6WritePlanInputs({ targetSystem, pipeline, context, adapterRegistry, ownerPrincipal, readSourceConfigs, getExternalSystem, instanceDigestOf }) {',
    count: 1,
    why: 'the PARAMETER that receives the `getExternalSystem: (input) => …` seam rostered above (K3 B4 same-INSTANCE comparison: kind + baseUrl, no adapter). On the roster because the match is on the IDENTIFIER, not on `.name` / `\'name\'` — a binding created by destructuring is exactly the form that used to be invisible.',
  },
  {
    exact: "if (typeof externalSystems.getExternalSystemAdapterConfig !== 'function') return null",
    count: 1,
    why: 'b2aSourceSystemConfigLoader: the NON-DECRYPTING config read for the B2a object-scope fence. Returns `{ id, kind, config }` with no credentials and never reaches createAdapter; `null` is not a pass — resolveB2aSourceObjects refuses fail-closed. (This optional-accessor shape is the H-3 one the M2 review flagged as OUT OF SCOPE here; see the M2 implementation record §7.)',
  },
  {
    exact: 'return () => externalSystems.getExternalSystemAdapterConfig(scopedInput(req, { ...scope, id: systemId }))',
    count: 1,
    why: 'the same loader, continued.',
  },
  {
    exact: "const peek = typeof externalSystems.getExternalSystemAdapterConfig === 'function'",
    count: 1,
    why: 'peekTableActionSourceBinding FIRST preference — the non-decrypting config accessor. Same peek as the two public-projection lines below it, same consumer (read-PRINCIPAL resolution), builds no adapter.',
  },
  {
    exact: '? externalSystems.getExternalSystemAdapterConfig.bind(externalSystems)',
    count: 1,
    why: 'the same peek, continued.',
  },
  {
    exact: 'externalSystems.listExternalSystems({ ...listScope, limit: HUB_OVERVIEW_SYSTEM_LIMIT }),',
    count: 1,
    why: 'hub overview: a LIST of public projections (publicRow() per row) rendered as counts/labels. Listed here because a list of public rows is as feedable to createAdapter as a single one.',
  },
  {
    exact: 'return sendOk(res, await externalSystems.listExternalSystems(scopedInput(req, {',
    count: 1,
    why: 'the public LIST route — the projections ARE the response body.',
  },
  {
    exact: 'externalSystems.listExternalSystems({ ...listScope, limit: SOURCE_BINDING_CANDIDATE_LIMIT }),',
    count: 1,
    why: 'source-binding CANDIDATES: kind + accessibility filtering of rows the operator may bind. Nothing downstream builds an adapter from a candidate.',
  },
])

/** Block-comment lines of `lib/http-routes.cjs` that name a credential-free accessor. */
const ROUTE_PUBLIC_DOC_MENTIONS = Object.freeze([
  '* `getExternalSystemAdapterConfig` reads the row and returns its config WITHOUT touching the',
  '* `getExternalSystem` (no connection resolution at all), so it measured the hand-off to',
  '* (`getExternalSystemAdapterConfig`), and then drives BOTH halves — the connection resolution',
  '* Preference order is deliberate: `getExternalSystemAdapterConfig` is the accessor built for',
  '* config without decrypting. `getExternalSystem` is the fallback because its public projection',
  '* TWO FILTERS, and both matter. `listExternalSystems` is already tenant/workspace scoped, and',
].map((exact) => Object.freeze({ exact, count: 1, why: 'doc-comment prose; carries no expression' })))

const RUNNER_DECRYPTING_FORMS = Object.freeze([
  {
    exact: "const externalSystemRegistry = requireDependency(deps, 'externalSystemRegistry', ['getExternalSystem', 'getExternalSystemForAdapter'])",
    count: 1,
    why: 'the runner-side hard dependency (§3 M2: the route layer cannot reach this constructor)',
  },
  {
    exact: 'return externalSystemRegistry.getExternalSystemForAdapter(input)',
    count: 1,
    why: 'the sole body of loadExternalSystemForAdapter — source, target and replay all route through it',
  },
])

const RUNNER_PUBLIC_PROJECTION_FORMS = Object.freeze([
  {
    exact: 'const sourceSystem = await externalSystemRegistry.getExternalSystem({',
    count: 1,
    why: 'B2a: the source system KIND for the registration key, same contract as the route half — before any credential reload.',
  },
  {
    exact: "loadSourceSystemConfig: typeof externalSystemRegistry.getExternalSystemAdapterConfig === 'function'",
    count: 1,
    why: 'H-3: the NON-DECRYPTING config read the B2a object-scope resolver needs for a config-bound second read (`lookupProjection`). No credentials, no adapter. Its `: null` leg is the optional-guard shape the M2 review flagged as the SAME failure shape — out of M2 scope, recorded in the implementation record §7.',
  },
  {
    exact: 'const loaded = await externalSystemRegistry.getExternalSystemAdapterConfig({',
    count: 1,
    why: 'the same loader, continued.',
  },
])

/** Block-comment lines of `lib/pipeline-runner.cjs` that name a credential-free accessor. */
const RUNNER_PUBLIC_DOC_MENTIONS = Object.freeze([
  '* comes through `getExternalSystem` — the credential-STRIPPED accessor, which never decrypts — so',
].map((exact) => Object.freeze({ exact, count: 1, why: 'doc-comment prose; carries no expression' })))

/**
 * The audit itself, over already-parsed lines so that the SAME code can be run against an in-memory
 * rewrite (the anti-fake-green control below) and not only against a file on disk.
 *
 * `counts` is a property of the real modules, not of a snippet, so the control runs with it off; the
 * per-line allowlist — the half that decides whether a rewrite is VISIBLE at all — runs in both.
 */
function auditForms({ lines, source, label, mentions, forms, counts = true }) {
  const mentioned = lines.filter(({ text }) => mentions.test(text))
  const allowed = new Map(forms.map((form) => [form.exact, form]))
  const seen = new Map()

  for (const { number, text } of mentioned) {
    const form = allowed.get(text)
    assert.ok(
      form,
      `${label}: ${source}:${number} is not one of the allowed forms.\n`
        + `  line: ${text}\n`
        + '  If this is a NEW adapter load, use the existing unconditional form. If it is a new\n'
        + '  non-adapter read of the public projection, add it to the allowlist in this file WITH\n'
        + '  the reason it never reaches createAdapter. Restoring a fallback is neither.',
    )
    seen.set(text, (seen.get(text) || 0) + 1)
  }

  if (!counts) return
  for (const form of forms) {
    assert.equal(
      seen.get(form.exact) || 0,
      form.count,
      `${label}: expected ${form.count} occurrence(s) of "${form.exact}" (${form.why}); `
        + `found ${seen.get(form.exact) || 0}. A deliberate change updates this count.`,
    )
  }
}

function assertOnlyAllowedForms({ file, label, mentions, forms }) {
  auditForms({ lines: codeLines(file), source: path.basename(file), label, mentions, forms })
}

function assertOnlyAllowedFormsInText({ text, source, label, mentions, forms }) {
  auditForms({ lines: codeLinesFrom(text), source, label, mentions, forms, counts: false })
}

const ROUTE_DECRYPTING_ROSTER = Object.freeze([...ROUTE_DECRYPTING_FORMS, ...ROUTE_DECRYPTING_DOC_MENTIONS])
const ROUTE_PUBLIC_ROSTER = Object.freeze([...ROUTE_PUBLIC_PROJECTION_FORMS, ...ROUTE_PUBLIC_DOC_MENTIONS])
const RUNNER_PUBLIC_ROSTER = Object.freeze([...RUNNER_PUBLIC_PROJECTION_FORMS, ...RUNNER_PUBLIC_DOC_MENTIONS])

test('G4/M2-b structural: every getExternalSystemForAdapter expression in http-routes.cjs is an UNCONDITIONAL adapter load', () => {
  assertOnlyAllowedForms({
    file: HTTP_ROUTES_FILE,
    label: 'route decrypting-accessor forms',
    mentions: DECRYPTING,
    forms: ROUTE_DECRYPTING_ROSTER,
  })
})

test('G4/M2-b structural: every credential-free registry read in http-routes.cjs is on the reviewed non-adapter allowlist', () => {
  assertOnlyAllowedForms({
    file: HTTP_ROUTES_FILE,
    label: 'route public-projection forms',
    // A line that mentions BOTH (the requireService dependency list) is covered by the decrypting
    // allowlist above; excluding it here keeps each line under exactly one roster.
    mentions: PUBLIC_READ,
    forms: ROUTE_PUBLIC_ROSTER,
  })
})

test('G4/M2-b structural: pipeline-runner.cjs expresses one unconditional adapter load and its credential-free reads are rostered', () => {
  assertOnlyAllowedForms({
    file: PIPELINE_RUNNER_FILE,
    label: 'runner decrypting-accessor forms',
    mentions: DECRYPTING,
    forms: RUNNER_DECRYPTING_FORMS,
  })
  assertOnlyAllowedForms({
    file: PIPELINE_RUNNER_FILE,
    label: 'runner public-projection forms',
    mentions: PUBLIC_READ,
    forms: RUNNER_PUBLIC_ROSTER,
  })
})

/**
 * ANTI-FAKE-GREEN CONTROL for the structural half — the three rewrites an earlier version of this
 * file could NOT see, each restated as text and each required to be a red.
 *
 * All three keep every allowlisted line of `lib/http-routes.cjs` exactly as it is, so a guard that
 * only re-read the roster would report green. What makes them visible is the two fixes this control
 * pins: matching on the IDENTIFIER (`\b…\b`) instead of `.name` / `'name'`, and dropping only lines
 * that are `//` comments end to end instead of every line that starts with `*` or an inline block
 * comment. Delete either fix and the corresponding case below stops throwing.
 *
 * The `.catch(() => loadPublic(x))` line in case (a) is deliberately NOT the line that fails: a
 * call through an alias names nothing. The alias has to be MADE somewhere, and that is the line the
 * roster catches. A binding produced without ever spelling the name (a computed property key, a
 * re-export) is still outside this guard — the `route-swap:*` runtime half is what covers it, and
 * the verification record says so rather than claiming otherwise.
 */
const STRUCTURAL_ESCAPE_REWRITES = Object.freeze([
  {
    name: 'destructuring alias + appended .catch fallback',
    text: [
      'const loadSystem = externalSystems.getExternalSystemForAdapter.bind(externalSystems)',
      'const { getExternalSystem: loadPublic } = externalSystems',
      'const system = await loadSystem(scope).catch(() => loadPublic(scope))',
    ].join('\n'),
    roster: 'public',
    offending: 'const { getExternalSystem: loadPublic } = externalSystems',
  },
  {
    name: 'bracket read with a quoted accessor name',
    text: [
      'const loadSystem = externalSystems.getExternalSystemForAdapter.bind(externalSystems)',
      'const system = await externalSystems["getExternalSystem"](scope)',
    ].join('\n'),
    roster: 'public',
    offending: 'const system = await externalSystems["getExternalSystem"](scope)',
  },
  {
    name: 'inline block comment in front of the statement',
    // Assembled from pieces because a block comment cannot contain the sequence that ends one.
    text: `${'/*'} x ${'*/'} const loadSystem = externalSystems.getExternalSystem.bind(externalSystems)`,
    roster: 'public',
    offending: `${'/*'} x ${'*/'} const loadSystem = externalSystems.getExternalSystem.bind(externalSystems)`,
  },
])

test('G4/M2-b structural CONTROL: three rewrites that leave every allowlisted line intact are still red', () => {
  for (const rewrite of STRUCTURAL_ESCAPE_REWRITES) {
    const audit = () => assertOnlyAllowedFormsInText({
      text: rewrite.text,
      source: `rewrite<${rewrite.name}>`,
      label: 'control',
      mentions: rewrite.roster === 'public' ? PUBLIC_READ : DECRYPTING,
      forms: rewrite.roster === 'public' ? ROUTE_PUBLIC_ROSTER : ROUTE_DECRYPTING_ROSTER,
    })
    assert.throws(
      audit,
      (error) => {
        assert.match(error.message, /is not one of the allowed forms/)
        assert.ok(
          error.message.includes(rewrite.offending),
          `${rewrite.name}: the refusal must name the offending line, got:\n${error.message}`,
        )
        return true
      },
      `${rewrite.name}: this rewrite must NOT be expressible without a roster change`,
    )
  }
})

test('G4/M2-b structural CONTROL: the control harness passes text that IS on the roster', () => {
  // The other half of the control: `assertOnlyAllowedFormsInText` is not a function that throws at
  // everything. Two real allowlisted lines, verbatim, must go through.
  assertOnlyAllowedFormsInText({
    text: [
      'const loadSystem = externalSystems.getExternalSystemForAdapter.bind(externalSystems)',
      '// a whole-line comment naming getExternalSystem, which is dropped as a comment',
      'const candidate = await externalSystems.getExternalSystem({ ...listScope, id: externalSystemId })',
    ].join('\n'),
    source: 'rewrite<positive control>',
    label: 'control',
    mentions: PUBLIC_READ,
    forms: ROUTE_PUBLIC_ROSTER,
  })
})

// ============================================================================================
// Shared fixtures for PART 2 and PART 3
// ============================================================================================

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function invoke(routes, method, routePath, req) {
  const handler = routes.get(`${String(method).toUpperCase()} ${routePath}`)
  assert.ok(handler, `expected route ${method} ${routePath} to be registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  return res
}

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

const NOOP_CONFIG_STORE = Object.freeze({
  async saveVersion() { return {} },
  async list() { return [] },
  async get() { return {} },
  async approve() { return {} },
  async retire() { return {} },
  async listAudit() { return [] },
  async getForRuntime() { return {} },
})

/**
 * A stored row and its PUBLIC projection, built the way `external-systems.cjs` builds them.
 *
 * `credentials` is deleted and the kind's private config subtree is deleted — for
 * `data-source:sql-readonly` that is `lookupProjection` (PRIVATE_CONFIG_KEYS_BY_KIND). Both halves
 * matter: the credentials difference catches an HTTP-kind degradation, the config difference catches
 * a SQL-kind one, and a stub that returned the same object twice would catch neither.
 */
function publicProjectionOf(row) {
  const { credentials, ...rest } = row
  const config = { ...(row.config || {}) }
  delete config.lookupProjection
  return { ...rest, config }
}

/**
 * The registry every runtime case mounts: two DISTINCT accessors over one store, each recording its
 * own calls so a test can say WHICH accessor an adapter's object came from.
 */
function recordingRegistry(rows) {
  const systems = new Map(rows.map((row) => [row.id, row]))
  const calls = { public: [], decrypting: [] }
  return {
    calls,
    registry: {
      async upsertExternalSystem() { return {} },
      async deleteExternalSystem() { return {} },
      async listExternalSystems() { return [] },
      async getExternalSystem(input = {}) {
        calls.public.push(input.id)
        const row = systems.get(input.id)
        return row ? publicProjectionOf(row) : null
      },
      async getExternalSystemForAdapter(input = {}) {
        calls.decrypting.push(input.id)
        const row = systems.get(input.id)
        return row ? { ...row } : null
      },
    },
  }
}

const HTTP_SYSTEM = Object.freeze({
  id: 'sys_http',
  name: 'Vendor HTTP',
  kind: 'http',
  role: 'source',
  status: 'active',
  config: { baseUrl: 'https://vendor.example/api' },
  credentials: { token: 'REDACTED-IN-TEST' },
})

const SQL_SYSTEM = Object.freeze({
  id: 'sys_sql',
  name: 'Readonly PLM SQL',
  kind: 'data-source:sql-readonly',
  role: 'source',
  status: 'active',
  config: { dataSourceId: 'ds_plm', schema: 'dbo', lookupProjection: { table: 'dbo.parts' } },
  credentials: { password: 'REDACTED-IN-TEST' },
})

function mountRoutes({ registry, adapterRegistry, pipelineRegistry, storage, config }) {
  const routes = new Map()
  httpRoutes.registerIntegrationRoutes({
    context: {
      storage: storage || new Map(),
      config: config || {},
      api: {
        http: {
          addRoute(method, routePath, handler) {
            routes.set(`${String(method).toUpperCase()} ${routePath}`, handler)
          },
        },
        multitable: { provisioning: {}, records: {} },
      },
    },
    services: {
      externalSystemRegistry: registry,
      adapterRegistry,
      pipelineRegistry: pipelineRegistry
        || inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
      pipelineRunner: inertService(['runPipeline']),
      deadLetterStore: inertService(['listDeadLetters']),
      stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
      templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
      readSourceConfigStore: NOOP_CONFIG_STORE,
      readSourceCompositionConfigStore: NOOP_CONFIG_STORE,
      bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  return routes
}

// ============================================================================================
// PART 2 — M2-a CONSTRUCTION: the accessor is unrepresentably absent
// ============================================================================================

test('G4/M2-a route: registerIntegrationRoutes REFUSES a registry without getExternalSystemForAdapter', () => {
  const { registry } = recordingRegistry([HTTP_SYSTEM])
  delete registry.getExternalSystemForAdapter

  assert.throws(
    () => mountRoutes({ registry, adapterRegistry: { createAdapter() { return {} }, listAdapterKinds() { return [] } } }),
    /externalSystemRegistry\.getExternalSystemForAdapter is required/,
    'a services object that omits the decrypting accessor must not mount at all — the pre-M2 code '
      + 'mounted happily and downgraded every credential load to the public projection at request time',
  )
})

test('G4/M2-a route control: the SAME mount succeeds once the decrypting accessor is present', () => {
  const { registry } = recordingRegistry([HTTP_SYSTEM])
  const routes = mountRoutes({
    registry,
    adapterRegistry: { createAdapter() { return {} }, listAdapterKinds() { return [] } },
  })
  // Anti-fake-green for the refusal above: it must be THIS method that decided, not some unrelated
  // breakage in the harness.
  assert.ok(routes.size > 0, 'the identical harness mounts when the accessor is present')
})

function runnerDeps(registry) {
  return {
    pipelineRegistry: { async getPipeline() { return null } },
    externalSystemRegistry: registry,
    adapterRegistry: { createAdapter() { return {} } },
    deadLetterStore: { async createDeadLetter() { return {} } },
    watermarkStore: { async getWatermark() { return null }, async setWatermark() { return {} } },
    runLogger: { async startRun() { return { id: 'run_1' } }, async finishRun() { return {} } },
  }
}

test('G4/M2-a runner: createPipelineRunner REFUSES deps without getExternalSystemForAdapter', () => {
  const { registry } = recordingRegistry([HTTP_SYSTEM])
  delete registry.getExternalSystemForAdapter

  assert.throws(
    () => createPipelineRunner(runnerDeps(registry)),
    /createPipelineRunner: externalSystemRegistry\.getExternalSystemForAdapter is required/,
    'the runner has its OWN dependency check and index.cjs builds it directly, so the route layer’s '
      + 'hard dependency cannot cover this door',
  )
})

test('G4/M2-a runner control: the SAME deps construct once the decrypting accessor is present', () => {
  const { registry } = recordingRegistry([HTTP_SYSTEM])
  const runner = createPipelineRunner(runnerDeps(registry))
  assert.equal(typeof runner.runPipeline, 'function')
})

// ============================================================================================
// PART 3 — M2-b RUNTIME: the object an adapter is built from came from the DECRYPTING accessor
// ============================================================================================

test('G4/M2-b runtime (HTTP kind): externalSystemsTest builds its adapter from the DECRYPTING accessor', async () => {
  const { registry, calls } = recordingRegistry([HTTP_SYSTEM])
  const adapterInputs = []
  const routes = mountRoutes({
    registry,
    adapterRegistry: {
      listAdapterKinds() { return ['http'] },
      createAdapter(system) {
        adapterInputs.push(system)
        return { async testConnection() { return { ok: true } } }
      },
    },
  })

  const res = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITER,
    params: { id: HTTP_SYSTEM.id },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(adapterInputs.length, 1, 'exactly one adapter was built')
  assert.deepEqual(calls.decrypting, [HTTP_SYSTEM.id], 'the decrypting accessor was the one that loaded it')
  assert.deepEqual(calls.public, [], 'the credential-stripped projection was not read on this path at all')
  // The property, not the accessor name: a degraded call site hands over a row with no credentials.
  assert.deepEqual(
    adapterInputs[0].credentials,
    HTTP_SYSTEM.credentials,
    'the adapter received the CREDENTIAL-BEARING row; the public projection deletes this field',
  )
})

test('G4/M2-b runtime (SQL kind): externalSystemObjects builds its adapter from the DECRYPTING accessor', async () => {
  const { registry, calls } = recordingRegistry([SQL_SYSTEM])
  const adapterInputs = []
  const routes = mountRoutes({
    registry,
    adapterRegistry: {
      listAdapterKinds() { return ['data-source:sql-readonly'] },
      createAdapter(system) {
        adapterInputs.push(system)
        return { async listObjects() { return [] } }
      },
    },
  })

  const res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/objects', {
    user: READER,
    params: { id: SQL_SYSTEM.id },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(adapterInputs.length, 1)
  assert.deepEqual(calls.decrypting, [SQL_SYSTEM.id])
  assert.deepEqual(calls.public, [])
  // The SQL half is deliberately asserted on the PRIVATE CONFIG SUBTREE rather than on credentials:
  // `publicRow()` deletes `lookupProjection` for this kind, and an adapter built from the projection
  // would be silently reading a different plan — the #5534 shape.
  assert.deepEqual(
    adapterInputs[0].config.lookupProjection,
    SQL_SYSTEM.config.lookupProjection,
    'the adapter received the FULL config; the public projection deletes the private subtree',
  )
})

/**
 * The runner half. `runPipeline` resolves BOTH systems and builds BOTH adapters as its first act,
 * and dead-letter replay re-enters through it — so one dry run witnesses the source leg, the target
 * leg and (by construction) the accessor replay's kind check reads.
 */
test('G4/M2-b runtime (runner): the pipeline SOURCE and TARGET adapters are built from the DECRYPTING accessor', async () => {
  const target = {
    id: 'sys_target',
    name: 'Staging',
    kind: 'metasheet:staging',
    role: 'target',
    status: 'active',
    config: { sheetId: 'sheet_1' },
    credentials: { token: 'REDACTED-IN-TEST' },
  }
  const { registry, calls } = recordingRegistry([SQL_SYSTEM, target])
  const adapterInputs = []

  const runner = createPipelineRunner({
    pipelineRegistry: {
      async getPipeline() {
        return {
          id: 'pipe_g4',
          tenantId: TENANT_ID,
          workspaceId: null,
          sourceSystemId: SQL_SYSTEM.id,
          sourceObject: 'parts',
          targetSystemId: target.id,
          targetObject: 'parts',
          status: 'active',
          createdBy: 'u_owner',
          fieldMappings: [{ sourceField: 'code', targetField: 'code' }],
        }
      },
    },
    externalSystemRegistry: registry,
    adapterRegistry: {
      createAdapter(system) {
        adapterInputs.push(system)
        return {
          async read() { return { records: [{ code: 'MAT-1' }], done: true } },
          async upsert() { return { written: 1, failed: 0, results: [], errors: [] } },
          async previewUpsert() { return { records: [], metadata: {} } },
        }
      },
    },
    deadLetterStore: { async createDeadLetter() { return {} } },
    watermarkStore: { async getWatermark() { return null }, async setWatermark() { return {} } },
    runLogger: { async startRun() { return { id: 'run_1' } }, async finishRun() { return {} }, async failRun() { return {} } },
    logger: { info() {}, warn() {}, error() {} },
  })

  await runner.runPipeline({
    tenantId: TENANT_ID,
    workspaceId: null,
    pipelineId: 'pipe_g4',
    dryRun: true,
  })

  assert.deepEqual(
    calls.decrypting,
    [SQL_SYSTEM.id, target.id],
    'both legs were loaded through the decrypting accessor, source first',
  )
  assert.deepEqual(calls.public, [], 'a dormant runner reads the public projection on neither leg')
  const source = adapterInputs.find((system) => system.id === SQL_SYSTEM.id)
  const loadedTarget = adapterInputs.find((system) => system.id === target.id)
  assert.ok(source && loadedTarget, 'both adapters were built')
  assert.deepEqual(source.config.lookupProjection, SQL_SYSTEM.config.lookupProjection)
  assert.deepEqual(loadedTarget.credentials, target.credentials)
})

// ============================================================================================
// PART 4 — M2-b C6: the target overload keeps its KIND limit after losing its existence check
// ============================================================================================

const K3_TARGET_KIND = 'erp:k3-wise-webapi'
const NON_ADAPTER_BACKED_TARGET_KIND = 'metasheet:multitable'

function c6Harness(targetKind) {
  const source = { ...SQL_SYSTEM, id: 'sys_c6_source' }
  const target = {
    id: 'sys_c6_target',
    name: 'C6 target',
    kind: targetKind,
    role: 'target',
    status: 'active',
    config: { baseUrl: 'https://erp.example/k3', sheetId: 'sheet_1' },
    credentials: { acctId: 'REDACTED-IN-TEST' },
  }
  const { registry, calls } = recordingRegistry([source, target])
  const routes = mountRoutes({
    registry,
    adapterRegistry: {
      listAdapterKinds() { return [targetKind, SQL_SYSTEM.kind] },
      createAdapter() {
        return {
          async read() { return { records: [], done: true } },
          async previewUpsert() { return { records: [], metadata: {} } },
          async upsert() { return { written: 0, failed: 0, results: [], errors: [] } },
        }
      },
    },
    pipelineRegistry: {
      async upsertPipeline() { return {} },
      async listPipelines() { return [] },
      async listPipelineRuns() { return [] },
      async getPipeline() {
        return {
          id: 'pipe_c6',
          tenantId: TENANT_ID,
          workspaceId: null,
          sourceSystemId: source.id,
          sourceObject: 'parts',
          targetSystemId: target.id,
          targetObject: 'parts',
          status: 'active',
          createdBy: 'u_owner',
          fieldMappings: [{ sourceField: 'code', targetField: 'FNumber' }],
        }
      },
    },
  })
  return { routes, calls, source, target }
}

test('G4/M2-b C6 dry-run: an ADAPTER-BACKED target IS re-loaded through the decrypting accessor', async () => {
  const h = c6Harness(K3_TARGET_KIND)

  await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/dry-run', {
    user: READER,
    params: { id: 'pipe_c6' },
    body: {},
  })

  // Order is the contract, not an accident: peek the target (stripped) -> decide by kind -> reload.
  assert.deepEqual(
    h.calls.public,
    [h.target.id],
    'the target was PEEKED once through the credential-stripped accessor',
  )
  assert.deepEqual(
    h.calls.decrypting,
    [h.source.id, h.target.id],
    'the source always reloads; an adapter-backed target reloads too, and only after the kind check',
  )
})

test('G4/M2-b C6 dry-run: a NON-adapter-backed target is NEVER re-loaded through the decrypting accessor', async () => {
  const h = c6Harness(NON_ADAPTER_BACKED_TARGET_KIND)

  await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/dry-run', {
    user: READER,
    params: { id: 'pipe_c6' },
    body: {},
  })

  assert.deepEqual(h.calls.public, [h.target.id], 'the peek still happens')
  assert.deepEqual(
    h.calls.decrypting,
    [h.source.id],
    'M2 removed the METHOD-EXISTENCE condition only. The KIND limit is what stops a config-only '
      + 'target from being handed decrypted credentials, and it is still standing.',
  )
})

/**
 * The apply half, stated as it actually is rather than as a mirror of the dry-run.
 *
 * `ADAPTER_BACKED_C6_TARGET_KINDS` has exactly one member (`erp:k3-wise-webapi`), and on the APPLY
 * route the E4 layer-1 permanent fence refuses that kind BEFORE the source load and before the
 * target reload. So apply's adapter-backed reload branch is, today, unreachable — and this test
 * pins that fact instead of claiming a reload it cannot witness. If the fence is ever narrowed or a
 * second adapter-backed kind is added, this test is where the change has to be acknowledged.
 */
test('G4/M2-b C6 apply: the only adapter-backed kind is refused BEFORE any credential load', async () => {
  const h = c6Harness(K3_TARGET_KIND)

  const res = await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/apply', {
    user: WRITER,
    params: { id: 'pipe_c6' },
    body: { confirm: { dryRunToken: 'never-minted' } },
  })

  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
  assert.deepEqual(h.calls.public, [h.target.id], 'the credential-stripped peek is all that ran')
  assert.deepEqual(h.calls.decrypting, [], 'zero credential loads — neither source nor target')
})

test('G4/M2-b C6 apply: a NON-adapter-backed target loads the SOURCE with credentials and the target without', async () => {
  const h = c6Harness(NON_ADAPTER_BACKED_TARGET_KIND)

  await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/apply', {
    user: WRITER,
    params: { id: 'pipe_c6' },
    body: { confirm: { dryRunToken: 'never-minted' } },
  })

  assert.deepEqual(h.calls.public, [h.target.id])
  assert.deepEqual(
    h.calls.decrypting,
    [h.source.id],
    'the apply source load is unconditional after M2; the config-only target stays config-only',
  )
})
