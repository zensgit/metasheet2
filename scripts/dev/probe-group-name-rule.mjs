#!/usr/bin/env node
/**
 * probe-group-name-rule.mjs — evaluate the approval-form-group NAME RULE with NO DATABASE.
 *
 * WHY THIS EXISTS. The owner's 2026-09-20 erratum-3 ruling (「暂缓定案:支持两层规则,但先提交准确
 * 字符规则及上述反例测试」) came out of an own-machine probe that RE-TYPED the rule as the design
 * documents spelled it — `[\p{L}\p{N}\p{P}\p{S}]` — and measured `true` for U+3164 / U+115F /
 * U+2800: 「字符属于这些类别,不等于可见」. The prose was the thing that was wrong, and a re-typed
 * predicate can always disagree with the shipped one. So this probe does NOT re-type anything: it
 * imports `packages/core-backend/src/services/approval-template-group-name-rule.ts` — the module
 * the HTTP route actually calls — and prints what that module returns. It opens no socket, reads
 * no `DATABASE_URL`, and touches no database.
 *
 * USAGE
 *   node scripts/dev/probe-group-name-rule.mjs U+3164 U+115F U+2800 请假 '⠀'
 *
 *   Each argument is either a CODE POINT (`U+3164`, `u+3164`, `0x3164`) or a literal STRING.
 *   Force the reading with `--cp <hex>` / `--str <text>` when a literal string looks like a code
 *   point. `--json` prints machine-readable rows instead of the table. `--help` prints this usage.
 *
 * OUTPUT, per code point: cp · category · defaultIgnorable · visible · verdict, where
 *   - `category`     is the Unicode General_Category, measured here by probing `\p{General_Category=…}`
 *                    (diagnostic only — the rule itself never reads a category NAME);
 *   - `defaultIgnorable` is MEASURED via `\p{Default_Ignorable_Code_Point}` by the rule module, not
 *                    asserted from a list in a document;
 *   - `visible`      is the rule module's own `isVisibleCodePoint` — the predicate
 *                    `cp ∈ [L N P S] ∧ cp ∉ DI ∧ cp ∉ BLANK_GLYPH_SET ∧ cp ∉ White_Space`;
 *   - `verdict`      is the STAGE that decides a name made of exactly that code point, because
 *                    `visible=false` alone does not say WHICH half of the two-layer rule rejected
 *                    it: `trimmed-to-empty` (the edge trim emptied the name — true for U+2800,
 *                    U+3164, U+115F and the rest of the trim set) vs `no-visible-character` (the
 *                    visible-character rule rejected it) vs `length` vs `accepted`.
 *
 * For a STRING argument the same rows are printed for each of its code points, followed by the
 * verdict for the whole submitted string (the value the HTTP route would classify), including the
 * trimmed result and the HTTP status/error code the route would return.
 */

import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RULE_PATH = path.resolve(HERE, '../../packages/core-backend/src/services/approval-template-group-name-rule.ts')

/**
 * `interop` exists because `packages/core-backend` is a CommonJS package: `tsx` transpiles the
 * rule module to CJS, so the namespace this probe receives carries the real exports on `.default`
 * rather than as named bindings. Reading `.default` only when the named binding is absent keeps
 * the probe working under BOTH loaders (native type stripping gives real named exports).
 */
function interop(namespace) {
  return typeof namespace.isVisibleCodePoint === 'function' ? namespace : namespace.default
}

async function loadRule() {
  const parentURL = import.meta.url
  // Preferred: this repository's own `tsx` devDependency, which works on every Node version CI uses.
  // `tsImport` (not `register()`) because the rule module is loaded from a CommonJS package and the
  // global ESM hook hits Node's require(esm)-in-a-cycle guard.
  let tsxError
  try {
    const { tsImport } = await import('tsx/esm/api')
    const rule = interop(await tsImport(RULE_PATH, parentURL))
    if (rule && typeof rule.isVisibleCodePoint === 'function') return rule
    tsxError = new Error('tsx loaded the module but it exported no isVisibleCodePoint')
  } catch (error) {
    tsxError = error
  }
  // Fallback: Node >= 22.18 strips types natively. The rule module is erasable-syntax-only.
  try {
    const rule = interop(await import(pathToFileURL(RULE_PATH).href))
    if (rule && typeof rule.isVisibleCodePoint === 'function') return rule
    throw new Error('native import produced no isVisibleCodePoint export')
  } catch (nativeError) {
    console.error('Could not load the name-rule module from', RULE_PATH)
    console.error('  via tsx   :', tsxError && tsxError.message)
    console.error('  via node  :', nativeError && nativeError.message)
    console.error('Run `pnpm install` at the repository root, or use Node >= 22.18.')
    process.exit(2)
  }
}

const GENERAL_CATEGORIES = [
  'Lu', 'Ll', 'Lt', 'Lm', 'Lo',
  'Mn', 'Mc', 'Me',
  'Nd', 'Nl', 'No',
  'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po',
  'Sm', 'Sc', 'Sk', 'So',
  'Zs', 'Zl', 'Zp',
  'Cc', 'Cf', 'Cs', 'Co', 'Cn',
]

const CATEGORY_PATTERNS = GENERAL_CATEGORIES.map((name) => [name, new RegExp(`\\p{General_Category=${name}}`, 'u')])

function generalCategory(codePoint) {
  const character = String.fromCodePoint(codePoint)
  for (const [name, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(character)) return name
  }
  return '??'
}

const CODE_POINT_ARG = /^(?:[Uu]\+|0[xX])([0-9A-Fa-f]{1,6})$/

function parseArgs(argv) {
  const inputs = []
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') { json = true; continue }
    if (arg === '--cp') {
      const next = argv[i += 1]
      const hex = next && (CODE_POINT_ARG.exec(next)?.[1] ?? (/^[0-9A-Fa-f]{1,6}$/.test(next) ? next : null))
      if (!hex) { console.error(`--cp needs a hex code point, got: ${next}`); process.exit(2) }
      inputs.push({ kind: 'cp', codePoint: Number.parseInt(hex, 16), source: next })
      continue
    }
    if (arg === '--str') {
      const next = argv[i += 1]
      if (next === undefined) { console.error('--str needs a value'); process.exit(2) }
      inputs.push({ kind: 'str', value: next, source: next })
      continue
    }
    const asCodePoint = CODE_POINT_ARG.exec(arg)
    if (asCodePoint) {
      inputs.push({ kind: 'cp', codePoint: Number.parseInt(asCodePoint[1], 16), source: arg })
      continue
    }
    inputs.push({ kind: 'str', value: arg, source: arg })
  }
  return { inputs, json }
}

function label(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

function row(rule, codePoint) {
  const report = rule.describeCodePoint(codePoint)
  const verdict = rule.classifyGroupName(String.fromCodePoint(codePoint))
  return {
    cp: label(codePoint),
    category: generalCategory(codePoint),
    defaultIgnorable: report.defaultIgnorable,
    visible: report.visible,
    verdict: verdict.stage,
    // Extra columns, printed in the table because the four above cannot explain each other:
    visibleCategory: report.visibleCategory,
    blankGlyphListed: report.blankGlyphListed,
    whiteSpace: report.whiteSpace,
    edgeTrimmed: report.edgeTrimmed,
    code: verdict.ok ? '201' : `400 ${verdict.code}`,
  }
}

function printTable(rows) {
  const header = ['cp', 'category', 'defaultIgnorable', 'visible', 'verdict', 'inLNPS', 'inBlankSet', 'whiteSpace', 'edgeTrimmed', 'alone->']
  const body = rows.map((r) => [
    r.cp, r.category, String(r.defaultIgnorable), String(r.visible), r.verdict,
    String(r.visibleCategory), String(r.blankGlyphListed), String(r.whiteSpace), String(r.edgeTrimmed), r.code,
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(line(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const b of body) console.log(line(b))
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/dev/probe-group-name-rule.mjs [--json] <U+XXXX | 0xXXXX | string> ...')
    console.log('       node scripts/dev/probe-group-name-rule.mjs --cp 2800 --str "a\\u200Bb"')
    console.log('')
    console.log('Prints, per code point: cp / category / defaultIgnorable / visible / verdict,')
    console.log('evaluated by the SAME module the HTTP route calls. No database is opened.')
    process.exit(argv.length === 0 ? 2 : 0)
  }

  const rule = await loadRule()
  const { inputs, json } = parseArgs(argv)
  const output = []

  for (const input of inputs) {
    if (input.kind === 'cp') {
      const r = row(rule, input.codePoint)
      output.push({ input: input.source, kind: 'codepoint', ...r })
      if (!json) {
        console.log(`\n# ${input.source} — as a name of exactly this one code point`)
        printTable([r])
      }
      continue
    }

    const codePoints = [...input.value].map((c) => c.codePointAt(0))
    const rows = codePoints.map((cp) => row(rule, cp))
    const verdict = rule.classifyGroupName(input.value)
    const trimmed = rule.trimNameEdges(input.value)
    const summary = {
      input: input.source,
      kind: 'string',
      submittedCodePoints: codePoints.length,
      codePoints: codePoints.map(label),
      trimmed: [...trimmed].map((c) => label(c.codePointAt(0))),
      verdict: verdict.stage,
      result: verdict.ok ? `201 (stored as ${JSON.stringify(verdict.name)})` : `400 ${verdict.code}`,
      rows,
    }
    output.push(summary)
    if (!json) {
      console.log(`\n# ${JSON.stringify(input.value)} — ${codePoints.length} submitted code point(s)`)
      printTable(rows)
      console.log(`whole name: trimmed=${JSON.stringify(trimmed)} verdict=${verdict.stage} -> ${summary.result}`)
    }
  }

  if (json) console.log(JSON.stringify(output, null, 2))
}

await main()
