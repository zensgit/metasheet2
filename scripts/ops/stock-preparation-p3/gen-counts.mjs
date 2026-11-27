#!/usr/bin/env node
// gen-counts.mjs - DRAFT, not approved, not for sending.
//
// Computes the package-3 migration counts and names at CUT TIME from the package's own migration
// folders, and fills the {{TOKENS}} of the install / rollback sheet and of the s06 SQL template.
// No number is hardcoded here: the count comes from the folders the migrator itself reads.
//
// Why a generator (pre-audit R1): the R85 sheet hardcodes its counts. Package 3 counts change at
// every cut (Y9 adds at least one migration). A reused number stops a correct install or checks a
// rollback against the wrong baseline.
//
// NAME RULE (mirrors packages/core-backend/src/db/migration-provider.ts:144-165, 201-254, 279-311
// @59876b3d6 and kysely 0.28.8 FileMigrationProvider + Migrator#resolveMigrations):
//   runtimeDir = <root>/packages/core-backend/dist/src/db   (package layout: compiled migrate.js)
//              = <root>/packages/core-backend/src/db        (source layout: git archive of the cut)
//   provider folders  : runtimeDir/migrations, runtimeDir/../../migrations, runtimeDir/../../../migrations
//                       file ends .js | .mjs | .ts (not .d.ts) | .mts (not .d.mts); name = up to the last dot;
//                       names starting with '_' are skipped.
//   sql folders       : runtimeDir/migrations, runtimeDir/../../../src/db/migrations,
//                       runtimeDir/../../migrations, runtimeDir/../../../migrations
//                       file ends .sql and does not start with '.' or '_'; name = basename without .sql.
//   Folders are de-duplicated after path resolution; a missing folder is skipped.
//   A name seen twice is an ERROR (the provider throws "Duplicate migration name detected").
//   Superseded legacy SQL names stay in the list (they become no-op history markers, still counted).
//   MIGRATION_EXCLUDE is NOT applied: the site must have it unset (pre-audit R14); the sheet checks that.
//   Order = plain JavaScript .sort() of the names (Migrator#resolveMigrations, kysely 0.28.8 migrator.js:457-465).
// LIMITS: name-level only. The real provider also drops a .js/.ts module that exports no up(); this tool
// never imports package code, so it cannot see that. The package layout is mirrored from the code above;
// it has only been run against package-shaped folders (synthetic, and an empty-file skeleton of the real
// r85 package file list), never against a real extracted package-3 zip.
//
// USAGE (dev machine, at cut time, never on the site):
//   node gen-counts.mjs --root <package or source root> --label <package label>
//        ( --baseline-root <root> | --baseline-names <file, one name per line> ) --baseline-label <label>
//        [--layout auto|package|source] [--expect-new <n>] [--expect-total <n>]
//        [--fill <template> --out <file>]...   (pairs, in order)
//        [--lint <file>]...                    (lint these too, with the computed counts; any hit fails)
//        [--json <file>] [--names-out <file>] [--new-names-out <file>]
//   node gen-counts.mjs --lint <file> [--lint <file>]...     (CONTEXT-ONLY lint; no counting)
//
// LINT (section 9 of P3-install-sheet-DELTA.md). Refuses a file that still carries a hand-typed
// migration count. Two layers:
//   COMPUTED (only when --root is given; the counts come from this run, never from a literal list):
//     the bare BASELINE and TOTAL numbers this run computed, and the bare NEW number when it has 3 or
//     more digits (a 1-2 digit NEW is caught by the context layer only; bare, it would hit step numbers).
//     A ':481'-style line citation or range (preceded by ':' '.' '#' '-', a letter or a digit, or followed
//     by '-<digit>') is not a hit.
//   CONTEXT (always): a non-zero digit after names= / applied_t= / applied_f= / Applied / Pending;
//     any digit after kysely_migration= or after MIG_COUNT ... =; "<n> 个|条 [新] 迁移|名字";
//     执行|多|应为 <n>; 迁移[数] <3-digit n>; → <3-digit n>.
//     ('Pending: 0' and 'applied_t=0' are the fixed success words, not counts, so 0 is allowed there.)
//   {{TOKENS}} and hex runs of 12 or more characters are removed before matching.
//   A hit prints line numbers only and exits 3.
//   --lint WITH --root lints with both layers or fails (exit 2 on missing arguments, exit 3 on a hit):
//   it is never silently skipped. Every --fill template is linted the same way BEFORE anything is
//   written. --lint WITHOUT --root runs the context layer only and says so (mode=context).
//   The baseline is a PARAMETER because owner item O1 (R85 or R84 baseline) is open.
//
// TOKENS filled in every --fill template (an unknown or unfilled {{TOKEN}} is an error):
//   {{MIGRATIONS_TOTAL}}           names in the package (= kysely_migration rows after a good install)
//   {{MIGRATIONS_BASELINE}}        names in the baseline (= kysely_migration rows before the install)
//   {{MIGRATIONS_NEW}}             package names not in the baseline (= migrations the install runs)
//   {{LAST_MIGRATION}}             last package name in migrator order
//   {{LAST_NEW_MIGRATION}}         last NEW name in migrator order
//   {{PACKAGE_LABEL}} {{BASELINE_LABEL}}
//   {{MIGRATIONS_NEW_NAMES_MD}}    the new names as a markdown bullet list, one per line
//   {{MIGRATIONS_NEW_SQL_ARRAY}}   the new names as SQL string literals, comma separated, one per line
//   {{MIGRATIONS_NAMES_SHA256}}    sha256 of the sorted package names joined by LF (provenance)
//   {{MIGRATIONS_BASELINE_NAMES_MD5}}  md5 of the sorted BASELINE names joined by LF, no trailing LF
//   {{MIGRATIONS_TOTAL_NAMES_MD5}}     md5 of the sorted PACKAGE names joined by LF, no trailing LF
//     (both equal PostgreSQL md5(string_agg(name, E'\n' ORDER BY name COLLATE "C")) over a ledger that
//      holds exactly those names; SAFE_NAME keeps names ASCII, so JS sort = C collation. Used by the
//      RECOMMENDED s06 MIG_NAMESET line.)
//
// EXIT: 0 ok; 2 usage; 3 a rule failed (no names, duplicate, baseline not a subset, package dist/src
// mismatch, unsafe name, expectation mismatch, unknown or unfilled token, hardcoded count). Output lines
// are fixed words, counts and repository file names only.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { createHash } from 'node:crypto'

const TOKENS = [
  'MIGRATIONS_TOTAL', 'MIGRATIONS_BASELINE', 'MIGRATIONS_NEW', 'LAST_MIGRATION', 'LAST_NEW_MIGRATION',
  'PACKAGE_LABEL', 'BASELINE_LABEL', 'MIGRATIONS_NEW_NAMES_MD', 'MIGRATIONS_NEW_SQL_ARRAY', 'MIGRATIONS_NAMES_SHA256',
  'MIGRATIONS_BASELINE_NAMES_MD5', 'MIGRATIONS_TOTAL_NAMES_MD5',
]
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,40}$/

class RuleError extends Error {}
function fail(msg) { throw new RuleError(msg) }

function parseArgs(argv) {
  const o = { fills: [], lints: [], layout: 'auto' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => { if (i + 1 >= argv.length) usage('missing value for ' + a); return argv[++i] }
    switch (a) {
      case '--root': o.root = v(); break
      case '--label': o.label = v(); break
      case '--baseline-root': o.baselineRoot = v(); break
      case '--baseline-names': o.baselineNames = v(); break
      case '--baseline-label': o.baselineLabel = v(); break
      case '--layout': o.layout = v(); break
      case '--expect-new': o.expectNew = v(); break
      case '--expect-total': o.expectTotal = v(); break
      case '--fill': o.fills.push({ template: v() }); break
      case '--out': if (!o.fills.length || o.fills[o.fills.length - 1].out) usage('--out must follow --fill'); o.fills[o.fills.length - 1].out = v(); break
      case '--json': o.json = v(); break
      case '--lint': o.lints.push(v()); break
      case '--names-out': o.namesOut = v(); break
      case '--new-names-out': o.newNamesOut = v(); break
      default: usage('unknown argument ' + a)
    }
  }
  if (o.lints.length && !o.root) {
    // Context-only lint. Any counting argument without --root is a usage error, never silently ignored.
    const extra = ['label', 'baselineRoot', 'baselineNames', 'baselineLabel', 'expectNew', 'expectTotal', 'json', 'namesOut', 'newNamesOut']
      .filter(k => o[k] !== undefined)
    if (extra.length || o.fills.length || o.layout !== 'auto') usage('--lint without --root takes only --lint <file> arguments')
    o.lintOnly = true
    return o
  }
  if (!o.root || !o.label || !o.baselineLabel) usage('need --root, --label, --baseline-label')
  if (!!o.baselineRoot === !!o.baselineNames) usage('need exactly one of --baseline-root / --baseline-names')
  if (!['auto', 'package', 'source'].includes(o.layout)) usage('bad --layout')
  if (!SAFE_LABEL.test(o.label) || !SAFE_LABEL.test(o.baselineLabel)) usage('labels: letters, digits, _ . + - only')
  for (const f of o.fills) if (!f.out) usage('--fill without --out')
  return o
}

function usage(msg) {
  console.error('GENCOUNTS_USAGE ' + msg)
  process.exit(2)
}

function listDir(dir) {
  try { return readdirSync(dir) } catch (e) { if (e && e.code === 'ENOENT') return null; throw e }
}

function isFile(p) { try { return statSync(p).isFile() } catch { return false } }

function detectLayout(root, wanted) {
  const cb = join(root, 'packages', 'core-backend')
  const hasDist = existsSync(join(cb, 'dist', 'src', 'db', 'migrate.js'))
  const hasSrc = existsSync(join(cb, 'src', 'db', 'migrations'))
  if (wanted === 'package') { if (!hasDist) fail('layout_package_without_dist_migrate_js'); return 'package' }
  if (wanted === 'source') { if (!hasSrc) fail('layout_source_without_src_db_migrations'); return 'source' }
  if (hasDist) return 'package'
  if (hasSrc) return 'source'
  fail('layout_unknown')
}

function providerKey(fileName) {
  const jsLike = fileName.endsWith('.js') || fileName.endsWith('.mjs') ||
    (fileName.endsWith('.ts') && !fileName.endsWith('.d.ts')) ||
    (fileName.endsWith('.mts') && !fileName.endsWith('.d.mts'))
  if (!jsLike) return null
  return fileName.substring(0, fileName.lastIndexOf('.'))
}

function dedupe(paths) { return [...new Set(paths.map(p => resolve(p)))] }

function collect(root, layout) {
  const runtimeDir = layout === 'package'
    ? join(root, 'packages', 'core-backend', 'dist', 'src', 'db')
    : join(root, 'packages', 'core-backend', 'src', 'db')
  const providerFolders = dedupe([join(runtimeDir, 'migrations'), resolve(runtimeDir, '../../migrations'), resolve(runtimeDir, '../../../migrations')])
  const sqlFolders = dedupe([join(runtimeDir, 'migrations'), resolve(runtimeDir, '../../../src/db/migrations'),
    resolve(runtimeDir, '../../migrations'), resolve(runtimeDir, '../../../migrations')])
  const names = new Set()
  const add = (name) => {
    if (names.has(name)) fail('duplicate_name ' + name)
    names.add(name)
  }
  for (const folder of providerFolders) {
    const files = listDir(folder)
    if (!files) continue
    for (const f of files) {
      if (!isFile(join(folder, f))) continue
      const key = providerKey(f)
      if (key === null || key.startsWith('_')) continue
      add(key)
    }
  }
  for (const folder of sqlFolders) {
    const files = listDir(folder)
    if (!files) continue
    for (const f of files) {
      if (f.startsWith('.') || f.startsWith('_') || !f.endsWith('.sql')) continue
      if (!isFile(join(folder, f))) continue
      add(basename(f, '.sql'))
    }
  }
  if (layout === 'package') {
    // The compiled runner loads JS from dist; the shipped src/db/migrations must name the same modules.
    const srcDir = join(root, 'packages', 'core-backend', 'src', 'db', 'migrations')
    const distDir = join(runtimeDir, 'migrations')
    const srcTs = new Set((listDir(srcDir) || []).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('_') && isFile(join(srcDir, f))).map(f => f.slice(0, -3)))
    const distJs = new Set((listDir(distDir) || []).filter(f => f.endsWith('.js') && !f.startsWith('_') && isFile(join(distDir, f))).map(f => f.slice(0, -3)))
    if (srcTs.size > 0) {
      const onlySrc = [...srcTs].filter(n => !distJs.has(n))
      const onlyDist = [...distJs].filter(n => !srcTs.has(n))
      if (onlySrc.length || onlyDist.length) fail(`package_dist_src_mismatch only_src=${onlySrc.length} only_dist=${onlyDist.length}`)
    }
  }
  const sorted = [...names].sort()
  if (sorted.length === 0) fail('no_names')
  for (const n of sorted) if (!SAFE_NAME.test(n)) fail('unsafe_name')
  return sorted
}

function readNamesFile(file) {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
  const names = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
  const set = new Set()
  for (const n of names) { if (!SAFE_NAME.test(n)) fail('unsafe_baseline_name'); if (set.has(n)) fail('duplicate_baseline_name ' + n); set.add(n) }
  if (set.size === 0) fail('no_baseline_names')
  return [...set].sort()
}

function checkExpect(label, actual, expected) {
  if (expected === undefined) return
  if (!/^\d+$/.test(expected)) usage('expectation must be a number')
  if (Number(expected) !== actual) fail(`expect_${label}_mismatch expected=${expected} actual=${actual}`)
}

function fillTemplate(text, values) {
  const unknown = []
  const out = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
    if (Object.prototype.hasOwnProperty.call(values, k)) return values[k]
    unknown.push(k)
    return m
  })
  if (unknown.length) fail('unknown_token ' + [...new Set(unknown)].join(','))
  if (/\{\{[^}]*\}\}/.test(out)) fail('unfilled_token')
  return out
}

// CONTEXT layer: no number list at all; a count in a migration context is a hit whatever its value.
const CONTEXT_PATTERNS = [
  /(names|applied_t|applied_f)\s*=\s*[1-9]/,
  /Applied:?\s*[1-9]/,
  /Pending:?\s*[1-9]/,
  /kysely_migration\s*=\s*\d/,
  /MIG_COUNT[^=\n]*=\s*\d/,
  /[1-9][0-9]*\s*(个|条)\s*(新)?\s*(迁移|名字)/,
  /(执行|多|应为)\s*[1-9][0-9]*\s*(条)?/,
  /迁移数?\s*[:：=]?\s*\**\s*[1-9][0-9]{2}(?![0-9])/,
  /→\s*\**\s*[1-9][0-9]{2}(?![0-9])/,
]

// COMPUTED layer: the numbers this run computed (never a literal list).
function computedPatterns(counts) {
  if (!counts) return []
  const nums = new Set([counts.baseline, counts.total])
  if (counts.added >= 100) nums.add(counts.added)
  // Not a hit: a number right after ':' '.' '#' '-', a letter or a digit (line citations such as ':481' and
  // range ends such as ':439-440'), or right before '-<digit>' (range starts such as '484-490').
  return [...nums].filter(n => n > 0).map(n => new RegExp(`(?<![0-9A-Za-z:.#-])${n}(?![0-9A-Za-z]|-[0-9])`))
}

function lintText(text, counts) {
  const patterns = [...CONTEXT_PATTERNS, ...computedPatterns(counts)]
  const hits = []
  text.split(/\r?\n/).forEach((line, i) => {
    const scrubbed = line.replace(/\{\{[A-Z0-9_]+\}\}/g, '').replace(/[0-9a-f]{12,}/gi, '')
    if (patterns.some(re => re.test(scrubbed))) hits.push(i + 1)
  })
  return hits
}

function lintFile(file, counts) {
  const hits = lintText(readFileSync(file, 'utf8').replace(/^﻿/, ''), counts)
  const mode = counts ? `computed baseline=${counts.baseline} total=${counts.total} new=${counts.added}` : 'context'
  console.log(`GENCOUNTS_LINT file=${basename(file)} mode=${mode} hardcoded_lines=${hits.length}${hits.length ? ' lines=' + hits.join(',') : ''}`)
  return hits.length
}

function md5Names(names) { return createHash('md5').update(names.join('\n')).digest('hex') }

function writeLf(file, text) { writeFileSync(file, text.replace(/\r\n/g, '\n'), { encoding: 'utf8' }) }

function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.lintOnly) {
    let bad = 0
    for (const f of o.lints) bad += lintFile(f, null)
    if (bad) fail('hardcoded_count mode=context')
    console.log('GENCOUNTS_RESULT status=complete lint=clean mode=context')
    return
  }
  const layout = detectLayout(resolve(o.root), o.layout)
  const pkg = collect(resolve(o.root), layout)
  let base
  let baseLayout = 'names-file'
  if (o.baselineRoot) {
    baseLayout = detectLayout(resolve(o.baselineRoot), 'auto')
    base = collect(resolve(o.baselineRoot), baseLayout)
  } else {
    base = readNamesFile(o.baselineNames)
  }
  const pkgSet = new Set(pkg)
  const missing = base.filter(n => !pkgSet.has(n))
  // A baseline name the package lacks = kysely "corrupted migrations: previously executed migration ... is missing".
  if (missing.length) fail(`baseline_not_subset missing=${missing.length} first=${missing[0]}`)
  const baseSet = new Set(base)
  const added = pkg.filter(n => !baseSet.has(n))
  checkExpect('total', pkg.length, o.expectTotal)
  checkExpect('new', added.length, o.expectNew)
  // Lint every --lint file and every --fill template with the computed counts BEFORE anything is written.
  const counts = { baseline: base.length, total: pkg.length, added: added.length }
  let lintHits = 0
  const lintFiles = []
  for (const f of o.lints) { lintHits += lintFile(f, counts); lintFiles.push(basename(f)) }
  for (const f of o.fills) if (lintFile(f.template, counts)) fail('hardcoded_count mode=computed template=' + basename(f.template))
  if (lintHits) fail('hardcoded_count mode=computed lint=' + lintFiles.join(','))
  const values = {
    MIGRATIONS_TOTAL: String(pkg.length),
    MIGRATIONS_BASELINE: String(base.length),
    MIGRATIONS_NEW: String(added.length),
    LAST_MIGRATION: pkg[pkg.length - 1],
    LAST_NEW_MIGRATION: added.length ? added[added.length - 1] : '-',
    PACKAGE_LABEL: o.label,
    BASELINE_LABEL: o.baselineLabel,
    MIGRATIONS_NEW_NAMES_MD: added.map(n => '- `' + n + '`').join('\n'),
    MIGRATIONS_NEW_SQL_ARRAY: added.map(n => "      '" + n + "'").join(',\n'),
    MIGRATIONS_NAMES_SHA256: createHash('sha256').update(pkg.join('\n')).digest('hex'),
    MIGRATIONS_BASELINE_NAMES_MD5: md5Names(base),
    MIGRATIONS_TOTAL_NAMES_MD5: md5Names(pkg),
  }
  for (const k of TOKENS) if (!(k in values)) fail('internal_token_gap ' + k)
  const filledAll = []
  for (const f of o.fills) {
    if (resolve(f.template) === resolve(f.out)) usage('--out must differ from --fill')
    filledAll.push([f, fillTemplate(readFileSync(f.template, 'utf8').replace(/^﻿/, ''), values)])
  }
  for (const [f, filled] of filledAll) {
    writeLf(f.out, filled)
    console.log(`GENCOUNTS_FILL template=${basename(f.template)} out=${basename(f.out)} ok=true`)
  }
  if (o.lints.length) console.log(`GENCOUNTS_LINT_RESULT files=${o.lints.length} mode=computed lint=clean`)
  if (o.namesOut) writeLf(o.namesOut, pkg.join('\n') + '\n')
  if (o.newNamesOut) writeLf(o.newNamesOut, added.join('\n') + (added.length ? '\n' : ''))
  if (o.json) writeLf(o.json, JSON.stringify({ layout, baselineLayout: baseLayout, ...values, newNames: added }, null, 2) + '\n')
  console.log(`GENCOUNTS layout=${layout} baseline_layout=${baseLayout} package=${o.label} baseline=${o.baselineLabel} total=${pkg.length} baseline_total=${base.length} new=${added.length}`)
  console.log(`GENCOUNTS_LAST last=${values.LAST_MIGRATION} last_new=${values.LAST_NEW_MIGRATION}`)
  console.log(`GENCOUNTS_RESULT status=complete names_sha256=${values.MIGRATIONS_NAMES_SHA256}`)
}

try {
  main()
} catch (e) {
  if (e instanceof RuleError) {
    console.log('GENCOUNTS_RESULT status=failed reason=' + e.message)
    process.exit(3)
  }
  console.log('GENCOUNTS_RESULT status=failed reason=script_error')
  console.error(e && e.stack ? e.stack : String(e))
  process.exit(3)
}
