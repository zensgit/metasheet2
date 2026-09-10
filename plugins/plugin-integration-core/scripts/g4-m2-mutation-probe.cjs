'use strict'

/**
 * G4/M2 MUTATION PROBE — the "remove the guard and watch a NAMED test go red" harness.
 *
 * Design: `docs/development/integration-g4-structural-enforcement-design-20260908.md` §4 asks every
 * guard this cut adds to come with evidence that deleting it turns a specific test red, and it asks
 * for that evidence to be produced by an `-r` PRELOAD hook with an IN-MEMORY edit — never by editing
 * the working copy. A probe that writes to `lib/` can be forgotten half-applied; this one cannot,
 * because it owns no files.
 *
 * USAGE (from the plugin directory)
 *   G4_M2_MUTATION=list node -r ./scripts/g4-m2-mutation-probe.cjs -e ""   # print the catalogue
 *   G4_M2_MUTATION=route-hard-dep node -r ./scripts/g4-m2-mutation-probe.cjs __tests__/x.test.cjs
 *   G4_M2_MUTATION=route-fallback:3 …                                # ONE call site, by ordinal
 *   G4_M2_MUTATION=route-hard-dep,route-fallback:all …               # JOINT mutation, comma-joined
 *
 * A mutation whose target text is not found the expected number of times ABORTS the process with
 * exit 2. A probe that silently no-ops is worse than no probe: it reports "the test still passed"
 * for a mutation that never happened, which is exactly the fake-green shape §4 rules out.
 *
 * TWO SEAMS ARE PATCHED, on purpose:
 *   1. `Module.prototype._compile` — so the RUNTIME behaviour of the mutated module changes.
 *   2. `fs.readFileSync` — so the STATIC guard (which reads the production source off disk) sees the
 *      same mutated text. Without this a structural test would report green against a mutation the
 *      runtime tests already felt, and the two halves of the M2 evidence would disagree.
 *
 * LINE ENDINGS. `lib/http-routes.cjs` is `eol=lf` in `.gitattributes`; `lib/pipeline-runner.cjs` is
 * not, so on a `core.autocrlf=true` Windows checkout it is CRLF on disk. Matching therefore happens
 * on an LF-normalised copy and the file's original EOL style is restored on the way out, so the
 * probe behaves identically on both checkouts.
 */

const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const PLUGIN_ROOT = path.resolve(__dirname, '..')
const HTTP_ROUTES = path.join(PLUGIN_ROOT, 'lib', 'http-routes.cjs')
const PIPELINE_RUNNER = path.join(PLUGIN_ROOT, 'lib', 'pipeline-runner.cjs')

/** The pre-M2 ternary, restored verbatim from the parent commit of the M2 change. */
function restoredRouteFallback(binding) {
  return `const ${binding} = typeof externalSystems.getExternalSystemForAdapter === 'function'\n`
    + '        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)\n'
    + '        : externalSystems.getExternalSystem.bind(externalSystems)'
}

/** Every `const loadSystem|loadSourceSystem = …ForAdapter.bind(…)` site, in file order. */
const ROUTE_BIND_SITE =
  /const (loadSystem|loadSourceSystem) = externalSystems\.getExternalSystemForAdapter\.bind\(externalSystems\)/g

/** The C6 target overload's kind guard — the line a restored existence check would hang off. */
const C6_KIND_GUARD = /&& ADAPTER_BACKED_C6_TARGET_KINDS\.has\(targetSystem\.kind\)/g

function replaceNth(text, pattern, replacer, ordinal, label) {
  const matches = [...text.matchAll(pattern)]
  if (matches.length === 0) throw new Error(`${label}: no occurrence of the target text`)
  const targets = ordinal === 'all' ? matches : [matches[ordinal - 1]]
  if (targets.some((match) => match === undefined)) {
    throw new Error(`${label}: ordinal ${ordinal} is out of range (found ${matches.length})`)
  }
  let out = ''
  let cursor = 0
  for (const match of targets) {
    out += text.slice(cursor, match.index) + replacer(match)
    cursor = match.index + match[0].length
  }
  return out + text.slice(cursor)
}

function replaceLiteral(text, from, to, expected, label) {
  const parts = text.split(from)
  const found = parts.length - 1
  if (found !== expected) {
    throw new Error(`${label}: expected ${expected} occurrence(s) of the target text, found ${found}`)
  }
  return parts.join(to)
}

const MUTATIONS = {
  'route-hard-dep': {
    file: HTTP_ROUTES,
    what: 'route registration stops REQUIRING getExternalSystemForAdapter',
    apply: (text) => replaceLiteral(
      text,
      "'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem'",
      "'getExternalSystem', 'deleteExternalSystem'",
      1,
      'route-hard-dep',
    ),
  },
  'runner-hard-dep': {
    file: PIPELINE_RUNNER,
    what: 'runner construction stops REQUIRING getExternalSystemForAdapter',
    apply: (text) => replaceLiteral(
      text,
      "['getExternalSystem', 'getExternalSystemForAdapter'])",
      "['getExternalSystem'])",
      1,
      'runner-hard-dep',
    ),
  },
  'runner-swap': {
    file: PIPELINE_RUNNER,
    what: 'runner loadExternalSystemForAdapter reads the credential-stripped accessor instead',
    apply: (text) => replaceLiteral(
      text,
      '    return externalSystemRegistry.getExternalSystemForAdapter(input)\n',
      '    return externalSystemRegistry.getExternalSystem(input)\n',
      1,
      'runner-swap',
    ),
  },
  'runner-fallback': {
    file: PIPELINE_RUNNER,
    what: 'runner loadExternalSystemForAdapter falls back to the public projection again',
    apply: (text) => replaceLiteral(
      text,
      '    return externalSystemRegistry.getExternalSystemForAdapter(input)\n',
      "    if (typeof externalSystemRegistry.getExternalSystemForAdapter === 'function') {\n"
        + '      return externalSystemRegistry.getExternalSystemForAdapter(input)\n'
        + '    }\n'
        + '    return externalSystemRegistry.getExternalSystem(input)\n',
      1,
      'runner-fallback',
    ),
  },
}

/** `route-fallback:<n|all>` — restore the pre-M2 ternary at one call site, or at all of them. */
function routeFallbackMutation(ordinal) {
  return {
    file: HTTP_ROUTES,
    what: `route adapter-load call site ${ordinal} falls back to the public projection again`,
    apply: (text) => replaceNth(
      text,
      ROUTE_BIND_SITE,
      (match) => restoredRouteFallback(match[1]),
      ordinal,
      `route-fallback:${ordinal}`,
    ),
  }
}

/**
 * `route-swap:<n|all>` — the OTHER shape of the same defect, and the one the runtime tests can see.
 *
 * A restored ternary is observationally IDENTICAL to the direct call whenever the registry actually
 * has the accessor, which every stub now does — so `route-fallback:*` can only ever be caught by the
 * structural guard, and reporting it as runtime evidence would be the fake-green §4 warns about.
 * Swapping a call site outright to the credential-stripped accessor is a single-point mutation with
 * an observable effect, so it is what shows the runtime tests are not decoration.
 */
function routeSwapMutation(ordinal) {
  return {
    file: HTTP_ROUTES,
    what: `route adapter-load call site ${ordinal} reads the credential-stripped accessor instead`,
    apply: (text) => replaceNth(
      text,
      ROUTE_BIND_SITE,
      (match) => `const ${match[1]} = externalSystems.getExternalSystem.bind(externalSystems)`,
      ordinal,
      `route-swap:${ordinal}`,
    ),
  }
}

/** `c6-swap:<1|2|all>` — the C6 target RELOAD reads the stripped accessor instead. */
function c6SwapMutation(ordinal) {
  return {
    file: HTTP_ROUTES,
    what: `C6 target overload ${ordinal} reloads through the credential-stripped accessor`,
    apply: (text) => replaceNth(
      text,
      /targetSystem = await externalSystems\.getExternalSystemForAdapter\(targetSystemScope\)/g,
      () => 'targetSystem = await externalSystems.getExternalSystem(targetSystemScope)',
      ordinal,
      `c6-swap:${ordinal}`,
    ),
  }
}

/** `c6-condition:<1|2|all>` — restore the method-existence condition on a C6 target overload. */
function c6ConditionMutation(ordinal) {
  return {
    file: HTTP_ROUTES,
    what: `C6 target overload ${ordinal} is conditional on the accessor existing again`,
    apply: (text) => replaceNth(
      text,
      C6_KIND_GUARD,
      (match) => `${match[0]}\n        && typeof externalSystems.getExternalSystemForAdapter === 'function'`,
      ordinal,
      `c6-condition:${ordinal}`,
    ),
  }
}

function resolveMutation(id) {
  if (Object.prototype.hasOwnProperty.call(MUTATIONS, id)) return MUTATIONS[id]
  const fallback = /^route-fallback:(\d+|all)$/.exec(id)
  if (fallback) return routeFallbackMutation(fallback[1] === 'all' ? 'all' : Number(fallback[1]))
  const swap = /^route-swap:(\d+|all)$/.exec(id)
  if (swap) return routeSwapMutation(swap[1] === 'all' ? 'all' : Number(swap[1]))
  const c6 = /^c6-condition:(\d+|all)$/.exec(id)
  if (c6) return c6ConditionMutation(c6[1] === 'all' ? 'all' : Number(c6[1]))
  const c6swap = /^c6-swap:(\d+|all)$/.exec(id)
  if (c6swap) return c6SwapMutation(c6swap[1] === 'all' ? 'all' : Number(c6swap[1]))
  return null
}

const CATALOGUE = Object.freeze([
  'route-hard-dep       — drop getExternalSystemForAdapter from the route requireService list',
  'runner-hard-dep      — drop it from the runner requireDependency list',
  'runner-fallback      — restore the runner public-projection fallback',
  'runner-swap          — make the runner read the credential-stripped accessor outright',
  'route-swap:N         — make route adapter-load site N (1..13) read the stripped accessor, or :all',
  'c6-swap:N            — make C6 target overload N reload through the stripped accessor, or :all',
  'route-fallback:N     — restore the pre-M2 ternary at route adapter-load site N (1..13), or :all',
  'c6-condition:N       — restore the accessor-existence condition on C6 overload N (1 dry-run, 2 apply), or :all',
])

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

const requested = String(process.env.G4_M2_MUTATION || '').trim()

if (requested === 'list') {
  for (const line of CATALOGUE) console.log(line)
} else if (requested.length > 0) {
  const ids = requested.split(',').map((value) => value.trim()).filter(Boolean)
  /** @type {Map<string, { text: string, eol: string }>} absolute path -> mutated LF source */
  const mutated = new Map()
  for (const id of ids) {
    const mutation = resolveMutation(id)
    if (!mutation) {
      console.error(`g4-m2-mutation-probe: unknown mutation ${JSON.stringify(id)}. Known:`)
      for (const line of CATALOGUE) console.error('  ' + line)
      process.exit(2)
    }
    let entry = mutated.get(mutation.file)
    if (!entry) {
      const raw = fs.readFileSync(mutation.file, 'utf8')
      entry = { text: raw.split('\r\n').join('\n'), eol: eolOf(raw) }
    }
    let after
    try {
      after = mutation.apply(entry.text)
    } catch (error) {
      console.error(`g4-m2-mutation-probe: ${id} FAILED TO APPLY: ${error.message}`)
      process.exit(2)
    }
    if (after === entry.text) {
      console.error(`g4-m2-mutation-probe: ${id} changed nothing — refusing to report a no-op run`)
      process.exit(2)
    }
    mutated.set(mutation.file, { text: after, eol: entry.eol })
    console.error(`g4-m2-mutation-probe: applied ${id} (${mutation.what})`)
  }

  const served = new Map()
  for (const [file, entry] of mutated) {
    served.set(file, entry.eol === '\n' ? entry.text : entry.text.split('\n').join(entry.eol))
  }

  const realReadFileSync = fs.readFileSync
  fs.readFileSync = function readFileSync(file, options) {
    if (typeof file === 'string') {
      const resolved = path.resolve(file)
      if (served.has(resolved)) {
        const encoding = typeof options === 'string' ? options : options && options.encoding
        const text = served.get(resolved)
        return encoding ? text : Buffer.from(text, 'utf8')
      }
    }
    return realReadFileSync.apply(this, arguments)
  }

  const realCompile = Module.prototype._compile
  Module.prototype._compile = function compile(content, filename) {
    const replacement = served.get(path.resolve(String(filename)))
    return realCompile.call(this, replacement === undefined ? content : replacement, filename)
  }
}

module.exports = { CATALOGUE, resolveMutation }
