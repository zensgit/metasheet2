'use strict'

/**
 * REACHABILITY GUARD — does a shipped capability have a production caller at all?
 *
 * THE DEFECT THIS EXISTS FOR, twice in one week:
 *
 *   #5101  shipped the customer-pack INSTALL ROUTES. They were reachable code, but the server-config
 *          key they gate on was never populated by the host, so the whole line was dormant. #5108
 *          had to go back and add the file-path env var that fills it.
 *   #5118  shipped the source->`ext_` FIELD MAPPER and gave `computeDryRun` an `extFieldMapping`
 *          parameter. Neither route-side wrapper passed it and `http-routes.cjs` did not contain the
 *          word, so `normalizeExtFieldMapping` — the mapper's entry point — had NO production caller
 *          on any path. The feature merged green: its own suite exercised it directly.
 *
 * Both are the same shape: the unit tests prove the capability WORKS, and nothing proves anything
 * REACHES it. A test suite is a caller, so "it has a caller" is trivially true and useless. This
 * guard asks the question the suites cannot: starting from a plugin lifecycle root (index.cjs) or
 * the HTTP route module, and never following a test file, is the capability named at all?
 *
 * ── WHAT IT ASSERTS ─────────────────────────────────────────────────────────────────────────────
 *
 * (A) ENTRY POINTS. For each declared `{ module, exportName }`:
 *       1. the module really exports that name (a rename cannot make the check vacuous);
 *       2. the module is in the require graph rooted at the production roots below — computed by
 *          following literal `require('./…')` specifiers, including lazy ones inside functions, and
 *          never entering `__tests__`;
 *       3. the name appears AS CODE in some OTHER file of that graph. Comments and string/template
 *          literals are stripped first, because `normalizeExtFieldMapping` appeared in two error
 *          MESSAGES on the day it had no caller — a plain grep would have reported it green.
 *
 * (B) SERVER-CONFIG KEYS. For each declared key: the host's `resolvePluginRuntimeConfig` actually
 *     PUTS it on the config object it returns, and some production file here reads it. That is the
 *     #5101 half — a plugin reading a key no host writes is a capability that cannot switch on.
 *
 * ── HONEST POSTURE ──────────────────────────────────────────────────────────────────────────────
 *
 * FALSE NEGATIVES (guard green, capability still unreachable). Three, and they are real:
 *
 *   1. NAMED IS NOT CALLED. A production file that destructures a symbol and never invokes it
 *      satisfies this guard. Proving invocation needs a call graph, which needs a parser; this is a
 *      scanner. It catches "nothing in production mentions this", which is the failure both #5101
 *      and #5118 actually had — not "this is mentioned but dead".
 *   2. THE DECLARED SET IS NOT DISCOVERED. A capability nobody adds below is not checked. An
 *      exhaustive module-level sweep was measured before choosing this: 30 of the 152 `lib/**.cjs`
 *      modules are unreachable from a production root TODAY, and most of them are deliberately so
 *      (the GIP inert-entry modules, the sealed-export pin verifier whose own header says "LATENT").
 *      An exhaustive guard would therefore ship with a 30-entry amnesty list whose reasons nobody
 *      could write honestly, and that list is exactly how a guard rots into decoration. Declaring
 *      the entry points is the smaller, truer claim.
 *   3. REACHABLE IS NOT ENABLED. (B) checks that the host CAN produce a key, not that any deployment
 *      sets the env var. A correctly wired, entirely dormant feature passes — as it should, since
 *      dormant-by-default is the intended posture for every one of these.
 *
 * FALSE POSITIVES (guard red though the capability is reachable):
 *
 *   1. INDIRECTION. A symbol reached through a computed property, a re-export under a different
 *      name, or a non-literal `require` is invisible here. The fix is a reviewable edit to the
 *      declaration below, which is the intended cost of an explicit list.
 *   2. THE STRIPPER IS A SCANNER, AND IT CAN FAIL IN BOTH DIRECTIONS. It is not a JS parser. An
 *      earlier draft of this file claimed its failures were always RED; that was measured and it is
 *      false. Deciding whether `/` opens a regex or divides needs the preceding TOKEN, and the first
 *      version compared the preceding CHARACTER, so `return /normalizeExtFieldMapping/.test(x)` was
 *      read as division and leaked the regex body as code — turning a correctly RED assertion GREEN.
 *      The scanner now tracks the last token (keywords included) and remembers whether a `)` closed
 *      an `if`/`while`/`for`/`with` head. Three residuals are known and are not fixable without a
 *      parser:
 *        - `}` is treated as a block end, so a regex may follow it. `({}) /x/ g` would be misread.
 *        - after a `)` that did NOT close a control head, `/` is taken as division, so a regex there
 *          leaks its body as code. That position is not valid JavaScript (`f() /x/ .y` does not
 *          parse), so the leak is unreachable rather than merely unlikely — but it is a leak.
 *        - anything else the token tracker gets wrong leaks a literal into the code text (GREEN, the
 *          dangerous direction) or swallows a real caller (RED).
 *      The tripwire below pins every position that has actually been reproduced, in both directions,
 *      so a regression in the scanner is a test failure rather than a silent loss of coverage.
 *
 * Plain node test (throws on failure). Hermetic: reads files, executes none of the plugin's routes.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PLUGIN_DIR = path.join(__dirname, '..')
const REPO_ROOT = path.join(PLUGIN_DIR, '..', '..')
const HOST_RUNTIME_CONFIG = path.join(REPO_ROOT, 'packages', 'core-backend', 'src', 'plugin-runtime-config.ts')

/**
 * The two ways host code enters this plugin: the lifecycle module the loader activates
 * (index.cjs — `activate` registers services, routes and the communication namespace) and the HTTP
 * route module it hands the context to. Nothing else is a production entry point, and a test file is
 * never one.
 */
const PRODUCTION_ROOTS = Object.freeze(['index.cjs', 'lib/http-routes.cjs'])

/**
 * Capability entry points that are MEANT to be reachable from a route or a lifecycle hook.
 *
 * `why` is not decoration: it is the sentence a reviewer needs in order to decide whether a future
 * red here means "wire it" or "delete the entry".
 */
const CAPABILITY_ENTRY_POINTS = Object.freeze([
  {
    module: 'lib/stock-preparation-ext-field-mapping.cjs',
    exportName: 'normalizeExtFieldMapping',
    why: 'the ONLY way to mint a mapping the expansion will accept; with no caller, no `ext_` value can ever be produced (#5118)',
  },
  {
    module: 'lib/stock-preparation-ext-field-mapping.cjs',
    exportName: 'applyExtFieldMapping',
    why: 'turns one source row into `ext_` values; called from the row-production boundary in bom-expansion',
  },
  {
    module: 'lib/stock-preparation-ext-field-mapping.cjs',
    exportName: 'extFieldMappingTargetIds',
    why: 'reconciles the runtime mapping against the action config`s durable extensionFieldIds',
  },
  {
    module: 'lib/stock-preparation-ext-field-mapping.cjs',
    exportName: 'summarizeExtFieldMappingForEvidence',
    why: 'the values-free projection that puts the mapping into dry-run/apply evidence',
  },
  {
    module: 'lib/stock-preparation-ext-field-mapping-config.cjs',
    exportName: 'createConfiguredExtFieldMapping',
    why: 'builds the server-held mapping at route registration; this is the producer the mapper lacked',
  },
  {
    module: 'lib/stock-preparation-customer-pack-catalog.cjs',
    exportName: 'createCustomerPackCatalog',
    why: 'the server-held pack allowlist every pack route gates on',
  },
  {
    module: 'lib/stock-preparation-customer-pack-catalog.cjs',
    exportName: 'resolveCustomerPackCatalogConfig',
    why: 'reads the pack map off server config; unreferenced, the catalog is always empty (the #5101 shape)',
  },
  {
    module: 'lib/stock-preparation-customer-pack-installer.cjs',
    exportName: 'installCustomerPack',
    why: 'the write half of the pack line; before #5101 it was reachable only from a test file',
  },
  {
    module: 'lib/stock-preparation-customer-pack-installer.cjs',
    exportName: 'planCustomerPackInstall',
    why: 'the zero-write dry run the install route offers first',
  },
  {
    module: 'lib/stock-preparation-customer-pack.cjs',
    exportName: 'normalizeCustomerPack',
    why: 'the single authority on what a legal pack is; every other pack path must route through it',
  },
  {
    module: 'lib/stock-preparation-pack-installed-fields.cjs',
    exportName: 'loadPackInstalledFieldProperties',
    why: 'turns the install ledger into the planner`s pack-aware bands; unreferenced, every refresh silently stays on the legacy bands',
  },
  {
    module: 'lib/stock-preparation-source-preflight.cjs',
    exportName: 'runStockPreparationSourcePreflight',
    why: 'the whole source preflight: measures the customer source`s reachability, data and TOPOLOGY. With no caller, a deployment configured for the wrong bridge goes on expanding zero rows and calling it success — the failure the module was written for',
  },
  // NOT declared here, deliberately: `assertSourcePreflightValuesFree`. This guard asks whether some
  // OTHER production file names a capability, and that self-check has exactly one production caller —
  // the preflight itself, in the same module, on every run before it returns. Declaring it would make
  // this guard red for a symbol that is anything but dead; its liveness is asserted where it can
  // actually be asserted (stock-preparation-source-preflight.test.cjs, S-12: the check refuses a
  // planted secret, an unclassified leaf and a code-field violation).
])

/**
 * Server-config keys a capability switches on. Each must be PRODUCED by the host resolver and READ
 * by production code here; a key with only one of the two halves is a dormant feature.
 */
const SERVER_CONFIG_KEYS = Object.freeze([
  {
    key: 'stockPreparationTableActions',
    why: 'the PLM refresh action config; without it every table-action route answers TABLE_ACTION_NOT_CONFIGURED',
  },
  {
    key: 'stockPreparationCustomerPacks',
    why: 'the pack allowlist. Populated by #5108 after #5101 shipped the routes with no way to fill it',
  },
  {
    key: 'stockPreparationExtFieldMapping',
    why: 'the source->`ext_` mapping. The key this guard was written alongside',
  },
  {
    key: 'c6TestFailureInjection',
    why: 'the C6 external-write failure-injection switch, deploy-gated at the host',
  },
])

// ── the production require graph ──────────────────────────────────────────────

function resolveRelativeRequire(fromFile, specifier) {
  const target = path.resolve(path.dirname(fromFile), specifier)
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target
  for (const extension of ['.cjs', '.js', '.json', '.mjs']) {
    if (fs.existsSync(target + extension)) return target + extension
  }
  const indexFile = path.join(target, 'index.cjs')
  if (fs.existsSync(indexFile)) return indexFile
  return null
}

/**
 * Files transitively required from the production roots. Literal relative specifiers only — a
 * `require(someVariable)` is invisible here, which is stated in the posture note above. Lazy
 * requires inside a function body ARE followed: they are still literal, and the ext-mapping module
 * uses one on purpose to break a load-time cycle.
 */
function productionGraph() {
  const seen = new Set()
  const stack = PRODUCTION_ROOTS.map((relative) => path.join(PLUGIN_DIR, relative))
  for (const root of stack) {
    assert.ok(fs.existsSync(root), `production root ${path.relative(PLUGIN_DIR, root)} must exist`)
  }
  while (stack.length > 0) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.(cjs|js|mjs)$/.test(file)) continue
    // Comments blanked, string literals KEPT: a commented-out `require('./x')` is not an edge, but a
    // require specifier is itself a literal, so `stripNonCode` here would blank every path and leave
    // the graph empty. Enforcing "comments are not code" on the naming check but not on the graph
    // would let a dead require keep a module in the production graph — reproduced with a
    // commented-out require plus a same-named local shadow.
    const text = stripComments(fs.readFileSync(file, 'utf8'))
    const requirePattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g
    let match = requirePattern.exec(text)
    while (match) {
      const resolved = resolveRelativeRequire(file, match[1])
      // A test file is never production, even if something in lib were to require one.
      if (resolved && !resolved.split(path.sep).includes('__tests__')) stack.push(resolved)
      match = requirePattern.exec(text)
    }
  }
  return seen
}

// ── the code/prose separator ──────────────────────────────────────────────────

// Punctuation after which a `/` opens a REGEX rather than dividing. `)` and `]` are deliberately
// absent — after them `/` is division — except for the `)` that closes a control head, which the
// scanner tracks separately. `}` is genuinely ambiguous (block end vs object literal); it is treated
// as a block end because that is what it is everywhere in this codebase.
const REGEX_PRECEDING_PUNCTUATION = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n',
])

// Keywords after which a `/` opens a regex. Without these, `return /x/` reads as division and the
// regex BODY leaks into the code text — the reproduced false-green this scanner was rewritten for.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else',
  'yield', 'await', 'throw',
])

// A `)` opens a regex only when it closed one of these heads: `if (x) /re/.test(y)`.
const CONTROL_HEAD_KEYWORDS = new Set(['if', 'while', 'for', 'with'])

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/

/**
 * Replace every comment, string literal, template literal and regex literal with a space, leaving
 * code positions intact enough to search for identifiers.
 *
 * This is the load-bearing half of the guard. On the day `normalizeExtFieldMapping` had no caller it
 * still appeared in `stock-preparation-table-actions.cjs` and `stock-preparation-bom-expansion.cjs`
 * — inside error MESSAGES telling a developer which function to call. A substring search over the
 * raw files would have reported the capability green while it was entirely unreachable.
 */
function scan(text, keep) {
  let out = ''
  let index = 0
  // The last CODE token: a whole identifier/keyword/number, or one punctuation character. Comparing
  // the last CHARACTER instead is what let `return /x/` be read as division and leak its body.
  let lastToken = '\n'
  // Whether the `)` just closed an `if`/`while`/`for`/`with` head, tracked per paren depth.
  const parenIsControlHead = []
  let closedControlHead = false

  const emitCode = (chunk) => { if (keep !== 'literals') out += chunk }
  // `kind` is 'comment' | 'string' | 'regex'.
  //   'code'        — blanks all three. Used for the naming check: prose is not a call site.
  //   'literals'    — keeps only string/template CONTENTS. Used for the config-key read check.
  //   'uncommented' — keeps code AND string literals verbatim, blanking comments and regexes. Used
  //                   for the require scan, because a require specifier IS a string literal: mode
  //                   'code' would blank every path and leave the graph empty.
  const emitOther = (raw, kind, content) => {
    if (keep === 'code') out += ' '
    else if (keep === 'literals') out += kind === 'string' ? `${content}\n` : ''
    else out += kind === 'string' ? raw : ' '
  }

  const regexMayFollow = () => {
    if (lastToken === ')') return closedControlHead
    if (lastToken === ']') return false
    if (IDENTIFIER_CHAR.test(lastToken[0] || '')) return REGEX_PRECEDING_KEYWORDS.has(lastToken)
    return REGEX_PRECEDING_PUNCTUATION.has(lastToken)
  }

  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]

    if (char === '/' && next === '/') {
      const start = index
      while (index < text.length && text[index] !== '\n') index += 1
      emitOther(text.slice(start, index), 'comment', '')
      continue
    }
    if (char === '/' && next === '*') {
      const start = index
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index = Math.min(index + 2, text.length)
      emitOther(text.slice(start, index), 'comment', '')
      continue
    }
    if (char === '/' && regexMayFollow()) {
      const start = index
      index += 1
      let inClass = false
      while (index < text.length) {
        const inner = text[index]
        if (inner === '\\') { index += 2; continue }
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        else if (inner === '/' && !inClass) { index += 1; break }
        else if (inner === '\n') break
        index += 1
      }
      emitOther(text.slice(start, index), 'regex', '')
      lastToken = '/'
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      const start = index
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue }
        if (text[index] === quote) { index += 1; break }
        index += 1
      }
      // Only the CONTENTS are data; the quotes are punctuation.
      emitOther(text.slice(start, index), 'string', text.slice(start + 1, Math.max(start + 1, index - 1)))
      lastToken = quote
      continue
    }

    if (IDENTIFIER_CHAR.test(char)) {
      const start = index
      while (index < text.length && IDENTIFIER_CHAR.test(text[index])) index += 1
      const word = text.slice(start, index)
      emitCode(word)
      lastToken = word
      continue
    }

    if (char === '(') {
      parenIsControlHead.push(CONTROL_HEAD_KEYWORDS.has(lastToken))
    } else if (char === ')') {
      closedControlHead = parenIsControlHead.pop() === true
    }
    emitCode(char)
    if (!/\s/.test(char) || char === '\n') lastToken = char
    index += 1
  }
  return out
}

/** Code only: comments, string/template literals and regex literals become blanks. */
function stripNonCode(text) {
  return scan(text, 'code')
}

/** Code plus string literals, with comments and regex literals blanked. */
function stripComments(text) {
  return scan(text, 'uncommented')
}

/**
 * The complement, minus comments: the CONTENTS of string and template literals only.
 *
 * Layer B needs this. A config key legitimately lives in a literal
 * (`const KEY = 'stockPreparationCustomerPacks'`), and requiring the literal is the only way to pin
 * that the plugin reads the key the HOST writes rather than merely having a variable of that name.
 */
function literalText(text) {
  return scan(text, 'literals')
}

function relative(file) {
  return path.relative(PLUGIN_DIR, file).split(path.sep).join('/')
}

// ── (A) capability entry points ───────────────────────────────────────────────

function everyCapabilityEntryPointHasAProductionCaller() {
  const graph = productionGraph()
  const codeByFile = new Map()
  for (const file of graph) {
    if (!/\.(cjs|js|mjs)$/.test(file)) continue
    codeByFile.set(file, stripNonCode(fs.readFileSync(file, 'utf8')))
  }

  const seenDeclarations = new Set()
  for (const entry of CAPABILITY_ENTRY_POINTS) {
    const label = `${entry.module}#${entry.exportName}`
    assert.equal(seenDeclarations.has(label), false, `${label} is declared twice`)
    seenDeclarations.add(label)
    assert.ok(typeof entry.why === 'string' && entry.why.trim().length > 0, `${label} must carry a reason`)

    const moduleFile = path.join(PLUGIN_DIR, entry.module)
    assert.ok(fs.existsSync(moduleFile), `${label}: declared module does not exist (stale entry)`)

    // 1. the export really exists — a rename must not turn this check into a no-op.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const exported = require(moduleFile)
    assert.ok(
      Object.prototype.hasOwnProperty.call(exported, entry.exportName),
      `${label}: the module does not export that name (stale entry, or the export was renamed)`,
    )

    // 2. the module is transitively required from a production root.
    assert.ok(
      graph.has(moduleFile),
      `${label}: the module is not required from any production root (${PRODUCTION_ROOTS.join(', ')}). ` +
      'It is reachable only from tests. ' + entry.why,
    )

    // 3. some OTHER production file names it, as code.
    const token = new RegExp(`\\b${entry.exportName}\\b`)
    const callers = []
    for (const [file, code] of codeByFile) {
      if (file === moduleFile) continue
      if (token.test(code)) callers.push(relative(file))
    }
    assert.ok(
      callers.length > 0,
      `${label}: no production file names this capability (comments and string literals do not count). ` +
      'It is built but unreachable. ' + entry.why,
    )
  }
}

// ── (B) server-config keys ────────────────────────────────────────────────────

/**
 * The object literal `resolvePluginRuntimeConfig` returns, extracted by brace matching.
 *
 * Read from the STRIPPED text, so a commented-out spread does not count as producing the key.
 * Reproduced: deleting the host spread and leaving `// TODO(#5199): re-enable
 * stockPreparationExtFieldMapping` passed the un-stripped version — which is precisely the #5101
 * shape Layer B exists to catch. Stripping also removes any `{`/`}` inside a literal or comment, so
 * the brace matching below cannot be thrown off by one.
 */
function hostReturnedConfigObject() {
  const text = stripNonCode(fs.readFileSync(HOST_RUNTIME_CONFIG, 'utf8'))
  const functionStart = text.indexOf('export function resolvePluginRuntimeConfig')
  assert.notEqual(functionStart, -1, 'the host resolver must still be named resolvePluginRuntimeConfig')
  const returnStart = text.indexOf('\n  return {', functionStart)
  assert.notEqual(returnStart, -1, 'the host resolver must end in a returned config object literal')
  const open = text.indexOf('{', returnStart)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, index + 1)
    }
  }
  throw new Error('could not brace-match the host resolver`s returned object')
}

/**
 * A production file READS a config key only if it names the key as data — as a string literal
 * (`const KEY = 'stockPreparationCustomerPacks'`) or as a property access (`config.tableActions`).
 *
 * A BARE IDENTIFIER does not count, and that exclusion is the whole point. The first version of this
 * check searched raw text, and the wiring it was shipped alongside introduced
 * `const stockPreparationExtFieldMapping = …` in http-routes.cjs — a local with the same name as the
 * key. That local was the only "consumer" hit, so mistyping the key constant in
 * stock-preparation-ext-field-mapping-config.cjs left the capability permanently dormant (verified:
 * `createConfiguredExtFieldMapping` returns null for a valid config) while this guard stayed green.
 * A guard whose own subject can punch a hole in it is worse than no guard.
 */
function configKeyIsReadAsData(key, literals, code) {
  const token = new RegExp(`\\b${key}\\b`)
  if (token.test(literals)) return 'string literal'
  if (new RegExp(`\\.\\s*${key}\\b`).test(code)) return 'property access'
  return null
}

function everyServerConfigKeyIsBothProducedAndConsumed() {
  const graph = productionGraph()
  const returned = hostReturnedConfigObject()
  const literalsByFile = new Map()
  const codeByFile = new Map()
  for (const file of graph) {
    if (!/\.(cjs|js|mjs)$/.test(file)) continue
    const raw = fs.readFileSync(file, 'utf8')
    literalsByFile.set(file, literalText(raw))
    codeByFile.set(file, stripNonCode(raw))
  }

  const seen = new Set()
  for (const entry of SERVER_CONFIG_KEYS) {
    assert.equal(seen.has(entry.key), false, `${entry.key} is declared twice`)
    seen.add(entry.key)
    assert.ok(typeof entry.why === 'string' && entry.why.trim().length > 0, `${entry.key} must carry a reason`)

    const token = new RegExp(`\\b${entry.key}\\b`)
    assert.ok(
      token.test(returned),
      `${entry.key}: the host resolver never puts this key on the config it returns, so no deployment ` +
      'can switch the capability on. ' + entry.why,
    )

    const consumers = []
    for (const [file, literals] of literalsByFile) {
      const how = configKeyIsReadAsData(entry.key, literals, codeByFile.get(file))
      if (how) consumers.push(`${relative(file)} (${how})`)
    }
    assert.ok(
      consumers.length > 0,
      `${entry.key}: no production file names this key as DATA — a string literal or a property ` +
      'access. A local variable that happens to share the name is not a read, so the key the host ' +
      'writes and the key the plugin looks up have drifted apart. ' + entry.why,
    )
  }
}

// ── the guard's own tripwire ──────────────────────────────────────────────────

/**
 * A guard whose detector does not detect is worse than none, so the detector is exercised on
 * synthetic inputs rather than trusted. These pin the exact discrimination the whole file rests on:
 * a name in prose or in an error message is NOT a caller.
 */
function theDetectorActuallyDiscriminates() {
  const stripped = stripNonCode([
    "// normalizeExtFieldMapping is mentioned in a comment",
    "const message = 'call normalizeExtFieldMapping first'",
    'const template = `see normalizeExtFieldMapping`',
    '/* normalizeExtFieldMapping in a block comment */',
    'const pattern = /normalizeExtFieldMapping/',
    'const real = applyExtFieldMapping(mapping, row)',
  ].join('\n'))
  assert.equal(/\bnormalizeExtFieldMapping\b/.test(stripped), false, 'prose and literals must not count as callers')
  assert.equal(/\bapplyExtFieldMapping\b/.test(stripped), true, 'real code must survive stripping')

  // EVERY REGEX POSITION THAT WAS REPRODUCED LEAKING. The first scanner compared the preceding
  // CHARACTER, so only `= /re/` was recognised; `return /re/`, `if (x) /re/` and `foo() /re/` were
  // read as division and leaked the regex BODY into the code text — a false GREEN, the dangerous
  // direction, and the direct refutation of an earlier claim in this file's header that the
  // scanner could only fail RED. Each of these is a regression pin, not an illustration.
  for (const probe of [
    'const p = /normalizeExtFieldMapping/',
    'return /normalizeExtFieldMapping/.test(x)',
    'if (x) /normalizeExtFieldMapping/.test(x)',
    'const v = typeof x === "string" ? /normalizeExtFieldMapping/ : null',
    'throw /normalizeExtFieldMapping/',
    'const arr = [/normalizeExtFieldMapping/]',
  ]) {
    assert.equal(
      /\bnormalizeExtFieldMapping\b/.test(stripNonCode(probe)),
      false,
      `a regex literal must not leak its body as code: ${probe}`,
    )
  }

  // A quote inside a regex literal must not desync the scanner and swallow the code after it.
  const tricky = stripNonCode("const q = /['\"]/\nconst real = applyExtFieldMapping(row)\n")
  assert.equal(/\bapplyExtFieldMapping\b/.test(tricky), true, 'a regex literal containing a quote must not desync the scanner')

  // Division is not a regex: the scanner must not eat the rest of the line. `)` and `]` are the
  // positions where `/` divides, and getting them wrong swallows a real caller (a false RED).
  for (const probe of [
    'const ratio = total / count\nconst real = applyExtFieldMapping(row)\n',
    'const ratio = f(a) / count\nconst real = applyExtFieldMapping(row)\n',
    'const ratio = xs[0] / count\nconst real = applyExtFieldMapping(row)\n',
  ]) {
    assert.equal(/\bapplyExtFieldMapping\b/.test(stripNonCode(probe)), true, `division must not be lexed as a regex: ${probe}`)
  }

  // THE COMPLEMENT. `literalText` keeps string/template CONTENTS and drops comments and code, so a
  // config key mentioned only in a comment or held only in a same-named local is not a "read".
  const literals = literalText([
    "const KEY = 'stockPreparationCustomerPacks'",
    '// TODO(#5199): re-enable stockPreparationExtFieldMapping',
    'const stockPreparationTableActions = build()',
  ].join('\n'))
  assert.equal(/\bstockPreparationCustomerPacks\b/.test(literals), true, 'a string literal is a read')
  assert.equal(/\bstockPreparationExtFieldMapping\b/.test(literals), false, 'a comment is not a read')
  assert.equal(/\bstockPreparationTableActions\b/.test(literals), false, 'a same-named local is not a read')
  // …and the property-access half, which is how the table-action keys are actually consumed.
  assert.equal(
    configKeyIsReadAsData('tableActions', literalText('context.config.tableActions'), stripNonCode('context.config.tableActions')),
    'property access',
  )
  assert.equal(
    configKeyIsReadAsData('tableActions', literalText('const tableActions = x'), stripNonCode('const tableActions = x')),
    null,
    'a bare local of the same name is not a read',
  )

  // A commented-out require is not a production edge — asserted against the mode the graph walker
  // actually uses, which must keep the specifier literal while dropping the comment.
  const specifier = /require\(\s*['"](\.[^'"]+)['"]\s*\)/
  assert.equal(
    specifier.test(stripComments("// const x = require('./ghost.cjs')")),
    false,
    'a commented-out require must not become a graph edge',
  )
  assert.equal(
    specifier.test(stripComments("const x = require('./real.cjs')")),
    true,
    'a live require must survive — stripping the specifier literal would empty the whole graph',
  )

  // And the graph really is rooted: a module no root requires is absent from it.
  const graph = productionGraph()
  assert.ok(graph.has(path.join(PLUGIN_DIR, 'lib', 'http-routes.cjs')))
  assert.equal(
    graph.has(path.join(PLUGIN_DIR, '__tests__', 'plugin-capability-reachability.test.cjs')),
    false,
    'the graph never contains a test file',
  )
}

function main() {
  theDetectorActuallyDiscriminates()
  everyCapabilityEntryPointHasAProductionCaller()
  everyServerConfigKeyIsBothProducedAndConsumed()
}

main()
console.log('plugin-capability-reachability.test.cjs OK')
